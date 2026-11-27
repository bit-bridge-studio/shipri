import { decodeBase64Url, encodeBase64Url } from './base64url.js';

export const ROOM_AUTH_HKDF_SALT = 'shipri-room-auth-salt-v1';
export const ROOM_AUTH_HKDF_INFO = 'shipri-room-auth-v1';

const CANONICAL_ROOM_ID_PATTERN = /^ship-[a-f0-9]{4}$/;
const TERMINAL_AUTH_ERROR_CODES = new Set([
  'UNAUTHORIZED',
  'ROOM_NOT_FOUND',
  'ROOM_FULL',
  'INVALID_ROOM_ID',
  'INVALID_PAYLOAD',
]);

const SAFE_AUTH_ERROR_MESSAGES = Object.freeze({
  UNAUTHORIZED: 'Room authorization failed or expired.',
  ROOM_NOT_FOUND: 'Room does not exist or has expired.',
  ROOM_FULL: 'Room already has two active peers.',
  INVALID_ROOM_ID: 'Room identifier is invalid.',
  INVALID_PAYLOAD: 'Room authorization payload was rejected.',
  RATE_LIMITED: 'Too many room requests. Try again shortly.',
  SERVER_BUSY: 'Signaling server capacity is currently unavailable.',
});

function getSafeAuthErrorMessage(code) {
  return (
    SAFE_AUTH_ERROR_MESSAGES[code] ??
    'Room authorization failed.'
  );
}

/**
 * Derives HKDF-SHA256 roomAuthToken and SHA-256 authVerifier from a 32-byte
 * master secret using the frozen shipri-room-auth-v1 domain, mathematically
 * disjoint from per-room E2EE AES-GCM keys.
 * @param {Uint8Array} masterSecretBytes
 */
export async function deriveRoomAuthCredentials(masterSecretBytes) {
  if (
    !(masterSecretBytes instanceof Uint8Array) ||
    masterSecretBytes.byteLength !== 32
  ) {
    throw new TypeError('Expected a 32-byte Uint8Array master secret.');
  }

  const encoder = new TextEncoder();
  const baseKey = await globalThis.crypto.subtle.importKey(
    'raw',
    masterSecretBytes,
    'HKDF',
    false,
    ['deriveBits'],
  );

  const derivedBits = await globalThis.crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: encoder.encode(ROOM_AUTH_HKDF_SALT),
      info: encoder.encode(ROOM_AUTH_HKDF_INFO),
    },
    baseKey,
    256,
  );

  const authToken = encodeBase64Url(new Uint8Array(derivedBits));
  const verifierBuffer = await globalThis.crypto.subtle.digest(
    'SHA-256',
    encoder.encode(authToken),
  );
  const authVerifier = encodeBase64Url(new Uint8Array(verifierBuffer));

  return { authToken, authVerifier };
}

/**
 * Constructs a shareable room URL keeping the master secret strictly in the
 * URL fragment (#key=...) with zero secrets or authorization tokens in the
 * path or query string.
 * @param {{ origin: string, roomId: string, masterKeyBase64Url: string }} params
 */
export function buildRoomShareUrl({ origin, roomId, masterKeyBase64Url }) {
  if (typeof origin !== 'string' || origin.trim() === '') {
    throw new TypeError('Expected a valid HTTP(S) origin.');
  }
  const parsedOrigin = new URL(origin.trim());
  if (
    (parsedOrigin.protocol !== 'https:' && parsedOrigin.protocol !== 'http:') ||
    parsedOrigin.pathname !== '/' ||
    parsedOrigin.search !== '' ||
    parsedOrigin.hash !== '' ||
    parsedOrigin.username !== '' ||
    parsedOrigin.password !== ''
  ) {
    throw new TypeError('Origin must be a canonical HTTP(S) origin only.');
  }

  if (typeof roomId !== 'string' || !CANONICAL_ROOM_ID_PATTERN.test(roomId)) {
    throw new TypeError('Expected a canonical roomId matching ship-[a-f0-9]{4}.');
  }

  const decodedKey = decodeBase64Url(masterKeyBase64Url);
  if (decodedKey.byteLength !== 32) {
    throw new TypeError('Master key must decode to exactly 32 bytes.');
  }

  return `${parsedOrigin.origin}/room/${roomId}#key=${masterKeyBase64Url}`;
}

/**
 * Manages the production Socket.IO room authorization lifecycle: attaches
 * derived authVerifier/authToken to room:create and room:join, clears active
 * credentials on leave or terminal authorization errors, and never logs or
 * exposes raw tokens in error records or state snapshots.
 */
