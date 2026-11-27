import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { createSignalingClient } from '../src/signaling/socket-client.js';
import { validateProductionIceServers } from '../src/webrtc/ice-config.js';
import {
  PRODUCTION_BINARY_CHANNEL_LABEL,
  PRODUCTION_CONTROL_CHANNEL_LABEL,
  createPeerConnectionManager,
} from '../src/webrtc/peer-connection.js';
import { createMockSocketFactory } from './helpers/mock-socket.js';
import { createMockPeerConnectionFactory } from './helpers/mock-webrtc.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CLIENT_SRC_DIR = path.resolve(__dirname, '../src');

async function flushMicrotasks(rounds = 32) {
  for (let index = 0; index < rounds; index += 1) {
    await Promise.resolve();
  }
}

function createRoomSignalingHarness() {
  const baseFactory = createMockSocketFactory({ idPrefix: 'prod-peer' });
  const rooms = new Map();
  let roomSeq = 0x4100;
  let peerSeq = 1;
  let iceMode = 'turn';

  function setIceMode(mode) {
    iceMode = mode;
  }

  function ioFactory(url, options) {
    const socket = baseFactory(url, options);
    const originalEmit = socket.emit.bind(socket);

    socket.emit = (event, ...args) => {
      originalEmit(event, ...args);
      const payload = args[0];

      if (event === 'room:create') {
        const roomId = `ship-${(roomSeq++).toString(16).padStart(4, '0')}`;
        const peerId = `peer-${peerSeq++}`;
        rooms.set(roomId, {
          authVerifier: payload?.authVerifier ?? null,
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
        if (!room) {
          queueMicrotask(() => {
            socket.simulateServerEvent('room:error', {
              roomId: payload?.roomId,
              code: 'ROOM_NOT_FOUND',
              message: 'Room not found.',
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
          if (existing) {
            existing.socket.simulateServerEvent('peer:joined', {
              roomId: payload.roomId,
              peerId,
            });
          }
        });
      }

      if (event === 'room:leave') {
        const room = rooms.get(payload?.roomId);
        if (room) {
          const idx = room.peers.findIndex((entry) => entry.socket === socket);
          if (idx !== -1) {
            const [removed] = room.peers.splice(idx, 1);
            if (room.peers.length === 0) {
              rooms.delete(payload.roomId);
            } else {
              const remaining = room.peers[0];
              queueMicrotask(() => {
                remaining.socket.simulateServerEvent('peer:left', {
                  roomId: payload.roomId,
                  peerId: removed.peerId,
                  reason: 'leave',
                });
              });
            }
          }
        }
      }

      if (event === 'ice:get') {
        queueMicrotask(() => {
          if (iceMode === 'busy') {
            socket.simulateServerEvent('room:error', {
              roomId: payload.roomId,
              code: 'SERVER_BUSY',
              message: 'TURN credentials unavailable.',
            });
            return;
          }
          if (iceMode === 'malformed') {
            socket.simulateServerEvent('ice:credentials', {
              roomId: payload.roomId,
              iceServers: [{ urls: 'http://invalid.example' }],
            });
            return;
          }
          socket.simulateServerEvent('ice:credentials', {
            roomId: payload.roomId,
            iceServers: [
              { urls: ['stun:stun.shipri.test:3478'] },
              {
                urls: [
                  'turn:turn.shipri.test:3478?transport=udp',
                  'turns:turn.shipri.test:443?transport=tcp',
                ],
                username: '1999999999:prodtag',
                credential: 'ephemeral_turn_cred_never_leak',
              },
            ],
          });
        });
      }

      if (event === 'signal:forward') {
        const room = rooms.get(payload?.roomId);
        if (!room) {
          return socket;
        }
        const sender = room.peers.find((entry) => entry.socket === socket);
        const target = room.peers.find((entry) => entry.socket !== socket);
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

      return socket;
    };

    return socket;
  }

  return { ioFactory, setIceMode, rooms };
}

describe('production peer connection modules (ticket [42])', () => {
  it('excludes prototype modules and diagnostic UI dependencies from production modules', () => {
    const productionFiles = [
      'signaling/socket-client.js',
      'webrtc/ice-config.js',
      'webrtc/peer-connection.js',
    ];

    for (const relPath of productionFiles) {
      const source = readFileSync(path.join(CLIENT_SRC_DIR, relPath), 'utf8');
      expect(source).not.toMatch(/['"]\.\.?\/prototype\//);
      expect(source).not.toContain('diagnostic-');
      expect(source).not.toContain('MALFORMED_TEST_SCENARIOS');
    }

    const validIce = validateProductionIceServers(
      {
        roomId: 'ship-12ab',
        iceServers: [
          { urls: ['stun:stun.shipri.test:3478'] },
          {
            urls: 'turns:turn.shipri.test:443?transport=tcp',
            username: '1999999999:tag',
            credential: 'secret-cred',
          },
        ],
      },
      { expectedRoomId: 'ship-12ab' },
    );
    expect(validIce.ok).toBe(true);
    expect(validIce.iceServers).toHaveLength(2);
    expect(validIce.hasTurn).toBe(true);

    const badTurn = validateProductionIceServers(
      {
        roomId: 'ship-12ab',
        iceServers: [{ urls: 'turn:turn.shipri.test:3478' }],
      },
      { expectedRoomId: 'ship-12ab' },
    );
    expect(badTurn.ok).toBe(false);
    expect(badTurn.error.code).toBe('INVALID_ICE_CREDENTIALS');
  });

  it('negotiates equal-peer control and binary channels, propagates path state without leaking secrets, and cleans up on dispose()', async () => {
    const harness = createRoomSignalingHarness();
    const clientA = createSignalingClient({
      url: 'https://shipri.app',
      ioFactory: harness.ioFactory,
    });
    const clientB = createSignalingClient({
      url: 'https://shipri.app',
      ioFactory: harness.ioFactory,
    });

    const pcFactoryA = createMockPeerConnectionFactory();
    const pcFactoryB = createMockPeerConnectionFactory();

    const statesA = [];
    const openedA = [];
    const openedB = [];

    const managerA = createPeerConnectionManager({
      signalingClient: clientA,
      peerConnectionFactory: pcFactoryA,
      iceTransportPolicy: 'relay',
      onStateChange: (state) => statesA.push(state),
      onChannelOpen: (label) => openedA.push(label),
    });
    const managerB = createPeerConnectionManager({
      signalingClient: clientB,
      peerConnectionFactory: pcFactoryB,
      iceTransportPolicy: 'relay',
      onChannelOpen: (label) => openedB.push(label),
    });

    clientA.connect();
    clientB.connect();

    clientA.createRoom({ authVerifier: 'verifier_43_chars_placeholder_value_01234567' });
    await flushMicrotasks();
    const roomId = managerA.getState().roomId;
    expect(roomId).toMatch(/^ship-[a-f0-9]{4}$/);

    clientB.joinRoom({ roomId, authToken: 'token_value_never_logged_anywhere' });
    await flushMicrotasks();

    const pcA = managerA.getPeerConnection();
    const pcB = managerB.getPeerConnection();
    expect(pcA).not.toBeNull();
    expect(pcB).not.toBeNull();
    expect(pcA.config.iceTransportPolicy).toBe('relay');
    expect(pcB.config.iceTransportPolicy).toBe('relay');

    const controlA = managerA.getChannel(PRODUCTION_CONTROL_CHANNEL_LABEL);
    const binaryA = managerA.getChannel(PRODUCTION_BINARY_CHANNEL_LABEL);
    expect(controlA).not.toBeNull();
    expect(binaryA).not.toBeNull();
    expect(binaryA.binaryType).toBe('arraybuffer');

    const controlB = pcB.simulateRemoteDataChannel(PRODUCTION_CONTROL_CHANNEL_LABEL);
    const binaryB = pcB.simulateRemoteDataChannel(PRODUCTION_BINARY_CHANNEL_LABEL);
    expect(binaryB.binaryType).toBe('arraybuffer');

    controlA.simulateOpen();
    binaryA.simulateOpen();
    controlB.simulateOpen();
    binaryB.simulateOpen();

    pcA.simulateIceConnectionStateChange('connected');
    pcA.simulateConnectionStateChange('connected');
    await flushMicrotasks();

    expect(openedA).toEqual([
      PRODUCTION_CONTROL_CHANNEL_LABEL,
      PRODUCTION_BINARY_CHANNEL_LABEL,
    ]);
    expect(openedB).toEqual([
      PRODUCTION_CONTROL_CHANNEL_LABEL,
      PRODUCTION_BINARY_CHANNEL_LABEL,
    ]);
    expect(managerA.getState().selectedPath).toMatchObject({
      mode: 'relay',
      relayed: true,
    });

    // No credentials or raw IPs in manager state snapshots
    const serializedStates = JSON.stringify(statesA);
    expect(serializedStates).not.toContain('ephemeral_turn_cred_never_leak');
    expect(serializedStates).not.toContain('1999999999:prodtag');

    // Dispose closes channels and RTCPeerConnection and clears retained references
    managerA.dispose();
    expect(pcA.closed).toBe(true);
    expect(controlA.readyState).toBe('closed');
    expect(binaryA.readyState).toBe('closed');
    expect(managerA.getPeerConnection()).toBeNull();
    expect(managerA.getChannel(PRODUCTION_CONTROL_CHANNEL_LABEL)).toBeNull();
    expect(managerA.getChannel(PRODUCTION_BINARY_CHANNEL_LABEL)).toBeNull();
    expect(managerA.getState().disposed).toBe(true);

    managerB.dispose();
    clientA.dispose();
    clientB.dispose();
  });

  it('handles repeated replacement-peer cycles, reconnect() hook generations, and rejects stale events from disposed generations', async () => {
    const harness = createRoomSignalingHarness();
    const clientA = createSignalingClient({
      url: 'https://shipri.app',
      ioFactory: harness.ioFactory,
    });
    const clientB = createSignalingClient({
      url: 'https://shipri.app',
      ioFactory: harness.ioFactory,
    });
    const clientC = createSignalingClient({
      url: 'https://shipri.app',
      ioFactory: harness.ioFactory,
    });

    const pcFactoryA = createMockPeerConnectionFactory();
    const pcFactoryB = createMockPeerConnectionFactory();
    const pcFactoryC = createMockPeerConnectionFactory();

    const managerA = createPeerConnectionManager({
      signalingClient: clientA,
      peerConnectionFactory: pcFactoryA,
    });
    const managerB = createPeerConnectionManager({
      signalingClient: clientB,
      peerConnectionFactory: pcFactoryB,
    });
    const managerC = createPeerConnectionManager({
      signalingClient: clientC,
      peerConnectionFactory: pcFactoryC,
    });

    clientA.connect();
    clientB.connect();
    clientC.connect();

    clientA.createRoom({ authVerifier: 'verifier_cycle_test' });
    await flushMicrotasks();
    const roomId = managerA.getState().roomId;

    // Cycle 1: Peer B joins
    clientB.joinRoom({ roomId, authToken: 'token_cycle_test' });
    await flushMicrotasks();
    const gen1 = managerA.getState().generation;
    const pcA1 = managerA.getPeerConnection();
    const peerBId = managerA.getState().remotePeerId;
    expect(gen1).toBeGreaterThanOrEqual(1);
    expect(pcA1).not.toBeNull();

    // Peer B leaves -> old PC disposed and A promoted to waiting_for_peer offerer
    clientB.leaveRoom(roomId);
    await flushMicrotasks();
    expect(pcA1.closed).toBe(true);
    expect(managerA.getPeerConnection()).toBeNull();
    expect(managerA.getState()).toMatchObject({
      peerState: 'waiting_for_peer',
      negotiationDuty: 'offerer',
      remotePeerId: null,
    });

    // Cycle 2: Replacement Peer C joins -> new generation
    clientC.joinRoom({ roomId, authToken: 'token_cycle_test' });
    await flushMicrotasks();
    const gen2 = managerA.getState().generation;
    const pcA2 = managerA.getPeerConnection();
    expect(gen2).toBeGreaterThan(gen1);
    expect(pcA2).not.toBeNull();
    expect(pcA2).not.toBe(pcA1);

    // Late stale event from Peer B / gen1 is rejected and ignored
    const addIceSpy = vi.spyOn(pcA2, 'addIceCandidate');
    const remoteDescSpy = vi.spyOn(pcA2, 'setRemoteDescription');
    clientA.emitRaw('room:noop', {}); // no-op sanity check
    // Deliver stale signal:receive from old peerBId via mock socket
    const socketsA = harness.rooms.get(roomId).peers.find((p) => p.peerId !== managerA.getState().remotePeerId);
    socketsA.socket.simulateServerEvent('signal:receive', {
      roomId,
      peerId: peerBId,
      signalData: {
        kind: 'ice',
        generation: gen1,
        candidate: { candidate: 'candidate:1 1 UDP 1 198.51.100.9 5000 typ srflx' },
      },
    });
    await flushMicrotasks();
    expect(addIceSpy).not.toHaveBeenCalled();
    expect(remoteDescSpy).not.toHaveBeenCalled();
    expect(managerA.getState().staleEventsIgnored).toBeGreaterThanOrEqual(1);

    // Explicit reconnect() hook creates a new generation and disposes previous PC
    const genBeforeReconnect = managerA.getState().generation;
    const pcBeforeReconnect = managerA.getPeerConnection();
    const reconnected = managerA.reconnect();
    expect(reconnected).toBe(true);
    await flushMicrotasks();

    expect(pcBeforeReconnect.closed).toBe(true);
    expect(managerA.getState().generation).toBeGreaterThan(genBeforeReconnect);
    const pcAfterReconnect = managerA.getPeerConnection();
    expect(pcAfterReconnect).not.toBeNull();
    expect(pcAfterReconnect).not.toBe(pcBeforeReconnect);

    // Late ICE candidate emitted on disposed pcBeforeReconnect is ignored
    const staleCandBefore = managerA.getState().staleEventsIgnored;
    pcBeforeReconnect.simulateIceCandidate({
      candidate: 'candidate:9 1 UDP 1 198.51.100.10 5001 typ srflx',
      sdpMid: '0',
      sdpMLineIndex: 0,
    });
    await flushMicrotasks();
    expect(managerA.getState().staleEventsIgnored).toBeGreaterThanOrEqual(
      staleCandBefore,
    );

    managerA.dispose();
    managerB.dispose();
    managerC.dispose();
    clientA.dispose();
    clientB.dispose();
    clientC.dispose();
  });

  it('propagates room:error and malformed ICE errors without crashing or leaking credentials', async () => {
    const harness = createRoomSignalingHarness();
    const clientA = createSignalingClient({
      url: 'https://shipri.app',
      ioFactory: harness.ioFactory,
    });
    const clientB = createSignalingClient({
      url: 'https://shipri.app',
      ioFactory: harness.ioFactory,
    });

    const errorsA = [];
    const managerA = createPeerConnectionManager({
      signalingClient: clientA,
      peerConnectionFactory: createMockPeerConnectionFactory(),
      onError: (err) => errorsA.push(err),
    });
    const managerB = createPeerConnectionManager({
      signalingClient: clientB,
      peerConnectionFactory: createMockPeerConnectionFactory(),
    });

    clientA.connect();
    clientB.connect();

    harness.setIceMode('busy');
    clientA.createRoom({ authVerifier: 'verifier_err_test' });
    await flushMicrotasks();
    const roomId = managerA.getState().roomId;
    clientB.joinRoom({ roomId, authToken: 'token_err_test' });
    await flushMicrotasks();

    expect(errorsA.some((err) => err.code === 'SERVER_BUSY')).toBe(true);
    expect(managerA.getState().lastError?.code).toBe('SERVER_BUSY');

    // Malformed ICE payload fails closed with INVALID_ICE_CREDENTIALS
    harness.setIceMode('malformed');
    managerA.reconnect();
    await flushMicrotasks();
    expect(errorsA.some((err) => err.code === 'INVALID_ICE_CREDENTIALS')).toBe(
      true,
    );

    managerA.dispose();
    managerB.dispose();
    clientA.dispose();
    clientB.dispose();
  });

  it('handles offerer and answerer bidirectional reconnect(), rejects stale-generation offers, and cleans up on local room:leave', async () => {
    const harness = createRoomSignalingHarness();
    const clientA = createSignalingClient({
      url: 'https://shipri.app',
      ioFactory: harness.ioFactory,
    });
    const clientB = createSignalingClient({
      url: 'https://shipri.app',
      ioFactory: harness.ioFactory,
    });

    const pcFactoryA = createMockPeerConnectionFactory();
    const pcFactoryB = createMockPeerConnectionFactory();

    const managerA = createPeerConnectionManager({
      signalingClient: clientA,
      peerConnectionFactory: pcFactoryA,
    });
    const managerB = createPeerConnectionManager({
      signalingClient: clientB,
      peerConnectionFactory: pcFactoryB,
    });

    clientA.connect();
    clientB.connect();

    clientA.createRoom({ authVerifier: 'verifier_bidir' });
    await flushMicrotasks();
    const roomId = managerA.getState().roomId;
    clientB.joinRoom({ roomId, authToken: 'token_bidir' });
    await flushMicrotasks();

    const pcA1 = managerA.getPeerConnection();
    const pcB1 = managerB.getPeerConnection();
    const initialGenA = managerA.getState().generation;
    const initialGenB = managerB.getState().generation;
    expect(pcA1).not.toBeNull();
    expect(pcB1).not.toBeNull();

    // Open initial remote channels on answerer
    pcB1.simulateRemoteDataChannel(PRODUCTION_CONTROL_CHANNEL_LABEL).simulateOpen();
    pcB1.simulateRemoteDataChannel(PRODUCTION_BINARY_CHANNEL_LABEL).simulateOpen();
    managerA.getChannel(PRODUCTION_CONTROL_CHANNEL_LABEL).simulateOpen();
    managerA.getChannel(PRODUCTION_BINARY_CHANNEL_LABEL).simulateOpen();

    // 1. Offerer-initiated reconnect() replaces BOTH pcA1 and pcB1 with fresh channels
    expect(managerA.reconnect()).toBe(true);
    await flushMicrotasks();

    const pcA2 = managerA.getPeerConnection();
    const pcB2 = managerB.getPeerConnection();
    expect(pcA1.closed).toBe(true);
    expect(pcB1.closed).toBe(true);
    expect(pcA2).not.toBeNull();
    expect(pcA2).not.toBe(pcA1);
    expect(pcB2).not.toBeNull();
    expect(pcB2).not.toBe(pcB1);
    expect(managerA.getState().generation).toBeGreaterThan(initialGenA);
    expect(managerB.getState().generation).toBeGreaterThan(initialGenB);

    const ctrlB2 = pcB2.simulateRemoteDataChannel(PRODUCTION_CONTROL_CHANNEL_LABEL);
    const binB2 = pcB2.simulateRemoteDataChannel(PRODUCTION_BINARY_CHANNEL_LABEL);
    ctrlB2.simulateOpen();
    binB2.simulateOpen();
    expect(managerB.getChannel(PRODUCTION_CONTROL_CHANNEL_LABEL)?.readyState).toBe('open');
    expect(managerB.getChannel(PRODUCTION_BINARY_CHANNEL_LABEL)?.readyState).toBe('open');

    // 2. Stale/duplicate SDP offer with generation <= lastAcceptedOfferGeneration is rejected
    const staleBeforeB = managerB.getState().staleEventsIgnored;
    const peerAId = pcB2 ? managerA.getState().selfPeerId : null;
    const roomSockets = harness.rooms.get(roomId).peers;
    const socketB = roomSockets.find((p) => p.peerId === managerB.getState().selfPeerId).socket;
    socketB.simulateServerEvent('signal:receive', {
      roomId,
      peerId: peerAId,
      signalData: {
        kind: 'sdp',
        generation: initialGenA,
        description: { type: 'offer', sdp: 'v=0\r\nstale-offer' },
      },
    });
    await flushMicrotasks();
    expect(managerB.getPeerConnection()).toBe(pcB2);
    expect(pcB2.closed).toBe(false);
    expect(managerB.getState().staleEventsIgnored).toBe(staleBeforeB + 1);

    // 3. Answerer-initiated reconnect() signals offerer and yields fresh pcA3 & pcB3
    const genA2 = managerA.getState().generation;
    const genB2 = managerB.getState().generation;
    expect(managerB.reconnect()).toBe(true);
    await flushMicrotasks();

    const pcA3 = managerA.getPeerConnection();
    const pcB3 = managerB.getPeerConnection();
    expect(pcA2.closed).toBe(true);
    expect(pcB2.closed).toBe(true);
    expect(pcA3).not.toBeNull();
    expect(pcA3).not.toBe(pcA2);
    expect(pcB3).not.toBeNull();
    expect(pcB3).not.toBe(pcB2);
    expect(managerA.getState().generation).toBeGreaterThan(genA2);
    expect(managerB.getState().generation).toBeGreaterThan(genB2);

    // 4. Local room:leave tears down active channels and PC and resets to unaffiliated
    expect(managerA.leaveRoom()).toBe(true);
    await flushMicrotasks();
    expect(pcA3.closed).toBe(true);
    expect(managerA.getPeerConnection()).toBeNull();
    expect(managerA.getChannel(PRODUCTION_CONTROL_CHANNEL_LABEL)).toBeNull();
    expect(managerA.getState()).toMatchObject({
      roomId: null,
      peerState: 'unaffiliated',
      negotiationDuty: null,
    });

    managerA.dispose();
    managerB.dispose();
    clientA.dispose();
    clientB.dispose();
  });
});
