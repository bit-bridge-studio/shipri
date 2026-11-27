import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLocalFileBoard } from '../src/board/local-board.js';
import { createRemoteFileBoard } from '../src/board/remote-board.js';
import { encryptBinaryChunkFrame } from '../src/crypto/binary-framing.js';
import { generateTransferId } from '../src/crypto/control-codec.js';
import {
  generateMasterKey,
  generateMemberId,
} from '../src/crypto/fragment-key.js';
import { createSignalingClient } from '../src/signaling/socket-client.js';
import { CHUNK_SIZE_BYTES } from '../src/transfer/owner-streamer.js';
import { createTransferCoordinator } from '../src/transfer/transfer-coordinator.js';
import {
  PRODUCTION_BINARY_CHANNEL_LABEL,
  PRODUCTION_CONTROL_CHANNEL_LABEL,
} from '../src/webrtc/peer-connection.js';
import {
  INITIAL_RECONNECT_BACKOFF_MS,
  MAX_RECONNECT_ATTEMPTS,
  RECONNECT_GRACE_WINDOW_MS,
  createReconnectSupervisor,
} from '../src/webrtc/reconnect-supervisor.js';
import { createRoomBoardController } from '../src/ui/room-board-controller.js';
import { createMockSocketFactory } from './helpers/mock-socket.js';
import { createMockPeerConnectionFactory } from './helpers/mock-webrtc.js';

const ROOM_ID = 'ship-8d4c';

afterEach(() => {
  vi.useRealTimers();
});

function sha256Base64Url(value) {
  return createHash('sha256').update(value, 'utf8').digest('base64url');
}

function createMemoryStorage() {
  const store = new Map();
  return {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
    size: () => store.size,
  };
}

function createDeterministicBytes(length, seed = 7) {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) {
    out[i] = (i * 29 + seed) & 0xff;
  }
  return out;
}

