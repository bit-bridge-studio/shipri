import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, test, vi } from 'vitest';
import App from '../src/App.jsx';
import {
  appendSanitizedLogEntry,
  applyConnectionStatus,
  bindSignalingClient,
  clearEventLog,
  createInitialPrototypeState,
  sanitizeLogEntry,
} from '../src/prototype/diagnostic-state.js';
import { createSignalingClient } from '../src/signaling/socket-client.js';
import { createMockSocketFactory } from './helpers/mock-socket.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createInitialPrototypeState', () => {
  test('returns expected default diagnostic fields and empty event log', () => {
    expect(createInitialPrototypeState()).toEqual({
      connectionStatus: 'disconnected',
      roomId: null,
      peerState: 'unaffiliated',
      negotiationDuty: null,
      lastError: null,
      eventLog: [],
    });
  });

  test('validates and sanitizes optional initial state overrides', () => {
    const state = createInitialPrototypeState({
      connectionStatus: 'connected',
      roomId: 'ship-83a1',
      peerState: 'connected',
      negotiationDuty: 'offerer',
      lastError: {
        code: 'ROOM_FULL',
        roomId: 'ship-83a1',
        message:
          'Failed with https://user:secretPass@poc.shipri.app/#key=secretMasterKey authToken=tok999',
      },
      eventLog: [
        {
          direction: 'outbound',
          event: 'signal:forward',
          timestamp: '2026-11-18T15:00:00.000Z',
          payload: {
            roomId: 'ship-83a1',
            signalData: {
              type: 'offer',
              sdp: 'v=0\r\no=- 1 2 IN IP4 10.0.0.8\r\na=ice-pwd:overrideSecretPwd\r\n',
            },
          },
        },
      ],
    });

    expect(state.connectionStatus).toBe('connected');
    expect(state.roomId).toBe('ship-83a1');
    expect(state.peerState).toBe('connected');
    expect(state.negotiationDuty).toBe('offerer');
    expect(state.lastError).toMatchObject({
      code: 'ROOM_FULL',
      roomId: 'ship-83a1',
    });
    expect(state.lastError.message).not.toContain('secretPass');
    expect(state.lastError.message).not.toContain('secretMasterKey');
    expect(state.lastError.message).not.toContain('tok999');

    expect(state.eventLog).toHaveLength(1);
    expect(state.eventLog[0].summary).toMatch(/sdp.*offer/i);
    expect(JSON.stringify(state)).not.toContain('overrideSecretPwd');
    expect(JSON.stringify(state)).not.toContain('10.0.0.8');

    const sanitizedInvalid = createInitialPrototypeState({
      connectionStatus: 'unexpected-status',
      roomId: 'https://shipri.app/room/ship-83a1#key=leakKey',
      peerState: 'bogus',
      negotiationDuty: 'sender',
    });
    expect(sanitizedInvalid).toEqual({
      connectionStatus: 'disconnected',
      roomId: null,
      peerState: 'unaffiliated',
      negotiationDuty: null,
      lastError: null,
      eventLog: [],
    });

    expect(() => createInitialPrototypeState(null)).toThrow(TypeError);
    expect(() => createInitialPrototypeState('invalid')).toThrow(TypeError);
  });
});

