import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, test, vi } from 'vitest';
import App from '../src/App.jsx';
import {
  DEFAULT_SIGNALING_URL,
  createSignalingClient,
  normalizeSignalingEvent,
  resolveSignalingUrl,
  sanitizeEventPayloadSummary,
  sanitizeTextValue,
} from '../src/signaling/socket-client.js';
import {
  createMockSocket,
  createMockSocketFactory,
} from './helpers/mock-socket.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

afterEach(() => {
  vi.restoreAllMocks();
});

describe('resolveSignalingUrl', () => {
  test('defaults to http://localhost:5001 when VITE_SIGNALING_URL is missing or blank', () => {
    expect(DEFAULT_SIGNALING_URL).toBe('http://localhost:5001');
    expect(resolveSignalingUrl({})).toBe('http://localhost:5001');
    expect(resolveSignalingUrl({ VITE_SIGNALING_URL: undefined })).toBe(
      'http://localhost:5001',
    );
    expect(resolveSignalingUrl({ VITE_SIGNALING_URL: null })).toBe(
      'http://localhost:5001',
    );
    expect(resolveSignalingUrl({ VITE_SIGNALING_URL: '' })).toBe(
      'http://localhost:5001',
    );
    expect(resolveSignalingUrl({ VITE_SIGNALING_URL: '   \t\n  ' })).toBe(
      'http://localhost:5001',
    );
  });

  test('accepts, trims, and normalizes http and https origins without trailing slash', () => {
    expect(
      resolveSignalingUrl({ VITE_SIGNALING_URL: '  http://localhost:5001/  ' }),
    ).toBe('http://localhost:5001');
    expect(
      resolveSignalingUrl({ VITE_SIGNALING_URL: 'https://poc.shipri.app/' }),
    ).toBe('https://poc.shipri.app');
    expect(
      resolveSignalingUrl({
        VITE_SIGNALING_URL: '  https://poc.shipri.app:8443/ ',
      }),
    ).toBe('https://poc.shipri.app:8443');
  });

  test('rejects non-HTTP(S) protocols, credentials, paths, queries, hashes, and invalid types', () => {
    expect(() =>
      resolveSignalingUrl({ VITE_SIGNALING_URL: 'ws://localhost:5001' }),
    ).toThrow(/http/i);
    expect(() =>
      resolveSignalingUrl({ VITE_SIGNALING_URL: 'wss://poc.shipri.app' }),
    ).toThrow(/http/i);
    expect(() =>
      resolveSignalingUrl({ VITE_SIGNALING_URL: 'ftp://poc.shipri.app' }),
    ).toThrow(/http/i);
    expect(() =>
      resolveSignalingUrl({ VITE_SIGNALING_URL: 'javascript:alert(1)' }),
    ).toThrow(/http/i);

    let credentialError;
    try {
      resolveSignalingUrl({
        VITE_SIGNALING_URL: 'https://user:supersecret@poc.shipri.app',
      });
    } catch (error) {
      credentialError = error;
    }
    expect(credentialError).toBeInstanceOf(Error);
    expect(credentialError.message).toMatch(/credential/i);
    expect(credentialError.message).not.toContain('supersecret');

    expect(() =>
      resolveSignalingUrl({ VITE_SIGNALING_URL: 'https://:@poc.shipri.app' }),
    ).toThrow(/credential/i);
    expect(() =>
      resolveSignalingUrl({
        VITE_SIGNALING_URL: 'https://poc.shipri.app/socket.io',
      }),
    ).toThrow(/path/i);
    expect(() =>
      resolveSignalingUrl({
        VITE_SIGNALING_URL: 'https://poc.shipri.app/?token=abc',
      }),
    ).toThrow(/query/i);
    expect(() =>
      resolveSignalingUrl({
        VITE_SIGNALING_URL: 'https://poc.shipri.app/?',
      }),
    ).toThrow(/query/i);
    expect(() =>
      resolveSignalingUrl({
        VITE_SIGNALING_URL: 'https://poc.shipri.app/#key=secret',
      }),
    ).toThrow(/hash|fragment/i);
    expect(() =>
      resolveSignalingUrl({
        VITE_SIGNALING_URL: 'https://poc.shipri.app/#',
      }),
    ).toThrow(/hash|fragment/i);
    expect(() =>
      resolveSignalingUrl({ VITE_SIGNALING_URL: 5001 }),
    ).toThrow(/string/i);
    expect(() => resolveSignalingUrl(null)).toThrow(/object/i);
    expect(() =>
      resolveSignalingUrl({ VITE_SIGNALING_URL: 'not-a-url' }),
    ).toThrow(/valid/i);
  });
});

