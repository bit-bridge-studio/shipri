import {
  decryptFileAdvertisement,
  isValidFileId,
} from '../crypto/board-metadata.js';

export const RECONNECT_BOARD_GRACE_MS = 60_000;

const CANONICAL_ROOM_ID_PATTERN = /^ship-[a-f0-9]{4}$/;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isValidRoomId(roomId) {
  return typeof roomId === 'string' && CANONICAL_ROOM_ID_PATTERN.test(roomId);
}

function freezeEntry(fileId, metadata, availability) {
  return Object.freeze({
    fileId,
    fileName: metadata.fileName,
    fileSize: metadata.fileSize,
    fileType: metadata.fileType,
    chunkSize: metadata.chunkSize,
    totalChunks: metadata.totalChunks,
    ...(metadata.sha256 ? { sha256: metadata.sha256 } : {}),
    availability,
  });
}

function validatePeerHello(message) {
  const payload = message.payload;
  return (
    isPlainObject(payload) &&
    typeof payload.memberId === 'string' &&
    payload.memberId.length > 0 &&
    payload.protocolVersion === 1
  );
}

function validateFileRemove(message) {
  if (!isPlainObject(message) || message.type !== 'FILE_REMOVE') {
    return { ok: false };
  }
  const payload = message.payload;
  if (!isPlainObject(payload)) {
    return { ok: false };
  }
  const keys = Object.keys(payload);
  if (keys.length !== 1 || keys[0] !== 'fileId') {
    return { ok: false };
  }
  if (!isValidFileId(payload.fileId)) {
    return { ok: false };
  }
  return { ok: true, fileId: payload.fileId };
}

function validateBoardSyncShape(message) {
  if (!isPlainObject(message) || message.type !== 'BOARD_SYNC') {
    return { ok: false };
  }
  const payload = message.payload;
  if (!isPlainObject(payload)) {
    return { ok: false };
  }
  const keys = Object.keys(payload);
  if (keys.length !== 1 || keys[0] !== 'files' || !Array.isArray(payload.files)) {
    return { ok: false };
  }
  return { ok: true, files: payload.files };
}

/**
 * Manages the peer-facing read-only remote file board: decrypts incoming
 * FILE_ADVERTISE and BOARD_SYNC snapshots using the room master key, converges
 * without duplicate or stale entries, handles FILE_REMOVE updates, and enforces
 * the 60s reconnect availability grace window without leaking local File handles.
 */
