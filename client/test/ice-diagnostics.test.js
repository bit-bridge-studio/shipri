import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, test, vi } from 'vitest';
import App from '../src/App.jsx';
import {
  applyIceCredentials,
  applyIceRequestStarted,
  applyRoomError,
  bindSignalingClient,
  clearLastError,
  createInitialPrototypeState,
  createRoomLifecycleActions,
  recoverErrorState,
} from '../src/prototype/diagnostic-state.js';
import {
  createInitialIceDiagnosticsState,
  summarizeIceServers,
  validateIceCredentialsPayload,
} from '../src/prototype/ice-diagnostics.js';
import { resolveRoomErrorDescriptor } from '../src/prototype/room-errors.js';
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

describe('summarizeIceServers and validateIceCredentialsPayload', () => {
  test('accepts valid Backend POC STUN-only ice:credentials payloads and produces sanitized summaries', () => {
    const multiUrlPayload = {
      roomId: 'ship-83a1',
      iceServers: [
        {
          urls: [
            'stun:stun.l.google.com:19302',
            'stun:stun1.l.google.com:19302',
          ],
        },
      ],
    };

    expect(summarizeIceServers(multiUrlPayload.iceServers)).toEqual({
      serverEntryCount: 1,
      endpointCount: 2,
      schemes: ['stun'],
      stunCount: 2,
      turnCount: 0,
      isStunOnly: true,
      endpointsRedacted: true,
    });

    const multiResult = validateIceCredentialsPayload(multiUrlPayload, {
      expectedRoomId: 'ship-83a1',
    });
    expect(multiResult).toEqual({
      ok: true,
      roomId: 'ship-83a1',
      iceServers: [
        {
          urls: [
            'stun:stun.l.google.com:19302',
            'stun:stun1.l.google.com:19302',
          ],
        },
      ],
      summary: {
        serverEntryCount: 1,
        endpointCount: 2,
        schemes: ['stun'],
        stunCount: 2,
        turnCount: 0,
        isStunOnly: true,
        endpointsRedacted: true,
      },
    });
    expect(JSON.stringify(multiResult.summary)).not.toContain('stun.l.google.com');

    const singleStringPayload = {
      roomId: 'ship-0f2b',
      iceServers: [
        { urls: 'stun:stun.example.org:3478' },
        { urls: ['stuns:stun.example.org:5349'] },
      ],
    };
    const singleResult = validateIceCredentialsPayload(singleStringPayload);
    expect(singleResult.ok).toBe(true);
    expect(singleResult.roomId).toBe('ship-0f2b');
    expect(singleResult.summary).toEqual({
      serverEntryCount: 2,
      endpointCount: 2,
      schemes: ['stun', 'stuns'],
      stunCount: 2,
      turnCount: 0,
      isStunOnly: true,
      endpointsRedacted: true,
    });
    expect(JSON.stringify(singleResult.summary)).not.toContain('stun.example.org');

    // summarizeIceServers handles TURN entries safely without exposing credentials or URLs.
    const mixedSummary = summarizeIceServers([
      { urls: 'stun:stun.l.google.com:19302' },
      {
        urls: ['turn:turn.shipri.app:3478?transport=udp', 'turns:turn.shipri.app:443'],
        username: 'secretTurnUser',
        credential: 'secretTurnPassword',
        TURN_SHARED_SECRET: 'secretTurnShared',
      },
    ]);
    expect(mixedSummary).toEqual({
      serverEntryCount: 2,
      endpointCount: 3,
      schemes: ['stun', 'turn', 'turns'],
      stunCount: 1,
      turnCount: 2,
      isStunOnly: false,
      endpointsRedacted: true,
    });
    const serializedMixed = JSON.stringify(mixedSummary);
    expect(serializedMixed).not.toContain('secretTurnUser');
    expect(serializedMixed).not.toContain('secretTurnPassword');
    expect(serializedMixed).not.toContain('secretTurnShared');
    expect(serializedMixed).not.toContain('turn.shipri.app');
    expect(serializedMixed).not.toContain('stun.l.google.com');
  });

  test('rejects malformed, mismatched, invalid-URI, and TURN/credential-bearing ice:credentials payloads without leaking secrets', () => {
    const malformedCases = [
      { label: 'null payload', payload: null },
      { label: 'undefined payload', payload: undefined },
      { label: 'string payload', payload: 'ship-83a1' },
      { label: 'array payload', payload: [] },
      {
        label: 'missing roomId',
        payload: { iceServers: [{ urls: ['stun:stun.l.google.com:19302'] }] },
      },
      {
        label: 'invalid roomId',
        payload: {
          roomId: 'bad-room-id#key=secretRoomFrag',
          iceServers: [{ urls: ['stun:stun.l.google.com:19302'] }],
        },
      },
      {
        label: 'mismatched roomId',
        payload: {
          roomId: 'ship-9999',
          iceServers: [{ urls: ['stun:stun.l.google.com:19302'] }],
        },
        options: { expectedRoomId: 'ship-83a1' },
      },
      {
        label: 'missing iceServers',
        payload: { roomId: 'ship-83a1' },
      },
      {
        label: 'non-array iceServers',
        payload: { roomId: 'ship-83a1', iceServers: 'stun:stun.l.google.com:19302' },
      },
      {
        label: 'empty iceServers',
        payload: { roomId: 'ship-83a1', iceServers: [] },
      },
      {
        label: 'non-object iceServers entry',
        payload: { roomId: 'ship-83a1', iceServers: ['stun:stun.l.google.com:19302'] },
      },
      {
        label: 'missing urls',
        payload: { roomId: 'ship-83a1', iceServers: [{}] },
      },
      {
        label: 'empty urls string',
        payload: { roomId: 'ship-83a1', iceServers: [{ urls: '   ' }] },
      },
      {
        label: 'empty urls array',
        payload: { roomId: 'ship-83a1', iceServers: [{ urls: [] }] },
      },
      {
        label: 'invalid URI without scheme',
        payload: { roomId: 'ship-83a1', iceServers: [{ urls: 'not-a-uri' }] },
      },
      {
        label: 'invalid http scheme',
        payload: {
          roomId: 'ship-83a1',
          iceServers: [{ urls: ['http://stun.l.google.com:19302'] }],
        },
      },
      {
        label: 'invalid double slash STUN authority',
        payload: {
          roomId: 'ship-83a1',
          iceServers: [{ urls: ['stun://stun.l.google.com:19302'] }],
        },
      },
      {
        label: 'invalid zero port',
        payload: {
          roomId: 'ship-83a1',
          iceServers: [{ urls: ['stun:stun.l.google.com:0'] }],
        },
      },
      {
        label: 'invalid out-of-range port',
        payload: {
          roomId: 'ship-83a1',
          iceServers: [{ urls: ['stun:stun.l.google.com:70000'] }],
        },
      },
      {
        label: 'invalid non-numeric port',
        payload: {
          roomId: 'ship-83a1',
          iceServers: [{ urls: ['stun:stun.l.google.com:abc'] }],
        },
      },
      {
        label: 'embedded URL secret/credentials',
        payload: {
          roomId: 'ship-83a1',
          iceServers: [
            { urls: ['stun:secretUrlUser:secretUrlPass@stun.l.google.com:19302#key=secretUrlFrag'] },
          ],
        },
      },
      {
        label: 'unexpected turn URL in POC mode',
        payload: {
          roomId: 'ship-83a1',
          iceServers: [{ urls: ['turn:turn.shipri.app:3478'] }],
        },
      },
      {
        label: 'unexpected turns URL in POC mode',
        payload: {
          roomId: 'ship-83a1',
          iceServers: [{ urls: ['turns:turn.shipri.app:443?transport=tcp'] }],
        },
      },
      {
        label: 'unexpected username and credential fields on server entry',
        payload: {
          roomId: 'ship-83a1',
          iceServers: [
            {
              urls: ['stun:stun.l.google.com:19302'],
              username: 'leakUsernameVal',
              credential: 'leakCredentialVal',
            },
          ],
        },
      },
      {
        label: 'unexpected TURN_SHARED_SECRET top-level field',
        payload: {
          roomId: 'ship-83a1',
          iceServers: [{ urls: ['stun:stun.l.google.com:19302'] }],
          TURN_SHARED_SECRET: 'leakSharedSecretVal',
          authToken: 'leakAuthTokenVal',
        },
      },
    ];

    const forbiddenSecrets = [
      'secretRoomFrag',
      'secretUrlUser',
      'secretUrlPass',
      'secretUrlFrag',
      'leakUsernameVal',
      'leakCredentialVal',
      'leakSharedSecretVal',
      'leakAuthTokenVal',
      'turn.shipri.app',
      'stun.l.google.com',
    ];

    for (const testCase of malformedCases) {
      const result = validateIceCredentialsPayload(
        testCase.payload,
        testCase.options,
      );
      expect(result.ok, testCase.label).toBe(false);
      expect(result.error.code, testCase.label).toBe('INVALID_ICE_CREDENTIALS');
      expect(typeof result.error.message, testCase.label).toBe('string');
      expect(result.error.message.length, testCase.label).toBeGreaterThan(0);

      const serialized = JSON.stringify(result);
      for (const secret of forbiddenSecrets) {
        expect(serialized, `${testCase.label} leaked ${secret}`).not.toContain(
          secret,
        );
      }
    }
  });

  test('resolves INVALID_ICE_CREDENTIALS error descriptor with validation category', () => {
    const descriptor = resolveRoomErrorDescriptor('INVALID_ICE_CREDENTIALS');
    expect(descriptor).toMatchObject({
      code: 'INVALID_ICE_CREDENTIALS',
      category: 'validation',
      preservesMembership: true,
      known: true,
    });
    expect(descriptor.recoveryGuidance.length).toBeGreaterThan(0);
    expect(
      resolveRoomErrorDescriptor({
        code: 'INVALID_ICE_CREDENTIALS',
        message: 'Raw server message',
      }),
    ).toEqual(descriptor);
  });
});

