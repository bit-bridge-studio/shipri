import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, test, vi } from 'vitest';
import App from '../src/App.jsx';
import {
  applyRoomCreated,
  applyRoomError,
  bindSignalingClient,
  clearLastError,
  createInitialPrototypeState,
  recoverErrorState,
  shouldClearDraftRoomInput,
} from '../src/prototype/diagnostic-state.js';
import {
  MALFORMED_TEST_SCENARIOS,
  POC_ROOM_ERROR_DESCRIPTORS,
  resolveRoomErrorDescriptor,
  runValidationScenario,
} from '../src/prototype/room-errors.js';
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

describe('resolveRoomErrorDescriptor and POC_ROOM_ERROR_DESCRIPTORS', () => {
  test('resolves all 7 stable POC room:error codes plus CONNECT_ERROR with category and recovery guidance', () => {
    const expectedCodes = [
      'ROOM_NOT_FOUND',
      'ROOM_FULL',
      'INVALID_ROOM_ID',
      'INVALID_PAYLOAD',
      'UNAUTHORIZED',
      'PEER_UNAVAILABLE',
      'SERVER_BUSY',
      'CONNECT_ERROR',
    ];

    expect(Object.keys(POC_ROOM_ERROR_DESCRIPTORS).sort()).toEqual(
      [...expectedCodes].sort(),
    );

    for (const code of expectedCodes) {
      const fromString = resolveRoomErrorDescriptor(code);
      const fromObject = resolveRoomErrorDescriptor({
        code,
        message: 'Diagnostic message',
      });

      expect(fromString).toEqual(fromObject);
      expect(fromString.code).toBe(code);
      expect(typeof fromString.category).toBe('string');
      expect(fromString.category.length).toBeGreaterThan(0);
      expect(typeof fromString.title).toBe('string');
      expect(fromString.title.length).toBeGreaterThan(0);
      expect(typeof fromString.recoveryGuidance).toBe('string');
      expect(fromString.recoveryGuidance.length).toBeGreaterThan(0);
      expect(fromString.preservesMembership).toBe(true);
      expect(fromString.known).toBe(true);
      expect(fromString.title).not.toMatch(/\bsender\b|\breceiver\b/i);
      expect(fromString.recoveryGuidance).not.toMatch(
        /\bsender\b|\breceiver\b/i,
      );
    }
  });

  test('branches strictly on code rather than message and falls back safely to UNKNOWN_ERROR', () => {
    const mismatchedMessage = resolveRoomErrorDescriptor({
      code: 'ROOM_NOT_FOUND',
      message: 'This room is already occupied. ROOM_FULL.',
    });
    expect(mismatchedMessage.code).toBe('ROOM_NOT_FOUND');
    expect(mismatchedMessage.category).toBe('room');

    const unrecognizedWithKnownText = resolveRoomErrorDescriptor({
      code: 'RATE_LIMITED',
      message: 'Room not found.',
    });
    expect(unrecognizedWithKnownText.code).toBe('UNKNOWN_ERROR');
    expect(unrecognizedWithKnownText.category).toBe('unknown');
    expect(unrecognizedWithKnownText.known).toBe(false);
    expect(unrecognizedWithKnownText.recoveryGuidance.length).toBeGreaterThan(
      0,
    );

    const missingCodeWithKnownText = resolveRoomErrorDescriptor({
      message: 'This room is already occupied.',
    });
    expect(missingCodeWithKnownText.code).toBe('UNKNOWN_ERROR');
    expect(missingCodeWithKnownText.known).toBe(false);

    for (const badInput of [
      null,
      undefined,
      '',
      '   ',
      123,
      [],
      'constructor',
      'toString',
      '__proto__',
      { code: 404 },
    ]) {
      const fallback = resolveRoomErrorDescriptor(badInput);
      expect(fallback.code).toBe('UNKNOWN_ERROR');
      expect(fallback.category).toBe('unknown');
      expect(fallback.known).toBe(false);
    }
  });
});

