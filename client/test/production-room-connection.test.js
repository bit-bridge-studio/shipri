import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { encryptBinaryChunkFrame, decryptBinaryChunkFrame } from '../src/crypto/binary-framing.js';
import { generateFileId } from '../src/crypto/board-metadata.js';
import {
  formatTransferDirection,
  generateTransferId,
} from '../src/crypto/control-codec.js';
import { createSignalingClient } from '../src/signaling/socket-client.js';
import {
  PRODUCTION_BINARY_CHANNEL_LABEL,
  PRODUCTION_CONTROL_CHANNEL_LABEL,
} from '../src/webrtc/peer-connection.js';
import { createProductionRoomConnection } from '../src/webrtc/room-connection.js';
import { createMockSocketFactory } from './helpers/mock-socket.js';
import { createMockPeerConnectionFactory } from './helpers/mock-webrtc.js';

function sha256Base64Url(value) {
  return createHash('sha256').update(value, 'utf8').digest('base64url');
}

function createMemoryStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
    size: () => map.size,
  };
}

function linkReliableChannels(chA, chB) {
  const pendingToB = [];
  const pendingToA = [];
  const origSendA = chA.send.bind(chA);
  const origSendB = chB.send.bind(chB);

  chA.send = (data) => {
    origSendA(data);
    if (chB.readyState === 'open') {
      chB.simulateMessage(data);
    } else {
      pendingToB.push(data);
    }
  };
  chB.send = (data) => {
    origSendB(data);
    if (chA.readyState === 'open') {
      chA.simulateMessage(data);
    } else {
      pendingToA.push(data);
    }
  };

  return {
    openBoth: () => {
      chA.simulateOpen();
      chB.simulateOpen();
      while (pendingToB.length > 0) {
        chB.simulateMessage(pendingToB.shift());
      }
      while (pendingToA.length > 0) {
        chA.simulateMessage(pendingToA.shift());
      }
    },
  };
}

async function flushAll(rounds = 32) {
  for (let i = 0; i < rounds; i += 1) {
    await Promise.resolve();
  }
  await new Promise((resolve) => setTimeout(resolve, 15));
}

function createFullAuthSignalingHarness() {
  const baseFactory = createMockSocketFactory({ idPrefix: 'room-conn' });
  const rooms = new Map();
  let roomSeq = 0x5200;
  let peerSeq = 1;

  return function ioFactory(url, options) {
    const socket = baseFactory(url, options);
    const origEmit = socket.emit.bind(socket);

    socket.emit = (event, ...args) => {
      origEmit(event, ...args);
      const payload = args[0];

      if (event === 'room:create') {
        const roomId = `ship-${(roomSeq++).toString(16).padStart(4, '0')}`;
        const peerId = `peer-${peerSeq++}`;
        rooms.set(roomId, {
          authVerifier: payload.authVerifier,
          peers: [{ socket, peerId }],
        });
        queueMicrotask(() => {
          socket.simulateServerEvent('room:created', {
            roomId,
            peerId,
            negotiationDuty: 'offerer',
          });
        });
      }

      if (event === 'room:join') {
        const room = rooms.get(payload?.roomId);
        if (!room || sha256Base64Url(payload.authToken) !== room.authVerifier) {
          queueMicrotask(() => {
            socket.simulateServerEvent('room:error', {
              roomId: payload?.roomId,
              code: 'UNAUTHORIZED',
              message: 'Invalid room token.',
            });
          });
          return socket;
        }
        const peerId = `peer-${peerSeq++}`;
        const existing = room.peers[0];
        room.peers.push({ socket, peerId });
        queueMicrotask(() => {
          socket.simulateServerEvent('room:joined', {
            roomId: payload.roomId,
            peerId,
            negotiationDuty: 'answerer',
          });
          existing?.socket.simulateServerEvent('peer:joined', {
            roomId: payload.roomId,
            peerId,
          });
        });
      }

      if (event === 'ice:get') {
        queueMicrotask(() => {
          socket.simulateServerEvent('ice:credentials', {
            roomId: payload.roomId,
            iceServers: [
              { urls: ['stun:stun.shipri.test:3478'] },
              {
                urls: ['turns:turn.shipri.test:443?transport=tcp'],
                username: '1999999999:peer',
                credential: 'ephemeral_turn_cred_secret_value',
              },
            ],
          });
        });
      }

      if (event === 'signal:forward') {
        const room = rooms.get(payload?.roomId);
        const sender = room?.peers.find((p) => p.socket === socket);
        const target = room?.peers.find((p) => p.socket !== socket);
        if (sender && target) {
          queueMicrotask(() => {
            target.socket.simulateServerEvent('signal:receive', {
              roomId: payload.roomId,
              peerId: sender.peerId,
              signalData: payload.signalData,
            });
          });
        }
      }

      if (event === 'room:leave') {
        const room = rooms.get(payload?.roomId);
        if (room) {
          const idx = room.peers.findIndex((p) => p.socket === socket);
          if (idx !== -1) {
            const [removed] = room.peers.splice(idx, 1);
            if (room.peers.length === 0) {
              rooms.delete(payload.roomId);
            } else {
              queueMicrotask(() => {
                room.peers[0].socket.simulateServerEvent('peer:left', {
                  roomId: payload.roomId,
                  peerId: removed.peerId,
                  reason: 'leave',
                });
              });
            }
          }
        }
      }

      return socket;
    };

    return socket;
  };
}