describe('ICE diagnostics state transitions and bindSignalingClient integration', () => {
  test('preserves baseline 6-key createInitialPrototypeState when iceDiagnostics is omitted', () => {
    expect(createInitialPrototypeState()).toEqual({
      connectionStatus: 'disconnected',
      roomId: null,
      peerState: 'unaffiliated',
      negotiationDuty: null,
      lastError: null,
      eventLog: [],
    });

    expect(createInitialIceDiagnosticsState()).toEqual({
      status: 'idle',
      roomId: null,
      serverEntryCount: 0,
      endpointCount: 0,
      schemes: [],
      stunCount: 0,
      turnCount: 0,
      isStunOnly: false,
      endpointsRedacted: true,
      lastError: null,
    });
  });

  test('requestIce requires active roomId, emits ice:get, transitions loading -> ready on valid ice:credentials, and resets on leave/disconnect', () => {
    const ioFactory = createMockSocketFactory();
    let tick = 0;
    const client = createSignalingClient({
      ioFactory,
      now: () => `2026-11-22T18:00:0${tick++}.000Z`,
    });
    const harness = createStateHarness();
    const unbind = bindSignalingClient(client, harness.setState);
    const actions = createRoomLifecycleActions(client, harness.setState);

    client.connect();
    const socket = ioFactory.lastSocket;

    // Blank or invalid room IDs do not emit ice:get.
    expect(actions.requestIce('')).toBe(false);
    expect(actions.requestIce('   ')).toBe(false);
    expect(actions.requestIce('invalid-room')).toBe(false);
    expect(socket.emittedEvents).toEqual([]);

    // Enter active room as creator.
    actions.createRoom();
    socket.simulateServerEvent('room:created', {
      roomId: 'ship-83a1',
      peerId: 'peer-a',
      negotiationDuty: 'offerer',
    });

    expect(actions.requestIce('  ship-83a1  ')).toBe(true);
    expect(socket.emittedEvents).toContainEqual({
      event: 'ice:get',
      args: [{ roomId: 'ship-83a1' }],
    });
    expect(harness.getState().iceDiagnostics).toMatchObject({
      status: 'loading',
      roomId: 'ship-83a1',
      lastError: null,
    });

    // Valid STUN-only response transitions iceDiagnostics to ready.
    socket.simulateServerEvent('ice:credentials', {
      roomId: 'ship-83a1',
      iceServers: [
        {
          urls: [
            'stun:stun.l.google.com:19302',
            'stun:stun1.l.google.com:19302',
          ],
        },
      ],
    });

    expect(harness.getState().lastError).toBeNull();
    expect(harness.getState().iceDiagnostics).toEqual({
      status: 'ready',
      roomId: 'ship-83a1',
      serverEntryCount: 1,
      endpointCount: 2,
      schemes: ['stun'],
      stunCount: 2,
      turnCount: 0,
      isStunOnly: true,
      endpointsRedacted: true,
      lastError: null,
    });
    expect(JSON.stringify(harness.getState())).not.toContain('stun.l.google.com');

    // Leaving room resets iceDiagnostics while preserving eventLog.
    expect(actions.leaveRoom('ship-83a1')).toBe(true);
    expect(harness.getState().roomId).toBeNull();
    expect(harness.getState().iceDiagnostics).toEqual(
      createInitialIceDiagnosticsState(),
    );
    expect(harness.getState().eventLog.map((entry) => entry.event)).toEqual([
      'connect',
      'room:create',
      'room:created',
      'ice:get',
      'ice:credentials',
      'room:leave',
    ]);

    // Join a second room, receive ICE, then simulate socket disconnect.
    socket.simulateServerEvent('room:joined', {
      roomId: 'ship-4c2d',
      peerId: 'peer-b',
      negotiationDuty: 'answerer',
    });
    expect(actions.requestIce('ship-4c2d')).toBe(true);
    socket.simulateServerEvent('ice:credentials', {
      roomId: 'ship-4c2d',
      iceServers: [{ urls: 'stuns:stun.example.org:5349' }],
    });
    expect(harness.getState().iceDiagnostics).toMatchObject({
      status: 'ready',
      roomId: 'ship-4c2d',
      serverEntryCount: 1,
      endpointCount: 1,
      schemes: ['stuns'],
      stunCount: 1,
      turnCount: 0,
      isStunOnly: true,
    });

    socket.simulateDisconnect('transport close');
    expect(harness.getState().roomId).toBeNull();
    expect(harness.getState().iceDiagnostics).toEqual(
      createInitialIceDiagnosticsState(),
    );
    expect(harness.getState().eventLog.at(-1).event).toBe('disconnect');

    unbind();
    client.dispose();
  });

  test('malformed inbound ice:credentials sets status invalid and sanitized lastError without dropping room membership', () => {
    const ioFactory = createMockSocketFactory();
    let tick = 0;
    const client = createSignalingClient({
      ioFactory,
      now: () => `2026-11-22T18:10:0${tick++}.000Z`,
    });
    const harness = createStateHarness();
    const unbind = bindSignalingClient(client, harness.setState);
    const actions = createRoomLifecycleActions(client, harness.setState);

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

    actions.requestIce('ship-83a1');
    socket.simulateServerEvent('ice:credentials', {
      roomId: 'ship-83a1',
      iceServers: [
        {
          urls: ['turn:turn.shipri.app:443?transport=tcp'],
          username: 'malformedUserSecret',
          credential: 'malformedTurnSecret',
        },
      ],
      TURN_SHARED_SECRET: 'malformedGlobalSecret',
    });

    const stateAfterInvalid = harness.getState();
    expect(stateAfterInvalid).toMatchObject({
      connectionStatus: 'connected',
      roomId: 'ship-83a1',
      peerState: 'connected',
      entryRole: 'creator',
      negotiationDuty: 'offerer',
      selfPeerId: 'peer-a',
      remotePeerId: 'peer-b',
      lastError: {
        source: 'ice:credentials',
        code: 'INVALID_ICE_CREDENTIALS',
        roomId: 'ship-83a1',
      },
    });
    expect(stateAfterInvalid.iceDiagnostics).toMatchObject({
      status: 'invalid',
      roomId: 'ship-83a1',
      serverEntryCount: 0,
      endpointCount: 0,
      schemes: [],
      stunCount: 0,
      turnCount: 0,
      isStunOnly: false,
      lastError: {
        code: 'INVALID_ICE_CREDENTIALS',
        roomId: 'ship-83a1',
      },
    });

    const serialized = JSON.stringify(stateAfterInvalid);
    expect(serialized).not.toContain('malformedUserSecret');
    expect(serialized).not.toContain('malformedTurnSecret');
    expect(serialized).not.toContain('malformedGlobalSecret');
    expect(serialized).not.toContain('turn.shipri.app');

    // Mismatched roomId also sets invalid without clearing active room membership.
    const mismatched = applyIceCredentials(
      applyIceRequestStarted(stateAfterInvalid, 'ship-83a1'),
      {
        roomId: 'ship-ffff',
        iceServers: [{ urls: ['stun:stun.l.google.com:19302'] }],
      },
    );
    expect(mismatched.roomId).toBe('ship-83a1');
    expect(mismatched.iceDiagnostics.status).toBe('invalid');
    expect(mismatched.lastError.code).toBe('INVALID_ICE_CREDENTIALS');

    unbind();
    client.dispose();
  });

  test('server failures (SERVER_BUSY, UNAUTHORIZED, ROOM_NOT_FOUND) set iceDiagnostics.status to error while preserving membership and supporting selective recovery', () => {
    const ioFactory = createMockSocketFactory();
    let tick = 0;
    const client = createSignalingClient({
      ioFactory,
      now: () => `2026-11-22T18:20:0${tick++}.000Z`,
    });
    const harness = createStateHarness();
    const unbind = bindSignalingClient(client, harness.setState);
    const actions = createRoomLifecycleActions(client, harness.setState);

    client.connect();
    const socket = ioFactory.lastSocket;

    socket.simulateServerEvent('room:created', {
      roomId: 'ship-83a1',
      peerId: 'peer-a',
      negotiationDuty: 'offerer',
    });

    // 1. SERVER_BUSY while awaiting ice:credentials.
    actions.requestIce('ship-83a1');
    socket.simulateServerEvent('room:error', {
      roomId: 'ship-83a1',
      code: 'SERVER_BUSY',
      message:
        'Development ICE unavailable TURN_SHARED_SECRET=serverBusySecret https://u:pw@poc.shipri.app/#key=fragBusy',
    });

    expect(harness.getState()).toMatchObject({
      roomId: 'ship-83a1',
      peerState: 'waiting_for_peer',
      entryRole: 'creator',
      negotiationDuty: 'offerer',
      lastError: {
        source: 'room:error',
        code: 'SERVER_BUSY',
        roomId: 'ship-83a1',
      },
      iceDiagnostics: {
        status: 'error',
        roomId: 'ship-83a1',
        serverEntryCount: 0,
        endpointCount: 0,
        schemes: [],
        lastError: {
          code: 'SERVER_BUSY',
          roomId: 'ship-83a1',
        },
      },
    });
    expect(JSON.stringify(harness.getState())).not.toContain('serverBusySecret');
    expect(JSON.stringify(harness.getState())).not.toContain('fragBusy');

    // Selective recovery clears lastError without dropping room membership or eventLog.
    const logLengthBeforeClear = harness.getState().eventLog.length;
    harness.setState((prev) => recoverErrorState(prev));
    expect(harness.getState().lastError).toBeNull();
    expect(harness.getState().iceDiagnostics.lastError).toBeNull();
    expect(harness.getState().roomId).toBe('ship-83a1');
    expect(harness.getState().peerState).toBe('waiting_for_peer');
    expect(harness.getState().eventLog).toHaveLength(logLengthBeforeClear);

    // 2. UNAUTHORIZED while awaiting ice:credentials.
    actions.requestIce('ship-83a1');
    socket.simulateServerEvent('room:error', {
      roomId: 'ship-83a1',
      code: 'UNAUTHORIZED',
      message: 'Socket is not a member of this room.',
    });
    expect(harness.getState().iceDiagnostics).toMatchObject({
      status: 'error',
      lastError: {
        code: 'UNAUTHORIZED',
        roomId: 'ship-83a1',
      },
    });

    harness.setState((prev) => clearLastError(prev));
    expect(harness.getState().lastError).toBeNull();
    expect(harness.getState().roomId).toBe('ship-83a1');

    // 3. ROOM_NOT_FOUND while awaiting ice:credentials.
    actions.requestIce('ship-83a1');
    socket.simulateServerEvent('room:error', {
      roomId: 'ship-83a1',
      code: 'ROOM_NOT_FOUND',
      message: 'Room does not exist or has expired.',
    });
    expect(harness.getState().iceDiagnostics).toMatchObject({
      status: 'error',
      lastError: {
        code: 'ROOM_NOT_FOUND',
        roomId: 'ship-83a1',
      },
    });

    // Direct applyRoomError with SERVER_BUSY also sets iceDiagnostics.status = 'error'.
    const directServerBusy = applyRoomError(
      createInitialPrototypeState({
        connectionStatus: 'connected',
        roomId: 'ship-83a1',
        peerState: 'waiting_for_peer',
      }),
      {
        roomId: 'ship-83a1',
        code: 'SERVER_BUSY',
        message: 'Development ICE configuration is unavailable.',
      },
    );
    expect(directServerBusy.iceDiagnostics).toMatchObject({
      status: 'error',
      roomId: 'ship-83a1',
      lastError: {
        code: 'SERVER_BUSY',
        roomId: 'ship-83a1',
      },
    });

    // Retry succeeds after recovery.
    actions.requestIce('ship-83a1');
    socket.simulateServerEvent('ice:credentials', {
      roomId: 'ship-83a1',
      iceServers: [{ urls: ['stun:stun.l.google.com:19302'] }],
    });
    expect(harness.getState().lastError).toBeNull();
    expect(harness.getState().iceDiagnostics).toMatchObject({
      status: 'ready',
      serverEntryCount: 1,
      endpointCount: 1,
      schemes: ['stun'],
      stunCount: 1,
      turnCount: 0,
      isStunOnly: true,
      lastError: null,
    });

    unbind();
    client.dispose();
  });
});

