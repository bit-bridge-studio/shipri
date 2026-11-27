import { decodeBase64Url, encodeBase64Url } from './base64url.js';

export const ROOM_KEY_BYTES = 32;
export const MEMBER_ID_BYTES = 16;
export const SESSION_STORAGE_PREFIX = 'shipri:room-session:';

const CANONICAL_ROOM_ID_PATTERN = /^ship-[a-f0-9]{4}$/;
const TERMINAL_ROOM_ERROR_CODES = new Set([
  'ROOM_NOT_FOUND',
  'UNAUTHORIZED',
  'ROOM_FULL',
  'INVALID_ROOM_ID',
]);

function isValidRoomId(value) {
  return typeof value === 'string' && CANONICAL_ROOM_ID_PATTERN.test(value);
}

function getStorageKey(roomId) {
  return `${SESSION_STORAGE_PREFIX}${roomId}`;
}

/**
 * Generates a cryptographically random 256-bit room master secret.
 */
export function generateMasterKey() {
  const masterKeyBytes = new Uint8Array(ROOM_KEY_BYTES);
  globalThis.crypto.getRandomValues(masterKeyBytes);
  return {
    masterKeyBytes,
    masterKeyBase64Url: encodeBase64Url(masterKeyBytes),
  };
}

/**
 * Generates a cryptographically random 16-byte persistent room-session memberId
 * encoded as unpadded base64url (22 characters).
 */
export function generateMemberId() {
  const bytes = new Uint8Array(MEMBER_ID_BYTES);
  globalThis.crypto.getRandomValues(bytes);
  return encodeBase64Url(bytes);
}

/**
 * Validates and decodes an unpadded base64url room master key (exactly 32 bytes).
 * @param {string} base64UrlKey
 */
export function decodeMasterKey(base64UrlKey) {
  const decoded = decodeBase64Url(base64UrlKey);
  if (decoded.byteLength !== ROOM_KEY_BYTES) {
    throw new TypeError('Master key must decode to exactly 32 bytes.');
  }
  return decoded;
}

function isValidMemberId(value) {
  if (typeof value !== 'string') {
    return false;
  }
  try {
    return decodeBase64Url(value).byteLength === MEMBER_ID_BYTES;
  } catch {
    return false;
  }
}

/**
 * Extracts #key=<base64url> from location.hash, rejects query-string key transport,
 * and immediately strips the fragment via history.replaceState without logging secrets.
 */
export function extractAndStripFragmentKey({
  locationObj = globalThis.window?.location,
  historyObj = globalThis.window?.history,
} = {}) {
  const pathname =
    typeof locationObj?.pathname === 'string' && locationObj.pathname !== ''
      ? locationObj.pathname
      : '/';
  const search = typeof locationObj?.search === 'string' ? locationObj.search : '';
  const hash = typeof locationObj?.hash === 'string' ? locationObj.hash : '';

  // Reject any key accidentally placed in query parameters
  if (search !== '') {
    const queryParams = new URLSearchParams(search);
    if (queryParams.has('key') || queryParams.has('authToken')) {
      if (typeof historyObj?.replaceState === 'function') {
        historyObj.replaceState(null, '', pathname);
      }
      return {
        ok: false,
        code: 'INSECURE_KEY_TRANSPORT',
        message: 'Room encryption key must be provided only in the URL fragment.',
      };
    }
  }

  if (!hash || hash === '#') {
    return {
      ok: false,
      code: 'MISSING_KEY',
      message: 'Room encryption key is missing from the link.',
    };
  }

  // Always strip the fragment from the visible address bar immediately
  if (typeof historyObj?.replaceState === 'function') {
    historyObj.replaceState(null, '', pathname);
  }

  const rawFragment = hash.startsWith('#') ? hash.slice(1) : hash;
  const fragmentParams = new URLSearchParams(rawFragment);
  const rawKey = fragmentParams.get('key');

  if (!rawKey) {
    return {
      ok: false,
      code: 'MISSING_KEY',
      message: 'Room encryption key is missing from the link.',
    };
  }

  try {
    const masterKeyBytes = decodeMasterKey(rawKey);
    return {
      ok: true,
      masterKeyBytes,
      masterKeyBase64Url: rawKey,
    };
  } catch {
    return {
      ok: false,
      code: 'INVALID_KEY',
      message: 'Room encryption key is malformed.',
    };
  }
}

function saveRoomSession({ roomId, masterKeyBase64Url, memberId, storage }) {
  if (!storage || typeof storage.setItem !== 'function') {
    return;
  }
  storage.setItem(
    getStorageKey(roomId),
    JSON.stringify({ masterKeyBase64Url, memberId }),
  );
}

