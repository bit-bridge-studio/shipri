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
});