describe('event sanitization and normalization', () => {
  test('sanitizeTextValue preserves benign text and redacts SDP, ICE, TURN, fragment keys, tokens, and private metadata', () => {
    expect(sanitizeTextValue('Room does not exist or has expired.')).toBe(
      'Room does not exist or has expired.',
    );
    expect(sanitizeTextValue('Error #42 during transport close')).toBe(
      'Error #42 during transport close',
    );

    const rawSdp = [
      'v=0',
      'o=- 4611731400430051336 2 IN IP4 127.0.0.1',
      's=-',
      't=0 0',
      'a=ice-ufrag:ufrag123',
      'a=ice-pwd:supersecreticepassword',
      'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
    ].join('\r\n');
    const sanitizedSdp = sanitizeTextValue(rawSdp);
    expect(sanitizedSdp).not.toContain('supersecreticepassword');
    expect(sanitizedSdp).not.toContain('127.0.0.1');
    expect(sanitizedSdp).not.toContain('a=ice-pwd');

    const sanitizedCandidate = sanitizeTextValue(
      'a=candidate:1 1 UDP 2122252543 192.168.1.44 54321 typ host',
    );
    expect(sanitizedCandidate).not.toContain('192.168.1.44');
    expect(sanitizedCandidate).not.toContain('54321');

    const sanitizedTurn = sanitizeTextValue(
      'TURN_SHARED_SECRET=myTurnSecret username=turnUser credential=turnPass turns:u1:p1@turn.shipri.app:443',
    );
    expect(sanitizedTurn).not.toContain('myTurnSecret');
    expect(sanitizedTurn).not.toContain('turnUser');
    expect(sanitizedTurn).not.toContain('turnPass');
    expect(sanitizedTurn).not.toContain('u1:p1@');

    const sanitizedUrl = sanitizeTextValue(
      'Failed opening https://shipri.app/room/ship-83a1#key=secretMasterKey123?token=authTok999',
    );
    expect(sanitizedUrl).not.toContain('secretMasterKey123');
    expect(sanitizedUrl).not.toContain('authTok999');

    const sanitizedMultiFragment = sanitizeTextValue(
      '/room/ship-83a1#foo=bar&key=secretFrag2',
    );
    expect(sanitizedMultiFragment).not.toContain('secretFrag2');

    const sanitizedAuth = sanitizeTextValue(
      'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJyb29tIjoic2hpcC04M2ExIn0.signatureSecret authToken=tok123',
    );
    expect(sanitizedAuth).not.toContain('signatureSecret');
    expect(sanitizedAuth).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(sanitizedAuth).not.toContain('tok123');

    const sanitizedFile = sanitizeTextValue(
      'fileName="payroll_2026.pdf" fileSize=998877 ciphertext=abcSecretCipher',
    );
    expect(sanitizedFile).not.toContain('payroll_2026.pdf');
    expect(sanitizedFile).not.toContain('998877');
    expect(sanitizedFile).not.toContain('abcSecretCipher');
  });

  test('normalizeSignalingEvent strips signalData bodies, TURN secrets, fragment keys, tokens, and private file fields without console output', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});

    const sdpNormalized = normalizeSignalingEvent({
      direction: 'outbound',
      event: 'signal:forward',
      timestamp: '2026-11-18T15:00:00.000Z',
      payload: {
        roomId: 'ship-83a1',
        signalData: {
          type: 'offer',
          sdp: 'v=0\r\no=- 1 2 IN IP4 10.0.0.5\r\na=ice-pwd:secretIcePwd\r\n',
          extraSecret: 'must-not-leak',
        },
        authToken: 'secret-auth-token',
      },
    });

    expect(sdpNormalized).toEqual({
      timestamp: '2026-11-18T15:00:00.000Z',
      direction: 'outbound',
      event: 'signal:forward',
      roomId: 'ship-83a1',
      summary: expect.stringMatching(/sdp.*offer/i),
      meta: {
        signalKind: 'sdp',
        sdpType: 'offer',
      },
    });
    const sdpSerialized = JSON.stringify(sdpNormalized);
    expect(sdpSerialized).not.toContain('10.0.0.5');
    expect(sdpSerialized).not.toContain('secretIcePwd');
    expect(sdpSerialized).not.toContain('must-not-leak');
    expect(sdpSerialized).not.toContain('secret-auth-token');

    const iceSignalNormalized = normalizeSignalingEvent({
      direction: 'inbound',
      event: 'signal:receive',
      timestamp: '2026-11-18T15:00:01.000Z',
      payload: {
        roomId: 'ship-83a1',
        peerId: 'peer-2',
        signalData: {
          candidate: {
            candidate: 'candidate:1 1 UDP 2122252543 198.51.100.7 45123 typ srflx',
            sdpMid: '0',
            sdpMLineIndex: 0,
          },
        },
      },
    });

    expect(iceSignalNormalized).toEqual({
      timestamp: '2026-11-18T15:00:01.000Z',
      direction: 'inbound',
      event: 'signal:receive',
      roomId: 'ship-83a1',
      peerId: 'peer-2',
      summary: expect.stringMatching(/ice/i),
      meta: {
        signalKind: 'ice',
      },
    });
    expect(JSON.stringify(iceSignalNormalized)).not.toContain('198.51.100.7');
    expect(JSON.stringify(iceSignalNormalized)).not.toContain('45123');

    const iceConfigNormalized = normalizeSignalingEvent({
      direction: 'inbound',
      event: 'ice:credentials',
      timestamp: '2026-11-18T15:00:02.000Z',
      payload: {
        roomId: 'ship-83a1',
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          {
            urls: ['turn:turn.shipri.app:443?transport=tcp', 'turns:turn.shipri.app:443'],
            username: '1700000:secret-user',
            credential: 'hmac-turn-credential-secret',
            credentialType: 'password',
          },
        ],
        TURN_SHARED_SECRET: 'server-turn-secret',
      },
    });

    expect(iceConfigNormalized.roomId).toBe('ship-83a1');
    expect(iceConfigNormalized.meta).toEqual({
      serverCount: 2,
      schemes: ['stun', 'turn', 'turns'],
      hasTurn: true,
    });
    const iceConfigSerialized = JSON.stringify(iceConfigNormalized);
    expect(iceConfigSerialized).not.toContain('secret-user');
    expect(iceConfigSerialized).not.toContain('hmac-turn-credential-secret');
    expect(iceConfigSerialized).not.toContain('server-turn-secret');
    expect(iceConfigSerialized).not.toContain('stun.l.google.com');

    const privatePayloadSummary = sanitizeEventPayloadSummary('board:sync', {
      roomId: 'ship-83a1',
      fileName: 'secret-contract.pdf',
      fileSize: 4096,
      fileType: 'application/pdf',
      fileBoard: [{ name: 'hidden.txt' }],
      ciphertext: 'encrypted-blob-secret',
      chunkData: new Uint8Array([1, 2, 3, 4]),
      shareUrl: 'https://shipri.app/room/ship-83a1#key=masterFragmentKey',
      roomToken: 'room-auth-token-secret',
    });

    expect(privatePayloadSummary).not.toContain('secret-contract.pdf');
    expect(privatePayloadSummary).not.toContain('hidden.txt');
    expect(privatePayloadSummary).not.toContain('encrypted-blob-secret');
    expect(privatePayloadSummary).not.toContain('masterFragmentKey');
    expect(privatePayloadSummary).not.toContain('room-auth-token-secret');

    const malformedJoin = normalizeSignalingEvent({
      direction: 'outbound',
      event: 'room:join',
      timestamp: '2026-11-18T15:00:03.000Z',
      payload: {
        roomId: 'https://shipri.app/room/ship-83a1#key=leakAttempt',
      },
    });
    expect(malformedJoin.roomId).toBeUndefined();
    expect(JSON.stringify(malformedJoin)).not.toContain('leakAttempt');

    const endOfCandidates = normalizeSignalingEvent({
      direction: 'outbound',
      event: 'signal:forward',
      timestamp: '2026-11-18T15:00:04.000Z',
      payload: {
        roomId: 'ship-83a1',
        signalData: { candidate: null },
      },
    });
    expect(endOfCandidates.meta).toEqual({
      signalKind: 'ice',
      endOfCandidates: true,
    });

    const unknownSignal = normalizeSignalingEvent({
      direction: 'inbound',
      event: 'signal:receive',
      timestamp: '2026-11-18T15:00:05.000Z',
      payload: {
        roomId: 'ship-83a1',
        peerId: 'peer-2',
        signalData: { unexpectedSecret: 'do-not-expose' },
      },
    });
    expect(unknownSignal.meta).toEqual({ signalKind: 'unknown' });
    expect(JSON.stringify(unknownSignal)).not.toContain('do-not-expose');

    const singleArgSummary = sanitizeEventPayloadSummary({
      token: 'secret-tok',
      note: 'hello',
    });
    expect(singleArgSummary).toContain('note=hello');
    expect(singleArgSummary).not.toContain('secret-tok');

    expect(logSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    expect(infoSpy).not.toHaveBeenCalled();
    expect(debugSpy).not.toHaveBeenCalled();
  });
});