describe('App static markup for ICE configuration diagnostics', () => {
  test('renders ICE Configuration Diagnostics panel, disabled Request ICE Config button without connection or roomId, counts, schemes, and sanitized failures', () => {
    const defaultMarkup = renderToStaticMarkup(React.createElement(App));
    expect(defaultMarkup).toContain('ICE Configuration Diagnostics');
    expect(defaultMarkup).toContain('Request ICE Config');
    expect(defaultMarkup).toContain('ICE Status');
    expect(defaultMarkup).toContain('idle');
    expect(defaultMarkup).toContain('Server Entries');
    expect(defaultMarkup).toContain('Endpoint URLs');
    expect(defaultMarkup).toContain('Schemes');
    expect(defaultMarkup).toContain('STUN / TURN Counts');
    expect(defaultMarkup).toContain('STUN: 0 / TURN: 0');
    expect(defaultMarkup).toMatch(
      /<button[^>]*disabled=""[^>]*>Request ICE Config<\/button>/,
    );

    const connectedNoRoomMarkup = renderToStaticMarkup(
      React.createElement(App, {
        initialState: {
          connectionStatus: 'connected',
          roomId: null,
        },
      }),
    );
    expect(connectedNoRoomMarkup).toMatch(
      /<button[^>]*disabled=""[^>]*>Request ICE Config<\/button>/,
    );

    const readyMarkup = renderToStaticMarkup(
      React.createElement(App, {
        initialState: {
          connectionStatus: 'connected',
          roomId: 'ship-83a1',
          peerState: 'connected',
          entryRole: 'creator',
          negotiationDuty: 'offerer',
          iceDiagnostics: {
            status: 'ready',
            roomId: 'ship-83a1',
            serverEntryCount: 1,
            endpointCount: 2,
            schemes: ['stun'],
            stunCount: 2,
            turnCount: 0,
            isStunOnly: true,
          },
        },
      }),
    );
    expect(readyMarkup).toContain('ready');
    expect(readyMarkup).toContain('stun');
    expect(readyMarkup).toContain('STUN: 2 / TURN: 0');
    expect(readyMarkup).toContain('Development STUN-only');
    expect(readyMarkup).toMatch(
      /<button(?![^>]*disabled)[^>]*>Request ICE Config<\/button>/,
    );
    expect(readyMarkup).not.toMatch(/\bsender\b|\breceiver\b/i);

    const invalidMarkup = renderToStaticMarkup(
      React.createElement(App, {
        initialState: {
          connectionStatus: 'connected',
          roomId: 'ship-83a1',
          peerState: 'waiting_for_peer',
          lastError: {
            source: 'ice:credentials',
            code: 'INVALID_ICE_CREDENTIALS',
            roomId: 'ship-83a1',
            message:
              'Rejected username=secretUiUser credential=secretUiCred TURN_SHARED_SECRET=secretUiTurn',
          },
          iceDiagnostics: {
            status: 'invalid',
            roomId: 'ship-83a1',
            lastError: {
              code: 'INVALID_ICE_CREDENTIALS',
              roomId: 'ship-83a1',
              message:
                'Rejected username=secretUiUser credential=secretUiCred TURN_SHARED_SECRET=secretUiTurn',
            },
          },
        },
      }),
    );
    expect(invalidMarkup).toContain('invalid');
    expect(invalidMarkup).toContain('INVALID_ICE_CREDENTIALS');
    expect(invalidMarkup).toContain('Category: validation');
    expect(invalidMarkup).toContain('STUN: 0 / TURN: 0');
    expect(invalidMarkup).not.toContain('secretUiUser');
    expect(invalidMarkup).not.toContain('secretUiCred');
    expect(invalidMarkup).not.toContain('secretUiTurn');

    const rejectedPayloadState = applyIceCredentials(
      createInitialPrototypeState({
        connectionStatus: 'connected',
        roomId: 'ship-83a1',
        peerState: 'waiting_for_peer',
      }),
      {
        roomId: 'ship-83a1',
        iceServers: [
          {
            urls: ['turn:turn.shipri.app:443'],
            username: 'rejectedTurnUser',
            credential: 'rejectedTurnPass',
          },
        ],
        TURN_SHARED_SECRET: 'rejectedTurnShared',
      },
    );
    const rejectedPayloadMarkup = renderToStaticMarkup(
      React.createElement(App, { initialState: rejectedPayloadState }),
    );
    expect(rejectedPayloadMarkup).toContain('INVALID_ICE_CREDENTIALS');
    expect(rejectedPayloadMarkup).not.toContain('rejectedTurnUser');
    expect(rejectedPayloadMarkup).not.toContain('rejectedTurnPass');
    expect(rejectedPayloadMarkup).not.toContain('rejectedTurnShared');
    expect(rejectedPayloadMarkup).not.toContain('turn.shipri.app');
    expect(rejectedPayloadMarkup).not.toContain('username');
    expect(rejectedPayloadMarkup).not.toMatch(/\bcredential\b/);
    expect(rejectedPayloadMarkup).not.toContain('TURN_SHARED_SECRET');

    const loadingMarkup = renderToStaticMarkup(
      React.createElement(App, {
        initialState: {
          connectionStatus: 'connected',
          roomId: 'ship-83a1',
          peerState: 'waiting_for_peer',
          iceDiagnostics: {
            status: 'loading',
            roomId: 'ship-83a1',
          },
        },
      }),
    );
    expect(loadingMarkup).toContain('loading');
    expect(loadingMarkup).toMatch(
      /<button[^>]*disabled=""[^>]*>Request ICE Config<\/button>/,
    );

    const serverBusyMarkup = renderToStaticMarkup(
      React.createElement(App, {
        initialState: {
          connectionStatus: 'connected',
          roomId: 'ship-83a1',
          peerState: 'waiting_for_peer',
          lastError: {
            source: 'room:error',
            code: 'SERVER_BUSY',
            roomId: 'ship-83a1',
            message: 'Development ICE configuration is unavailable.',
          },
          iceDiagnostics: {
            status: 'error',
            roomId: 'ship-83a1',
            lastError: {
              code: 'SERVER_BUSY',
              roomId: 'ship-83a1',
              message: 'Development ICE configuration is unavailable.',
            },
          },
        },
      }),
    );
    expect(serverBusyMarkup).toContain('error');
    expect(serverBusyMarkup).toContain('SERVER_BUSY');
    expect(serverBusyMarkup).toContain('Category: server');
    expect(serverBusyMarkup).toContain(
      'Development ICE configuration is unavailable.',
    );
  });
});
