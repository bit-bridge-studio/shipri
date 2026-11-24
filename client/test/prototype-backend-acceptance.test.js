import { createHash } from 'node:crypto';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import App from '../src/App.jsx';
import {
  createDiagnosticChannelController,
  createInitialDiagnosticChannelState,
} from '../src/prototype/diagnostic-channel.js';
import {
  applyDiagnosticChannelState,
  applyWebRtcState,
  bindSignalingClient,
  createInitialPrototypeState,
  createRoomLifecycleActions,
  recoverErrorState,
} from '../src/prototype/diagnostic-state.js';
import { validateIceCredentialsPayload } from '../src/prototype/ice-diagnostics.js';
import {
  FULL_BACKEND_ERROR_DESCRIPTORS,
  FULL_BACKEND_VALIDATION_SCENARIOS,
  PROTOTYPE_ONLY_MODULES,
  REUSABLE_CLIENT_MODULES,
  resolveFullBackendErrorDescriptor,
} from '../src/prototype/prototype-manifest.js';
import {
  ROOM_AUTH_HKDF_INFO,
  ROOM_AUTH_HKDF_SALT,
  generatePrototypeRoomAuth,
} from '../src/prototype/room-auth.js';
import {
  POC_ROOM_ERROR_DESCRIPTORS,
  runValidationScenario,
} from '../src/prototype/room-errors.js';
import {
  RELAY_BANDWIDTH_WARNING,
  createWebRtcHarness,
} from '../src/prototype/webrtc-harness.js';
import { createSignalingClient } from '../src/signaling/socket-client.js';
import { createMockPeerConnectionFactory } from './helpers/mock-webrtc.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROTOTYPE_DIR = path.resolve(__dirname, '../src/prototype');
const ROOM_ID_PATTERN = /^ship-[a-f0-9]{4}$/;

function sha256Base64Url(value) {
  return createHash('sha256').update(value, 'utf8').digest('base64url');
}

