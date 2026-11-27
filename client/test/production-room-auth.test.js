import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  decodeBase64Url,
  encodeBase64Url,
  isValidBase64Url,
} from '../src/crypto/base64url.js';
import {
  ROOM_AUTH_HKDF_INFO,
  ROOM_AUTH_HKDF_SALT,
  buildRoomShareUrl,
  createRoomAuthorizationSession,
  deriveRoomAuthCredentials,
} from '../src/crypto/room-auth.js';
import { createFragmentKeyLifecycle } from '../src/crypto/fragment-key.js';
import { createSignalingClient } from '../src/signaling/socket-client.js';
import { createMockSocketFactory } from './helpers/mock-socket.js';

function sha256Base64Url(value) {
  return createHash('sha256').update(value, 'utf8').digest('base64url');
}

describe('production room authorization lifecycle (ticket [43])', () => {
  it('derives HKDF room authorization credentials independently from E2EE keys and validates strict unpadded base64url', async () => {
    const masterSecret = new Uint8Array(32);
    for (let i = 0; i < 32; i += 1) {
      masterSecret[i] = (i * 11 + 7) & 0xff;
    }

    expect(ROOM_AUTH_HKDF_SALT).toBe('shipri-room-auth-salt-v1');
    expect(ROOM_AUTH_HKDF_INFO).toBe('shipri-room-auth-v1');

    const { authToken, authVerifier } =
      await deriveRoomAuthCredentials(masterSecret);

    expect(isValidBase64Url(authToken)).toBe(true);
    expect(isValidBase64Url(authVerifier)).toBe(true);
    expect(decodeBase64Url(authToken).byteLength).toBe(32);
    expect(decodeBase64Url(authVerifier).byteLength).toBe(32);
    expect(authVerifier).toBe(sha256Base64Url(authToken));
    expect(authToken).not.toBe(encodeBase64Url(masterSecret));

    // Cryptographic separation from E2EE board-metadata HKDF derivation
    const encoder = new TextEncoder();
    const baseKey = await globalThis.crypto.subtle.importKey(
      'raw',
      masterSecret,
      'HKDF',
      false,
      ['deriveBits'],
    );
    const e2eeBits = await globalThis.crypto.subtle.deriveBits(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: encoder.encode('shipri:ship-83a1'),
        info: encoder.encode('shipri-board-metadata-v1'),
      },
      baseKey,
      256,
    );
    expect(encodeBase64Url(new Uint8Array(e2eeBits))).not.toBe(authToken);

    // Rejects padded or malformed base64url and wrong-length master secrets
    expect(isValidBase64Url('abc=')).toBe(false);
    expect(isValidBase64Url('abc+def')).toBe(false);
    expect(() => decodeBase64Url('abc=')).toThrow();
    await expect(
      deriveRoomAuthCredentials(new Uint8Array(16)),
    ).rejects.toThrow();
  });

  it('constructs share URLs keeping secrets strictly in #key= fragment with zero path or query leakage', () => {
    const masterKey = encodeBase64Url(new Uint8Array(32).fill(0x5a));
    const shareUrl = buildRoomShareUrl({
      origin: 'https://shipri.app',
      roomId: 'ship-83a1',
      masterKeyBase64Url: masterKey,
    });

    const parsed = new URL(shareUrl);
    expect(parsed.origin).toBe('https://shipri.app');
    expect(parsed.pathname).toBe('/room/ship-83a1');
    expect(parsed.search).toBe('');
    expect(parsed.hash).toBe(`#key=${masterKey}`);
    expect(parsed.pathname).not.toContain(masterKey);
    expect(parsed.search).not.toContain('key');
    expect(parsed.search).not.toContain('token');

    // Rejects invalid origin, non-canonical roomId, or non-32-byte key
    expect(() =>
      buildRoomShareUrl({
        origin: 'https://shipri.app/extra?token=leak',
        roomId: 'ship-83a1',
        masterKeyBase64Url: masterKey,
      }),
    ).toThrow();
    expect(() =>
      buildRoomShareUrl({
        origin: 'https://shipri.app',
        roomId: 'INVALID',
        masterKeyBase64Url: masterKey,
      }),
    ).toThrow();
    expect(() =>
      buildRoomShareUrl({
        origin: 'https://shipri.app',
        roomId: 'ship-83a1',
        masterKeyBase64Url: encodeBase64Url(new Uint8Array(16)),
      }),
    ).toThrow();
  });

  it('attaches derived credentials to Socket.IO actions, clears them on leave, and fails safely on invalid or expired auth without logging tokens', async () => {
    const socketFactory = createMockSocketFactory({ idPrefix: 'auth-peer' });
    let capturedSocket = null;
    const emitted = [];
    const logs = [];

    const client = createSignalingClient({
      url: 'https://shipri.app',
      ioFactory: (url, opts) => {
        capturedSocket = socketFactory(url, opts);
        const origEmit = capturedSocket.emit.bind(capturedSocket);
        capturedSocket.emit = (event, payload) => {
          emitted.push({ event, payload });
          return origEmit(event, payload);
        };
        return capturedSocket;
      },
    });
    client.subscribeEvents((entry) => logs.push(entry));
    client.connect();

    const authErrors = [];
    const session = createRoomAuthorizationSession({
      signalingClient: client,
      onAuthError: (err) => authErrors.push(err),
    });

    const masterSecret = new Uint8Array(32).fill(0x2c);
    const derived = await deriveRoomAuthCredentials(masterSecret);

    // 1. Authorized create attaches { authVerifier } only
    await session.createAuthorizedRoom(masterSecret);
    expect(emitted[0]).toEqual({
      event: 'room:create',
      payload: { authVerifier: derived.authVerifier },
    });
    capturedSocket.simulateServerEvent('room:created', {
      roomId: 'ship-a1b2',
      peerId: 'peer-1',
      negotiationDuty: 'offerer',
    });
    expect(session.getState()).toMatchObject({
      status: 'authorized',
      roomId: 'ship-a1b2',
      hasActiveCredentials: true,
    });

    // 2. Leave clears in-memory authorization state and emits room:leave
    session.leaveAuthorizedRoom();
    expect(emitted[1]).toEqual({
      event: 'room:leave',
      payload: { roomId: 'ship-a1b2' },
    });
    expect(session.getState()).toEqual({
      status: 'idle',
      roomId: null,
      hasActiveCredentials: false,
      lastError: null,
    });

    // 3. Authorized join attaches { roomId, authToken }
    await session.joinAuthorizedRoom('ship-c3d4', masterSecret);
    expect(emitted[2]).toEqual({
      event: 'room:join',
      payload: { roomId: 'ship-c3d4', authToken: derived.authToken },
    });

    // 4. Server rejects expired or invalid auth -> clears credentials safely without leaking token
    capturedSocket.simulateServerEvent('room:error', {
      roomId: 'ship-c3d4',
      code: 'UNAUTHORIZED',
      message: `Invalid token ${derived.authToken}`,
    });

    expect(session.getState()).toMatchObject({
      status: 'failed',
      roomId: null,
      hasActiveCredentials: false,
    });
    expect(authErrors).toHaveLength(1);
    expect(authErrors[0].code).toBe('UNAUTHORIZED');

    // Never expose raw authToken or authVerifier in state, errors, or sanitized logs
    const auditBlob = JSON.stringify({
      state: session.getState(),
      errors: authErrors,
      logs,
    });
    expect(auditBlob).not.toContain(derived.authToken);
    expect(auditBlob).not.toContain(derived.authVerifier);

    session.dispose();
    client.dispose();
  });

  it('completes creator-to-joiner share link flow with matching authToken/authVerifier and preserves authorized state across non-terminal errors until expiry or disconnect', async () => {
    const socketFactory = createMockSocketFactory({ idPrefix: 'e2e-auth' });
    const creatorEmitted = [];
    const joinerEmitted = [];
    let creatorSocket = null;
    let joinerSocket = null;

    const creatorClient = createSignalingClient({
      url: 'https://shipri.app',
      ioFactory: (url, opts) => {
        creatorSocket = socketFactory(url, opts);
        const origEmit = creatorSocket.emit.bind(creatorSocket);
        creatorSocket.emit = (event, payload) => {
          creatorEmitted.push({ event, payload });
          return origEmit(event, payload);
        };
        return creatorSocket;
      },
    });
    const joinerClient = createSignalingClient({
      url: 'https://shipri.app',
      ioFactory: (url, opts) => {
        joinerSocket = socketFactory(url, opts);
        const origEmit = joinerSocket.emit.bind(joinerSocket);
        joinerSocket.emit = (event, payload) => {
          joinerEmitted.push({ event, payload });
          return origEmit(event, payload);
        };
        return joinerSocket;
      },
    });
    creatorClient.connect();
    joinerClient.connect();

    const creatorStorage = new Map();
    const joinerStorage = new Map();
    const wrapStorage = (m) => ({
      getItem: (k) => (m.has(k) ? m.get(k) : null),
      setItem: (k, v) => m.set(k, String(v)),
      removeItem: (k) => m.delete(k),
    });

    const lifecycleA = createFragmentKeyLifecycle({
      storage: wrapStorage(creatorStorage),
      locationObj: { origin: 'https://shipri.app', pathname: '/', search: '', hash: '' },
      historyObj: { replaceState: () => {} },
    });
    const authA = createRoomAuthorizationSession({ signalingClient: creatorClient });

    // Creator prepares key BEFORE room:create
    const pending = lifecycleA.prepareCreation();
    await authA.createAuthorizedRoom(pending.masterKeyBytes);
    const creatorVerifier = creatorEmitted[0].payload.authVerifier;

    // Server assigns roomId -> bind exact pre-generated key without regenerating
    creatorSocket.simulateServerEvent('room:created', {
      roomId: 'ship-77ef',
      peerId: 'peer-a',
      negotiationDuty: 'offerer',
    });
    const bound = lifecycleA.bindCreatedRoom('ship-77ef');
    expect(bound.masterKeyBase64Url).toBe(pending.masterKeyBase64Url);

    const shareUrl = buildRoomShareUrl({
      origin: 'https://shipri.app',
      roomId: bound.roomId,
      masterKeyBase64Url: bound.masterKeyBase64Url,
    });
    const parsedShare = new URL(shareUrl);

    // Joiner extracts fragment, derives authToken, and matches creator authVerifier
    const joinerLoc = {
      origin: parsedShare.origin,
      pathname: parsedShare.pathname,
      search: parsedShare.search,
      hash: parsedShare.hash,
    };
    const lifecycleB = createFragmentKeyLifecycle({
      storage: wrapStorage(joinerStorage),
      locationObj: joinerLoc,
      historyObj: { replaceState: () => { joinerLoc.hash = ''; } },
    });
    const authB = createRoomAuthorizationSession({ signalingClient: joinerClient });
    const extracted = lifecycleB.resolveForRoom('ship-77ef');
    expect(extracted.ok).toBe(true);
    await authB.joinAuthorizedRoom('ship-77ef', extracted.masterKeyBytes);

    const joinerToken = joinerEmitted[0].payload.authToken;
    expect(sha256Base64Url(joinerToken)).toBe(creatorVerifier);
    joinerSocket.simulateServerEvent('room:joined', {
      roomId: 'ship-77ef',
      peerId: 'peer-b',
      negotiationDuty: 'answerer',
    });

    // Non-terminal atomic no-op errors MUST preserve authorized state & credentials
    creatorSocket.simulateServerEvent('room:error', {
      code: 'INVALID_PAYLOAD',
      message: 'Malformed probe payload.',
    });
    expect(authA.getState()).toMatchObject({
      status: 'authorized',
      roomId: 'ship-77ef',
      hasActiveCredentials: true,
    });

    creatorSocket.simulateServerEvent('room:error', {
      roomId: 'ship-9999',
      code: 'UNAUTHORIZED',
      message: 'Cross-room check.',
    });
    expect(authA.getState()).toMatchObject({
      status: 'authorized',
      roomId: 'ship-77ef',
      hasActiveCredentials: true,
    });

    // Active room expiry (ROOM_NOT_FOUND for active room) clears credentials
    creatorSocket.simulateServerEvent('room:error', {
      roomId: 'ship-77ef',
      code: 'ROOM_NOT_FOUND',
      message: 'Room expired.',
    });
    expect(authA.getState()).toMatchObject({
      status: 'failed',
      roomId: null,
      hasActiveCredentials: false,
    });

    // Socket disconnect while authorized clears joiner credentials safely
    expect(authB.getState().status).toBe('authorized');
    joinerSocket.simulateDisconnect('transport close');
    expect(authB.getState()).toMatchObject({
      status: 'disconnected',
      roomId: null,
      hasActiveCredentials: false,
    });

    authA.dispose();
    authB.dispose();
    creatorClient.dispose();
    joinerClient.dispose();
  });
});
