import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, test, vi } from 'vitest';
import App from '../src/App.jsx';
import {
  appendSanitizedLogEntry,
  applyConnectionStatus,
  applyLocalRoomLeave,
  applyPeerJoined,
  applyPeerLeft,
  applyRoomCreated,
  applyRoomJoined,
  applySignalingServerEvent,
  bindSignalingClient,
  clearEventLog,
  createInitialPrototypeState,
  createRoomLifecycleActions,
  resetRoomMembership,
} from '../src/prototype/diagnostic-state.js';
import { createSignalingClient } from '../src/signaling/socket-client.js';
import { createMockSocketFactory } from './helpers/mock-socket.js';

function createStateHarness(initialOverrides) {
  let state = createInitialPrototypeState(initialOverrides);
  const setState = (updater) => {
    state = typeof updater === 'function' ? updater(state) : updater;
  };
  return {
    getState: () => state,
    setState,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('POC room lifecycle reducers', () => {
  test('applyRoomCreated transitions unaffiliated creator into waiting_for_peer with offerer duty', () => {
    const initial = createInitialPrototypeState({
      connectionStatus: 'connected',
    });

    const created = applyRoomCreated(initial, {
      roomId: 'ship-83a1',
      peerId: 'peer-creator-1',
      negotiationDuty: 'offerer',
    });

    expect(created).toEqual({
      connectionStatus: 'connected',
      roomId: 'ship-83a1',
      peerState: 'waiting_for_peer',
      entryRole: 'creator',
      negotiationDuty: 'offerer',
      selfPeerId: 'peer-creator-1',
      remotePeerId: null,
      lastError: null,
      eventLog: [],
    });

    // Malformed room:created payload does not corrupt existing state.
    const unchanged = applyRoomCreated(initial, {
      roomId: 'not-a-room',
      peerId: 'peer-bad',
      negotiationDuty: 'offerer',
    });
    expect(unchanged).toEqual(initial);

    // Optional lifecycle overrides are sanitized when explicitly provided.
    const sanitizedOptional = createInitialPrototypeState({
      entryRole: 'sender',
      selfPeerId: 'bad peer id#key=leak',
      remotePeerId: 'peer-valid-1',
    });
    expect(sanitizedOptional).toMatchObject({
      entryRole: null,
      selfPeerId: null,
      remotePeerId: 'peer-valid-1',
    });
  });

  test('applyRoomJoined and applyPeerJoined establish equal-peer connected state', () => {
    const joinerInitial = createInitialPrototypeState({
      connectionStatus: 'connected',
    });
    const joinerConnected = applyRoomJoined(joinerInitial, {
      roomId: 'ship-83a1',
      peerId: 'peer-joiner-2',
      negotiationDuty: 'answerer',
    });

    expect(joinerConnected).toMatchObject({
      roomId: 'ship-83a1',
      peerState: 'connected',
      entryRole: 'joiner',
      negotiationDuty: 'answerer',
      selfPeerId: 'peer-joiner-2',
      remotePeerId: null,
    });

    const creatorWaiting = applyRoomCreated(
      createInitialPrototypeState({ connectionStatus: 'connected' }),
      {
        roomId: 'ship-83a1',
        peerId: 'peer-creator-1',
        negotiationDuty: 'offerer',
      },
    );
    const creatorConnected = applyPeerJoined(creatorWaiting, {
      roomId: 'ship-83a1',
      peerId: 'peer-joiner-2',
    });

    expect(creatorConnected).toMatchObject({
      roomId: 'ship-83a1',
      peerState: 'connected',
      entryRole: 'creator',
      negotiationDuty: 'offerer',
      selfPeerId: 'peer-creator-1',
      remotePeerId: 'peer-joiner-2',
    });

    // Mismatched room peer:joined notification is ignored.
    const ignored = applyPeerJoined(creatorWaiting, {
      roomId: 'ship-ffff',
      peerId: 'peer-other',
    });
    expect(ignored).toEqual(creatorWaiting);
  });

  test('applyPeerLeft keeps remaining creator or joiner in room as offerer and supports replacement peer:joined', () => {
    const creatorConnected = createInitialPrototypeState({
      connectionStatus: 'connected',
      roomId: 'ship-83a1',
      peerState: 'connected',
      entryRole: 'creator',
      negotiationDuty: 'offerer',
      selfPeerId: 'peer-1',
      remotePeerId: 'peer-2',
    });

    const creatorWaitingAgain = applyPeerLeft(creatorConnected, {
      roomId: 'ship-83a1',
      peerId: 'peer-2',
      reason: 'leave',
    });

    expect(creatorWaitingAgain).toMatchObject({
      roomId: 'ship-83a1',
      peerState: 'waiting_for_peer',
      entryRole: 'creator',
      negotiationDuty: 'offerer',
      selfPeerId: 'peer-1',
      remotePeerId: null,
    });

    const joinerConnected = createInitialPrototypeState({
      connectionStatus: 'connected',
      roomId: 'ship-83a1',
      peerState: 'connected',
      entryRole: 'joiner',
      negotiationDuty: 'answerer',
      selfPeerId: 'peer-2',
      remotePeerId: 'peer-1',
    });

    const joinerPromoted = applyPeerLeft(joinerConnected, {
      roomId: 'ship-83a1',
      peerId: 'peer-1',
      reason: 'disconnect',
    });

    expect(joinerPromoted).toMatchObject({
      roomId: 'ship-83a1',
      peerState: 'waiting_for_peer',
      entryRole: 'joiner',
      negotiationDuty: 'offerer',
      selfPeerId: 'peer-2',
      remotePeerId: null,
    });

    const joinerWithReplacement = applyPeerJoined(joinerPromoted, {
      roomId: 'ship-83a1',
      peerId: 'peer-3',
    });

    expect(joinerWithReplacement).toMatchObject({
      roomId: 'ship-83a1',
      peerState: 'connected',
      entryRole: 'joiner',
      negotiationDuty: 'offerer',
      selfPeerId: 'peer-2',
      remotePeerId: 'peer-3',
    });

    // Mismatched room peer:left does not alter active membership.
    expect(
      applyPeerLeft(joinerConnected, {
        roomId: 'ship-9999',
        peerId: 'peer-1',
        reason: 'leave',
      }),
    ).toEqual(joinerConnected);
  });

  test('applyLocalRoomLeave and resetRoomMembership clear active room while preserving eventLog and optional state helpers preserve room fields', () => {
    let state = createInitialPrototypeState({
      connectionStatus: 'connected',
      roomId: 'ship-83a1',
      peerState: 'connected',
      entryRole: 'joiner',
      negotiationDuty: 'answerer',
      selfPeerId: 'peer-2',
      remotePeerId: null,
    });
    state = appendSanitizedLogEntry(state, {
      direction: 'inbound',
      event: 'room:joined',
      timestamp: '2026-11-18T16:00:00.000Z',
      payload: {
        roomId: 'ship-83a1',
        peerId: 'peer-2',
        negotiationDuty: 'answerer',
      },
    });

    expect(state).toMatchObject({
      entryRole: 'joiner',
      selfPeerId: 'peer-2',
      remotePeerId: null,
    });

    const errored = applyConnectionStatus(state, {
      status: 'error',
      connected: false,
      lastError: {
        source: 'connect_error',
        code: 'CONNECT_ERROR',
        message: 'Temporary drop',
      },
    });
    expect(errored).toMatchObject({
      connectionStatus: 'error',
      roomId: 'ship-83a1',
      peerState: 'connected',
      entryRole: 'joiner',
      negotiationDuty: 'answerer',
      selfPeerId: 'peer-2',
    });

    // Mismatched room leave request leaves state unchanged.
    expect(applyLocalRoomLeave(state, 'ship-1111')).toEqual(state);

    const left = applyLocalRoomLeave(state);
    expect(left).toEqual({
      connectionStatus: 'connected',
      roomId: null,
      peerState: 'unaffiliated',
      entryRole: null,
      negotiationDuty: null,
      selfPeerId: null,
      remotePeerId: null,
      lastError: null,
      eventLog: state.eventLog,
    });

    const cleared = clearEventLog(state);
    expect(cleared).toMatchObject({
      entryRole: 'joiner',
      selfPeerId: 'peer-2',
      remotePeerId: null,
      eventLog: [],
    });

    const resetFromServerEvent = applySignalingServerEvent(
      state,
      'disconnect',
      'transport close',
    );
    expect(resetFromServerEvent).toEqual(resetRoomMembership(state));
    expect(resetFromServerEvent.eventLog).toHaveLength(1);
  });
});

describe('createRoomLifecycleActions and bindSignalingClient room flow', () => {
  test('first peer creates a room, second peer joins, and either peer can leave while remaining peer stays', () => {
    const ioFactory = createMockSocketFactory();
    let tick = 0;
    const now = () => `2026-11-18T16:10:0${tick++}.000Z`;

    const peerAClient = createSignalingClient({ ioFactory, now });
    const peerBClient = createSignalingClient({ ioFactory, now });

    const peerA = createStateHarness();
    const peerB = createStateHarness();

    const unbindA = bindSignalingClient(peerAClient, peerA.setState);
    const unbindB = bindSignalingClient(peerBClient, peerB.setState);

    const actionsA = createRoomLifecycleActions(peerAClient, peerA.setState);
    const actionsB = createRoomLifecycleActions(peerBClient, peerB.setState);

    peerAClient.connect();
    const socketA = ioFactory.calls[0].socket;
    peerBClient.connect();
    const socketB = ioFactory.calls[1].socket;

    // 1. Peer A creates room.
    actionsA.createRoom();
    expect(socketA.emittedEvents).toContainEqual({
      event: 'room:create',
      args: [{}],
    });

    socketA.simulateServerEvent('room:created', {
      roomId: 'ship-83a1',
      peerId: 'peer-a',
      negotiationDuty: 'offerer',
    });

    expect(peerA.getState()).toMatchObject({
      connectionStatus: 'connected',
      roomId: 'ship-83a1',
      peerState: 'waiting_for_peer',
      entryRole: 'creator',
      negotiationDuty: 'offerer',
      selfPeerId: 'peer-a',
      remotePeerId: null,
    });

    // 2. Peer B ignores blank input and trims whitespace on joinRoom.
    expect(actionsB.joinRoom('   ')).toBe(false);
    expect(socketB.emittedEvents).toEqual([]);

    expect(actionsB.joinRoom('  ship-83a1  ')).toBe(true);
    expect(socketB.emittedEvents).toContainEqual({
      event: 'room:join',
      args: [{ roomId: 'ship-83a1' }],
    });

    socketB.simulateServerEvent('room:joined', {
      roomId: 'ship-83a1',
      peerId: 'peer-b',
      negotiationDuty: 'answerer',
    });
    socketA.simulateServerEvent('peer:joined', {
      roomId: 'ship-83a1',
      peerId: 'peer-b',
    });

    expect(peerB.getState()).toMatchObject({
      roomId: 'ship-83a1',
      peerState: 'connected',
      entryRole: 'joiner',
      negotiationDuty: 'answerer',
      selfPeerId: 'peer-b',
      remotePeerId: null,
    });
    expect(peerA.getState()).toMatchObject({
      roomId: 'ship-83a1',
      peerState: 'connected',
      entryRole: 'creator',
      negotiationDuty: 'offerer',
      selfPeerId: 'peer-a',
      remotePeerId: 'peer-b',
    });

    // 3. Creator (Peer A) leaves explicitly while joiner (Peer B) remains and becomes offerer.
    expect(actionsA.leaveRoom('   ')).toBe(false);
    expect(actionsA.leaveRoom('ship-83a1')).toBe(true);

    expect(socketA.emittedEvents).toContainEqual({
      event: 'room:leave',
      args: [{ roomId: 'ship-83a1' }],
    });
    expect(peerA.getState()).toMatchObject({
      connectionStatus: 'connected',
      roomId: null,
      peerState: 'unaffiliated',
      entryRole: null,
      negotiationDuty: null,
      selfPeerId: null,
      remotePeerId: null,
    });
    expect(peerA.getState().eventLog.map((entry) => entry.event)).toEqual([
      'connect',
      'room:create',
      'room:created',
      'peer:joined',
      'room:leave',
    ]);

    socketB.simulateServerEvent('peer:left', {
      roomId: 'ship-83a1',
      peerId: 'peer-a',
      reason: 'leave',
    });

    expect(peerB.getState()).toMatchObject({
      connectionStatus: 'connected',
      roomId: 'ship-83a1',
      peerState: 'waiting_for_peer',
      entryRole: 'joiner',
      negotiationDuty: 'offerer',
      selfPeerId: 'peer-b',
      remotePeerId: null,
    });

    // 4. Replacement peer joins Peer B, then Peer B leaves explicitly.
    socketB.simulateServerEvent('peer:joined', {
      roomId: 'ship-83a1',
      peerId: 'peer-c',
    });
    expect(peerB.getState()).toMatchObject({
      roomId: 'ship-83a1',
      peerState: 'connected',
      entryRole: 'joiner',
      negotiationDuty: 'offerer',
      selfPeerId: 'peer-b',
      remotePeerId: 'peer-c',
    });

    expect(actionsB.leaveRoom('  ship-83a1  ')).toBe(true);
    expect(peerB.getState()).toMatchObject({
      connectionStatus: 'connected',
      roomId: null,
      peerState: 'unaffiliated',
      entryRole: null,
      negotiationDuty: null,
      selfPeerId: null,
      remotePeerId: null,
    });
    expect(peerB.getState().eventLog.map((entry) => entry.event)).toEqual([
      'connect',
      'room:join',
      'room:joined',
      'peer:left',
      'peer:joined',
      'room:leave',
    ]);

    unbindA();
    unbindB();
    peerAClient.dispose();
    peerBClient.dispose();
  });

  test('joiner leaving or disconnecting keeps creator waiting as offerer for replacement peer and validates action args', () => {
    expect(() => createRoomLifecycleActions(null, () => {})).toThrow(TypeError);
    expect(() => createRoomLifecycleActions({}, 'not-a-fn')).toThrow(
      TypeError,
    );

    const ioFactory = createMockSocketFactory();
    let tick = 0;
    const now = () => `2026-11-18T16:15:0${tick++}.000Z`;

    const peerAClient = createSignalingClient({ ioFactory, now });
    const peerBClient = createSignalingClient({ ioFactory, now });

    const peerA = createStateHarness();
    const peerB = createStateHarness();

    const unbindA = bindSignalingClient(peerAClient, peerA.setState);
    const unbindB = bindSignalingClient(peerBClient, peerB.setState);

    const actionsA = createRoomLifecycleActions(peerAClient, peerA.setState);
    const actionsB = createRoomLifecycleActions(peerBClient, peerB.setState);

    peerAClient.connect();
    const socketA = ioFactory.calls[0].socket;
    peerBClient.connect();
    const socketB = ioFactory.calls[1].socket;

    actionsA.createRoom();
    socketA.simulateServerEvent('room:created', {
      roomId: 'ship-83a1',
      peerId: 'peer-a',
      negotiationDuty: 'offerer',
    });

    actionsB.joinRoom('ship-83a1');
    socketB.simulateServerEvent('room:joined', {
      roomId: 'ship-83a1',
      peerId: 'peer-b',
      negotiationDuty: 'answerer',
    });
    socketA.simulateServerEvent('peer:joined', {
      roomId: 'ship-83a1',
      peerId: 'peer-b',
    });

    // Joiner leaves explicitly while creator remains waiting in the room.
    expect(actionsB.leaveRoom('ship-83a1')).toBe(true);
    expect(peerB.getState()).toMatchObject({
      roomId: null,
      peerState: 'unaffiliated',
      entryRole: null,
      negotiationDuty: null,
    });

    socketA.simulateServerEvent('peer:left', {
      roomId: 'ship-83a1',
      peerId: 'peer-b',
      reason: 'leave',
    });
    expect(peerA.getState()).toMatchObject({
      roomId: 'ship-83a1',
      peerState: 'waiting_for_peer',
      entryRole: 'creator',
      negotiationDuty: 'offerer',
      selfPeerId: 'peer-a',
      remotePeerId: null,
    });

    // Replacement peer joins, then disconnects unexpectedly.
    socketA.simulateServerEvent('peer:joined', {
      roomId: 'ship-83a1',
      peerId: 'peer-c',
    });
    expect(peerA.getState()).toMatchObject({
      peerState: 'connected',
      remotePeerId: 'peer-c',
      negotiationDuty: 'offerer',
    });

    socketA.simulateServerEvent('peer:left', {
      roomId: 'ship-83a1',
      peerId: 'peer-c',
      reason: 'disconnect',
    });
    expect(peerA.getState()).toMatchObject({
      roomId: 'ship-83a1',
      peerState: 'waiting_for_peer',
      entryRole: 'creator',
      negotiationDuty: 'offerer',
      remotePeerId: null,
    });

    unbindA();
    unbindB();
    peerAClient.dispose();
    peerBClient.dispose();
  });

  test('bindSignalingClient resets active room state on disconnect while preserving sanitized eventLog and unbinds cleanly', () => {
    const ioFactory = createMockSocketFactory();
    let tick = 0;
    const client = createSignalingClient({
      ioFactory,
      now: () => `2026-11-18T16:20:0${tick++}.000Z`,
    });

    const harness = createStateHarness();
    const unbind = bindSignalingClient(client, harness.setState);

    client.connect();
    const socket = ioFactory.lastSocket;

    socket.simulateServerEvent('room:created', {
      roomId: 'ship-83a1',
      peerId: 'peer-a',
      negotiationDuty: 'offerer',
    });
    socket.simulateServerEvent('peer:joined', {
      roomId: 'ship-83a1',
      peerId: 'peer-b',
    });

    expect(harness.getState().peerState).toBe('connected');

    socket.simulateDisconnect('transport close');

    expect(harness.getState()).toMatchObject({
      connectionStatus: 'disconnected',
      roomId: null,
      peerState: 'unaffiliated',
      entryRole: null,
      negotiationDuty: null,
      selfPeerId: null,
      remotePeerId: null,
    });
    expect(harness.getState().eventLog.map((entry) => entry.event)).toEqual([
      'connect',
      'room:created',
      'peer:joined',
      'disconnect',
    ]);

    // Unbind stops subsequent server events from updating state.
    unbind();
    const countBeforeLateEvents = harness.getState().eventLog.length;
    socket.simulateConnect();
    socket.simulateServerEvent('room:created', {
      roomId: 'ship-beef',
      peerId: 'peer-late',
      negotiationDuty: 'offerer',
    });
    expect(harness.getState().roomId).toBeNull();
    expect(harness.getState().eventLog).toHaveLength(countBeforeLateEvents);

    client.dispose();
  });

  test('bindSignalingClient also resets room state when disconnect arrives via subscribeServerEvent', () => {
    const statusListeners = new Set();
    const serverListeners = new Map();

    const mockClient = {
      getStatus: () => ({
        status: 'connected',
        connected: true,
        url: 'http://localhost:5001',
        lastError: null,
        disconnectReason: null,
      }),
      subscribeStatus: (listener) => {
        statusListeners.add(listener);
        return () => statusListeners.delete(listener);
      },
      subscribeServerEvent: (event, listener) => {
        const set = serverListeners.get(event) ?? new Set();
        set.add(listener);
        serverListeners.set(event, set);
        return () => set.delete(listener);
      },
    };

    const harness = createStateHarness({
      eventLog: [
        {
          direction: 'local',
          event: 'diagnostic:note',
          timestamp: '2026-11-18T16:30:00.000Z',
          summary: 'Existing log entry',
        },
      ],
    });

    const unbind = bindSignalingClient(mockClient, harness.setState);

    for (const listener of serverListeners.get('room:joined') ?? []) {
      listener({
        roomId: 'ship-83a1',
        peerId: 'peer-b',
        negotiationDuty: 'answerer',
      });
    }
    expect(harness.getState().peerState).toBe('connected');

    for (const listener of serverListeners.get('disconnect') ?? []) {
      listener({ reason: 'io server disconnect' });
    }

    expect(harness.getState()).toMatchObject({
      roomId: null,
      peerState: 'unaffiliated',
      entryRole: null,
      negotiationDuty: null,
      selfPeerId: null,
      remotePeerId: null,
    });
    expect(harness.getState().eventLog).toHaveLength(1);

    unbind();
    for (const set of serverListeners.values()) {
      expect(set.size).toBe(0);
    }
  });
});

describe('App static markup for room lifecycle controls and equal-peer duties', () => {
  test('renders room lifecycle controls, entry role, signaling-only duty, and equal-peer copy without transfer roles', () => {
    const defaultMarkup = renderToStaticMarkup(React.createElement(App));

    expect(defaultMarkup).toContain('Create Room');
    expect(defaultMarkup).toContain('Join Room');
    expect(defaultMarkup).toContain('<input');
    expect(defaultMarkup).toContain('Leave Room');
    expect(defaultMarkup).toContain('Entry Role');
    expect(defaultMarkup).toContain('Entry history only');
    expect(defaultMarkup).toContain('Negotiation Duty');
    expect(defaultMarkup).toContain('Signaling-only');
    expect(defaultMarkup).toMatch(/equal peers/i);
    expect(defaultMarkup).toMatch(/file-transfer direction/i);
    expect(defaultMarkup).not.toMatch(/\bsender\b|\breceiver\b/i);

    const creatorMarkup = renderToStaticMarkup(
      React.createElement(App, {
        initialState: {
          connectionStatus: 'connected',
          roomId: 'ship-83a1',
          peerState: 'waiting_for_peer',
          entryRole: 'creator',
          negotiationDuty: 'offerer',
          selfPeerId: 'peer-creator-1',
        },
      }),
    );
    expect(creatorMarkup).toContain('ship-83a1');
    expect(creatorMarkup).toContain('waiting_for_peer');
    expect(creatorMarkup).toContain('creator');
    expect(creatorMarkup).toContain('offerer');
    expect(creatorMarkup).toContain('peer-creator-1');

    const promotedJoinerMarkup = renderToStaticMarkup(
      React.createElement(App, {
        initialState: {
          connectionStatus: 'connected',
          roomId: 'ship-83a1',
          peerState: 'waiting_for_peer',
          entryRole: 'joiner',
          negotiationDuty: 'offerer',
          selfPeerId: 'peer-joiner-2',
        },
      }),
    );
    expect(promotedJoinerMarkup).toContain('joiner');
    expect(promotedJoinerMarkup).toContain('offerer');
    expect(promotedJoinerMarkup).not.toMatch(/\bsender\b|\breceiver\b/i);

    const ioFactory = createMockSocketFactory();
    const client = createSignalingClient({ ioFactory });
    const ssrMarkup = renderToStaticMarkup(
      React.createElement(App, { signalingClient: client }),
    );
    expect(ssrMarkup).toContain('Create Room');
    expect(ioFactory.calls).toHaveLength(0);
    client.dispose();
  });
});