async function flushMicrotasks(rounds = 32) {
  for (let index = 0; index < rounds; index += 1) {
    await Promise.resolve();
  }
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

function createStateHarness(initial = {}) {
  let state = createInitialPrototypeState(initial);
  const setState = (updater) => {
    state = typeof updater === 'function' ? updater(state) : updater;
  };
  return {
    getState: () => state,
    setState,
  };
}

/**
 * In-memory full-backend signaling simulator matching BE-2..BE-6 contracts:
 * REQUIRE_ROOM_AUTH=true, rate limits, MAX_ROOMS, non-member isolation, TTL expiry,
 * and STUN+TURN ice:credentials.
 */
function createFullBackendSignalingCluster(options = {}) {
  const maxRooms = options.maxRooms ?? 10;
  const createRateLimitMax = options.createRateLimitMax ?? 5;
  const turnSecret = 'test-turn-shared-secret-never-emit';
  const iceServers = options.iceServers ?? [
    { urls: ['stun:stun.shipri.test:3478'] },
    {
      urls: [
        'turn:turn.shipri.test:3478?transport=udp',
        'turns:turn.shipri.test:5349?transport=tcp',
      ],
      username: '1999999999:peer',
      credential: 'ephemeral-hmac-turn-credential-value',
    },
  ];
  let iceUnavailable = Boolean(options.iceUnavailable);

  let nextRoomCounter = 0x2000;
  let nextPeerCounter = 1;
  const rooms = new Map();
  const socketToRoom = new Map();
  const sockets = new Map();
  const createAttemptsBySocket = new Map();

  function emitTo(socketId, event, payload) {
    const target = sockets.get(socketId);
    if (!target || !target.connected) {
      return;
    }
    const listeners = target.listeners.get(event);
    if (!listeners) {
      return;
    }
    for (const listener of [...listeners]) {
      listener(payload);
    }
  }

  function removePeerFromRoom(socketId, reason) {
    const roomId = socketToRoom.get(socketId);
    if (!roomId) {
      return;
    }
    socketToRoom.delete(socketId);
    const room = rooms.get(roomId);
    if (!room) {
      return;
    }
    const leavingPeerId = room.peerIds.get(socketId);
    room.members.delete(socketId);
    room.peerIds.delete(socketId);

    if (room.members.size === 0) {
      rooms.delete(roomId);
      return;
    }

    for (const remainingSocketId of room.members) {
      emitTo(remainingSocketId, 'peer:left', {
        roomId,
        peerId: leavingPeerId,
        reason,
      });
    }
  }

  function expireRoom(roomId) {
    const room = rooms.get(roomId);
    if (!room) {
      return false;
    }
    const memberIds = [...room.members];
    rooms.delete(roomId);
    for (const memberSocketId of memberIds) {
      socketToRoom.delete(memberSocketId);
      emitTo(memberSocketId, 'room:error', {
        roomId,
        code: 'ROOM_NOT_FOUND',
        message: 'Room expired.',
      });
    }
    return true;
  }

  function handleEmit(socketId, event, payload) {
    const isPlainObj =
      payload !== null && typeof payload === 'object' && !Array.isArray(payload);

    if (event === 'room:create') {
      if (!isPlainObj) {
        emitTo(socketId, 'room:error', {
          code: 'INVALID_PAYLOAD',
          message: 'Payload must be an object.',
        });
        return;
      }
      const allowedKeys = Object.keys(payload).every(
        (key) => key === 'authVerifier',
      );
      if (
        !allowedKeys ||
        typeof payload.authVerifier !== 'string' ||
        payload.authVerifier.trim() === ''
      ) {
        emitTo(socketId, 'room:error', {
          code: 'INVALID_PAYLOAD',
          message: 'authVerifier is required when REQUIRE_ROOM_AUTH=true.',
        });
        return;
      }
      if (socketToRoom.has(socketId)) {
        emitTo(socketId, 'room:error', {
          code: 'UNAUTHORIZED',
          message: 'Socket already belongs to an active room.',
        });
        return;
      }

      const attempts = (createAttemptsBySocket.get(socketId) ?? 0) + 1;
      createAttemptsBySocket.set(socketId, attempts);
      if (attempts > createRateLimitMax) {
        emitTo(socketId, 'room:error', {
          code: 'RATE_LIMITED',
          message: 'Too many room creation attempts.',
        });
        return;
      }

      if (rooms.size >= maxRooms) {
        emitTo(socketId, 'room:error', {
          code: 'SERVER_BUSY',
          message: 'Server room capacity reached.',
        });
        return;
      }

      const roomId = `ship-${(nextRoomCounter++).toString(16).padStart(4, '0')}`;
      const peerId = `peer-${nextPeerCounter++}`;
      rooms.set(roomId, {
        authVerifier: payload.authVerifier.trim(),
        members: new Set([socketId]),
        peerIds: new Map([[socketId, peerId]]),
      });
      socketToRoom.set(socketId, roomId);
      emitTo(socketId, 'room:created', {
        roomId,
        peerId,
        negotiationDuty: 'offerer',
      });
      return;
    }

    if (event === 'room:join') {
      if (!isPlainObj) {
        emitTo(socketId, 'room:error', {
          code: 'INVALID_PAYLOAD',
          message: 'Payload must be an object.',
        });
        return;
      }
      const allowedKeys = Object.keys(payload).every(
        (key) => key === 'roomId' || key === 'authToken',
      );
      if (!allowedKeys) {
        emitTo(socketId, 'room:error', {
          code: 'INVALID_PAYLOAD',
          message: 'Unsupported field in room:join payload.',
        });
        return;
      }
      if (
        typeof payload.roomId !== 'string' ||
        !ROOM_ID_PATTERN.test(payload.roomId)
      ) {
        emitTo(socketId, 'room:error', {
          code: 'INVALID_ROOM_ID',
          message: 'Invalid roomId format.',
        });
        return;
      }
      if (
        typeof payload.authToken !== 'string' ||
        payload.authToken.trim() === ''
      ) {
        emitTo(socketId, 'room:error', {
          roomId: payload.roomId,
          code: 'INVALID_PAYLOAD',
          message: 'authToken is required.',
        });
        return;
      }
      const room = rooms.get(payload.roomId);
      if (!room) {
        emitTo(socketId, 'room:error', {
          roomId: payload.roomId,
          code: 'ROOM_NOT_FOUND',
          message: 'Room does not exist.',
        });
        return;
      }
      if (socketToRoom.has(socketId)) {
        emitTo(socketId, 'room:error', {
          roomId: payload.roomId,
          code: 'UNAUTHORIZED',
          message: 'Socket already belongs to an active room.',
        });
        return;
      }
      // Auth checked before ROOM_FULL to prevent room occupancy probing
      if (sha256Base64Url(payload.authToken) !== room.authVerifier) {
        emitTo(socketId, 'room:error', {
          roomId: payload.roomId,
          code: 'UNAUTHORIZED',
          message: 'Invalid room authorization token.',
        });
        return;
      }
      if (room.members.size >= 2) {
        emitTo(socketId, 'room:error', {
          roomId: payload.roomId,
          code: 'ROOM_FULL',
          message: 'Room already has two peers.',
        });
        return;
      }

      const existingSocketId = [...room.members][0];
      const peerId = `peer-${nextPeerCounter++}`;
      room.members.add(socketId);
      room.peerIds.set(socketId, peerId);
      socketToRoom.set(socketId, payload.roomId);

      emitTo(socketId, 'room:joined', {
        roomId: payload.roomId,
        peerId,
        negotiationDuty: 'answerer',
      });
      if (existingSocketId) {
        emitTo(existingSocketId, 'peer:joined', {
          roomId: payload.roomId,
          peerId,
        });
      }
      return;
    }

    if (event === 'room:leave') {
      if (!isPlainObj) {
        emitTo(socketId, 'room:error', {
          code: 'INVALID_PAYLOAD',
          message: 'Payload must be an object.',
        });
        return;
      }
      if (
        typeof payload.roomId !== 'string' ||
        !ROOM_ID_PATTERN.test(payload.roomId)
      ) {
        emitTo(socketId, 'room:error', {
          code: 'INVALID_ROOM_ID',
          message: 'Invalid roomId format.',
        });
        return;
      }
      const room = rooms.get(payload.roomId);
      if (!room) {
        emitTo(socketId, 'room:error', {
          roomId: payload.roomId,
          code: 'ROOM_NOT_FOUND',
          message: 'Room not found.',
        });
        return;
      }
      if (!room.members.has(socketId)) {
        emitTo(socketId, 'room:error', {
          roomId: payload.roomId,
          code: 'UNAUTHORIZED',
          message: 'Not a member of this room.',
        });
        return;
      }
      removePeerFromRoom(socketId, 'leave');
      return;
    }

    if (event === 'ice:get') {
      if (!isPlainObj) {
        emitTo(socketId, 'room:error', {
          code: 'INVALID_PAYLOAD',
          message: 'Payload must be an object.',
        });
        return;
      }
      if (
        typeof payload.roomId !== 'string' ||
        !ROOM_ID_PATTERN.test(payload.roomId)
      ) {
        emitTo(socketId, 'room:error', {
          code: 'INVALID_ROOM_ID',
          message: 'Invalid roomId format.',
        });
        return;
      }
      const room = rooms.get(payload.roomId);
      if (!room) {
        emitTo(socketId, 'room:error', {
          roomId: payload.roomId,
          code: 'ROOM_NOT_FOUND',
          message: 'Room not found.',
        });
        return;
      }
      if (!room.members.has(socketId)) {
        emitTo(socketId, 'room:error', {
          roomId: payload.roomId,
          code: 'UNAUTHORIZED',
          message: 'Not a member of this room.',
        });
        return;
      }
      if (iceUnavailable) {
        emitTo(socketId, 'room:error', {
          roomId: payload.roomId,
          code: 'SERVER_BUSY',
          message: 'ICE/TURN configuration unavailable.',
        });
        return;
      }
      emitTo(socketId, 'ice:credentials', {
        roomId: payload.roomId,
        iceServers,
      });
      return;
    }

    if (event === 'signal:forward') {
      if (
        !isPlainObj ||
        !payload.signalData ||
        typeof payload.signalData !== 'object' ||
        Array.isArray(payload.signalData)
      ) {
        emitTo(socketId, 'room:error', {
          code: 'INVALID_PAYLOAD',
          message: 'Invalid signal:forward payload.',
        });
        return;
      }
      if (
        typeof payload.roomId !== 'string' ||
        !ROOM_ID_PATTERN.test(payload.roomId)
      ) {
        emitTo(socketId, 'room:error', {
          code: 'INVALID_ROOM_ID',
          message: 'Invalid roomId format.',
        });
        return;
      }
      const room = rooms.get(payload.roomId);
      if (!room) {
        emitTo(socketId, 'room:error', {
          roomId: payload.roomId,
          code: 'ROOM_NOT_FOUND',
          message: 'Room not found.',
        });
        return;
      }
      if (!room.members.has(socketId)) {
        emitTo(socketId, 'room:error', {
          roomId: payload.roomId,
          code: 'UNAUTHORIZED',
          message: 'Not a member of this room.',
        });
        return;
      }
      if (room.members.size < 2) {
        emitTo(socketId, 'room:error', {
          roomId: payload.roomId,
          code: 'PEER_UNAVAILABLE',
          message: 'No second peer in room.',
        });
        return;
      }
      const senderPeerId = room.peerIds.get(socketId);
      for (const memberSocketId of room.members) {
        if (memberSocketId !== socketId) {
          emitTo(memberSocketId, 'signal:receive', {
            roomId: payload.roomId,
            peerId: senderPeerId,
            signalData: payload.signalData,
          });
        }
      }
    }
  }

  function createPeerHarness(label, rtcFactory) {
    const socketId = `sock-${label}-${nextPeerCounter++}`;
    const socketRecord = {
      connected: false,
      listeners: new Map(),
      on(event, handler) {
        if (!this.listeners.has(event)) {
          this.listeners.set(event, new Set());
        }
        this.listeners.get(event).add(handler);
      },
      off(event, handler) {
        this.listeners.get(event)?.delete(handler);
      },
      connect() {
        this.connected = true;
        emitTo(socketId, 'connect');
      },
      disconnect() {
        if (!this.connected) {
          return;
        }
        this.connected = false;
        removePeerFromRoom(socketId, 'disconnect');
        const listeners = this.listeners.get('disconnect');
        if (listeners) {
          for (const listener of [...listeners]) {
            listener('io client disconnect');
          }
        }
      },
      emit(event, payload) {
        handleEmit(socketId, event, payload);
      },
    };
    sockets.set(socketId, socketRecord);

    const client = createSignalingClient({
      url: 'https://shipri.example',
      ioFactory: () => socketRecord,
    });
    const react = createStateHarness({
      diagnosticChannel: createInitialDiagnosticChannelState(),
    });
    const unbind = bindSignalingClient(client, react.setState);
    const actions = createRoomLifecycleActions(client, react.setState);

    const channel = createDiagnosticChannelController({
      signalingClient: client,
      onStateChange: (nextChannelState) => {
        react.setState((prev) =>
          applyDiagnosticChannelState(prev, nextChannelState),
        );
      },
    });

    const webrtc = createWebRtcHarness({
      signalingClient: client,
      peerConnectionFactory: rtcFactory,
      allowTurn: true,
      onStateChange: (nextWebRtcState) => {
        react.setState((prev) => applyWebRtcState(prev, nextWebRtcState));
      },
      onDataChannel: (dc, meta) => channel.attachChannel(dc, meta),
    });

    client.connect();

    return {
      socketId,
      socket: socketRecord,
      client,
      react,
      actions,
      channel,
      webrtc,
      renderMarkup: () =>
        renderToStaticMarkup(
          React.createElement(App, {
            signalingClient: client,
            initialState: react.getState(),
          }),
        ),
      dispose: () => {
        webrtc.dispose();
        channel.dispose();
        unbind();
        client.dispose();
      },
    };
  }

  return {
    rooms,
    turnSecret,
    expireRoom,
    setIceUnavailable: (value) => {
      iceUnavailable = Boolean(value);
    },
    createPeerHarness,
  };
}

describe('FP-6 prototype backend acceptance scenarios', () => {
  it('registers every prototype-only module and separates reusable signaling modules', () => {
    const prototypeFilesOnDisk = readdirSync(PROTOTYPE_DIR)
      .filter((entry) => entry.endsWith('.js'))
      .map((entry) => `client/src/prototype/${entry}`)
      .sort();

    const manifestPaths = PROTOTYPE_ONLY_MODULES.map((item) => item.path);

    for (const filePath of prototypeFilesOnDisk) {
      expect(manifestPaths).toContain(filePath);
    }
    expect(manifestPaths).toContain('client/src/App.jsx');
    for (const entry of PROTOTYPE_ONLY_MODULES) {
      expect(entry.removeOrReplaceInPart4).toBe(true);
      expect(entry.description.length).toBeGreaterThan(10);
    }

    expect(REUSABLE_CLIENT_MODULES.map((item) => item.path)).toContain(
      'client/src/signaling/socket-client.js',
    );

    // Full-backend error descriptors include RATE_LIMITED without mutating POC descriptors
    expect(FULL_BACKEND_ERROR_DESCRIPTORS.RATE_LIMITED).toBeDefined();
    expect(resolveFullBackendErrorDescriptor('RATE_LIMITED')).toMatchObject({
      code: 'RATE_LIMITED',
      category: 'rate_limit',
      known: true,
    });
    expect(POC_ROOM_ERROR_DESCRIPTORS.RATE_LIMITED).toBeUndefined();
    expect(FULL_BACKEND_VALIDATION_SCENARIOS.length).toBeGreaterThan(0);
  });

  it('passes authorized equal-peer lifecycle, third-peer rejection, unauthorized signaling, rate-limit/capacity, TTL expiry, and cleanup', async () => {
    const cluster = createFullBackendSignalingCluster({
      maxRooms: 1,
      createRateLimitMax: 2,
    });
    const rtcFactory = createMockPeerConnectionFactory();

    const peerA = cluster.createPeerHarness('a', rtcFactory);
    const peerB = cluster.createPeerHarness('b', rtcFactory);
    const peerC = cluster.createPeerHarness('c', rtcFactory);
    const peerD = cluster.createPeerHarness('d', rtcFactory);

    const authPair = await generatePrototypeRoomAuth();
    expect(ROOM_AUTH_HKDF_SALT).toBe('shipri-room-auth-salt-v1');
    expect(ROOM_AUTH_HKDF_INFO).toBe('shipri-room-auth-v1');
    expect(authPair.authVerifier).toBe(sha256Base64Url(authPair.authToken));

    // Peer A creates authorized room
    peerA.actions.createRoom({ authVerifier: authPair.authVerifier });
    const roomId = peerA.react.getState().roomId;
    expect(roomId).toMatch(ROOM_ID_PATTERN);
    expect(peerA.react.getState()).toMatchObject({
      peerState: 'waiting_for_peer',
      entryRole: 'creator',
      negotiationDuty: 'offerer',
    });

    // Unauthorized join attempts (missing token and wrong token) do not disturb creator
    peerB.actions.joinRoom(roomId);
    expect(peerB.react.getState().lastError?.code).toBe('INVALID_PAYLOAD');
    peerB.actions.joinRoom(roomId, { authToken: 'tampered-wrong-token-value' });
    expect(peerB.react.getState().lastError?.code).toBe('UNAUTHORIZED');
    expect(peerB.react.getState().peerState).toBe('unaffiliated');

    // Authorized second peer joins
    peerB.actions.joinRoom(roomId, { authToken: authPair.authToken });
    expect(peerB.react.getState()).toMatchObject({
      roomId,
      peerState: 'connected',
      entryRole: 'joiner',
      negotiationDuty: 'answerer',
    });
    expect(peerA.react.getState()).toMatchObject({
      roomId,
      peerState: 'connected',
      negotiationDuty: 'offerer',
    });

    // Third peer: wrong token -> UNAUTHORIZED before ROOM_FULL; valid token -> ROOM_FULL
    peerC.actions.joinRoom(roomId, { authToken: 'wrong-third-peer-token' });
    expect(peerC.react.getState().lastError?.code).toBe('UNAUTHORIZED');
    peerC.actions.joinRoom(roomId, { authToken: authPair.authToken });
    expect(peerC.react.getState().lastError?.code).toBe('ROOM_FULL');
    expect(peerC.react.getState().peerState).toBe('unaffiliated');

    // Non-member signaling, ICE, and leave attempts rejected with UNAUTHORIZED; no spoofed signals
    const receivedByA = vi.fn();
    peerA.client.subscribeServerEvent('signal:receive', receivedByA);

    peerC.client.forwardSignal(roomId, { type: 'offer', sdp: 'v=0\r\nspoof' });
    expect(peerC.react.getState().lastError?.code).toBe('UNAUTHORIZED');
    expect(receivedByA).not.toHaveBeenCalled();

    peerC.client.requestIce(roomId);
    expect(peerC.react.getState().lastError?.code).toBe('UNAUTHORIZED');

    peerC.client.leaveRoom(roomId);
    expect(peerC.react.getState().lastError?.code).toBe('UNAUTHORIZED');

    // Malformed validation scenario against active peer preserves membership
    runValidationScenario(peerA.client, 'invalid-payload-extra-field', {
      roomId,
    });
    expect(peerA.react.getState().lastError?.code).toBe('INVALID_PAYLOAD');
    expect(peerA.react.getState().peerState).toBe('connected');
    peerA.react.setState((prev) => recoverErrorState(prev));

    // Capacity saturation (MAX_ROOMS=1) -> SERVER_BUSY, then rate-limit -> RATE_LIMITED
    peerC.actions.createRoom({ authVerifier: authPair.authVerifier });
    expect(peerC.react.getState().lastError?.code).toBe('SERVER_BUSY');
    peerC.actions.createRoom({ authVerifier: authPair.authVerifier });
    expect(peerC.react.getState().lastError?.code).toBe('SERVER_BUSY');
    peerC.actions.createRoom({ authVerifier: authPair.authVerifier });
    expect(peerC.react.getState().lastError?.code).toBe('RATE_LIMITED');
    expect(
      resolveFullBackendErrorDescriptor(peerC.react.getState().lastError).known,
    ).toBe(true);

    // Creator leaves -> Joiner Peer B becomes waiting offerer
    peerA.actions.leaveRoom(roomId);
    expect(peerA.react.getState().peerState).toBe('unaffiliated');
    expect(peerB.react.getState()).toMatchObject({
      roomId,
      peerState: 'waiting_for_peer',
      negotiationDuty: 'offerer',
    });

    // Signal while waiting -> PEER_UNAVAILABLE
    peerB.client.forwardSignal(roomId, { type: 'offer' });
    expect(peerB.react.getState().lastError?.code).toBe('PEER_UNAVAILABLE');

    // Replacement authorized peer D joins, then disconnects unexpectedly
    peerD.actions.joinRoom(roomId, { authToken: authPair.authToken });
    expect(peerB.react.getState().peerState).toBe('connected');
    expect(peerD.react.getState().peerState).toBe('connected');

    peerD.socket.disconnect();
    expect(peerB.react.getState()).toMatchObject({
      roomId,
      peerState: 'waiting_for_peer',
      negotiationDuty: 'offerer',
    });

    // Room TTL expiry removes room and notifies remaining peer with ROOM_NOT_FOUND
    expect(cluster.expireRoom(roomId)).toBe(true);
    expect(cluster.rooms.size).toBe(0);
    expect(peerB.react.getState().lastError?.code).toBe('ROOM_NOT_FOUND');

    // Subsequent join to expired room fails with ROOM_NOT_FOUND
    peerA.actions.joinRoom(roomId, { authToken: authPair.authToken });
    expect(peerA.react.getState().lastError?.code).toBe('ROOM_NOT_FOUND');

    // Verify secrets never leaked into sanitized logs or rendered UI markup
    const combinedAudit = [
      ...peerA.react.getState().eventLog,
      ...peerB.react.getState().eventLog,
      ...peerC.react.getState().eventLog,
    ]
      .map((entry) => JSON.stringify(entry))
      .join('\n');
    const markupA = peerA.renderMarkup();

    expect(combinedAudit).not.toContain(authPair.authToken);
    expect(combinedAudit).not.toContain(authPair.authVerifier);
    expect(combinedAudit).not.toContain(cluster.turnSecret);
    expect(combinedAudit).not.toContain('ephemeral-hmac-turn-credential-value');
    expect(markupA).toContain('Prototype-only');
    expect(markupA).toContain('Generate Auth Pair');
    expect(markupA).not.toContain(authPair.authToken);

    peerA.dispose();
    peerB.dispose();
    peerC.dispose();
    peerD.dispose();
  });

  it('passes direct (all) and forced-TURN (relay) bidirectional diagnostic exchanges and fail-closed SERVER_BUSY', async () => {
    for (const mode of ['all', 'relay']) {
      const cluster = createFullBackendSignalingCluster();
      const rtcFactory = createMockPeerConnectionFactory();
      const peerA = cluster.createPeerHarness(`direct-${mode}-a`, rtcFactory);
      const peerB = cluster.createPeerHarness(`direct-${mode}-b`, rtcFactory);

      peerA.webrtc.setIceTransportPolicy(mode);
      peerB.webrtc.setIceTransportPolicy(mode);

      const authPair = await generatePrototypeRoomAuth();
      peerA.actions.createRoom({ authVerifier: authPair.authVerifier });
      const roomId = peerA.react.getState().roomId;
      peerB.actions.joinRoom(roomId, { authToken: authPair.authToken });

      await peerA.webrtc.startNegotiation();
      await flushMicrotasks();

      const pcA = peerA.webrtc.getPeerConnection();
      const pcB = peerB.webrtc.getPeerConnection();
      expect(pcA.config.iceTransportPolicy).toBe(mode);
      expect(pcB.config.iceTransportPolicy).toBe(mode);

      // Verify full-backend ICE credentials passed validation with STUN + TURN
      const iceValidation = validateIceCredentialsPayload(
        { roomId, iceServers: pcA.config.iceServers },
        { expectedRoomId: roomId, allowTurn: true },
      );
      expect(iceValidation.ok).toBe(true);
      expect(iceValidation.summary.stunCount).toBe(1);
      expect(iceValidation.summary.turnCount).toBe(2);

      // Pair data channels and simulate connected ICE + PeerConnection state
      const chA = peerA.webrtc.getDataChannel();
      const chB = pcB.simulateRemoteDataChannel('shipri-diagnostic');
      linkMockDataChannels(chA, chB);
      chA.simulateOpen();
      chB.simulateOpen();

      pcA.simulateIceConnectionStateChange('connected');
      pcA.simulateConnectionStateChange('connected');
      pcB.simulateIceConnectionStateChange('connected');
      pcB.simulateConnectionStateChange('connected');
      await flushMicrotasks();

      const expectedMode = mode === 'relay' ? 'relay' : 'direct';
      expect(peerA.react.getState().webrtc.selectedPath.mode).toBe(expectedMode);
      expect(peerA.react.getState().webrtc.selectedPath.relayWarning).toBe(
        mode === 'relay',
      );
      if (mode === 'relay') {
        expect(peerA.renderMarkup()).toContain(RELAY_BANDWIDTH_WARNING);
      }

      // Bidirectional equal-peer ping/pong and text initiated by BOTH offerer and answerer
      expect(peerA.channel.sendPing().ok).toBe(true);
      expect(peerB.channel.sendPing().ok).toBe(true);
      expect(peerA.channel.sendText(`hello-from-offerer-${mode}`).ok).toBe(true);
      expect(peerB.channel.sendText(`hello-from-answerer-${mode}`).ok).toBe(
        true,
      );
      await flushMicrotasks();

      expect(peerA.react.getState().diagnosticChannel.pongsReceived).toBe(1);
      expect(peerB.react.getState().diagnosticChannel.pongsReceived).toBe(1);
      expect(
        peerA.react
          .getState()
          .diagnosticChannel.messages.some(
            (msg) =>
              msg.direction === 'inbound' &&
              msg.body === `hello-from-answerer-${mode}`,
          ),
      ).toBe(true);
      expect(
        peerB.react
          .getState()
          .diagnosticChannel.messages.some(
            (msg) =>
              msg.direction === 'inbound' &&
              msg.body === `hello-from-offerer-${mode}`,
          ),
      ).toBe(true);

      // Verify zero credential or IP leakage across UI markup and sanitized event logs
      const logs = [
        ...peerA.react.getState().eventLog,
        ...peerB.react.getState().eventLog,
      ]
        .map((entry) => JSON.stringify(entry))
        .join('\n');
      expect(logs).not.toContain('ephemeral-hmac-turn-credential-value');
      expect(logs).not.toContain('1999999999:peer');
      expect(logs).not.toContain(cluster.turnSecret);
      expect(logs).not.toContain(authPair.authToken);

      // Fail-closed TURN unavailability surfaces SERVER_BUSY clearly
      cluster.setIceUnavailable(true);
      peerA.actions.requestIce(roomId);
      expect(peerA.react.getState().lastError?.code).toBe('SERVER_BUSY');

      peerA.actions.leaveRoom(roomId);
      peerB.actions.leaveRoom(roomId);
      expect(cluster.rooms.size).toBe(0);

      peerA.dispose();
      peerB.dispose();
    }
  });
});