export function createRemoteFileBoard({
  roomId,
  masterKeyBytes,
  graceWindowMs = RECONNECT_BOARD_GRACE_MS,
  setTimeoutFn = globalThis.setTimeout,
  clearTimeoutFn = globalThis.clearTimeout,
  onChange,
  onError,
} = {}) {
  if (!isValidRoomId(roomId)) {
    throw new TypeError('Expected a canonical roomId matching ship-[a-f0-9]{4}.');
  }
  if (
    !(masterKeyBytes instanceof Uint8Array) ||
    masterKeyBytes.byteLength !== 32
  ) {
    throw new TypeError('Expected a 32-byte Uint8Array master key.');
  }
  if (
    typeof graceWindowMs !== 'number' ||
    !Number.isFinite(graceWindowMs) ||
    graceWindowMs < 0
  ) {
    throw new TypeError('Expected a non-negative finite graceWindowMs.');
  }

  let disposed = false;
  let syncState = 'empty';
  let generation = 0;
  let graceTimer = null;
  let queue = Promise.resolve();
  const entries = new Map();

  function getEntries() {
    return Object.freeze(Array.from(entries.values()));
  }

  function getEntry(fileId) {
    if (typeof fileId !== 'string') {
      return null;
    }
    return entries.get(fileId) ?? null;
  }

  function getSyncState() {
    return syncState;
  }

  function emitChange() {
    if (!disposed && typeof onChange === 'function') {
      onChange(getEntries(), syncState);
    }
  }

  function emitError(error) {
    if (!disposed && typeof onError === 'function') {
      onError(error);
    }
  }

  function cancelGraceTimer() {
    if (graceTimer !== null) {
      clearTimeoutFn(graceTimer);
      graceTimer = null;
    }
  }

  function enqueue(task) {
    const run = queue.then(task, task);
    queue = run.catch(() => {});
    return run;
  }

  async function processFileAdvertise(message, capturedGeneration) {
    if (disposed) {
      return { ok: false, code: 'DISPOSED' };
    }
    if (capturedGeneration !== generation) {
      emitError({ code: 'STALE_EPOCH', type: 'FILE_ADVERTISE' });
      return { ok: false, code: 'STALE_EPOCH' };
    }

    const decrypted = await decryptFileAdvertisement({
      masterKeyBytes,
      roomId,
      message,
    });

    if (disposed) {
      return { ok: false, code: 'DISPOSED' };
    }
    if (capturedGeneration !== generation) {
      emitError({ code: 'STALE_EPOCH', type: 'FILE_ADVERTISE' });
      return { ok: false, code: 'STALE_EPOCH' };
    }
    if (!decrypted.ok) {
      emitError({ code: decrypted.code, type: 'FILE_ADVERTISE' });
      return { ok: false, code: decrypted.code };
    }

    const entry = freezeEntry(decrypted.fileId, decrypted.metadata, 'available');
    entries.set(decrypted.fileId, entry);
    if (syncState === 'empty' || syncState === 'syncing') {
      syncState = 'synced';
    }
    emitChange();
    return {
      ok: true,
      fileId: decrypted.fileId,
      entry,
    };
  }

  async function processBoardSync(message, capturedGeneration) {
    if (disposed) {
      return { ok: false, code: 'DISPOSED' };
    }
    if (capturedGeneration !== generation) {
      emitError({ code: 'STALE_EPOCH', type: 'BOARD_SYNC' });
      return { ok: false, code: 'STALE_EPOCH' };
    }

    const shape = validateBoardSyncShape(message);
    if (!shape.ok) {
      emitError({ code: 'INVALID_BOARD_SYNC', type: 'BOARD_SYNC' });
      return { ok: false, code: 'INVALID_BOARD_SYNC' };
    }

    const nextEntries = new Map();
    for (const item of shape.files) {
      const decrypted = await decryptFileAdvertisement({
        masterKeyBytes,
        roomId,
        message: {
          type: 'FILE_ADVERTISE',
          payload: item,
        },
      });

      if (disposed) {
        return { ok: false, code: 'DISPOSED' };
      }
      if (capturedGeneration !== generation) {
        emitError({ code: 'STALE_EPOCH', type: 'BOARD_SYNC' });
        return { ok: false, code: 'STALE_EPOCH' };
      }
      if (!decrypted.ok) {
        emitError({
          code: decrypted.code,
          type: 'BOARD_SYNC',
          ...(isPlainObject(item) && typeof item.fileId === 'string'
            ? { fileId: item.fileId }
            : {}),
        });
        return { ok: false, code: decrypted.code };
      }

      nextEntries.set(
        decrypted.fileId,
        freezeEntry(decrypted.fileId, decrypted.metadata, 'available'),
      );
    }

    cancelGraceTimer();
    entries.clear();
    for (const [fileId, entry] of nextEntries) {
      entries.set(fileId, entry);
    }
    syncState = 'synced';
    emitChange();
    return {
      ok: true,
      entries: getEntries(),
    };
  }

  async function processFileRemove(message, capturedGeneration) {
    if (disposed) {
      return { ok: false, code: 'DISPOSED' };
    }
    if (capturedGeneration !== generation) {
      emitError({ code: 'STALE_EPOCH', type: 'FILE_REMOVE' });
      return { ok: false, code: 'STALE_EPOCH' };
    }

    const parsed = validateFileRemove(message);
    if (!parsed.ok) {
      emitError({ code: 'INVALID_REMOVE', type: 'FILE_REMOVE' });
      return { ok: false, code: 'INVALID_REMOVE' };
    }

    const removed = entries.delete(parsed.fileId);
    if (removed) {
      emitChange();
    }
    return {
      ok: true,
      removed,
      fileId: parsed.fileId,
    };
  }

  function handleFileAdvertise(message) {
    const capturedGeneration = generation;
    return enqueue(() => processFileAdvertise(message, capturedGeneration));
  }

  function handleBoardSync(message) {
    const capturedGeneration = generation;
    return enqueue(() => processBoardSync(message, capturedGeneration));
  }

  function handleFileRemove(message) {
    const capturedGeneration = generation;
    return enqueue(() => processFileRemove(message, capturedGeneration));
  }

  function handleControlMessage(message) {
    if (!isPlainObject(message) || typeof message.type !== 'string') {
      emitError({ code: 'INVALID_CONTROL_MESSAGE' });
      return Promise.resolve({ ok: false, code: 'INVALID_CONTROL_MESSAGE' });
    }

    if (message.type === 'PEER_HELLO') {
      const capturedGeneration = generation;
      return enqueue(async () => {
        if (disposed) {
          return { ok: false, code: 'DISPOSED' };
        }
        if (capturedGeneration !== generation) {
          emitError({ code: 'STALE_EPOCH', type: 'PEER_HELLO' });
          return { ok: false, code: 'STALE_EPOCH' };
        }
        if (!validatePeerHello(message)) {
          emitError({ code: 'INVALID_PEER_HELLO', type: 'PEER_HELLO' });
          return { ok: false, code: 'INVALID_PEER_HELLO' };
        }
        if (syncState === 'empty') {
          syncState = 'syncing';
          emitChange();
        }
        return { ok: true };
      });
    }

    if (message.type === 'BOARD_SYNC') {
      return handleBoardSync(message);
    }
    if (message.type === 'FILE_ADVERTISE') {
      return handleFileAdvertise(message);
    }
    if (message.type === 'FILE_REMOVE') {
      return handleFileRemove(message);
    }

    return Promise.resolve({ ok: true, ignored: true });
  }

  function handlePeerDisconnected() {
    if (disposed) {
      return;
    }
    generation += 1;
    cancelGraceTimer();

    for (const [fileId, entry] of entries) {
      entries.set(fileId, freezeEntry(fileId, entry, 'unavailable_reconnecting'));
    }
    syncState = 'peer_disconnected_grace';

    graceTimer = setTimeoutFn(() => {
      graceTimer = null;
      if (disposed || syncState !== 'peer_disconnected_grace') {
        return;
      }
      generation += 1;
      entries.clear();
      syncState = 'empty';
      emitChange();
    }, graceWindowMs);

    emitChange();
  }

  function clear() {
    if (disposed) {
      return;
    }
    generation += 1;
    cancelGraceTimer();
    entries.clear();
    syncState = 'empty';
    emitChange();
  }

  function dispose() {
    if (disposed) {
      return;
    }
    disposed = true;
    generation += 1;
    cancelGraceTimer();
    entries.clear();
    syncState = 'empty';
  }

  return Object.freeze({
    handleControlMessage,
    handleFileAdvertise,
    handleFileRemove,
    handleBoardSync,
    handlePeerDisconnected,
    getEntries,
    getEntry,
    getSyncState,
    clear,
    dispose,
  });
}