describe('MALFORMED_TEST_SCENARIOS and runValidationScenario', () => {
  test('provides presets for malformed payload, invalid roomId, room not found, unauthorized, and unavailable peer', () => {
    const expectedCodes = [
      'INVALID_PAYLOAD',
      'INVALID_ROOM_ID',
      'ROOM_NOT_FOUND',
      'UNAUTHORIZED',
      'PEER_UNAVAILABLE',
    ];

    for (const code of expectedCodes) {
      expect(
        MALFORMED_TEST_SCENARIOS.some(
          (scenario) => scenario.expectedCode === code,
        ),
      ).toBe(true);
    }

    const invalidPayloadScenarios = MALFORMED_TEST_SCENARIOS.filter(
      (scenario) => scenario.expectedCode === 'INVALID_PAYLOAD',
    );
    expect(invalidPayloadScenarios.length).toBeGreaterThanOrEqual(2);
    expect(
      invalidPayloadScenarios.some(
        (scenario) =>
          scenario.payload === null ||
          typeof scenario.payload !== 'object' ||
          Array.isArray(scenario.payload),
      ),
    ).toBe(true);
    expect(
      invalidPayloadScenarios.some(
        (scenario) =>
          scenario.id.includes('extra') ||
          (typeof scenario.payload === 'object' &&
            scenario.payload !== null &&
            Object.keys(scenario.payload).some((key) => key !== 'roomId')),
      ),
    ).toBe(true);
  });

  test('dispatches validation scenarios via signalingClient.emitRaw without crashing and records sanitized events', () => {
    const ioFactory = createMockSocketFactory();
    let tick = 0;
    const client = createSignalingClient({
      ioFactory,
      now: () => `2026-11-18T17:00:0${tick++}.000Z`,
    });
    const harness = createStateHarness();
    const unbind = bindSignalingClient(client, harness.setState);

    // Calling runValidationScenario before connect must not throw or crash.
    const disconnectedResult = runValidationScenario(
      client,
      'invalid-room-id',
      { setState: harness.setState },
    );
    expect(disconnectedResult.ok).toBe(false);
    expect(disconnectedResult.error.message).toMatch(/not connected/i);

    client.connect();
    const socket = ioFactory.lastSocket;

    // Seed an active room waiting for a second peer so UNAUTHORIZED and PEER_UNAVAILABLE can run in context.
    socket.simulateServerEvent('room:created', {
      roomId: 'ship-83a1',
      peerId: 'peer-a',
      negotiationDuty: 'offerer',
    });

    const emitRawSpy = vi.fn((event, payload) =>
      client.emitRaw(event, payload),
    );
    const wrappedClient = {
      ...client,
      emitRaw: emitRawSpy,
    };

    for (const scenario of MALFORMED_TEST_SCENARIOS) {
      const result = runValidationScenario(wrappedClient, scenario.id, {
        roomId: harness.getState().roomId,
        targetRoomId: 'bad-id-input',
        setState: harness.setState,
      });
      expect(result.ok).toBe(true);
      expect(result.expectedCode).toBe(scenario.expectedCode);
    }

    expect(emitRawSpy).toHaveBeenCalledTimes(MALFORMED_TEST_SCENARIOS.length);
    expect(socket.emittedEvents).toEqual([
      { event: 'room:join', args: ['not-a-plain-object'] },
      {
        event: 'room:join',
        args: [{ roomId: 'ship-83a1', unsupportedField: 'validation-test' }],
      },
      { event: 'room:join', args: [{ roomId: 'bad-id-input' }] },
      { event: 'room:join', args: [{ roomId: 'ship-0000' }] },
      { event: 'room:create', args: [{}] },
      {
        event: 'signal:forward',
        args: [{ roomId: 'ship-83a1', signalData: { type: 'offer' } }],
      },
    ]);

    // Verify UNAUTHORIZED without an active room uses a non-mutating event (never room:create).
    const unaffiliatedOutcome = runValidationScenario(
      wrappedClient,
      'unauthorized-action',
      {
        roomId: null,
        targetRoomId: 'ship-9999',
      },
    );
    expect(unaffiliatedOutcome.ok).toBe(true);
    expect(unaffiliatedOutcome.event).not.toBe('room:create');

    // Verify custom scenario payload with secrets/SDP/tokens is sanitized in eventLog.
    const customOutcome = runValidationScenario(
      wrappedClient,
      {
        id: 'custom-secret-probe',
        expectedCode: 'INVALID_PAYLOAD',
        event: 'signal:forward',
        payload: {
          roomId: 'ship-83a1',
          signalData: {
            type: 'offer',
            sdp: 'v=0\r\no=- 1 2 IN IP4 203.0.113.55\r\na=ice-pwd:scenarioSecretPwd\r\n',
          },
          authToken: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.secretSig',
          extraField: 'https://user:pass@poc.shipri.app/#key=fragSecret99',
        },
      },
      { setState: harness.setState },
    );
    expect(customOutcome.ok).toBe(true);

    // Unknown scenario ID also returns safely without crashing.
    const unknownScenarioResult = runValidationScenario(
      wrappedClient,
      'non-existent-scenario',
    );
    expect(unknownScenarioResult.ok).toBe(false);

    // Secret-bearing synchronous emitRaw throw is sanitized too.
    emitRawSpy.mockImplementationOnce(() => {
      throw new Error(
        'Failed emit to https://u:leakPass@poc.shipri.app/#key=emitFragSecret',
      );
    });
    const thrownResult = runValidationScenario(
      wrappedClient,
      'invalid-room-id',
      {
        setState: harness.setState,
      },
    );
    expect(thrownResult.ok).toBe(false);
    expect(thrownResult.error.message).not.toContain('leakPass');
    expect(thrownResult.error.message).not.toContain('emitFragSecret');

    const serialized = JSON.stringify(harness.getState().eventLog);
    expect(serialized).not.toContain('203.0.113.55');
    expect(serialized).not.toContain('scenarioSecretPwd');
    expect(serialized).not.toContain('secretSig');
    expect(serialized).not.toContain('fragSecret99');
    expect(serialized).not.toContain('leakPass');
    expect(serialized).not.toContain('emitFragSecret');

    unbind();
    client.dispose();
  });
});