function createMutableMockFile({ name, bytes, lastModified = 1_786_000_000_000 }) {
  let currentSize = bytes.byteLength;
  let currentMod = lastModified;
  return {
    name,
    get size() {
      return currentSize;
    },
    type: 'application/octet-stream',
    get lastModified() {
      return currentMod;
    },
    slice(start = 0, end = currentSize) {
      const sub = bytes.slice(start, end);
      return {
        async arrayBuffer() {
          return sub.buffer.slice(sub.byteOffset, sub.byteOffset + sub.byteLength);
        },
      };
    },
    mutateSize(next) {
      currentSize = next;
    },
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
    openBoth() {
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

function createReconnectSignalingHarness() {
  const baseFactory = createMockSocketFactory({ idPrefix: 'rec-peer' });
  const rooms = new Map();
  const createdSockets = [];
  let roomSeq = 0x7100;
  let peerSeq = 1;

  const ioFactory = function ioFactory(url, options) {
    const socket = baseFactory(url, options);
    createdSockets.push(socket);
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
              message: 'Invalid token.',
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
            iceServers: [{ urls: ['stun:stun.shipri.test:3478'] }],
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

  ioFactory.sockets = createdSockets;
  ioFactory.simulateUnexpectedDrop = (targetSocket) => {
    for (const [roomId, room] of rooms.entries()) {
      const idx = room.peers.findIndex((p) => p.socket === targetSocket);
      if (idx !== -1) {
        const [removed] = room.peers.splice(idx, 1);
        targetSocket.simulateDisconnect('transport close');
        if (room.peers.length === 0) {
          rooms.delete(roomId);
        } else {
          queueMicrotask(() => {
            room.peers[0].socket.simulateServerEvent('peer:left', {
              roomId,
              peerId: removed.peerId,
              reason: 'disconnect',
            });
          });
        }
        return roomId;
      }
    }
    targetSocket.simulateDisconnect('transport close');
    return null;
  };

  return ioFactory;
}

async function flushMicrotasks(rounds = 24) {
  for (let i = 0; i < rounds; i += 1) {
    await Promise.resolve();
  }
}

describe('Board reconnection and safe transfer resume (FF-6)', () => {
  it('bounds reconnect retries with exponential backoff and halts on exhaustion or grace timeout', async () => {
    vi.useFakeTimers();
    let peerReady = false;
    let peerState = 'connected';
    let roomId = ROOM_ID;
    const reconnectSpy = vi.fn(() => true);
    const joinSpy = vi.fn(async () => ({ ok: true }));
    const exhaustedEvents = [];

    const supervisor = createReconnectSupervisor({
      roomConnection: {
        getState: () => ({
          connectionStatus: 'connected',
          roomId,
          peerState,
          peerReady,
        }),
        reconnect: reconnectSpy,
        joinRoom: joinSpy,
      },
      signalingClient: {
        getStatus: () => ({ status: 'connected' }),
      },
      maxAttempts: MAX_RECONNECT_ATTEMPTS,
      initialBackoffMs: INITIAL_RECONNECT_BACKOFF_MS,
      maxBackoffMs: 8_000,
      graceWindowMs: RECONNECT_GRACE_WINDOW_MS,
      onExhausted: (evt) => exhaustedEvents.push(evt),
    });

    // Loss triggers bounded backoff attempts: 1s, 2s, 4s then exhaustion (never unbounded!)
    supervisor.notifyTransportFailure('ICE_CONNECTION_FAILED');
    expect(supervisor.getState().state).toBe('reconnecting');

    await vi.advanceTimersByTimeAsync(1_000);
    expect(reconnectSpy).toHaveBeenCalledTimes(1);
    expect(supervisor.getState().attempts).toBe(1);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(reconnectSpy).toHaveBeenCalledTimes(2);
    expect(supervisor.getState().attempts).toBe(2);

    await vi.advanceTimersByTimeAsync(4_000);
    expect(reconnectSpy).toHaveBeenCalledTimes(3);
    expect(supervisor.getState().attempts).toBe(3);

    // Next attempt window hits maxAttempts -> exhausted with zero extra reconnect() calls
    await vi.advanceTimersByTimeAsync(10_000);
    expect(reconnectSpy).toHaveBeenCalledTimes(3);
    expect(supervisor.getState().state).toBe('exhausted');
    expect(exhaustedEvents[0]).toMatchObject({
      reason: 'MAX_ATTEMPTS_EXCEEDED',
      attempts: 3,
    });

    // Recovering before exhaustion resets attempt count
    supervisor.notifyTransportFailure('PEER_CONNECTION_FAILED');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(reconnectSpy).toHaveBeenCalledTimes(4);
    peerReady = true;
    supervisor.notifyPeerReady();
    expect(supervisor.getState()).toMatchObject({
      state: 'connected',
      attempts: 0,
    });

    // Grace window expiration during peer:left -> exhausted
    peerReady = false;
    peerState = 'waiting_for_peer';
    supervisor.notifyPeerLeft();
    expect(supervisor.getState().state).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(RECONNECT_GRACE_WINDOW_MS);
    expect(supervisor.getState().state).toBe('exhausted');
    expect(exhaustedEvents[exhaustedEvents.length - 1]?.reason).toBe(
      'GRACE_WINDOW_EXPIRED',
    );

    // Intentional leave cancels all future work cleanly
    supervisor.notifyIntentionalLeave();
    roomId = null;
    await vi.advanceTimersByTimeAsync(RECONNECT_GRACE_WINDOW_MS);
    expect(reconnectSpy).toHaveBeenCalledTimes(4);

    supervisor.dispose();
  });

  it('disposes prior channels/connections across 3 replacement cycles and ignores late stale generation events', async () => {
    const ioFactory = createReconnectSignalingHarness();
    const clientA = createSignalingClient({ url: 'https://shipri.app', ioFactory });
    const clientB = createSignalingClient({ url: 'https://shipri.app', ioFactory });
    const pcFactoryA = createMockPeerConnectionFactory();
    const pcFactoryB = createMockPeerConnectionFactory();
    const storageA = createMemoryStorage();
    const storageB = createMemoryStorage();
    const locA = { origin: 'https://shipri.app', pathname: '/', search: '', hash: '' };
    const locB = { origin: 'https://shipri.app', pathname: '/', search: '', hash: '' };

    const controllerA = createRoomBoardController({
      signalingClient: clientA,
      peerConnectionFactory: pcFactoryA,
      storage: storageA,
      locationObj: locA,
      historyObj: { replaceState: () => {} },
      windowObj: { isSecureContext: true },
      navigatorObj: {},
      origin: 'https://shipri.app',
      autoConnect: true,
    });
    const controllerB = createRoomBoardController({
      signalingClient: clientB,
      peerConnectionFactory: pcFactoryB,
      storage: storageB,
      locationObj: locB,
      historyObj: { replaceState: () => { locB.hash = ''; } },
      windowObj: { isSecureContext: true },
      navigatorObj: {},
      origin: 'https://shipri.app',
      autoConnect: false,
    });

    await controllerA.createRoom();
    await flushMicrotasks();
    const copied = [];
    await controllerA.copyShareLink({ writeText: async (u) => copied.push(u) });
    clientB.connect();
    await controllerB.joinRoom(copied[0]);
    await flushMicrotasks();

    const pmA = controllerA.getConnection().getPeerManager();
    const pmB = controllerB.getConnection().getPeerManager();

    let prevPcA = null;
    let prevPcB = null;
    let prevCtrlA = null;
    let prevCtrlB = null;

    for (let cycle = 1; cycle <= 3; cycle += 1) {
      await vi.waitFor(() => {
        const curA = pmA.getPeerConnection();
        const curB = pmB.getPeerConnection();
        expect(curA).not.toBeNull();
        expect(curB).not.toBeNull();
        expect(curA).not.toBe(prevPcA);
        expect(curB).not.toBe(prevPcB);
      });

      const curPcA = pmA.getPeerConnection();
      const curPcB = pmB.getPeerConnection();
      const ctrlA = pmA.getChannel(PRODUCTION_CONTROL_CHANNEL_LABEL);
      const binA = pmA.getChannel(PRODUCTION_BINARY_CHANNEL_LABEL);
      const ctrlB = curPcB.simulateRemoteDataChannel(PRODUCTION_CONTROL_CHANNEL_LABEL);
      const binB = curPcB.simulateRemoteDataChannel(PRODUCTION_BINARY_CHANNEL_LABEL);

      linkReliableChannels(ctrlA, ctrlB).openBoth();
      linkReliableChannels(binA, binB).openBoth();

      await vi.waitFor(() => {
        expect(controllerA.getState().peerReady).toBe(true);
        expect(controllerB.getState().peerReady).toBe(true);
      });

      if (prevCtrlB && prevPcB) {
        // Late stale event delivered on disposed generation channel must not mutate current state
        const errorsBefore = controllerB.getState().errorBanner;
        prevCtrlB.onmessage?.({ data: 'corrupt-stale-json' });
        prevCtrlA.onmessage?.({ data: 'corrupt-stale-json' });
        expect(controllerB.getState().errorBanner).toBe(errorsBefore);
        expect(prevPcA.closed).toBe(true);
        expect(prevPcB.closed).toBe(true);
        expect(prevCtrlB.readyState).toBe('closed');
      }

      prevPcA = curPcA;
      prevPcB = curPcB;
      prevCtrlA = ctrlA;
      prevCtrlB = ctrlB;

      if (cycle < 3) {
        expect(controllerA.getConnection().reconnect()).toBe(true);
        await flushMicrotasks();
      }
    }

    controllerA.dispose();
    controllerB.dispose();
    clientA.dispose();
    clientB.dispose();
  });

  it('converges board state and resumes mid-stream across two disconnect/reconnect cycles with epoch rotation and full output integrity', async () => {
    const { masterKeyBytes } = generateMasterKey();
    const memberA = generateMemberId();
    const memberB = generateMemberId();
    const localBoardA = createLocalFileBoard({ roomId: ROOM_ID, masterKeyBytes });
    const localBoardB = createLocalFileBoard({ roomId: ROOM_ID, masterKeyBytes });
    const remoteBoardA = createRemoteFileBoard({ roomId: ROOM_ID, masterKeyBytes });
    const remoteBoardB = createRemoteFileBoard({ roomId: ROOM_ID, masterKeyBytes });

    // 10 chunks (~640 KiB) with controlled slow write gating so we can disconnect twice mid-flight
    const payloadBytes = createDeterministicBytes(CHUNK_SIZE_BYTES * 15 + 777, 13);
    const bigFile = createMutableMockFile({ name: 'big-resume.bin', bytes: payloadBytes });
    const tempFile = createMutableMockFile({
      name: 'ephemeral.txt',
      bytes: new TextEncoder().encode('will be removed offline'),
    });
    const addedA = await localBoardA.addFiles([bigFile, tempFile]);
    const bigFileId = addedA.advertised[0].fileId;
    const tempFileId = addedA.advertised[1].fileId;

    let releaseWriteGate = null;
    const persistedChunks = [];
    const writeTarget = {
      closed: false,
      aborted: false,
      async write(chunk) {
        if (releaseWriteGate) {
          await releaseWriteGate();
        }
        await new Promise((resolve) => setTimeout(resolve, 18));
        persistedChunks.push(new Uint8Array(chunk));
      },
      async close() {
        this.closed = true;
      },
      async abort() {
        this.aborted = true;
      },
    };

    const windowB = {
      isSecureContext: true,
      showSaveFilePicker: vi.fn(async () => ({
        async createWritable() {
          return writeTarget;
        },
      })),
    };

    let connected = true;
    const makeChannel = (targetCoordGetter) => {
      const listeners = new Map();
      return {
        readyState: 'open',
        bufferedAmount: 0,
        bufferedAmountLowThreshold: 0,
        addEventListener(t, fn) {
          const set = listeners.get(t) ?? new Set();
          set.add(fn);
          listeners.set(t, set);
        },
        removeEventListener(t, fn) {
          listeners.get(t)?.delete(fn);
        },
        send(frame) {
          if (connected) {
            targetCoordGetter().handleBinaryFrame(frame);
          }
        },
      };
    };

    let coordA;
    let coordB;
    let chanA = makeChannel(() => coordB);
    let chanB = makeChannel(() => coordA);

    const relayedMessages = [];
    const relayControl = (targetGetter, senderId) => async (msg) => {
      relayedMessages.push(msg);
      if (!connected) {
        throw new Error('Disconnected');
      }
      await new Promise((resolve) => setTimeout(resolve, 1));
      if (!connected) {
        return;
      }
      await targetGetter().handleControlMessage(msg, senderId);
    };

    coordA = createTransferCoordinator({
      roomId: ROOM_ID,
      masterKeyBytes,
      localMemberId: memberA,
      getRemoteMemberId: () => (connected ? memberB : null),
      localBoard: localBoardA,
      remoteBoard: remoteBoardA,
      getBinaryChannel: () => chanA,
      sendControlMessage: relayControl(() => coordB, memberA),
      windowObj: { isSecureContext: true },
      navigatorObj: {},
    });
    coordB = createTransferCoordinator({
      roomId: ROOM_ID,
      masterKeyBytes,
      localMemberId: memberB,
      getRemoteMemberId: () => (connected ? memberA : null),
      localBoard: localBoardB,
      remoteBoard: remoteBoardB,
      getBinaryChannel: () => chanB,
      sendControlMessage: relayControl(() => coordA, memberB),
      windowObj: windowB,
      navigatorObj: {},
    });

    await remoteBoardB.handleControlMessage(await localBoardA.getBoardSyncMessage());
    coordB.refreshRemoteCapabilities(remoteBoardB.getEntries());

    const dlRes = await coordB.requestDownload(bigFileId);
    expect(dlRes.ok).toBe(true);
    const tid = dlRes.transferId;

    // Wait for at least 3 chunks persisted in epoch 1, then drop connection
    await vi.waitFor(() => {
      expect(coordB.getTransfer(tid)?.bytesTransferred).toBeGreaterThanOrEqual(
        CHUNK_SIZE_BYTES * 3,
      );
    });

    connected = false;
    chanA.readyState = 'closed';
    chanB.readyState = 'closed';
    remoteBoardB.handlePeerDisconnected();
    coordA.handlePeerDisconnected();
    coordB.handlePeerDisconnected();

    expect(remoteBoardB.getEntry(bigFileId)?.availability).toBe(
      'unavailable_reconnecting',
    );
    expect(coordA.getTransfer(tid)?.state).toBe('paused_reconnecting');
    expect(coordB.getTransfer(tid)?.state).toBe('paused_reconnecting');

    // Mutate owner board while disconnected: remove tempFile, add replacementFile
    await localBoardA.removeFile(tempFileId);
    const addedLater = await localBoardA.addFiles([
      createMutableMockFile({
        name: 'added-offline.txt',
        bytes: new TextEncoder().encode('fresh'),
      }),
    ]);
    const laterFileId = addedLater.advertised[0].fileId;

    // Reconnect cycle 1 (epoch 1 -> 2) with brand new replacement binary channels
    connected = true;
    chanA = makeChannel(() => coordB);
    chanB = makeChannel(() => coordA);

    await remoteBoardB.handleControlMessage(await localBoardA.getBoardSyncMessage());
    expect(remoteBoardB.getEntry(tempFileId)).toBeNull();
    expect(remoteBoardB.getEntry(laterFileId)?.fileName).toBe('added-offline.txt');
    expect(remoteBoardB.getEntry(bigFileId)?.availability).toBe('available');

    await coordA.handlePeerReconnected();
    await coordB.handlePeerReconnected();

    await vi.waitFor(
      () => {
        expect(coordB.getTransfer(tid)?.epoch).toBe(2);
        expect(coordA.getTransfer(tid)?.epoch).toBe(2);
        expect(coordB.getTransfer(tid)?.bytesTransferred).toBeGreaterThanOrEqual(
          CHUNK_SIZE_BYTES * 6,
        );
      },
      { timeout: 5000 },
    );

    // Inject leftover epoch-1 frame -> safely dropped without failing transfer!
    const leftoverEpoch1Frame = await encryptBinaryChunkFrame({
      masterKeyBytes,
      roomId: ROOM_ID,
      transferId: tid,
      fileId: bigFileId,
      direction: `${memberA}->${memberB}`,
      epoch: 1,
      chunkIndex: 0,
      plaintext: createDeterministicBytes(CHUNK_SIZE_BYTES),
      isFinalChunk: false,
    });
    expect(coordB.handleBinaryFrame(leftoverEpoch1Frame)).toEqual({
      ok: true,
      ignored: true,
    });

    // Inject stale RESUME_REQUEST (nextEpoch = 2 <= active epoch 2) -> rejected with INVALID_EPOCH without disrupting active transfer!
    await coordA.handleControlMessage(
      {
        type: 'RESUME_REQUEST',
        payload: {
          transferId: tid,
          fileId: bigFileId,
          direction: `${memberA}->${memberB}`,
          nextEpoch: 2,
          lastPersistedChunkIndex: 2,
          persistedPlaintextBytes: CHUNK_SIZE_BYTES * 3,
        },
      },
      memberB,
    );
    await vi.waitFor(() => {
      expect(
        relayedMessages.some(
          (m) =>
            m.type === 'RESUME_REJECTED' &&
            m.payload.transferId === tid &&
            m.payload.reason === 'INVALID_EPOCH',
        ),
      ).toBe(true);
    });
    expect(coordA.getTransfer(tid)?.epoch).toBe(2);

    // Disconnect cycle 2 (epoch 2 -> 3)
    connected = false;
    chanA.readyState = 'closed';
    chanB.readyState = 'closed';
    remoteBoardB.handlePeerDisconnected();
    coordA.handlePeerDisconnected();
    coordB.handlePeerDisconnected();

    expect(coordB.getTransfer(tid)?.state).toBe('paused_reconnecting');

    connected = true;
    chanA = makeChannel(() => coordB);
    chanB = makeChannel(() => coordA);
    await remoteBoardB.handleControlMessage(await localBoardA.getBoardSyncMessage());
    await coordA.handlePeerReconnected();
    await coordB.handlePeerReconnected();

    await vi.waitFor(
      () => {
        expect(coordB.getTransfer(tid)?.state).toBe('completed');
        expect(coordA.getTransfer(tid)?.state).toBe('completed');
      },
      { timeout: 5000 },
    );

    expect(coordB.getTransfer(tid)?.epoch).toBe(3);
    expect(writeTarget.closed).toBe(true);

    const totalPersisted = persistedChunks.reduce((s, c) => s + c.byteLength, 0);
    const merged = new Uint8Array(totalPersisted);
    let pos = 0;
    for (const c of persistedChunks) {
      merged.set(c, pos);
      pos += c.byteLength;
    }
    expect(merged.byteLength).toBe(payloadBytes.byteLength);
    expect(Buffer.compare(merged, payloadBytes)).toBe(0);

    coordA.dispose();
    coordB.dispose();
    localBoardA.dispose();
    localBoardB.dispose();
    remoteBoardA.dispose();
    remoteBoardB.dispose();
  });

  it('rejects resume when owner file changed (FILE_CHANGED) and fails closed on duplicate chunk in current epoch', async () => {
    const { masterKeyBytes } = generateMasterKey();
    const memberA = generateMemberId();
    const memberB = generateMemberId();
    const localBoardA = createLocalFileBoard({ roomId: ROOM_ID, masterKeyBytes });
    const remoteBoardB = createRemoteFileBoard({ roomId: ROOM_ID, masterKeyBytes });

    const bytes = createDeterministicBytes(CHUNK_SIZE_BYTES * 12, 31);
    const mutableFile = createMutableMockFile({ name: 'mutated.bin', bytes });
    const added = await localBoardA.addFiles([mutableFile]);
    const fileId = added.advertised[0].fileId;
    await remoteBoardB.handleControlMessage(added.messages[0]);

    const targets = [];
    const windowB = {
      isSecureContext: true,
      showSaveFilePicker: vi.fn(async () => ({
        async createWritable() {
          const target = {
            aborted: false,
            async write() {
              await new Promise((r) => setTimeout(r, 15));
            },
            async close() {},
            async abort() {
              this.aborted = true;
            },
          };
          targets.push(target);
          return target;
        },
      })),
    };

    let online = true;
    let coordA;
    let coordB;
    const channelA = {
      readyState: 'open',
      bufferedAmount: 0,
      bufferedAmountLowThreshold: 0,
      addEventListener() {},
      removeEventListener() {},
      send(frame) {
        if (online) {
          coordB.handleBinaryFrame(frame);
        }
      },
    };
    const channelB = {
      readyState: 'open',
      bufferedAmount: 0,
      bufferedAmountLowThreshold: 0,
      addEventListener() {},
      removeEventListener() {},
      send(frame) {
        if (online) {
          coordA.handleBinaryFrame(frame);
        }
      },
    };

    coordA = createTransferCoordinator({
      roomId: ROOM_ID,
      masterKeyBytes,
      localMemberId: memberA,
      getRemoteMemberId: () => (online ? memberB : null),
      localBoard: localBoardA,
      remoteBoard: createRemoteFileBoard({ roomId: ROOM_ID, masterKeyBytes }),
      getBinaryChannel: () => channelA,
      sendControlMessage: async (m) => {
        if (online) {
          await new Promise((r) => setTimeout(r, 1));
          await coordB.handleControlMessage(m, memberA);
        }
      },
      windowObj: { isSecureContext: true },
      navigatorObj: {},
    });
    coordB = createTransferCoordinator({
      roomId: ROOM_ID,
      masterKeyBytes,
      localMemberId: memberB,
      getRemoteMemberId: () => (online ? memberA : null),
      localBoard: createLocalFileBoard({ roomId: ROOM_ID, masterKeyBytes }),
      remoteBoard: remoteBoardB,
      getBinaryChannel: () => channelB,
      sendControlMessage: async (m) => {
        if (online) {
          await new Promise((r) => setTimeout(r, 1));
          await coordA.handleControlMessage(m, memberB);
        }
      },
      windowObj: windowB,
      navigatorObj: {},
    });

    const dl1 = await coordB.requestDownload(fileId);
    await vi.waitFor(() => {
      expect(coordB.getTransfer(dl1.transferId)?.bytesTransferred).toBeGreaterThanOrEqual(
        CHUNK_SIZE_BYTES,
      );
    });

    // Inject duplicate chunk 0 in active epoch 1 -> fail closed
    const dupFrame = await encryptBinaryChunkFrame({
      masterKeyBytes,
      roomId: ROOM_ID,
      transferId: dl1.transferId,
      fileId,
      direction: `${memberA}->${memberB}`,
      epoch: 1,
      chunkIndex: 0,
      plaintext: createDeterministicBytes(CHUNK_SIZE_BYTES),
      isFinalChunk: false,
    });
    const dupRes = coordB.handleBinaryFrame(dupFrame);
    expect(dupRes).toMatchObject({ ok: false, code: 'INVALID_FRAME' });
    await vi.waitFor(() => {
      expect(coordB.getTransfer(dl1.transferId)?.state).toBe('failed');
    });

    // Second transfer: disconnect, mutate owner file size -> FILE_CHANGED rejects resume
    const file2 = createMutableMockFile({
      name: 'will-change.bin',
      bytes: createDeterministicBytes(CHUNK_SIZE_BYTES * 8, 71),
    });
    const added2 = await localBoardA.addFiles([file2]);
    const file2Id = added2.advertised[0].fileId;
    await remoteBoardB.handleControlMessage(added2.messages[0]);

    const dl2 = await coordB.requestDownload(file2Id);
    await vi.waitFor(() => {
      expect(coordB.getTransfer(dl2.transferId)?.bytesTransferred).toBeGreaterThanOrEqual(
        CHUNK_SIZE_BYTES,
      );
    });

    online = false;
    coordA.handlePeerDisconnected();
    coordB.handlePeerDisconnected();
    file2.mutateSize(10);

    online = true;
    await coordB.handlePeerReconnected();

    await vi.waitFor(() => {
      expect(coordB.getTransfer(dl2.transferId)?.state).toBe('failed');
      expect(coordA.getTransfer(dl2.transferId)?.state).toBe('failed');
    });
    expect(coordB.getTransfer(dl2.transferId)?.errorCode).toBe('FILE_CHANGED');
    expect(targets[1].aborted).toBe(true);

    coordA.dispose();
    coordB.dispose();
    localBoardA.dispose();
    remoteBoardB.dispose();
  });

  it('preserves boards and resumes paused transfers across transient signaling disconnect and reconnect', async () => {
    const ioFactory = createReconnectSignalingHarness();
    const clientA = createSignalingClient({ url: 'https://shipri.app', ioFactory });
    const clientB = createSignalingClient({ url: 'https://shipri.app', ioFactory });
    const pcFactoryA = createMockPeerConnectionFactory();
    const pcFactoryB = createMockPeerConnectionFactory();
    const storageA = createMemoryStorage();
    const storageB = createMemoryStorage();
    const locA = { origin: 'https://shipri.app', pathname: '/', search: '', hash: '' };
    const locB = { origin: 'https://shipri.app', pathname: '/', search: '', hash: '' };

    const persistedChunks = [];
    const writeTarget = {
      closed: false,
      aborted: false,
      async write(chunk) {
        await new Promise((r) => setTimeout(r, 15));
        persistedChunks.push(new Uint8Array(chunk));
      },
      async close() {
        this.closed = true;
      },
      async abort() {
        this.aborted = true;
      },
    };

    const controllerA = createRoomBoardController({
      signalingClient: clientA,
      peerConnectionFactory: pcFactoryA,
      storage: storageA,
      locationObj: locA,
      historyObj: { replaceState: () => {} },
      windowObj: { isSecureContext: true },
      navigatorObj: {},
      origin: 'https://shipri.app',
      autoConnect: true,
    });
    const controllerB = createRoomBoardController({
      signalingClient: clientB,
      peerConnectionFactory: pcFactoryB,
      storage: storageB,
      locationObj: locB,
      historyObj: { replaceState: () => { locB.hash = ''; } },
      windowObj: {
        isSecureContext: true,
        showSaveFilePicker: vi.fn(async () => ({
          async createWritable() {
            return writeTarget;
          },
        })),
      },
      navigatorObj: {},
      origin: 'https://shipri.app',
      autoConnect: false,
    });

    await controllerA.createRoom();
    await flushMicrotasks();
    const copied = [];
    await controllerA.copyShareLink({ writeText: async (u) => copied.push(u) });
    clientB.connect();
    await controllerB.joinRoom(copied[0]);
    await flushMicrotasks();

    const pmA = controllerA.getConnection().getPeerManager();
    const pmB = controllerB.getConnection().getPeerManager();
    const bindChannels = async (prevPcA = null, prevPcB = null) => {
      await vi.waitFor(() => {
        const curA = pmA.getPeerConnection();
        const curB = pmB.getPeerConnection();
        expect(curA).not.toBeNull();
        expect(curB).not.toBeNull();
        expect(curA).not.toBe(prevPcA);
        expect(curB).not.toBe(prevPcB);
      });
      const curPcA = pmA.getPeerConnection();
      const curPcB = pmB.getPeerConnection();
      const ctrlA = pmA.getChannel(PRODUCTION_CONTROL_CHANNEL_LABEL);
      const binA = pmA.getChannel(PRODUCTION_BINARY_CHANNEL_LABEL);
      const ctrlB = curPcB.simulateRemoteDataChannel(PRODUCTION_CONTROL_CHANNEL_LABEL);
      const binB = curPcB.simulateRemoteDataChannel(PRODUCTION_BINARY_CHANNEL_LABEL);
      linkReliableChannels(ctrlA, ctrlB).openBoth();
      linkReliableChannels(binA, binB).openBoth();
      return { curPcA, curPcB };
    };

    const firstPair = await bindChannels();
    await vi.waitFor(() => {
      expect(controllerA.getState().peerReady).toBe(true);
      expect(controllerB.getState().peerReady).toBe(true);
    });

    const roomId = controllerB.getState().roomId;
    const payload = createDeterministicBytes(CHUNK_SIZE_BYTES * 12 + 321, 59);
    await controllerA.addLocalFiles([
      createMutableMockFile({ name: 'sig-resume.bin', bytes: payload }),
    ]);

    await vi.waitFor(() => {
      expect(controllerB.getState().remoteFiles).toHaveLength(1);
    });

    const remoteFileId = controllerB.getState().remoteFiles[0].fileId;
    const dlRes = await controllerB.downloadRemoteFile(remoteFileId);
    expect(dlRes.ok).toBe(true);
    const tid = dlRes.transferId;

    await vi.waitFor(() => {
      expect(
        controllerB.getState().transfers[0]?.bytesTransferred,
      ).toBeGreaterThanOrEqual(CHUNK_SIZE_BYTES * 3);
    });

    // Drop signaling socket unexpectedly -> controller must keep roomId, board, and paused_reconnecting state
    const socketB = ioFactory.sockets[1];
    ioFactory.simulateUnexpectedDrop(socketB);
    await flushMicrotasks();

    expect(controllerB.getState().roomId).toBe(roomId);
    expect(controllerB.getState().remoteFiles).toHaveLength(1);
    expect(controllerB.getState().transfers[0]?.state).toBe('paused_reconnecting');
    expect(controllerA.getState().transfers[0]?.state).toBe('paused_reconnecting');

    // Bring signaling back online -> controller automatically rejoins and resumes transfer across epoch 2
    socketB.simulateConnect();
    await bindChannels(firstPair.curPcA, firstPair.curPcB);

    await vi.waitFor(
      () => {
        const bTransfer = controllerB.getState().transfers.find((t) => t.transferId === tid);
        const aTransfer = controllerA.getState().transfers.find((t) => t.transferId === tid);
        expect(bTransfer?.state).toBe('completed');
        expect(aTransfer?.state).toBe('completed');
        expect(bTransfer?.epoch).toBe(2);
      },
      { timeout: 5000 },
    );

    expect(writeTarget.closed).toBe(true);
    const totalLen = persistedChunks.reduce((sum, c) => sum + c.byteLength, 0);
    const merged = new Uint8Array(totalLen);
    let pos = 0;
    for (const c of persistedChunks) {
      merged.set(c, pos);
      pos += c.byteLength;
    }
    expect(Buffer.compare(merged, payload)).toBe(0);

    controllerA.dispose();
    controllerB.dispose();
  });
});