describe('createSignalingClient', () => {
  test('does not connect on creation, validates URL, connects lazily, and updates status and event subscriptions', () => {
    const ioFactory = createMockSocketFactory();
    let tick = 0;
    const client = createSignalingClient({
      env: { VITE_SIGNALING_URL: 'https://poc.shipri.app/' },
      ioFactory,
      now: () => `2026-11-18T15:00:0${tick++}.000Z`,
    });

    expect(client.getUrl()).toBe('https://poc.shipri.app');
    expect(client.getStatus()).toEqual({
      status: 'disconnected',
      connected: false,
      url: 'https://poc.shipri.app',
      lastError: null,
      disconnectReason: null,
    });
    expect(ioFactory.calls).toHaveLength(0);

    const statusUpdates = [];
    const events = [];
    const unsubscribeStatus = client.subscribeStatus((status) =>
      statusUpdates.push(status),
    );
    const unsubscribeEvents = client.subscribeEvents((event) =>
      events.push(event),
    );

    client.connect();

    expect(ioFactory.calls).toHaveLength(1);
    expect(ioFactory.calls[0].url).toBe('https://poc.shipri.app');
    expect(ioFactory.calls[0].options).toEqual({ autoConnect: false });
    expect(ioFactory.lastSocket.connectCalls).toBe(1);
    expect(statusUpdates.map((entry) => entry.status)).toEqual([
      'connecting',
      'connected',
    ]);
    expect(client.getStatus()).toEqual({
      status: 'connected',
      connected: true,
      url: 'https://poc.shipri.app',
      lastError: null,
      disconnectReason: null,
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      timestamp: '2026-11-18T15:00:00.000Z',
      direction: 'inbound',
      event: 'connect',
    });

    // Idempotent connect while already connected
    client.connect();
    expect(ioFactory.calls).toHaveLength(1);
    expect(ioFactory.lastSocket.connectCalls).toBe(1);

    unsubscribeStatus();
    unsubscribeEvents();
    client.dispose();
  });

  test('supports async connecting state before connect event fires', () => {
    const mockSocket = createMockSocket({ id: 'async-socket' });
    mockSocket.connect = () => {
      mockSocket.connectCalls += 1;
      return mockSocket;
    };

    const client = createSignalingClient({
      url: 'http://localhost:5001',
      ioFactory: () => mockSocket,
    });

    client.connect();
    expect(client.getStatus()).toMatchObject({
      status: 'connecting',
      connected: false,
    });

    mockSocket.simulateConnect();
    expect(client.getStatus()).toMatchObject({
      status: 'connected',
      connected: true,
    });

    client.dispose();
  });

  test('emits outbound POC room, ICE, signal, and raw actions and normalizes server responses', () => {
    const ioFactory = createMockSocketFactory();
    const client = createSignalingClient({
      ioFactory,
      now: () => '2026-11-18T15:10:00.000Z',
    });

    const events = [];
    const serverCreated = [];
    client.subscribeEvents((event) => events.push(event));
    const unsubscribeCreated = client.subscribeServerEvent(
      'room:created',
      (payload) => serverCreated.push(payload),
    );

    client.connect();
    const socket = ioFactory.lastSocket;

    client.createRoom();
    socket.simulateServerEvent('room:created', {
      roomId: 'ship-83a1',
      peerId: 'peer-a',
      negotiationDuty: 'offerer',
    });

    client.joinRoom('ship-83a1');
    socket.simulateServerEvent('room:joined', {
      roomId: 'ship-83a1',
      peerId: 'peer-b',
      negotiationDuty: 'answerer',
    });
    socket.simulateServerEvent('peer:joined', {
      roomId: 'ship-83a1',
      peerId: 'peer-b',
    });

    client.requestIce('ship-83a1');
    socket.simulateServerEvent('ice:credentials', {
      roomId: 'ship-83a1',
      iceServers: [{ urls: ['stun:stun.l.google.com:19302'] }],
    });

    client.forwardSignal('ship-83a1', {
      type: 'offer',
      sdp: 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\na=ice-pwd:offerSecret\r\n',
    });
    socket.simulateServerEvent('signal:receive', {
      roomId: 'ship-83a1',
      peerId: 'peer-b',
      signalData: {
        type: 'answer',
        sdp: 'v=0\r\no=- 3 4 IN IP4 127.0.0.2\r\na=ice-pwd:answerSecret\r\n',
      },
    });

    client.leaveRoom('ship-83a1');
    socket.simulateServerEvent('peer:left', {
      roomId: 'ship-83a1',
      peerId: 'peer-b',
      reason: 'leave',
    });

    client.emitRaw('room:join', { roomId: 'bad-room' });

    expect(socket.emittedEvents).toEqual([
      { event: 'room:create', args: [{}] },
      { event: 'room:join', args: [{ roomId: 'ship-83a1' }] },
      { event: 'ice:get', args: [{ roomId: 'ship-83a1' }] },
      {
        event: 'signal:forward',
        args: [
          {
            roomId: 'ship-83a1',
            signalData: {
              type: 'offer',
              sdp: 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\na=ice-pwd:offerSecret\r\n',
            },
          },
        ],
      },
      { event: 'room:leave', args: [{ roomId: 'ship-83a1' }] },
      { event: 'room:join', args: [{ roomId: 'bad-room' }] },
    ]);

    expect(serverCreated).toEqual([
      {
        roomId: 'ship-83a1',
        peerId: 'peer-a',
        negotiationDuty: 'offerer',
      },
    ]);

    const serializedEvents = JSON.stringify(events);
    expect(serializedEvents).not.toContain('offerSecret');
    expect(serializedEvents).not.toContain('answerSecret');
    expect(serializedEvents).not.toContain('127.0.0.1');
    expect(serializedEvents).not.toContain('127.0.0.2');
    expect(serializedEvents).not.toContain('stun.l.google.com');

    unsubscribeCreated();
    client.dispose();
  });

  test('handles connect_error, room:error, disconnect, reconnect, and synchronous ioFactory failures cleanly', () => {
    const ioFactory = createMockSocketFactory();
    const client = createSignalingClient({
      ioFactory,
      now: () => '2026-11-18T15:20:00.000Z',
    });

    expect(() => client.createRoom()).toThrow(/not connected/i);

    const events = [];
    const statuses = [];
    client.subscribeEvents((entry) => events.push(entry));
    client.subscribeStatus((status) => statuses.push(status));

    client.connect();
    const socket = ioFactory.lastSocket;

    socket.simulateServerEvent('room:error', {
      roomId: 'ship-83a1',
      code: 'ROOM_FULL',
      message: 'This room is already occupied.',
    });

    expect(client.getStatus()).toEqual({
      status: 'connected',
      connected: true,
      url: 'http://localhost:5001',
      lastError: {
        source: 'room:error',
        code: 'ROOM_FULL',
        roomId: 'ship-83a1',
        message: 'This room is already occupied.',
        timestamp: '2026-11-18T15:20:00.000Z',
      },
      disconnectReason: null,
    });

    socket.simulateConnectError(
      new Error(
        'Cannot connect https://user:secretPass@poc.shipri.app/#key=secretKey123',
      ),
    );
    expect(client.getStatus().status).toBe('error');
    expect(client.getStatus().connected).toBe(false);
    expect(client.getStatus().lastError.message).not.toContain('secretPass');
    expect(client.getStatus().lastError.message).not.toContain('secretKey123');

    socket.simulateDisconnect('transport close');
    expect(client.getStatus()).toMatchObject({
      status: 'disconnected',
      connected: false,
      disconnectReason: 'transport close',
    });

    client.connect();
    expect(socket.connectCalls).toBe(2);
    expect(client.getStatus()).toMatchObject({
      status: 'connected',
      connected: true,
      lastError: null,
      disconnectReason: null,
    });

    client.dispose();

    const failingClient = createSignalingClient({
      ioFactory: () => {
        throw new Error('Factory failed for https://u:p@poc.shipri.app/#key=abc');
      },
      now: () => '2026-11-18T15:21:00.000Z',
    });
    const failingEvents = [];
    failingClient.subscribeEvents((entry) => failingEvents.push(entry));
    failingClient.connect();
    expect(failingClient.getStatus().status).toBe('error');
    expect(failingClient.getStatus().lastError.message).not.toContain('u:p@');
    expect(failingClient.getStatus().lastError.message).not.toContain('abc');
    expect(failingEvents[0]).toMatchObject({
      direction: 'local',
      event: 'connect_error',
    });
    failingClient.dispose();
  });

  test('dispose unregisters all Socket.IO listeners, disconnects socket, and prevents further use', () => {
    const ioFactory = createMockSocketFactory();
    const client = createSignalingClient({ ioFactory });

    const statusCalls = [];
    const eventCalls = [];
    client.subscribeStatus((status) => statusCalls.push(status));
    client.subscribeEvents((event) => eventCalls.push(event));

    client.connect();
    const socket = ioFactory.lastSocket;
    expect(socket.getListenerCount()).toBeGreaterThan(0);
    expect(socket.connected).toBe(true);

    const statusCountBeforeDispose = statusCalls.length;
    const eventCountBeforeDispose = eventCalls.length;

    client.dispose();

    expect(socket.getListenerCount()).toBe(0);
    expect(socket.disconnectCalls).toBe(1);
    expect(socket.connected).toBe(false);
    expect(client.getStatus()).toMatchObject({
      status: 'disconnected',
      connected: false,
    });

    // Late simulated events must not reach disposed subscribers
    socket.simulateServerEvent('room:created', {
      roomId: 'ship-83a1',
      peerId: 'peer-a',
      negotiationDuty: 'offerer',
    });
    expect(statusCalls).toHaveLength(statusCountBeforeDispose);
    expect(eventCalls).toHaveLength(eventCountBeforeDispose);

    // Idempotent second dispose
    expect(() => client.dispose()).not.toThrow();
    expect(() => client.connect()).toThrow(/disposed/i);
    expect(() => client.createRoom()).toThrow(/disposed/i);
  });

  test('validates constructor options and method arguments', () => {
    expect(() => createSignalingClient({ url: 'ws://bad.local' })).toThrow();
    expect(() => createSignalingClient({ ioFactory: 'not-a-fn' })).toThrow(
      TypeError,
    );
    expect(() => createSignalingClient({ now: 'not-a-fn' })).toThrow(
      TypeError,
    );

    const client = createSignalingClient({
      ioFactory: createMockSocketFactory(),
    });
    expect(() => client.subscribeStatus('bad')).toThrow(TypeError);
    expect(() => client.subscribeEvents('bad')).toThrow(TypeError);
    expect(() => client.subscribeServerEvent('', () => {})).toThrow(TypeError);
    expect(() => client.subscribeServerEvent('room:created', 'bad')).toThrow(
      TypeError,
    );
    expect(() => client.emitRaw('', {})).toThrow(TypeError);
    client.dispose();
  });
});

describe('App isolation from socket.io-client', () => {
  test('App.jsx does not import socket.io-client directly and renders cleanly without side effects', () => {
    const appSource = fs.readFileSync(
      path.resolve(__dirname, '../src/App.jsx'),
      'utf8',
    );
    expect(appSource).not.toMatch(/socket\.io-client/);

    const ioFactory = createMockSocketFactory();
    const injectedClient = createSignalingClient({ ioFactory });

    const defaultMarkup = renderToStaticMarkup(React.createElement(App));
    expect(defaultMarkup).toContain('Shipri');
    expect(defaultMarkup).toContain('Connecting to signaling server...');

    const disconnectedMarkup = renderToStaticMarkup(
      React.createElement(App, { signalingClient: injectedClient }),
    );
    expect(disconnectedMarkup).toContain('Connecting to signaling server...');
    expect(ioFactory.calls).toHaveLength(0);

    injectedClient.connect();
    const connectedMarkup = renderToStaticMarkup(
      React.createElement(App, { signalingClient: injectedClient }),
    );
    expect(connectedMarkup).toContain('Signaling server connected');

    injectedClient.dispose();
  });
});