describe('production equal-peer WebRTC connection (ticket [48])', () => {
  it('completes authorized room create/join, mutually authenticates channels, allows either peer to initiate control and binary traffic, and keeps secrets redacted', async () => {
    const ioFactory = createFullAuthSignalingHarness();
    const clientA = createSignalingClient({ url: 'https://shipri.app', ioFactory });
    const clientB = createSignalingClient({ url: 'https://shipri.app', ioFactory });
    const pcFactoryA = createMockPeerConnectionFactory();
    const pcFactoryB = createMockPeerConnectionFactory();

    const locA = { origin: 'https://shipri.app', pathname: '/', search: '', hash: '' };
    const storageA = createMemoryStorage();
    const statesA = [];
    const controlMsgsA = [];
    const controlMsgsB = [];
    const binaryFramesB = [];
    const errorsB = [];

    const connA = createProductionRoomConnection({
      signalingClient: clientA,
      peerConnectionFactory: pcFactoryA,
      storage: storageA,
      locationObj: locA,
      historyObj: { replaceState: () => {} },
      iceTransportPolicy: 'relay',
      onStateChange: (s) => statesA.push(s),
      onControlMessage: (msg, sender) => controlMsgsA.push({ msg, sender }),
    });

    clientA.connect();
    await connA.createRoom({ origin: 'https://shipri.app' });
    await flushAll();

    const shareUrl = connA.getShareUrl();
    expect(shareUrl).toMatch(/^https:\/\/shipri\.app\/room\/ship-[a-f0-9]{4}#key=[A-Za-z0-9_-]{43}$/);
    const parsedShare = new URL(shareUrl);
    const roomId = connA.getState().roomId;
    expect(storageA.size()).toBe(1);

    // Joiner opens shared URL with #key=
    const locB = {
      origin: parsedShare.origin,
      pathname: parsedShare.pathname,
      search: '',
      hash: parsedShare.hash,
    };
    const storageB = createMemoryStorage();

    const connB = createProductionRoomConnection({
      signalingClient: clientB,
      peerConnectionFactory: pcFactoryB,
      storage: storageB,
      locationObj: locB,
      historyObj: { replaceState: () => { locB.hash = ''; } },
      iceTransportPolicy: 'relay',
      onControlMessage: (msg, sender) => controlMsgsB.push({ msg, sender }),
      onBinaryFrame: (frame) => binaryFramesB.push(frame),
      onError: (err) => errorsB.push(err),
    });

    clientB.connect();
    await connB.joinRoom(roomId);
    await flushAll();

    // Fragment stripped on joiner
    expect(locB.hash).toBe('');

    const pcA = connA.getPeerManager().getPeerConnection();
    const pcB = connB.getPeerManager().getPeerConnection();
    const ctrlA = connA.getPeerManager().getChannel(PRODUCTION_CONTROL_CHANNEL_LABEL);
    const binA = connA.getPeerManager().getChannel(PRODUCTION_BINARY_CHANNEL_LABEL);
    const ctrlB = pcB.simulateRemoteDataChannel(PRODUCTION_CONTROL_CHANNEL_LABEL);
    const binB = pcB.simulateRemoteDataChannel(PRODUCTION_BINARY_CHANNEL_LABEL);

    const ctrlLink = linkReliableChannels(ctrlA, ctrlB);
    const binLink = linkReliableChannels(binA, binB);

    ctrlLink.openBoth();
    binLink.openBoth();
    pcA.simulateIceConnectionStateChange('connected');
    pcA.simulateConnectionStateChange('connected');
    await flushAll();

    // Mutual PEER_HELLO completes, making peerReady true on both sides
    expect(connA.getState().peerReady).toBe(true);
    expect(connB.getState().peerReady).toBe(true);
    expect(connA.getState().remoteMemberId).toBe(connB.getState().memberId);
    expect(connB.getState().remoteMemberId).toBe(connA.getState().memberId);
    expect(connA.getState().selectedPath).toEqual({ mode: 'relay', relayed: true });

    // EITHER peer can initiate authenticated control messages (B -> A AND A -> B)
    const fileId = generateFileId();
    const transferId = generateTransferId();
    const direction = formatTransferDirection(
      connA.getState().memberId,
      connB.getState().memberId,
    );

    await connB.sendControlMessage({
      type: 'DOWNLOAD_REQUEST',
      payload: { transferId, fileId, direction, initialEpoch: 1 },
    });
    await connA.sendControlMessage({
      type: 'TRANSFER_PAUSE',
      payload: { transferId, direction, epoch: 1 },
    });
    await flushAll();

    expect(controlMsgsA.some((entry) => entry.msg.type === 'DOWNLOAD_REQUEST')).toBe(true);
    expect(controlMsgsB.some((entry) => entry.msg.type === 'TRANSFER_PAUSE')).toBe(true);

    // Binary chunk encrypted frame over shipri-binary
    const activeKeyA = connA.getMasterKeyBytes();
    const frameBuf = await encryptBinaryChunkFrame({
      masterKeyBytes: activeKeyA,
      roomId,
      transferId,
      fileId,
      direction,
      epoch: 1,
      chunkIndex: 0,
      plaintext: new Uint8Array([10, 20, 30]),
      isFinalChunk: true,
    });
    expect(connA.sendBinaryFrame(frameBuf)).toBe(true);
    await flushAll();
    expect(binaryFramesB).toHaveLength(1);
    const decoded = await decryptBinaryChunkFrame({
      masterKeyBytes: connB.getMasterKeyBytes(),
      roomId,
      expectedTransferId: transferId,
      expectedFileId: fileId,
      expectedDirection: direction,
      expectedEpoch: 1,
      expectedChunkIndex: 0,
      frameBuffer: binaryFramesB[0],
    });
    expect(decoded.ok).toBe(true);
    expect(Array.from(new Uint8Array(decoded.plaintext))).toEqual([10, 20, 30]);

    // Forged/tampered control payload fails closed without disturbing session
    ctrlB.simulateMessage(JSON.stringify({ v: 1, senderMemberId: connA.getState().memberId, iv: 'AAAAAAAAAAAAAAAA', ciphertext: 'AAAAAAAAAAAAAAAAAAAAAAAA' }));
    await flushAll();
    expect(errorsB.some((e) => e.code === 'DECRYPTION_FAILED')).toBe(true);

    // State snapshots contain zero key/token/credential/SDP exposure
    const serializedStates = JSON.stringify(statesA);
    expect(serializedStates).not.toContain(parsedShare.hash.slice(5));
    expect(serializedStates).not.toContain('ephemeral_turn_cred_secret_value');

    // Leave clears keys and connection
    connA.leaveRoom();
    expect(connA.getShareUrl()).toBeNull();
    expect(connA.getMasterKeyBytes()).toBeNull();
    expect(storageA.size()).toBe(0);

    connA.dispose();
    connB.dispose();
    clientA.dispose();
    clientB.dispose();
  });
});
