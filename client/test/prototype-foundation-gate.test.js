import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, test, vi } from 'vitest';
import App from '../src/App.jsx';
import {
  DIAGNOSTIC_CHANNEL_LABEL,
  createDiagnosticChannelController,
} from '../src/prototype/diagnostic-channel.js';
import {
  applyDiagnosticChannelState,
  applyIceCredentials,
  applyWebRtcState,
  bindSignalingClient,
  createInitialPrototypeState,
  createRoomLifecycleActions,
  recoverErrorState,
  shouldClearDraftRoomInput,
} from '../src/prototype/diagnostic-state.js';
import {
  POC_ROOM_ERROR_DESCRIPTORS,
  resolveRoomErrorDescriptor,
  runValidationScenario,
} from '../src/prototype/room-errors.js';
import {
  ICE_GATHERING_STALL_TIMEOUT_MS,
  createWebRtcHarness,
} from '../src/prototype/webrtc-harness.js';
import { createSignalingClient } from '../src/signaling/socket-client.js';
import { createMockSocketFactory } from './helpers/mock-socket.js';
import { createMockPeerConnectionFactory } from './helpers/mock-webrtc.js';

const CANONICAL_ROOM_ID_PATTERN = /^ship-[a-f0-9]{4}$/;
const DEFAULT_STUN_ICE_SERVERS = [
  {
    urls: [
      'stun:stun.l.google.com:19302',
      'stun:stun1.l.google.com:19302',
    ],
  },
];