describe('diagnostic prototype App rendering', () => {
  test('renders Shipri shell with required status labels, defaults, empty event log, and Clear Log control', () => {
    const markup = renderToStaticMarkup(React.createElement(App));

    expect(markup).toContain('Shipri');
    expect(markup).toContain('Connecting to signaling server...');
    expect(markup).toContain('Connection State');
    expect(markup).toContain('disconnected');
    expect(markup).toContain('Room ID');
    expect(markup).toContain('Peer State');
    expect(markup).toContain('unaffiliated');
    expect(markup).toContain('Negotiation Duty');
    expect(markup).toContain('Last Error');
    expect(markup).toContain('None');
    expect(markup).toContain('Event Log');
    expect(markup).toContain('No signaling events recorded yet.');
    expect(markup).toContain('Clear Log');
  });

  test('renders populated diagnostic fields, chronological event log order, and redacts secrets from UI markup', () => {
    let state = createInitialPrototypeState({
      connectionStatus: 'connected',
      roomId: 'ship-83a1',
      peerState: 'connected',
      negotiationDuty: 'answerer',
      lastError: {
        code: 'PEER_UNAVAILABLE',
        roomId: 'ship-83a1',
        message: 'Peer left before https://shipri.app/#key=secretErrorFrag',
      },
    });

    state = appendSanitizedLogEntry(state, {
      direction: 'inbound',
      event: 'room:joined',
      timestamp: '2026-11-18T15:00:01.000Z',
      payload: {
        roomId: 'ship-83a1',
        peerId: 'peer-2',
        negotiationDuty: 'answerer',
      },
    });
    state = appendSanitizedLogEntry(state, {
      direction: 'inbound',
      event: 'ice:credentials',
      timestamp: '2026-11-18T15:00:02.000Z',
      payload: {
        roomId: 'ship-83a1',
        iceServers: [
          {
            urls: ['turns:turn.shipri.app:443'],
            username: 'ephemeral-user',
            credential: 'ephemeral-turn-secret',
          },
        ],
        TURN_SHARED_SECRET: 'server-turn-secret',
      },
    });
    state = appendSanitizedLogEntry(state, {
      direction: 'outbound',
      event: 'signal:forward',
      timestamp: '2026-11-18T15:00:03.000Z',
      payload: {
        roomId: 'ship-83a1',
        signalData: {
          type: 'answer',
          sdp: 'v=0\r\no=- 1 2 IN IP4 192.168.10.22\r\na=ice-pwd:uiLeakPwd\r\n',
        },
        authToken: 'secret-jwt-token',
      },
    });

    const markup = renderToStaticMarkup(
      React.createElement(App, { initialState: state }),
    );

    expect(markup).toContain('Shipri');
    expect(markup).toContain('Signaling server connected');
    expect(markup).toContain('connected');
    expect(markup).toContain('ship-83a1');
    expect(markup).toContain('answerer');
    expect(markup).toContain('PEER_UNAVAILABLE');
    expect(markup).not.toContain('No signaling events recorded yet.');

    const firstIdx = markup.indexOf('2026-11-18T15:00:01.000Z');
    const secondIdx = markup.indexOf('2026-11-18T15:00:02.000Z');
    const thirdIdx = markup.indexOf('2026-11-18T15:00:03.000Z');
    expect(firstIdx).toBeGreaterThan(-1);
    expect(secondIdx).toBeGreaterThan(firstIdx);
    expect(thirdIdx).toBeGreaterThan(secondIdx);

    expect(markup).not.toContain('secretErrorFrag');
    expect(markup).not.toContain('ephemeral-user');
    expect(markup).not.toContain('ephemeral-turn-secret');
    expect(markup).not.toContain('server-turn-secret');
    expect(markup).not.toContain('192.168.10.22');
    expect(markup).not.toContain('uiLeakPwd');
    expect(markup).not.toContain('secret-jwt-token');
  });

  test('renders side-effect free without invoking socket connection during static render', () => {
    const diagnosticStateSource = fs.readFileSync(
      path.resolve(__dirname, '../src/prototype/diagnostic-state.js'),
      'utf8',
    );
    expect(diagnosticStateSource).toMatch(/from '\.\.\/signaling\/socket-client\.js'/);

    const ioFactory = createMockSocketFactory();
    const client = createSignalingClient({ ioFactory });

    const disconnectedMarkup = renderToStaticMarkup(
      React.createElement(App, { signalingClient: client }),
    );
    expect(disconnectedMarkup).toContain('Connecting to signaling server...');
    expect(disconnectedMarkup).toContain('disconnected');
    expect(ioFactory.calls).toHaveLength(0);

    client.connect();
    const connectedMarkup = renderToStaticMarkup(
      React.createElement(App, { signalingClient: client }),
    );
    expect(connectedMarkup).toContain('Signaling server connected');
    expect(connectedMarkup).toContain('connected');

    client.dispose();
  });
});