describe('disconnect cases, room:error handling, and selective recovery', () => {
  test('handles peer:left disconnect, local socket disconnect, and connect_error cleanly', () => {
    const ioFactory = createMockSocketFactory();
    let tick = 0;
    const client = createSignalingClient({
      ioFactory,
      now: () => `2026-11-18T17:10:0${tick++}.000Z`,
    });
    const harness = createStateHarness();
    const unbind = bindSignalingClient(client, harness.setState);

    client.connect();
    const socket = ioFactory.lastSocket;

    socket.simulateServerEvent('room:joined', {
      roomId: 'ship-83a1',
      peerId: 'peer-joiner',
      negotiationDuty: 'answerer',
    });

    // Remote peer disconnects -> remaining peer stays in room as waiting_for_peer and offerer.
    socket.simulateServerEvent('peer:left', {
      roomId: 'ship-83a1',
      peerId: 'peer-creator',
      reason: 'disconnect',
    });

    expect(harness.getState()).toMatchObject({
      connectionStatus: 'connected',
      roomId: 'ship-83a1',
      peerState: 'waiting_for_peer',
      entryRole: 'joiner',
      negotiationDuty: 'offerer',
      selfPeerId: 'peer-joiner',
      remotePeerId: null,
    });

    // Local socket disconnect resets transient room/peer state while keeping sanitized eventLog.
    socket.simulateDisconnect('ping timeout');
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
      'room:joined',
      'peer:left',
      'disconnect',
    ]);

    // Connect error surfaces sanitized error cleanly.
    socket.simulateConnectError(
      new Error(
        'Cannot connect https://user:connSecret@poc.shipri.app/#key=connFrag',
      ),
    );
    expect(harness.getState().connectionStatus).toBe('error');
    expect(harness.getState().lastError).toMatchObject({
      source: 'connect_error',
      code: 'CONNECT_ERROR',
    });
    expect(harness.getState().lastError.message).not.toContain('connSecret');
    expect(harness.getState().lastError.message).not.toContain('connFrag');

    unbind();
    client.dispose();
  });

  test('room:error preserves active waiting_for_peer and connected room state while sanitizing lastError', () => {
    const waitingState = applyRoomCreated(
      createInitialPrototypeState({ connectionStatus: 'connected' }),
      {
        roomId: 'ship-83a1',
        peerId: 'peer-a',
        negotiationDuty: 'offerer',
      },
    );

    const afterPeerUnavailable = applyRoomError(waitingState, {
      roomId: 'ship-83a1',
      code: 'PEER_UNAVAILABLE',
      message: 'No second peer authToken=secretTok123',
    });
    expect(afterPeerUnavailable).toMatchObject({
      connectionStatus: 'connected',
      roomId: 'ship-83a1',
      peerState: 'waiting_for_peer',
      entryRole: 'creator',
      negotiationDuty: 'offerer',
      selfPeerId: 'peer-a',
      remotePeerId: null,
      lastError: {
        source: 'room:error',
        code: 'PEER_UNAVAILABLE',
        roomId: 'ship-83a1',
      },
    });
    expect(afterPeerUnavailable.lastError.message).not.toContain(
      'secretTok123',
    );

    const malformedRoomError = applyRoomError(waitingState, {
      roomId: 'invalid-room#key=leakRoomFrag',
      message: 'Malformed room error without code',
    });
    expect(malformedRoomError.roomId).toBe('ship-83a1');
    expect(malformedRoomError.lastError).toEqual({
      source: 'room:error',
      code: 'UNKNOWN_ERROR',
      message: 'Malformed room error without code',
    });
    expect(JSON.stringify(malformedRoomError)).not.toContain('leakRoomFrag');

    // Full end-to-end bindSignalingClient check while connected with two peers.
    const ioFactory = createMockSocketFactory();
    let tick = 0;
    const client = createSignalingClient({
      ioFactory,
      now: () => `2026-11-18T17:20:0${tick++}.000Z`,
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

    socket.simulateServerEvent('room:error', {
      roomId: 'ship-83a1',
      code: 'UNAUTHORIZED',
      message: 'Socket already belongs to an active room.',
    });

    expect(harness.getState()).toMatchObject({
      connectionStatus: 'connected',
      roomId: 'ship-83a1',
      peerState: 'connected',
      entryRole: 'creator',
      negotiationDuty: 'offerer',
      selfPeerId: 'peer-a',
      remotePeerId: 'peer-b',
      lastError: {
        source: 'room:error',
        code: 'UNAUTHORIZED',
        roomId: 'ship-83a1',
      },
    });

    // Clearing error selectively keeps membership and does not resurrect on subsequent disconnect status snapshot.
    harness.setState((prev) => clearLastError(prev));
    expect(harness.getState().lastError).toBeNull();
    expect(harness.getState().roomId).toBe('ship-83a1');
    expect(harness.getState().peerState).toBe('connected');

    socket.simulateDisconnect('transport close');
    expect(harness.getState().lastError).toBeNull();
    expect(harness.getState().peerState).toBe('unaffiliated');

    unbind();
    client.dispose();
  });

  test('clearLastError and recoverErrorState selectively reset only lastError (and draft input only when unaffiliated)', () => {
    const activeConnected = createInitialPrototypeState({
      connectionStatus: 'connected',
      roomId: 'ship-83a1',
      peerState: 'connected',
      entryRole: 'creator',
      negotiationDuty: 'offerer',
      selfPeerId: 'peer-a',
      remotePeerId: 'peer-b',
      lastError: {
        source: 'room:error',
        code: 'UNAUTHORIZED',
        roomId: 'ship-83a1',
        message: 'Socket already belongs to an active room.',
      },
      eventLog: [
        {
          direction: 'inbound',
          event: 'room:error',
          timestamp: '2026-11-18T17:30:00.000Z',
          payload: {
            roomId: 'ship-83a1',
            code: 'UNAUTHORIZED',
            message: 'Socket already belongs to an active room.',
          },
        },
      ],
    });

    const clearedActive = clearLastError(activeConnected);
    expect(clearedActive).toEqual({
      ...activeConnected,
      lastError: null,
    });
    expect(clearedActive.roomId).toBe('ship-83a1');
    expect(clearedActive.peerState).toBe('connected');
    expect(clearedActive.eventLog).toHaveLength(1);

    const clearDraftSpy = vi.fn();
    expect(shouldClearDraftRoomInput(activeConnected)).toBe(false);
    const recoveredActive = recoverErrorState(activeConnected, {
      onClearDraft: clearDraftSpy,
    });
    expect(recoveredActive).toEqual({
      ...activeConnected,
      lastError: null,
    });
    expect(clearDraftSpy).not.toHaveBeenCalled();

    const unaffiliatedErrored = createInitialPrototypeState({
      connectionStatus: 'connected',
      roomId: null,
      peerState: 'unaffiliated',
      negotiationDuty: null,
      lastError: {
        source: 'room:error',
        code: 'INVALID_ROOM_ID',
        message: 'Invalid room ID format.',
      },
      eventLog: [
        {
          direction: 'inbound',
          event: 'room:error',
          timestamp: '2026-11-18T17:31:00.000Z',
          payload: {
            code: 'INVALID_ROOM_ID',
            message: 'Invalid room ID format.',
          },
        },
      ],
    });

    expect(shouldClearDraftRoomInput(unaffiliatedErrored)).toBe(true);
    const recoveredUnaffiliated = recoverErrorState(unaffiliatedErrored, {
      onClearDraft: clearDraftSpy,
    });
    expect(recoveredUnaffiliated).toEqual({
      ...unaffiliatedErrored,
      lastError: null,
    });
    expect(clearDraftSpy).toHaveBeenCalledTimes(1);
    expect(recoveredUnaffiliated.eventLog).toHaveLength(1);

    // Connect error while unaffiliated preserves draft room input.
    const unaffiliatedConnectError = createInitialPrototypeState({
      connectionStatus: 'error',
      peerState: 'unaffiliated',
      lastError: {
        source: 'connect_error',
        code: 'CONNECT_ERROR',
        message: 'Socket connection timed out.',
      },
    });
    expect(shouldClearDraftRoomInput(unaffiliatedConnectError)).toBe(false);
  });
});