export function createRoomAuthorizationSession({
  signalingClient,
  onStateChange,
  onAuthError,
} = {}) {
  if (!signalingClient) {
    throw new TypeError(
      'Expected signalingClient to create room authorization session.',
    );
  }

  let status = 'idle';
  let roomId = null;
  let activeAuthToken = null;
  let activeAuthVerifier = null;
  let lastError = null;
  let disposed = false;

  function getState() {
    return {
      status,
      roomId,
      hasActiveCredentials: Boolean(activeAuthToken || activeAuthVerifier),
      lastError: lastError ? { ...lastError } : null,
    };
  }

  function notify() {
    if (typeof onStateChange === 'function') {
      onStateChange(getState());
    }
  }

  function clearCredentials() {
    activeAuthToken = null;
    activeAuthVerifier = null;
  }

  const unsubscribers = [
    signalingClient.subscribeStatus((snapshot) => {
      if (disposed) {
        return;
      }
      if (snapshot?.status === 'disconnected' && snapshot?.disconnectReason) {
        clearCredentials();
        roomId = null;
        status = 'disconnected';
        notify();
      }
    }),

    signalingClient.subscribeServerEvent('room:created', (payload) => {
      if (disposed) {
        return;
      }
      if (
        typeof payload?.roomId === 'string' &&
        CANONICAL_ROOM_ID_PATTERN.test(payload.roomId)
      ) {
        roomId = payload.roomId;
        status = 'authorized';
        lastError = null;
        notify();
      }
    }),

    signalingClient.subscribeServerEvent('room:joined', (payload) => {
      if (disposed) {
        return;
      }
      if (
        typeof payload?.roomId === 'string' &&
        CANONICAL_ROOM_ID_PATTERN.test(payload.roomId)
      ) {
        roomId = payload.roomId;
        status = 'authorized';
        lastError = null;
        notify();
      }
    }),

    signalingClient.subscribeServerEvent('room:error', (payload) => {
      if (disposed) {
        return;
      }
      const code =
        typeof payload?.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(payload.code)
          ? payload.code
          : 'UNAUTHORIZED';
      const safeError = {
        code,
        message: getSafeAuthErrorMessage(code),
      };

      const isActiveRoomExpiry =
        status === 'authorized' &&
        code === 'ROOM_NOT_FOUND' &&
        (!payload?.roomId || payload.roomId === roomId);

      if (
        (status === 'authorizing' && TERMINAL_AUTH_ERROR_CODES.has(code)) ||
        isActiveRoomExpiry
      ) {
        clearCredentials();
        roomId = null;
        status = 'failed';
      }
      lastError = safeError;
      if (typeof onAuthError === 'function') {
        onAuthError({ ...safeError });
      }
      notify();
    }),
  ];

  async function createAuthorizedRoom(masterSecretBytes) {
    if (disposed) {
      throw new Error('Room authorization session has been disposed.');
    }
    const { authToken, authVerifier } =
      await deriveRoomAuthCredentials(masterSecretBytes);
    activeAuthToken = authToken;
    activeAuthVerifier = authVerifier;
    status = 'authorizing';
    lastError = null;
    signalingClient.createRoom({ authVerifier });
    notify();
    return { status: 'authorizing' };
  }

  async function joinAuthorizedRoom(targetRoomId, masterSecretBytes) {
    if (disposed) {
      throw new Error('Room authorization session has been disposed.');
    }
    if (
      typeof targetRoomId !== 'string' ||
      !CANONICAL_ROOM_ID_PATTERN.test(targetRoomId)
    ) {
      throw new TypeError(
        'Expected a canonical roomId matching ship-[a-f0-9]{4}.',
      );
    }
    const { authToken, authVerifier } =
      await deriveRoomAuthCredentials(masterSecretBytes);
    activeAuthToken = authToken;
    activeAuthVerifier = authVerifier;
    roomId = targetRoomId;
    status = 'authorizing';
    lastError = null;
    signalingClient.joinRoom({ roomId: targetRoomId, authToken });
    notify();
    return { status: 'authorizing', roomId: targetRoomId };
  }

  function leaveAuthorizedRoom() {
    const activeRoom = roomId;
    clearCredentials();
    roomId = null;
    status = 'idle';
    lastError = null;
    if (activeRoom && !disposed) {
      try {
        signalingClient.leaveRoom(activeRoom);
      } catch {
        // Ignore disconnect race while clearing local authorization state.
      }
    }
    notify();
  }

  function dispose() {
    if (disposed) {
      return;
    }
    disposed = true;
    clearCredentials();
    roomId = null;
    status = 'idle';
    lastError = null;
    while (unsubscribers.length > 0) {
      const unsubscribe = unsubscribers.pop();
      unsubscribe();
    }
  }

  return Object.freeze({
    getState,
    createAuthorizedRoom,
    joinAuthorizedRoom,
    leaveAuthorizedRoom,
    dispose,
  });
}
