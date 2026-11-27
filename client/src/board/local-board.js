import {
  FIXED_CHUNK_SIZE_BYTES,
  encryptFileAdvertisement,
  generateFileId,
  validatePlaintextFileMetadata,
} from '../crypto/board-metadata.js';

const CANONICAL_ROOM_ID_PATTERN = /^ship-[a-f0-9]{4}$/;

function isValidRoomId(roomId) {
  return typeof roomId === 'string' && CANONICAL_ROOM_ID_PATTERN.test(roomId);
}

function isReadableFileLike(file) {
  return (
    file !== null &&
    typeof file === 'object' &&
    typeof file.name === 'string' &&
    typeof file.size === 'number' &&
    Number.isSafeInteger(file.size) &&
    file.size >= 0 &&
    typeof file.slice === 'function'
  );
}

function buildDuplicateKey(file) {
  const lastMod = Number.isFinite(file.lastModified) ? file.lastModified : 0;
  return `${file.name}\0${file.size}\0${lastMod}`;
}

function toPublicEntry(record) {
  return Object.freeze({
    fileId: record.fileId,
    fileName: record.metadata.fileName,
    fileSize: record.metadata.fileSize,
    fileType: record.metadata.fileType,
    chunkSize: record.metadata.chunkSize,
    totalChunks: record.metadata.totalChunks,
    ...(record.metadata.sha256 ? { sha256: record.metadata.sha256 } : {}),
    availability: 'available',
  });
}

/**
 * Manages the owner-side local file registry on the shared room board: keeps local
 * File references strictly in owner memory, publishes encrypted FILE_ADVERTISE and
 * BOARD_SYNC messages, suppresses duplicates, detects unreadable local files, and
 * preserves File handles for active transfers when an advertisement is removed.
 */