async function flushMicrotasks(rounds = 32) {
  for (let i = 0; i < rounds; i += 1) {
    await Promise.resolve();
  }
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function createReactStateHarness(initialOverrides = {}) {
  let state = createInitialPrototypeState(initialOverrides);
  const setState = (updater) => {
    state = typeof updater === 'function' ? updater(state) : updater;
  };
  return {
    getState: () => state,
    setState,
  };
}

function linkMockDataChannels(channelA, channelB) {
  const originalSendA = channelA.send.bind(channelA);
  const originalSendB = channelB.send.bind(channelB);

  channelA.send = (data) => {
    originalSendA(data);
    if (channelB.readyState === 'open') {
      channelB.simulateMessage(data);
    }
  };

  channelB.send = (data) => {
    originalSendB(data);
    if (channelA.readyState === 'open') {
      channelA.simulateMessage(data);
    }
  };
}

/**
 * Simulates the frozen Backend POC Socket.IO server rules and precedence
 * purely inside client tests without importing server/ modules.
 */
function createPocRelaySocketFactory({ iceAvailable = true } = {}) {
  const baseFactory = createMockSocketFactory({ idPrefix: 'fp-g1-socket' });
  const rooms = new Map();
  const socketToRoom = new Map();
  let roomSequence = 0;
  let peerSequence = 0;
  let iceEnabled = iceAvailable;

  function emitRoomError(socket, code, message, roomId) {
    queueMicrotask(() => {
      socket.simulateServerEvent('room:error', {
        ...(roomId !== undefined ? { roomId } : {}),
        code,
        message,
      });
    });
  }

  function removeSocketFromRoom(socket, reason) {
    const roomId = socketToRoom.get(socket);
    if (!roomId) {
      return;
    }
    socketToRoom.delete(socket);
    const room = rooms.get(roomId);
    if (!room) {
      return;
    }
    const departedMember = room.members.find((entry) => entry.socket === socket);
    room.members = room.members.filter((entry) => entry.socket !== socket);
    if (room.members.length === 0) {
      rooms.delete(roomId);
      return;
    }
    const remaining = room.members[0];
    queueMicrotask(() => {
      remaining.socket.simulateServerEvent('peer:left', {
        roomId,
        peerId: departedMember?.peerId ?? socket.id,
        reason,
      });
    });
  }

  function pocRelayIoFactory(url, options) {
    const socket = baseFactory(url, options);
    const originalEmit = socket.emit.bind(socket);
    const originalSimulateDisconnect = socket.simulateDisconnect.bind(socket);

    socket.simulateDisconnect = (reason = 'transport close') => {
      removeSocketFromRoom(socket, 'disconnect');
      originalSimulateDisconnect(reason);
    };

    socket.emit = (event, ...args) => {
      originalEmit(event, ...args);
      const payload = args[0];

      if (event === 'room:create') {
        if (!isPlainObject(payload) || Object.keys(payload).length > 0) {
          emitRoomError(
            socket,
            'INVALID_PAYLOAD',
            'room:create payload must be an empty plain object.',
          );
          return socket;
        }
        if (socketToRoom.has(socket)) {
          emitRoomError(
            socket,
            'UNAUTHORIZED',
            'Socket already belongs to an active room.',
          );
          return socket;
        }
        roomSequence += 1;
        peerSequence += 1;
        const roomId = `ship-${(0xa100 + roomSequence).toString(16).padStart(4, '0')}`;
        const peerId = `peer-${peerSequence}`;
        rooms.set(roomId, {
          roomId,
          members: [{ socket, peerId }],
        });
        socketToRoom.set(socket, roomId);
        queueMicrotask(() => {
          socket.simulateServerEvent('room:created', {
            roomId,
            peerId,
            negotiationDuty: 'offerer',
          });
        });
        return socket;
      }

      if (event === 'room:join') {
        if (
          !isPlainObject(payload) ||
          Object.keys(payload).some((key) => key !== 'roomId')
        ) {
          emitRoomError(
            socket,
            'INVALID_PAYLOAD',
            'room:join payload must contain only roomId.',
          );
          return socket;
        }
        const roomId = payload.roomId;
        if (typeof roomId !== 'string' || !CANONICAL_ROOM_ID_PATTERN.test(roomId)) {
          emitRoomError(
            socket,
            'INVALID_ROOM_ID',
            'roomId must match ship-[a-f0-9]{4}.',
          );
          return socket;
        }
        const room = rooms.get(roomId);
        if (!room) {
          emitRoomError(
            socket,
            'ROOM_NOT_FOUND',
            'Room does not exist or has expired.',
            roomId,
          );
          return socket;
        }
        if (socketToRoom.has(socket)) {
          emitRoomError(
            socket,
            'UNAUTHORIZED',
            'Socket already belongs to an active room.',
            roomId,
          );
          return socket;
        }
        if (room.members.length >= 2) {
          emitRoomError(
            socket,
            'ROOM_FULL',
            'This room is already occupied.',
            roomId,
          );
          return socket;
        }

        peerSequence += 1;
        const peerId = `peer-${peerSequence}`;
        const existingMember = room.members[0];
        room.members.push({ socket, peerId });
        socketToRoom.set(socket, roomId);
        queueMicrotask(() => {
          socket.simulateServerEvent('room:joined', {
            roomId,
            peerId,
            negotiationDuty: 'answerer',
          });
          existingMember.socket.simulateServerEvent('peer:joined', {
            roomId,
            peerId,
          });
        });
        return socket;
      }

      if (event === 'room:leave') {
        if (
          !isPlainObject(payload) ||
          Object.keys(payload).some((key) => key !== 'roomId')
        ) {
          emitRoomError(
            socket,
            'INVALID_PAYLOAD',
            'room:leave payload must contain only roomId.',
          );
          return socket;
        }
        const roomId = payload.roomId;
        if (typeof roomId !== 'string' || !CANONICAL_ROOM_ID_PATTERN.test(roomId)) {
          emitRoomError(
            socket,
            'INVALID_ROOM_ID',
            'roomId must match ship-[a-f0-9]{4}.',
          );
          return socket;
        }
        const room = rooms.get(roomId);
        if (!room) {
          emitRoomError(
            socket,
            'ROOM_NOT_FOUND',
            'Room does not exist or has expired.',
            roomId,
          );
          return socket;
        }
        if (socketToRoom.get(socket) !== roomId) {
          emitRoomError(
            socket,
            'UNAUTHORIZED',
            'Socket is not a member of this room.',
            roomId,
          );
          return socket;
        }
        removeSocketFromRoom(socket, 'leave');
        return socket;
      }

      if (event === 'ice:get') {
        if (
          !isPlainObject(payload) ||
          Object.keys(payload).some((key) => key !== 'roomId')
        ) {
          emitRoomError(
            socket,
            'INVALID_PAYLOAD',
            'ice:get payload must contain only roomId.',
          );
          return socket;
        }
        const roomId = payload.roomId;
        if (typeof roomId !== 'string' || !CANONICAL_ROOM_ID_PATTERN.test(roomId)) {
          emitRoomError(
            socket,
            'INVALID_ROOM_ID',
            'roomId must match ship-[a-f0-9]{4}.',
          );
          return socket;
        }
        const room = rooms.get(roomId);
        if (!room) {
          emitRoomError(
            socket,
            'ROOM_NOT_FOUND',
            'Room does not exist or has expired.',
            roomId,
          );
          return socket;
        }
        if (socketToRoom.get(socket) !== roomId) {
          emitRoomError(
            socket,
            'UNAUTHORIZED',
            'Socket is not a member of this room.',
            roomId,
          );
          return socket;
        }
        if (!iceEnabled) {
          emitRoomError(
            socket,
            'SERVER_BUSY',
            'Development ICE configuration is unavailable.',
            roomId,
          );
          return socket;
        }
        queueMicrotask(() => {
          socket.simulateServerEvent('ice:credentials', {
            roomId,
            iceServers: DEFAULT_STUN_ICE_SERVERS,
          });
        });
        return socket;
      }

      if (event === 'signal:forward') {
        if (
          !isPlainObject(payload) ||
          Object.keys(payload).some(
            (key) => key !== 'roomId' && key !== 'signalData',
          ) ||
          !isPlainObject(payload.signalData)
        ) {
          emitRoomError(
            socket,
            'INVALID_PAYLOAD',
            'signal:forward payload requires roomId and object signalData.',
          );
          return socket;
        }
        const roomId = payload.roomId;
        if (typeof roomId !== 'string' || !CANONICAL_ROOM_ID_PATTERN.test(roomId)) {
          emitRoomError(
            socket,
            'INVALID_ROOM_ID',
            'roomId must match ship-[a-f0-9]{4}.',
          );
          return socket;
        }
        const room = rooms.get(roomId);
        if (!room) {
          emitRoomError(
            socket,
            'ROOM_NOT_FOUND',
            'Room does not exist or has expired.',
            roomId,
          );
          return socket;
        }
        if (socketToRoom.get(socket) !== roomId) {
          emitRoomError(
            socket,
            'UNAUTHORIZED',
            'Socket is not a member of this room.',
            roomId,
          );
          return socket;
        }
        const sender = room.members.find((entry) => entry.socket === socket);
        const remote = room.members.find((entry) => entry.socket !== socket);
        if (!remote) {
          emitRoomError(
            socket,
            'PEER_UNAVAILABLE',
            'No second peer is connected to this room.',
            roomId,
          );
          return socket;
        }
        queueMicrotask(() => {
          remote.socket.simulateServerEvent('signal:receive', {
            roomId,
            peerId: sender.peerId,
            signalData: payload.signalData,
          });
        });
        return socket;
      }

      return socket;
    };

    return socket;
  }

  pocRelayIoFactory.calls = baseFactory.calls;
  Object.defineProperty(pocRelayIoFactory, 'lastSocket', {
    enumerable: true,
    get() {
      return baseFactory.lastSocket;
    },
  });
  pocRelayIoFactory.getActiveRoomCount = () => rooms.size;
  pocRelayIoFactory.getRoomMemberCount = (roomId) =>
    rooms.get(roomId)?.members.length ?? 0;
  pocRelayIoFactory.setIceAvailable = (next) => {
    iceEnabled = Boolean(next);
  };

  return pocRelayIoFactory;
}

function createPrototypePeer({
  ioFactory,
  pcBehavior = {},
  harnessOptions = {},
  initialClockMs = 1_700_200_000_000,
  nowIso,
} = {}) {
  let clockMs = initialClockMs;
  const react = createReactStateHarness();
  const client = createSignalingClient({
    url: 'http://localhost:5001',
    ioFactory,
    now: nowIso,
  });
  const unbind = bindSignalingClient(client, react.setState);
  const actions = createRoomLifecycleActions(client, react.setState);
  const controller = createDiagnosticChannelController({
    signalingClient: client,
    now: () => clockMs,
    onStateChange: (nextChannel) => {
      react.setState((prev) => applyDiagnosticChannelState(prev, nextChannel));
    },
  });
  const pcFactory = createMockPeerConnectionFactory(pcBehavior);
  const harness = createWebRtcHarness({
    signalingClient: client,
    peerConnectionFactory: pcFactory,
    onStateChange: (nextWebRtc) => {
      react.setState((prev) => applyWebRtcState(prev, nextWebRtc));
    },
    onDataChannel: (channel, meta) => controller.attachChannel(channel, meta),
    ...harnessOptions,
  });

  client.connect();
  const socket = ioFactory.lastSocket;

  return {
    client,
    socket,
    react,
    actions,
    controller,
    pcFactory,
    harness,
    advanceClock(ms) {
      clockMs += ms;
    },
    renderMarkup() {
      return renderToStaticMarkup(
        React.createElement(App, {
          signalingClient: client,
          initialState: react.getState(),
        }),
      );
    },
    dispose() {
      unbind();
      harness.dispose();
      controller.dispose();
      client.dispose();
    },
  };
}

function openAndBridgeDataChannels(offererPeer, answererPeer) {
  const pcOfferer = offererPeer.pcFactory.lastInstance;
  const pcAnswerer = answererPeer.pcFactory.lastInstance;
  expect(pcOfferer).not.toBeNull();
  expect(pcAnswerer).not.toBeNull();

  const offererChannel = pcOfferer.createdDataChannels.at(-1);
  expect(offererChannel).toBeDefined();
  expect(offererChannel.label).toBe(DIAGNOSTIC_CHANNEL_LABEL);

  const answererChannel = pcAnswerer.simulateRemoteDataChannel(
    DIAGNOSTIC_CHANNEL_LABEL,
    { ordered: true },
  );
  linkMockDataChannels(offererChannel, answererChannel);
  offererChannel.simulateOpen();
  answererChannel.simulateOpen();
  pcOfferer.simulateIceConnectionStateChange('connected');
  pcOfferer.simulateConnectionStateChange('connected');
  pcAnswerer.simulateIceConnectionStateChange('connected');
  pcAnswerer.simulateConnectionStateChange('connected');

  const origSendOfferer = offererChannel.send.bind(offererChannel);
  offererChannel.send = (data) => {
    offererPeer.advanceClock(14);
    origSendOfferer(data);
  };
  const origSendAnswerer = answererChannel.send.bind(answererChannel);
  answererChannel.send = (data) => {
    answererPeer.advanceClock(19);
    origSendAnswerer(data);
  };

  return { offererChannel, answererChannel, pcOfferer, pcAnswerer };
}

function assertBidirectionalMessaging(peerOne, peerTwo, tag) {
  const beforePingsOne = peerOne.react.getState().diagnosticChannel.pingsSent;
  const beforePingsTwo = peerTwo.react.getState().diagnosticChannel.pingsSent;

  expect(peerOne.controller.sendPing().ok).toBe(true);
  expect(peerOne.react.getState().diagnosticChannel.pingsSent).toBe(
    beforePingsOne + 1,
  );
  expect(peerOne.react.getState().diagnosticChannel.pongsReceived).toBe(
    beforePingsOne + 1,
  );
  expect(peerOne.react.getState().diagnosticChannel.lastRttMs).toBeGreaterThan(0);

  expect(peerTwo.controller.sendPing().ok).toBe(true);
  expect(peerTwo.react.getState().diagnosticChannel.pingsSent).toBe(
    beforePingsTwo + 1,
  );
  expect(peerTwo.react.getState().diagnosticChannel.pongsReceived).toBe(
    beforePingsTwo + 1,
  );
  expect(peerTwo.react.getState().diagnosticChannel.lastRttMs).toBeGreaterThan(0);

  const msgFromOne = `${tag}: one to two`;
  const msgFromTwo = `${tag}: two to one`;
  expect(peerOne.controller.sendText(msgFromOne).ok).toBe(true);
  expect(peerTwo.controller.sendText(msgFromTwo).ok).toBe(true);

  expect(peerTwo.react.getState().diagnosticChannel.messages).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        direction: 'inbound',
        type: 'text',
        body: msgFromOne,
      }),
    ]),
  );
  expect(peerOne.react.getState().diagnosticChannel.messages).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        direction: 'inbound',
        type: 'text',
        body: msgFromTwo,
      }),
    ]),
  );
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('FP-G1 Prototype Foundation Acceptance Gate', () => {
  test('validates room create, second-peer join, ROOM_FULL, either-peer leave/disconnect with offerer promotion, replacement join, and stale peerId/generation filtering', async () => {
    const ioFactory = createPocRelaySocketFactory();
    let tick = 0;
    const nowIso = () =>
      `2026-11-23T17:00:${String(tick++).padStart(2, '0')}.000Z`;

    const peerA = createPrototypePeer({ ioFactory, nowIso });
    const peerB = createPrototypePeer({ ioFactory, nowIso });
    const peerC = createPrototypePeer({ ioFactory, nowIso });
    const peerD = createPrototypePeer({ ioFactory, nowIso });

    // 1. Create room (Peer A) -> canonical ship-[a-f0-9]{4}
    peerA.actions.createRoom();
    await flushMicrotasks();

    const roomId = peerA.react.getState().roomId;
    expect(roomId).toMatch(CANONICAL_ROOM_ID_PATTERN);
    expect(peerA.react.getState()).toMatchObject({
      connectionStatus: 'connected',
      peerState: 'waiting_for_peer',
      entryRole: 'creator',
      negotiationDuty: 'offerer',
    });

    // 2. Join second peer (Peer B)
    peerB.actions.joinRoom(roomId);
    await flushMicrotasks();

    const peerAId = peerA.react.getState().selfPeerId;
    const peerBId = peerB.react.getState().selfPeerId;
    expect(peerA.react.getState()).toMatchObject({
      roomId,
      peerState: 'connected',
      entryRole: 'creator',
      negotiationDuty: 'offerer',
      remotePeerId: peerBId,
      webrtc: {
        generation: 1,
        remoteGeneration: 1,
        localDescriptionForwarded: true,
      },
    });
    expect(peerB.react.getState()).toMatchObject({
      roomId,
      peerState: 'connected',
      entryRole: 'joiner',
      negotiationDuty: 'answerer',
      webrtc: {
        generation: 1,
        remoteGeneration: 1,
        localDescriptionForwarded: true,
      },
    });

    // 3. Reject third peer (Peer C) with ROOM_FULL without disrupting Peer A or B
    peerC.actions.joinRoom(roomId);
    await flushMicrotasks();

    expect(peerC.react.getState()).toMatchObject({
      roomId: null,
      peerState: 'unaffiliated',
      negotiationDuty: null,
      lastError: {
        code: 'ROOM_FULL',
        roomId,
      },
    });
    expect(ioFactory.getRoomMemberCount(roomId)).toBe(2);

    // 4. Open Gen 1 DataChannel and verify bidirectional messages
    openAndBridgeDataChannels(peerA, peerB);
    assertBidirectionalMessaging(peerA, peerB, 'gen1');

    // 5. Creator (Peer A) explicitly leaves -> joiner Peer B stays in room and promotes to offerer
    peerA.actions.leaveRoom(roomId);
    await flushMicrotasks();

    expect(peerA.react.getState()).toMatchObject({
      roomId: null,
      peerState: 'unaffiliated',
      entryRole: null,
      negotiationDuty: null,
      webrtc: { status: 'idle', dataChannelState: 'none' },
      diagnosticChannel: { channelState: 'none' },
    });
    expect(peerB.react.getState()).toMatchObject({
      roomId,
      peerState: 'waiting_for_peer',
      entryRole: 'joiner',
      negotiationDuty: 'offerer',
      remotePeerId: null,
      webrtc: {
        status: 'closed',
        generation: 2,
        remoteGeneration: null,
        dataChannelState: 'closed',
      },
      diagnosticChannel: {
        channelState: 'closed',
        pendingPingCount: 0,
      },
    });

    // Stale signal from retired Peer A must be ignored
    const staleCountBeforeRetired = peerB.react.getState().webrtc.staleEventsIgnored;
    peerB.socket.simulateServerEvent('signal:receive', {
      roomId,
      peerId: peerAId,
      signalData: { type: 'answer', sdp: 'v=0\r\ns=-\r\n', generation: 1 },
    });
    expect(peerB.react.getState().webrtc.staleEventsIgnored).toBe(
      staleCountBeforeRetired + 1,
    );

    // 6. Replacement Peer C joins -> promoted Peer B negotiates fresh generation (gen 3)
    peerC.actions.joinRoom(roomId);
    await flushMicrotasks();

    const peerCId = peerC.react.getState().selfPeerId;
    expect(peerB.react.getState()).toMatchObject({
      roomId,
      peerState: 'connected',
      entryRole: 'joiner',
      negotiationDuty: 'offerer',
      remotePeerId: peerCId,
      webrtc: {
        generation: 3,
        remoteGeneration: 3,
        activePeerId: peerCId,
        localDescriptionForwarded: true,
      },
    });
    expect(peerC.react.getState()).toMatchObject({
      roomId,
      peerState: 'connected',
      entryRole: 'joiner',
      negotiationDuty: 'answerer',
      webrtc: {
        generation: 1,
        remoteGeneration: 3,
        activePeerId: peerBId,
        localDescriptionForwarded: true,
      },
    });

    // Stale generation signal from active Peer C and retired Peer A must both be filtered
    const staleBeforeGenMismatch = peerB.react.getState().webrtc.staleEventsIgnored;
    peerB.socket.simulateServerEvent('signal:receive', {
      roomId,
      peerId: peerCId,
      signalData: {
        candidate: { candidate: 'candidate:stale', sdpMid: '0', sdpMLineIndex: 0 },
        generation: 1,
      },
    });
    peerB.socket.simulateServerEvent('signal:receive', {
      roomId,
      peerId: peerAId,
      signalData: {
        candidate: { candidate: 'candidate:retired', sdpMid: '0', sdpMLineIndex: 0 },
        generation: 3,
      },
    });
    expect(peerB.react.getState().webrtc.staleEventsIgnored).toBe(
      staleBeforeGenMismatch + 2,
    );

    openAndBridgeDataChannels(peerB, peerC);
    assertBidirectionalMessaging(peerB, peerC, 'gen3-promoted');

    // 7. Joiner (Peer C) disconnects unexpectedly -> Peer B stays as offerer and shows disconnect notice
    peerC.socket.simulateDisconnect('transport close');
    await flushMicrotasks();

    expect(peerC.react.getState()).toMatchObject({
      connectionStatus: 'disconnected',
      roomId: null,
      peerState: 'unaffiliated',
      negotiationDuty: null,
    });
    expect(peerC.react.getState().eventLog.length).toBeGreaterThan(0);

    expect(peerB.react.getState()).toMatchObject({
      roomId,
      peerState: 'waiting_for_peer',
      negotiationDuty: 'offerer',
      remotePeerId: null,
      webrtc: {
        status: 'closed',
        generation: 4,
      },
    });
    expect(peerB.renderMarkup()).toContain(`Remote peer disconnected from ${roomId}`);

    // 8. Replacement Peer D joins -> fresh generation (gen 5), then Peer B disconnects so Peer D promotes to offerer
    peerD.actions.joinRoom(roomId);
    await flushMicrotasks();

    expect(peerB.react.getState().webrtc.generation).toBe(5);
    openAndBridgeDataChannels(peerB, peerD);
    assertBidirectionalMessaging(peerB, peerD, 'gen5-after-disconnect');

    peerB.socket.simulateDisconnect('ping timeout');
    await flushMicrotasks();

    expect(peerD.react.getState()).toMatchObject({
      roomId,
      peerState: 'waiting_for_peer',
      entryRole: 'joiner',
      negotiationDuty: 'offerer',
      webrtc: {
        status: 'closed',
        generation: 2,
      },
    });
    expect(peerD.renderMarkup()).toContain(
      'You remain in the room as offerer waiting for a replacement peer.',
    );

    // 9. Replacement peer joins promoted Peer D, exchanges messages, then joiner leaves explicitly
    peerA.actions.joinRoom(roomId);
    await flushMicrotasks();

    expect(peerD.react.getState().webrtc.generation).toBe(3);
    openAndBridgeDataChannels(peerD, peerA);
    assertBidirectionalMessaging(peerD, peerA, 'gen3-rejoined');

    peerA.actions.leaveRoom(roomId);
    await flushMicrotasks();

    expect(peerA.react.getState().peerState).toBe('unaffiliated');
    expect(peerD.react.getState()).toMatchObject({
      roomId,
      peerState: 'waiting_for_peer',
      negotiationDuty: 'offerer',
      webrtc: { status: 'closed', generation: 4 },
      diagnosticChannel: { channelState: 'closed' },
    });

    // Final peer leaves cleanly and deletes room
    peerD.actions.leaveRoom(roomId);
    await flushMicrotasks();

    expect(peerD.react.getState().peerState).toBe('unaffiliated');
    expect(ioFactory.getActiveRoomCount()).toBe(0);

    peerA.dispose();
    peerB.dispose();
    peerC.dispose();
    peerD.dispose();
  });

  test('covers all 7 stable room:error codes, UNKNOWN_ERROR fallback, malformed presets, INVALID_ICE_CREDENTIALS, and selective recovery', async () => {
    const ioFactory = createPocRelaySocketFactory();
    let tick = 0;
    const nowIso = () =>
      `2026-11-23T17:10:${String(tick++).padStart(2, '0')}.000Z`;

    const peerA = createPrototypePeer({ ioFactory, nowIso });
    const peerB = createPrototypePeer({ ioFactory, nowIso });
    const peerC = createPrototypePeer({ ioFactory, nowIso });

    // Confirm all 7 stable codes plus CONNECT_ERROR resolve cleanly by code
    for (const code of [
      'ROOM_NOT_FOUND',
      'ROOM_FULL',
      'INVALID_ROOM_ID',
      'INVALID_PAYLOAD',
      'UNAUTHORIZED',
      'PEER_UNAVAILABLE',
      'SERVER_BUSY',
      'CONNECT_ERROR',
    ]) {
      expect(POC_ROOM_ERROR_DESCRIPTORS[code]).toBeDefined();
      expect(resolveRoomErrorDescriptor({ code, message: 'ignored text' }).code).toBe(
        code,
      );
    }

    // UNKNOWN_ERROR fallback ignores misleading message text
    expect(
      resolveRoomErrorDescriptor({
        code: 'RATE_LIMITED',
        message: 'Room is full ROOM_FULL',
      }),
    ).toMatchObject({
      code: 'UNKNOWN_ERROR',
      category: 'unknown',
      known: false,
      preservesMembership: true,
    });

    // 1. ROOM_NOT_FOUND while unaffiliated clears draft input on selective recovery
    expect(runValidationScenario(peerA.client, 'room-not-found').ok).toBe(true);
    await flushMicrotasks();
    expect(peerA.react.getState().lastError?.code).toBe('ROOM_NOT_FOUND');
    expect(shouldClearDraftRoomInput(peerA.react.getState())).toBe(true);
    let clearedDraft = false;
    peerA.react.setState((prev) =>
      recoverErrorState(prev, {
        onClearDraft: () => {
          clearedDraft = true;
        },
      }),
    );
    expect(clearedDraft).toBe(true);
    expect(peerA.react.getState().lastError).toBeNull();
    expect(peerA.react.getState().eventLog.length).toBeGreaterThan(0);

    // Create active room on Peer A (waiting_for_peer)
    peerA.actions.createRoom();
    await flushMicrotasks();
    const roomId = peerA.react.getState().roomId;
    expect(roomId).toMatch(CANONICAL_ROOM_ID_PATTERN);

    // 2. INVALID_PAYLOAD (non-object and extra field) preserves waiting room membership
    expect(runValidationScenario(peerA.client, 'invalid-payload-non-object').ok).toBe(
      true,
    );
    await flushMicrotasks();
    expect(peerA.react.getState()).toMatchObject({
      roomId,
      peerState: 'waiting_for_peer',
      lastError: { code: 'INVALID_PAYLOAD' },
    });

    expect(
      runValidationScenario(peerA.client, 'invalid-payload-extra-field', {
        roomId,
      }).ok,
    ).toBe(true);
    await flushMicrotasks();
    expect(peerA.react.getState().lastError?.code).toBe('INVALID_PAYLOAD');

    // 3. INVALID_ROOM_ID preserves waiting room membership
    expect(
      runValidationScenario(peerA.client, 'invalid-room-id', {
        targetRoomId: '../ship-dead',
      }).ok,
    ).toBe(true);
    await flushMicrotasks();
    expect(peerA.react.getState()).toMatchObject({
      roomId,
      peerState: 'waiting_for_peer',
      lastError: { code: 'INVALID_ROOM_ID' },
    });

    // 4. UNAUTHORIZED while already in room preserves membership
    expect(
      runValidationScenario(peerA.client, 'unauthorized-action', { roomId }).ok,
    ).toBe(true);
    await flushMicrotasks();
    expect(peerA.react.getState()).toMatchObject({
      roomId,
      peerState: 'waiting_for_peer',
      lastError: { code: 'UNAUTHORIZED' },
    });

    // 5. PEER_UNAVAILABLE while waiting_for_peer preserves membership
    expect(
      runValidationScenario(peerA.client, 'peer-unavailable-signal', { roomId }).ok,
    ).toBe(true);
    await flushMicrotasks();
    expect(peerA.react.getState()).toMatchObject({
      roomId,
      peerState: 'waiting_for_peer',
      lastError: { code: 'PEER_UNAVAILABLE' },
    });

    // 6. SERVER_BUSY when STUN config unavailable preserves membership and marks ICE error
    ioFactory.setIceAvailable(false);
    expect(peerA.actions.requestIce(roomId)).toBe(true);
    await flushMicrotasks();
    expect(peerA.react.getState()).toMatchObject({
      roomId,
      peerState: 'waiting_for_peer',
      lastError: { code: 'SERVER_BUSY', roomId },
      iceDiagnostics: { status: 'error', roomId },
    });
    expect(shouldClearDraftRoomInput(peerA.react.getState())).toBe(false);

    // Restore STUN config, join Peer B, and verify ROOM_FULL on Peer C
    ioFactory.setIceAvailable(true);
    peerB.actions.joinRoom(roomId);
    await flushMicrotasks();
    peerC.actions.joinRoom(roomId);
    await flushMicrotasks();
    expect(peerC.react.getState().lastError?.code).toBe('ROOM_FULL');

    // Malformed / TURN-bearing ICE payload produces INVALID_ICE_CREDENTIALS without leaking secrets
    peerA.react.setState((prev) =>
      applyIceCredentials(prev, {
        roomId,
        iceServers: [
          {
            urls: ['turn:turn.shipri.app:3478'],
            username: 'turnUserSecret',
            credential: 'turnPassSecret',
          },
        ],
      }),
    );
    expect(peerA.react.getState()).toMatchObject({
      roomId,
      peerState: 'connected',
      lastError: { code: 'INVALID_ICE_CREDENTIALS' },
      iceDiagnostics: { status: 'invalid' },
    });

    // Unrecognized server error falls back to UNKNOWN_ERROR in UI markup and preserves membership
    peerA.socket.simulateServerEvent('room:error', {
      roomId,
      code: 'RATE_LIMITED',
      message: 'Too many requests',
    });
    await flushMicrotasks();
    expect(peerA.renderMarkup()).toContain('Fallback: UNKNOWN_ERROR');

    // Selective recovery clears errors while preserving roomId, peerState, negotiationDuty, and eventLog
    const logLengthBeforeRecovery = peerA.react.getState().eventLog.length;
    peerA.react.setState((prev) => recoverErrorState(prev));
    expect(peerA.react.getState()).toMatchObject({
      roomId,
      peerState: 'connected',
      negotiationDuty: 'offerer',
      lastError: null,
      iceDiagnostics: { lastError: null },
    });
    expect(peerA.react.getState().eventLog.length).toBe(logLengthBeforeRecovery);

    peerA.dispose();
    peerB.dispose();
    peerC.dispose();
  });

  test('verifies STUN-only ICE validation, early trickle ICE queuing and ordered flush, 5000ms non-blocking gathering bound, and bidirectional channel messaging', async () => {
    vi.useFakeTimers();
    const ioFactory = createPocRelaySocketFactory();
    let tick = 0;
    const nowIso = () =>
      `2026-11-23T17:20:${String(tick++).padStart(2, '0')}.000Z`;

    const peerA = createPrototypePeer({
      ioFactory,
      nowIso,
      pcBehavior: {
        deferSetRemoteDescription: true,
        gatheringStateOnLocalDescription: 'gathering',
      },
    });
    const peerB = createPrototypePeer({
      ioFactory,
      nowIso,
      pcBehavior: {
        deferSetRemoteDescription: true,
        gatheringStateOnLocalDescription: 'gathering',
      },
    });

    peerA.actions.createRoom();
    await flushMicrotasks();
    const roomId = peerA.react.getState().roomId;

    peerB.actions.joinRoom(roomId);
    await flushMicrotasks();

    // Validate development STUN-only ICE diagnostics
    expect(peerA.react.getState().iceDiagnostics).toMatchObject({
      status: 'ready',
      isStunOnly: true,
      serverEntryCount: 1,
      endpointCount: 2,
      schemes: ['stun'],
      stunCount: 2,
      turnCount: 0,
      endpointsRedacted: true,
    });
    expect(peerB.react.getState().iceDiagnostics).toMatchObject({
      status: 'ready',
      isStunOnly: true,
      stunCount: 2,
      turnCount: 0,
    });

    const pcA = peerA.pcFactory.lastInstance;
    const pcB = peerB.pcFactory.lastInstance;
    expect(pcA).not.toBeNull();
    expect(pcB).not.toBeNull();

    // Offerer forwarded SDP immediately while ICE gathering is still in progress
    expect(peerA.react.getState().webrtc).toMatchObject({
      localDescriptionForwarded: true,
      iceGatheringState: 'gathering',
      stalledGathering: false,
    });

    // Trickle two local candidates from Peer A BEFORE Peer B resolves setRemoteDescription(offer)
    const earlyCandA1 = {
      candidate: 'candidate:1 1 UDP 2122252543 198.51.100.11 55101 typ srflx',
      sdpMid: '0',
      sdpMLineIndex: 0,
    };
    const earlyCandA2 = {
      candidate: 'candidate:2 1 UDP 2122252542 198.51.100.12 55102 typ host',
      sdpMid: '0',
      sdpMLineIndex: 0,
    };
    pcA.simulateIceCandidate(earlyCandA1);
    pcA.simulateIceCandidate(earlyCandA2);
    await flushMicrotasks();

    expect(pcB.addedIceCandidates).toEqual([]);
    expect(peerB.react.getState().webrtc).toMatchObject({
      remoteCandidatesReceived: 2,
      remoteCandidatesQueued: 2,
      queuedCandidateCount: 2,
      remoteCandidatesApplied: 0,
    });

    // Resolve Peer B remote offer -> queued candidates flush in exact order and Peer B forwards answer
    pcB.resolvePendingSetRemoteDescription();
    await flushMicrotasks();

    expect(pcB.addedIceCandidates).toEqual([earlyCandA1, earlyCandA2]);
    expect(peerB.react.getState().webrtc).toMatchObject({
      queuedCandidateCount: 0,
      remoteCandidatesApplied: 2,
      localDescriptionForwarded: true,
    });

    // Trickle early candidate from Peer B before Peer A resolves setRemoteDescription(answer)
    const earlyCandB1 = {
      candidate: 'candidate:1 1 UDP 2122252543 203.0.113.21 55201 typ srflx',
      sdpMid: '0',
      sdpMLineIndex: 0,
    };
    pcB.simulateIceCandidate(earlyCandB1);
    await flushMicrotasks();

    expect(pcA.addedIceCandidates).toEqual([]);
    expect(peerA.react.getState().webrtc).toMatchObject({
      remoteCandidatesReceived: 1,
      queuedCandidateCount: 1,
      remoteCandidatesApplied: 0,
    });

    pcA.resolvePendingSetRemoteDescription();
    await flushMicrotasks();

    expect(pcA.addedIceCandidates).toEqual([earlyCandB1]);
    expect(peerA.react.getState().webrtc).toMatchObject({
      queuedCandidateCount: 0,
      remoteCandidatesApplied: 1,
    });

    // Advance 5000ms gathering bound -> stalledGathering diagnostics set without blocking data channel
    expect(ICE_GATHERING_STALL_TIMEOUT_MS).toBe(5000);
    vi.advanceTimersByTime(ICE_GATHERING_STALL_TIMEOUT_MS);

    expect(peerA.react.getState().webrtc.stalledGathering).toBe(true);
    expect(peerA.react.getState().webrtc.stalledDiagnostic).toContain('5000ms');
    expect(peerB.react.getState().webrtc.stalledGathering).toBe(true);

    // Late candidate trickling and bidirectional messaging continue unblocked
    const lateCandA3 = {
      candidate: 'candidate:3 1 UDP 1686052607 198.51.100.13 55103 typ srflx',
      sdpMid: '0',
      sdpMLineIndex: 0,
    };
    pcA.simulateIceCandidate(lateCandA3);
    pcA.simulateIceCandidate(null);
    pcB.simulateIceCandidate(null);
    await flushMicrotasks();

    expect(pcB.addedIceCandidates).toEqual([earlyCandA1, earlyCandA2, lateCandA3]);
    expect(peerA.react.getState().webrtc).toMatchObject({
      iceGatheringState: 'complete',
      stalledGathering: false,
      stalledDiagnostic: null,
    });
    expect(peerB.react.getState().webrtc).toMatchObject({
      iceGatheringState: 'complete',
      stalledGathering: false,
      stalledDiagnostic: null,
    });

    openAndBridgeDataChannels(peerA, peerB);
    const emittedBeforeChannel = [
      ...peerA.socket.emittedEvents,
      ...peerB.socket.emittedEvents,
    ].length;

    assertBidirectionalMessaging(peerA, peerB, 'trickle');

    // Data-channel messages never traverse Socket.IO
    const emittedAfterChannel = [
      ...peerA.socket.emittedEvents,
      ...peerB.socket.emittedEvents,
    ].length;
    expect(emittedAfterChannel).toBe(emittedBeforeChannel);

    peerA.dispose();
    peerB.dispose();
  });

  test('guarantees zero leaked SDP strings, ICE candidates, TURN secrets, #key= fragments, tokens, or file metadata across UI markup and sanitized logs', async () => {
    const ioFactory = createPocRelaySocketFactory();
    let tick = 0;
    const nowIso = () =>
      `2026-11-23T17:30:${String(tick++).padStart(2, '0')}.000Z`;

    const peerA = createPrototypePeer({ ioFactory, nowIso });
    const peerB = createPrototypePeer({ ioFactory, nowIso });

    peerA.actions.createRoom();
    await flushMicrotasks();
    const roomId = peerA.react.getState().roomId;

    peerB.actions.joinRoom(roomId);
    await flushMicrotasks();

    const pcA = peerA.pcFactory.lastInstance;
    const pcB = peerB.pcFactory.lastInstance;
    pcA.simulateIceCandidate({
      candidate: 'candidate:1 1 UDP 2122252543 198.51.100.42 55100 typ srflx',
      sdpMid: '0',
      sdpMLineIndex: 0,
    });
    pcB.simulateIceCandidate({
      candidate: 'candidate:1 1 UDP 2122252543 203.0.113.77 55200 typ srflx',
      sdpMid: '0',
      sdpMLineIndex: 0,
    });
    await flushMicrotasks();

    openAndBridgeDataChannels(peerA, peerB);

    // Inject sensitive strings into diagnostic text, ICE failure, and room error payloads
    peerA.controller.sendText(
      'leak check https://shipri.app/r/ship-1234#key=masterSecret999 authToken=secretJwtToken fileName=secret-budget.pdf sha256=deadbeef1234',
    );
    peerA.socket.simulateServerEvent('room:error', {
      roomId,
      code: 'SERVER_BUSY',
      message:
        'TURN_SHARED_SECRET=superSecretTurnKey username=turnUserSecret credential=turnPassSecret Bearer secretBearerToken123 eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.sigPayload999 encryptedMetadata=secretMeta chunkData=secretChunk',
    });
    await flushMicrotasks();

    const artifactsToCheck = [
      JSON.stringify(peerA.react.getState()),
      JSON.stringify(peerB.react.getState()),
      peerA.renderMarkup(),
      peerB.renderMarkup(),
    ];

    const forbiddenSecrets = [
      'mockOfferSecretIcePwd',
      'mockAnswerSecretIcePwd',
      'mockOfferUfrag',
      'mockAnswerUfrag',
      '203.0.113.10',
      '198.51.100.20',
      '198.51.100.42',
      '203.0.113.77',
      '55100',
      '55200',
      'stun.l.google.com',
      'masterSecret999',
      'secretJwtToken',
      'secret-budget.pdf',
      'deadbeef1234',
      'superSecretTurnKey',
      'turnUserSecret',
      'turnPassSecret',
      'secretBearerToken123',
      'sigPayload999',
      'secretMeta',
      'secretChunk',
    ];

    for (const output of artifactsToCheck) {
      for (const secret of forbiddenSecrets) {
        expect(output).not.toContain(secret);
      }
    }

    expect(peerA.renderMarkup()).toContain(roomId);
    expect(peerB.renderMarkup()).toContain('https://shipri.app/r/ship-1234#[REDACTED]');

    peerA.dispose();
    peerB.dispose();
  });
});