describe('App static markup for structured error diagnostics, disconnect notice, and validation controls', () => {
  test('renders structured Last Error diagnostics, Clear Error action, fallback unknown handling, disconnect notices, and Validation & Error Scenarios', () => {
    const roomFullMarkup = renderToStaticMarkup(
      React.createElement(App, {
        initialState: {
          connectionStatus: 'connected',
          roomId: 'ship-83a1',
          peerState: 'waiting_for_peer',
          entryRole: 'creator',
          negotiationDuty: 'offerer',
          selfPeerId: 'peer-1',
          lastError: {
            source: 'room:error',
            code: 'ROOM_FULL',
            roomId: 'ship-83a1',
            message: 'This room is already occupied.',
          },
          eventLog: [
            {
              direction: 'inbound',
              event: 'peer:left',
              timestamp: '2026-11-18T17:40:00.000Z',
              payload: {
                roomId: 'ship-83a1',
                peerId: 'peer-2',
                reason: 'disconnect',
              },
            },
            {
              direction: 'inbound',
              event: 'room:error',
              timestamp: '2026-11-18T17:40:01.000Z',
              payload: {
                roomId: 'ship-83a1',
                code: 'ROOM_FULL',
                message:
                  'Room full authToken=secretUiTok v=0\r\no=- 1 2 IN IP4 198.51.100.3\r\na=ice-pwd:uiErrorPwd\r\n',
              },
            },
          ],
        },
      }),
    );

    expect(roomFullMarkup).toContain('Last Error');
    expect(roomFullMarkup).toContain('ROOM_FULL');
    expect(roomFullMarkup).toContain('capacity');
    expect(roomFullMarkup).toContain(
      POC_ROOM_ERROR_DESCRIPTORS.ROOM_FULL.recoveryGuidance,
    );
    expect(roomFullMarkup).toContain('Clear Error');
    expect(roomFullMarkup).toContain('Remote peer disconnected');
    expect(roomFullMarkup).toContain('Validation &amp; Error Scenarios');
    for (const scenario of MALFORMED_TEST_SCENARIOS) {
      expect(roomFullMarkup).toContain(scenario.label);
      expect(roomFullMarkup).toContain(scenario.expectedCode);
    }
    expect(roomFullMarkup).not.toContain('secretUiTok');
    expect(roomFullMarkup).not.toContain('198.51.100.3');
    expect(roomFullMarkup).not.toContain('uiErrorPwd');
    expect(roomFullMarkup).not.toMatch(/\bsender\b|\breceiver\b/i);

    const unknownErrorAndLocalDisconnectMarkup = renderToStaticMarkup(
      React.createElement(App, {
        initialState: {
          connectionStatus: 'disconnected',
          lastError: {
            source: 'room:error',
            code: 'CUSTOM_UNRECOGNIZED',
            message: 'Unexpected backend failure #key=secretFragUi',
          },
          eventLog: [
            {
              direction: 'inbound',
              event: 'disconnect',
              timestamp: '2026-11-18T17:41:00.000Z',
              payload: 'transport close',
            },
          ],
        },
      }),
    );

    expect(unknownErrorAndLocalDisconnectMarkup).toContain(
      'CUSTOM_UNRECOGNIZED',
    );
    expect(unknownErrorAndLocalDisconnectMarkup).toContain('UNKNOWN_ERROR');
    expect(unknownErrorAndLocalDisconnectMarkup).toContain('unknown');
    expect(unknownErrorAndLocalDisconnectMarkup).toContain('transport close');
    expect(unknownErrorAndLocalDisconnectMarkup).not.toContain(
      'secretFragUi',
    );
    expect(unknownErrorAndLocalDisconnectMarkup).not.toMatch(
      /\bsender\b|\breceiver\b/i,
    );

    const connectErrorMarkup = renderToStaticMarkup(
      React.createElement(App, {
        initialState: {
          connectionStatus: 'error',
          lastError: {
            source: 'connect_error',
            code: 'CONNECT_ERROR',
            message: 'Unable to reach signaling origin.',
          },
        },
      }),
    );
    expect(connectErrorMarkup).toContain('Signaling connection error');
    expect(connectErrorMarkup).toContain('CONNECT_ERROR');
    expect(connectErrorMarkup).toContain('Category: connection');
    expect(connectErrorMarkup).toContain(
      POC_ROOM_ERROR_DESCRIPTORS.CONNECT_ERROR.recoveryGuidance,
    );

    const cleanConnectedMarkup = renderToStaticMarkup(
      React.createElement(App, {
        initialState: {
          connectionStatus: 'connected',
          roomId: 'ship-83a1',
          peerState: 'connected',
          entryRole: 'creator',
          negotiationDuty: 'offerer',
          lastError: null,
        },
      }),
    );
    expect(cleanConnectedMarkup).toContain('Clear Error');
    expect(cleanConnectedMarkup).not.toContain('disconnect-notice');
    expect(cleanConnectedMarkup).not.toContain('error-diagnostics');
  });
});