function clearRoomSession({ roomId, storage }) {
  if (!roomId || !storage || typeof storage.removeItem !== 'function') {
    return;
  }
  storage.removeItem(getStorageKey(roomId));
}

function loadRoomSession({ roomId, storage }) {
  if (!storage || typeof storage.getItem !== 'function') {
    return { ok: false, code: 'MISSING_KEY' };
  }
  const raw = storage.getItem(getStorageKey(roomId));
  if (raw === null || raw === undefined) {
    return { ok: false, code: 'MISSING_KEY' };
  }

  try {
    const parsed = JSON.parse(raw);
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      !isValidMemberId(parsed.memberId)
    ) {
      clearRoomSession({ roomId, storage });
      return {
        ok: false,
        code: 'INVALID_KEY',
        message: 'Cached room encryption key is invalid.',
      };
    }
    const masterKeyBytes = decodeMasterKey(parsed.masterKeyBase64Url);
    return {
      ok: true,
      masterKeyBytes,
      masterKeyBase64Url: parsed.masterKeyBase64Url,
      memberId: parsed.memberId,
    };
  } catch {
    clearRoomSession({ roomId, storage });
    return {
      ok: false,
      code: 'INVALID_KEY',
      message: 'Cached room encryption key is invalid.',
    };
  }
}

/**
 * Manages the full room master key lifecycle: creation, URL fragment extraction
 * and replaceState stripping, tab-scoped sessionStorage reload recovery, and
 * explicit wiping on leave, terminal room error, or session reset.
 */
export function createFragmentKeyLifecycle({
  storage = globalThis.window?.sessionStorage,
  locationObj = globalThis.window?.location,
  historyObj = globalThis.window?.history,
} = {}) {
  let activeSession = null;

  function wipeInMemory() {
    if (activeSession?.masterKeyBytes instanceof Uint8Array) {
      activeSession.masterKeyBytes.fill(0);
    }
    activeSession = null;
  }

  function createForRoom(roomId) {
    if (!isValidRoomId(roomId)) {
      return {
        ok: false,
        code: 'INVALID_ROOM_ID',
        message: 'Room identifier is invalid.',
      };
    }
    wipeInMemory();
    const { masterKeyBytes, masterKeyBase64Url } = generateMasterKey();
    const memberId = generateMemberId();
    saveRoomSession({ roomId, masterKeyBase64Url, memberId, storage });
    activeSession = {
      roomId,
      masterKeyBytes,
      masterKeyBase64Url,
      memberId,
      source: 'created',
    };
    return { ok: true, ...activeSession };
  }

  function resolveForRoom(roomId) {
    if (!isValidRoomId(roomId)) {
      return {
        ok: false,
        code: 'INVALID_ROOM_ID',
        message: 'Room identifier is invalid.',
      };
    }

    const fragment = extractAndStripFragmentKey({ locationObj, historyObj });
    if (fragment.ok) {
      wipeInMemory();
      const existing = loadRoomSession({ roomId, storage });
      const memberId =
        existing.ok && existing.memberId ? existing.memberId : generateMemberId();
      saveRoomSession({
        roomId,
        masterKeyBase64Url: fragment.masterKeyBase64Url,
        memberId,
        storage,
      });
      activeSession = {
        roomId,
        masterKeyBytes: fragment.masterKeyBytes,
        masterKeyBase64Url: fragment.masterKeyBase64Url,
        memberId,
        source: 'fragment',
      };
      return { ok: true, ...activeSession };
    }

    if (fragment.code !== 'MISSING_KEY') {
      return fragment;
    }

    const cached = loadRoomSession({ roomId, storage });
    if (cached.ok) {
      wipeInMemory();
      activeSession = {
        roomId,
        masterKeyBytes: cached.masterKeyBytes,
        masterKeyBase64Url: cached.masterKeyBase64Url,
        memberId: cached.memberId,
        source: 'session_storage',
      };
      return { ok: true, ...activeSession };
    }

    if (cached.code === 'INVALID_KEY') {
      return cached;
    }

    return {
      ok: false,
      code: 'MISSING_KEY',
      message: 'Room encryption key is missing from the link.',
    };
  }

  function wipeForLeave() {
    const targetRoomId = activeSession?.roomId ?? null;
    wipeInMemory();
    if (targetRoomId) {
      clearRoomSession({ roomId: targetRoomId, storage });
    }
  }

  function handleTerminalRoomError(code) {
    if (TERMINAL_ROOM_ERROR_CODES.has(code)) {
      wipeForLeave();
      return true;
    }
    return false;
  }

  function reset() {
    wipeForLeave();
  }

  return Object.freeze({
    createForRoom,
    resolveForRoom,
    getActiveSession: () => activeSession,
    wipeForLeave,
    handleTerminalRoomError,
    reset,
  });
}