describe('appendSanitizedLogEntry and sanitizeLogEntry', () => {
  test('appends entries in strict chronological order (oldest to newest) without mutating input state', () => {
    const initial = createInitialPrototypeState();
    const first = appendSanitizedLogEntry(initial, {
      direction: 'local',
      event: 'connect',
      timestamp: '2026-11-18T15:00:00.000Z',
    });
    const second = appendSanitizedLogEntry(first, {
      direction: 'outbound',
      event: 'room:create',
      timestamp: '2026-11-18T15:00:01.000Z',
      payload: {},
    });
    const third = appendSanitizedLogEntry(second, {
      direction: 'inbound',
      event: 'room:created',
      timestamp: '2026-11-18T15:00:02.000Z',
      payload: {
        roomId: 'ship-83a1',
        peerId: 'peer-a',
        negotiationDuty: 'offerer',
      },
    });

    expect(initial.eventLog).toEqual([]);
    expect(first.eventLog).toHaveLength(1);
    expect(second.eventLog).toHaveLength(2);
    expect(third.eventLog.map((entry) => entry.event)).toEqual([
      'connect',
      'room:create',
      'room:created',
    ]);
    expect(third.eventLog.map((entry) => entry.timestamp)).toEqual([
      '2026-11-18T15:00:00.000Z',
      '2026-11-18T15:00:01.000Z',
      '2026-11-18T15:00:02.000Z',
    ]);
  });

  test('redacts SDP blobs, ICE candidates, TURN secrets, URL key fragments, auth tokens, and private file fields', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    let state = createInitialPrototypeState();

    state = appendSanitizedLogEntry(state, {
      direction: 'outbound',
      event: 'signal:forward',
      timestamp: '2026-11-18T15:01:00.000Z',
      payload: {
        roomId: 'ship-83a1',
        signalData: {
          type: 'offer',
          sdp: [
            'v=0',
            'o=- 4611731400430051336 2 IN IP4 203.0.113.9',
            's=-',
            'a=ice-ufrag:ufragLeak',
            'a=ice-pwd:superSecretIcePassword',
          ].join('\r\n'),
        },
        authToken: 'secret-bearer-value',
      },
    });

    state = appendSanitizedLogEntry(state, {
      direction: 'inbound',
      event: 'signal:receive',
      timestamp: '2026-11-18T15:01:01.000Z',
      payload: {
        roomId: 'ship-83a1',
        peerId: 'peer-2',
        signalData: {
          candidate: {
            candidate: 'candidate:1 1 UDP 2122252543 198.51.100.42 54321 typ srflx',
            sdpMid: '0',
            sdpMLineIndex: 0,
          },
        },
      },
    });

    state = appendSanitizedLogEntry(state, {
      direction: 'inbound',
      event: 'ice:credentials',
      timestamp: '2026-11-18T15:01:02.000Z',
      payload: {
        roomId: 'ship-83a1',
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          {
            urls: ['turn:turn.shipri.app:443?transport=tcp'],
            username: 'turnUserSecret',
            credential: 'turnCredentialSecret',
          },
        ],
        TURN_SHARED_SECRET: 'globalTurnSharedSecret',
      },
    });

    state = appendSanitizedLogEntry(state, {
      direction: 'local',
      event: 'diagnostic:note',
      timestamp: '2026-11-18T15:01:03.000Z',
      summary:
        'Share https://shipri.app/room/ship-83a1#key=masterFragmentKey99 Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJyb29tIjoic2hpcC04M2ExIn0.sigSecret v=0\r\na=ice-pwd:rawSummaryPwd',
      sdp: 'v=0\r\na=ice-pwd:extraFieldSecret',
      credential: 'extraCredentialSecret',
    });

    state = appendSanitizedLogEntry(state, {
      direction: 'inbound',
      event: 'board:sync',
      timestamp: '2026-11-18T15:01:04.000Z',
      payload: {
        roomId: 'ship-83a1',
        fileName: 'confidential-report.pdf',
        fileSize: 819200,
        fileType: 'application/pdf',
        fileBoard: [{ name: 'hidden-doc.txt' }],
        encryptedMetadata: 'encMetaSecret',
        ciphertext: 'cipherSecretPayload',
        chunkData: new Uint8Array([9, 8, 7, 6]),
        roomToken: 'roomSecretToken',
      },
    });

    const sanitizedSummaryRecord = sanitizeLogEntry({
      direction: 'local',
      event: 'candidate:raw',
      timestamp: '2026-11-18T15:01:05.000Z',
      summary: 'candidate:2 1 TCP 2122252543 192.0.2.88 49999 typ host TURN_SHARED_SECRET=rawTurnSecret',
    });

    state = appendSanitizedLogEntry(state, sanitizedSummaryRecord);

    const serialized = JSON.stringify(state);
    const markup = renderToStaticMarkup(
      React.createElement(App, { initialState: state }),
    );

    const forbiddenSecrets = [
      '203.0.113.9',
      'ufragLeak',
      'superSecretIcePassword',
      'secret-bearer-value',
      '198.51.100.42',
      '54321',
      'turnUserSecret',
      'turnCredentialSecret',
      'globalTurnSharedSecret',
      'stun.l.google.com',
      'masterFragmentKey99',
      'sigSecret',
      'rawSummaryPwd',
      'extraFieldSecret',
      'extraCredentialSecret',
      'confidential-report.pdf',
      '819200',
      'hidden-doc.txt',
      'encMetaSecret',
      'cipherSecretPayload',
      'roomSecretToken',
      '192.0.2.88',
      '49999',
      'rawTurnSecret',
    ];

    for (const secret of forbiddenSecrets) {
      expect(serialized).not.toContain(secret);
      expect(markup).not.toContain(secret);
    }

    expect(state.eventLog[0].summary).toMatch(/sdp.*offer/i);
    expect(state.eventLog[1].summary).toMatch(/ice/i);
    expect(state.eventLog[2].summary).toMatch(/2 server\(s\).*stun, turn/i);

    expect(logSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });
});