export function createLocalFileBoard({
  roomId,
  masterKeyBytes,
  publishControlMessage,
  onChange,
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

  let disposed = false;
  const advertisedEntries = new Map();
  const retainedForRemovedTransfers = new Map();
  const transferToFileId = new Map();
  const fileIdToTransfers = new Map();

  function getPublicEntries() {
    return Array.from(advertisedEntries.values(), (record) =>
      toPublicEntry(record),
    );
  }

  function notifyChange() {
    if (!disposed && typeof onChange === 'function') {
      onChange(getPublicEntries());
    }
  }

  function findDuplicateByFingerprint(dupKey) {
    for (const record of advertisedEntries.values()) {
      if (record.duplicateKey === dupKey) {
        return record;
      }
    }
    return null;
  }

  async function emitControl(message) {
    if (!disposed && typeof publishControlMessage === 'function') {
      await publishControlMessage(message);
    }
  }

  async function addFiles(fileList) {
    if (disposed) {
      throw new Error('Local file board has been disposed.');
    }

    const files = fileList ? Array.from(fileList) : [];
    const advertised = [];
    const duplicates = [];
    const rejected = [];
    const messages = [];

    for (const file of files) {
      if (!isReadableFileLike(file)) {
        rejected.push({
          fileName: typeof file?.name === 'string' ? file.name : null,
          reason: 'INVALID_FILE',
        });
        continue;
      }

      const dupKey = buildDuplicateKey(file);
      const existing = findDuplicateByFingerprint(dupKey);
      if (existing) {
        duplicates.push({
          fileName: existing.metadata.fileName,
          existingFileId: existing.fileId,
          reason: 'DUPLICATE_FILE',
        });
        continue;
      }

      const rawMeta = {
        fileName: file.name,
        fileSize: file.size,
        fileType: typeof file.type === 'string' ? file.type : '',
        chunkSize: FIXED_CHUNK_SIZE_BYTES,
        totalChunks:
          file.size === 0 ? 0 : Math.ceil(file.size / FIXED_CHUNK_SIZE_BYTES),
      };

      const validated = validatePlaintextFileMetadata(rawMeta);
      if (!validated.ok) {
        rejected.push({
          fileName: file.name,
          reason: validated.code,
        });
        continue;
      }

      const fileId = generateFileId();
      const record = {
        fileId,
        metadata: validated.metadata,
        file,
        duplicateKey: dupKey,
        lastModified: Number.isFinite(file.lastModified)
          ? file.lastModified
          : 0,
      };

      const wireMsg = await encryptFileAdvertisement({
        masterKeyBytes,
        roomId,
        fileId,
        metadata: validated.metadata,
      });

      advertisedEntries.set(fileId, record);
      advertised.push(toPublicEntry(record));
      messages.push(wireMsg);
      await emitControl(wireMsg);
    }

    if (advertised.length > 0) {
      notifyChange();
    }

    return { advertised, duplicates, rejected, messages };
  }

  async function removeFile(fileId) {
    if (disposed) {
      return false;
    }
    const record = advertisedEntries.get(fileId);
    if (!record) {
      return false;
    }

    advertisedEntries.delete(fileId);
    const activeSet = fileIdToTransfers.get(fileId);
    if (activeSet && activeSet.size > 0) {
      retainedForRemovedTransfers.set(fileId, record);
    }

    await emitControl({
      type: 'FILE_REMOVE',
      payload: { fileId },
    });
    notifyChange();
    return true;
  }

  function registerActiveTransfer(transferId, fileId) {
    if (
      typeof transferId !== 'string' ||
      transferId === '' ||
      typeof fileId !== 'string'
    ) {
      return false;
    }
    const record =
      advertisedEntries.get(fileId) ?? retainedForRemovedTransfers.get(fileId);
    if (!record) {
      return false;
    }
    transferToFileId.set(transferId, fileId);
    let set = fileIdToTransfers.get(fileId);
    if (!set) {
      set = new Set();
      fileIdToTransfers.set(fileId, set);
    }
    set.add(transferId);
    return true;
  }

  function unregisterActiveTransfer(transferId) {
    const fileId = transferToFileId.get(transferId);
    if (!fileId) {
      return false;
    }
    transferToFileId.delete(transferId);
    const set = fileIdToTransfers.get(fileId);
    if (set) {
      set.delete(transferId);
      if (set.size === 0) {
        fileIdToTransfers.delete(fileId);
        retainedForRemovedTransfers.delete(fileId);
      }
    }
    return true;
  }

  function getAdvertisedEntry(fileId) {
    const record = advertisedEntries.get(fileId);
    return record ? toPublicEntry(record) : null;
  }

  function resolveFileForTransfer(transferId, fileId) {
    if (transferToFileId.get(transferId) !== fileId) {
      return null;
    }
    const record =
      advertisedEntries.get(fileId) ?? retainedForRemovedTransfers.get(fileId);
    if (!record) {
      return null;
    }
    return {
      fileId: record.fileId,
      file: record.file,
      metadata: record.metadata,
      lastModified: record.lastModified,
    };
  }

  async function verifyLocalFileReadable(fileId) {
    const record =
      advertisedEntries.get(fileId) ?? retainedForRemovedTransfers.get(fileId);
    if (!record) {
      return { ok: false, code: 'NOT_FOUND' };
    }
    const { file, metadata, lastModified } = record;
    const currentLastMod = Number.isFinite(file.lastModified)
      ? file.lastModified
      : 0;
    if (file.size !== metadata.fileSize || currentLastMod !== lastModified) {
      return { ok: false, code: 'FILE_UNREADABLE' };
    }

    if (metadata.fileSize > 0) {
      try {
        const probe = file.slice(0, 1);
        await probe.arrayBuffer();
      } catch {
        return { ok: false, code: 'FILE_UNREADABLE' };
      }
    }

    return {
      ok: true,
      fileId: record.fileId,
      metadata,
    };
  }

  async function getBoardSyncMessage() {
    const files = [];
    for (const record of advertisedEntries.values()) {
      const msg = await encryptFileAdvertisement({
        masterKeyBytes,
        roomId,
        fileId: record.fileId,
        metadata: record.metadata,
      });
      files.push({
        fileId: msg.payload.fileId,
        encryptedMetadata: msg.payload.encryptedMetadata,
      });
    }
    return {
      type: 'BOARD_SYNC',
      payload: { files },
    };
  }

  function clear() {
    advertisedEntries.clear();
    retainedForRemovedTransfers.clear();
    transferToFileId.clear();
    fileIdToTransfers.clear();
    notifyChange();
  }

  function dispose() {
    if (disposed) {
      return;
    }
    disposed = true;
    advertisedEntries.clear();
    retainedForRemovedTransfers.clear();
    transferToFileId.clear();
    fileIdToTransfers.clear();
  }

  return Object.freeze({
    addFiles,
    removeFile,
    getPublicEntries,
    getAdvertisedEntry,
    registerActiveTransfer,
    unregisterActiveTransfer,
    resolveFileForTransfer,
    verifyLocalFileReadable,
    getBoardSyncMessage,
    clear,
    dispose,
  });
}