describe('clearEventLog', () => {
  test('clears eventLog to empty array while preserving connection, room, peer, duty, and error fields', () => {
    let state = createInitialPrototypeState({
      connectionStatus: 'connected',
      roomId: 'ship-83a1',
      peerState: 'connected',
      negotiationDuty: 'offerer',
      lastError: {
        code: 'ROOM_FULL',
        roomId: 'ship-83a1',
        message: 'Room is full.',
      },
    });
    state = appendSanitizedLogEntry(state, {
      direction: 'inbound',
      event: 'peer:joined',
      timestamp: '2026-11-18T15:02:00.000Z',
      payload: { roomId: 'ship-83a1', peerId: 'peer-b' },
    });

    expect(state.eventLog).toHaveLength(1);

    const cleared = clearEventLog(state);
    expect(cleared).toEqual({
      connectionStatus: 'connected',
      roomId: 'ship-83a1',
      peerState: 'connected',
      negotiationDuty: 'offerer',
      lastError: {
        code: 'ROOM_FULL',
        roomId: 'ship-83a1',
        message: 'Room is full.',
      },
      eventLog: [],
    });
    expect(state.eventLog).toHaveLength(1);
  });
});

describe('applyConnectionStatus and signalingClient integration', () => {
  test('applyConnectionStatus updates connectionStatus and sanitizes lastError without dropping room state', () => {
    const initial = createInitialPrototypeState({
      roomId: 'ship-83a1',
      peerState: 'waiting_for_peer',
      negotiationDuty: 'offerer',
    });

    const errored = applyConnectionStatus(initial, {
      status: 'error',
      connected: false,
      lastError: {
        source: 'connect_error',
        code: 'CONNECT_ERROR',
        message: 'Cannot reach https://user:pw@poc.shipri.app/#key=secretKey123',
        timestamp: '2026-11-18T15:03:00.000Z',
      },
    });

    expect(errored.connectionStatus).toBe('error');
    expect(errored.roomId).toBe('ship-83a1');
    expect(errored.peerState).toBe('waiting_for_peer');
    expect(errored.negotiationDuty).toBe('offerer');
    expect(errored.lastError.code).toBe('CONNECT_ERROR');
    expect(errored.lastError.message).not.toContain('pw@');
    expect(errored.lastError.message).not.toContain('secretKey123');

    const recovered = applyConnectionStatus(errored, {
      status: 'connected',
      connected: true,
      lastError: null,
    });
    expect(recovered.connectionStatus).toBe('connected');
    expect(recovered.lastError).toBeNull();
    expect(recovered.roomId).toBe('ship-83a1');
  });

  test('bindSignalingClient streams status updates and sanitized events without leaking secrets and cleans up on unbind', () => {
    const ioFactory = createMockSocketFactory();
    let tick = 0;
    const client = createSignalingClient({
      ioFactory,
      now: () => `2026-11-18T15:04:0${tick++}.000Z`,
    });

    let state = createInitialPrototypeState();
    const setState = (updater) => {
      state = typeof updater === 'function' ? updater(state) : updater;
    };

    const unbind = bindSignalingClient(client, setState);

    expect(state.connectionStatus).toBe('disconnected');

    client.connect();
    const socket = ioFactory.lastSocket;

    expect(state.connectionStatus).toBe('connected');
    expect(state.eventLog.map((entry) => entry.event)).toEqual(['connect']);

    client.forwardSignal('ship-83a1', {
      type: 'offer',
      sdp: 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\na=ice-pwd:streamLeakPwd\r\n',
    });

    socket.simulateServerEvent('room:error', {
      roomId: 'ship-83a1',
      code: 'UNAUTHORIZED',
      message: 'Unauthorized room action authToken=secretStreamTok',
    });

    expect(state.lastError).toMatchObject({
      source: 'room:error',
      code: 'UNAUTHORIZED',
      roomId: 'ship-83a1',
    });
    expect(state.lastError.message).not.toContain('secretStreamTok');

    socket.simulateConnectError(
      new Error('Socket failed https://u:pass@poc.shipri.app/#key=fragSecret'),
    );

    expect(state.connectionStatus).toBe('error');
    expect(state.lastError.message).not.toContain('pass@');
    expect(state.lastError.message).not.toContain('fragSecret');

    const serialized = JSON.stringify(state);
    expect(serialized).not.toContain('streamLeakPwd');
    expect(serialized).not.toContain('secretStreamTok');
    expect(serialized).not.toContain('fragSecret');
    expect(state.eventLog.map((entry) => entry.event)).toEqual([
      'connect',
      'signal:forward',
      'room:error',
      'connect_error',
    ]);

    const cleared = clearEventLog(state);
    expect(cleared.eventLog).toEqual([]);
    expect(cleared.connectionStatus).toBe('error');
    expect(cleared.lastError.code).toBe('CONNECT_ERROR');

    unbind();

    const countBeforeLateDisconnect = state.eventLog.length;
    socket.simulateDisconnect('io client disconnect');
    expect(state.eventLog).toHaveLength(countBeforeLateDisconnect);
    expect(state.connectionStatus).toBe('error');

    client.dispose();
  });
});
