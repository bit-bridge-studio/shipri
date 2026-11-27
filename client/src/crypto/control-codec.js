import {
  decodeBase64Url,
  encodeBase64Url,
  isValidBase64Url,
} from './base64url.js';
import {
  FIXED_CHUNK_SIZE_BYTES,
  isValidFileId,
  validateEncryptedMetadataBlob,
} from './board-metadata.js';

export const CONTROL_HKDF_INFO = 'shipri-control-v1';
export const CONTROL_ENVELOPE_VERSION = 1;
export const TRANSFER_ID_BYTES = 16;
export const MEMBER_ID_BYTES = 16;

const CANONICAL_ROOM_ID_PATTERN = /^ship-[a-f0-9]{4}$/;
const AES_GCM_IV_BYTES = 12;
const AES_GCM_TAG_BYTES = 16;
const MAX_UINT32 = 0xffffffff;

const DOWNLOAD_REJECT_REASONS = new Set([
  'NOT_FOUND',
  'UNAVAILABLE',
  'BUSY',
  'INVALID_REQUEST',
  'LIMIT_EXCEEDED',
]);
const CANCEL_REASONS = new Set(['USER_CANCELLED', 'PERSISTENCE_CLOSED']);
const TRANSFER_ERROR_CODES = new Set([
  'AUTH_FAILED',
  'FLOW_CREDIT_EXCEEDED',
  'INVALID_FRAME',
  'FILE_UNREADABLE',
  'PERSISTENCE_FAILED',
  'QUOTA_EXCEEDED',
  'EPOCH_MISMATCH',
  'INTERNAL_ERROR',
]);
const RESUME_REJECT_REASONS = new Set([
  'NOT_FOUND',
  'FILE_CHANGED',
  'INVALID_EPOCH',
  'BUSY',
]);
const ENVELOPE_KEYS = new Set(['v', 'senderMemberId', 'iv', 'ciphertext']);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(obj, requiredKeys, optionalKeys = []) {
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  const keys = Object.keys(obj);
  for (const key of keys) {
    if (!allowed.has(key)) {
      return false;
    }
  }
  for (const key of requiredKeys) {
    if (!Object.prototype.hasOwnProperty.call(obj, key)) {
      return false;
    }
  }
  return true;
}

function isValidRoomId(value) {
  return typeof value === 'string' && CANONICAL_ROOM_ID_PATTERN.test(value);
}

function isValidFixedId(value, byteLength) {
  if (!isValidBase64Url(value)) {
    return false;
  }
  try {
    return decodeBase64Url(value).byteLength === byteLength;
  } catch {
    return false;
  }
}

export function isValidMemberId(value) {
  return isValidFixedId(value, MEMBER_ID_BYTES);
}

export function isValidTransferId(value) {
  return isValidFixedId(value, TRANSFER_ID_BYTES);
}

export function isValidEpoch(value) {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= MAX_UINT32
  );
}

export function isValidNonNegativeSafeInt(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function isValidPositiveSafeInt(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

/**
 * Generates an opaque 16-byte CSPRNG transferId encoded as unpadded base64url.
 */
export function generateTransferId() {
  const bytes = new Uint8Array(TRANSFER_ID_BYTES);
  globalThis.crypto.getRandomValues(bytes);
  return encodeBase64Url(bytes);
}

/**
 * Formats a protocol-stable transfer direction token independent of socket.id
 * or offerer/answerer negotiation duties.
 */
export function formatTransferDirection(ownerMemberId, downloaderMemberId) {
  if (!isValidMemberId(ownerMemberId) || !isValidMemberId(downloaderMemberId)) {
    throw new TypeError('Expected valid 16-byte base64url memberId values.');
  }
  if (ownerMemberId === downloaderMemberId) {
    throw new TypeError('Owner and downloader memberId values must differ.');
  }
  return `${ownerMemberId}->${downloaderMemberId}`;
}

export function isValidTransferDirection(value) {
  if (typeof value !== 'string') {
    return false;
  }
  const parts = value.split('->');
  if (parts.length !== 2) {
    return false;
  }
  const [owner, downloader] = parts;
  return (
    isValidMemberId(owner) &&
    isValidMemberId(downloader) &&
    owner !== downloader
  );
}

/**
 * Derives the room-bound non-extractable AES-256-GCM key for shipri-control-v1
 * AEAD envelopes via HKDF-SHA256.
 */
export async function deriveControlKey(masterKeyBytes, roomId) {
  if (
    !(masterKeyBytes instanceof Uint8Array) ||
    masterKeyBytes.byteLength !== 32
  ) {
    throw new TypeError('Expected a 32-byte Uint8Array master key.');
  }
  if (!isValidRoomId(roomId)) {
    throw new TypeError('Expected a canonical roomId matching ship-[a-f0-9]{4}.');
  }

  const encoder = new TextEncoder();
  const baseKey = await globalThis.crypto.subtle.importKey(
    'raw',
    masterKeyBytes,
    'HKDF',
    false,
    ['deriveKey'],
  );

  return globalThis.crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: encoder.encode(`shipri:${roomId}`),
      info: encoder.encode(CONTROL_HKDF_INFO),
    },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/**
 * Validates any frozen ControlMessage against strict type and field allowlists.
 * Rejects unknown types (including legacy FLOW_PAUSE/FLOW_RESUME) and extra keys.
 * @param {unknown} message
 */
export function validateControlMessage(message) {
  if (
    !isPlainObject(message) ||
    !hasExactKeys(message, ['type', 'payload']) ||
    typeof message.type !== 'string' ||
    !isPlainObject(message.payload)
  ) {
    return { ok: false, code: 'INVALID_CONTROL_MESSAGE' };
  }

  const { type, payload } = message;

  switch (type) {
    case 'PEER_HELLO':
      if (
        !hasExactKeys(payload, ['memberId', 'protocolVersion']) ||
        !isValidMemberId(payload.memberId) ||
        payload.protocolVersion !== 1
      ) {
        return { ok: false, code: 'INVALID_CONTROL_MESSAGE' };
      }
      return { ok: true, message };

    case 'BOARD_SYNC':
      if (!hasExactKeys(payload, ['files']) || !Array.isArray(payload.files)) {
        return { ok: false, code: 'INVALID_CONTROL_MESSAGE' };
      }
      for (const entry of payload.files) {
        if (
          !isPlainObject(entry) ||
          !hasExactKeys(entry, ['fileId', 'encryptedMetadata']) ||
          !isValidFileId(entry.fileId) ||
          !validateEncryptedMetadataBlob(entry.encryptedMetadata).ok
        ) {
          return { ok: false, code: 'INVALID_CONTROL_MESSAGE' };
        }
      }
      return { ok: true, message };

    case 'FILE_ADVERTISE':
      if (
        !hasExactKeys(payload, ['fileId', 'encryptedMetadata']) ||
        !isValidFileId(payload.fileId) ||
        !validateEncryptedMetadataBlob(payload.encryptedMetadata).ok
      ) {
        return { ok: false, code: 'INVALID_CONTROL_MESSAGE' };
      }
      return { ok: true, message };

    case 'FILE_REMOVE':
      if (!hasExactKeys(payload, ['fileId']) || !isValidFileId(payload.fileId)) {
        return { ok: false, code: 'INVALID_CONTROL_MESSAGE' };
      }
      return { ok: true, message };

    case 'DOWNLOAD_REQUEST':
      if (
        !hasExactKeys(payload, [
          'transferId',
          'fileId',
          'direction',
          'initialEpoch',
        ]) ||
        !isValidTransferId(payload.transferId) ||
        !isValidFileId(payload.fileId) ||
        !isValidTransferDirection(payload.direction) ||
        payload.initialEpoch !== 1
      ) {
        return { ok: false, code: 'INVALID_CONTROL_MESSAGE' };
      }
      return { ok: true, message };

    case 'DOWNLOAD_ACCEPTED':
      if (
        !hasExactKeys(payload, [
          'transferId',
          'fileId',
          'direction',
          'epoch',
          'chunkSize',
          'totalChunks',
          'fileSize',
        ]) ||
        !isValidTransferId(payload.transferId) ||
        !isValidFileId(payload.fileId) ||
        !isValidTransferDirection(payload.direction) ||
        payload.epoch !== 1 ||
        payload.chunkSize !== FIXED_CHUNK_SIZE_BYTES ||
        !isValidNonNegativeSafeInt(payload.fileSize) ||
        !isValidNonNegativeSafeInt(payload.totalChunks) ||
        payload.totalChunks !==
          (payload.fileSize === 0
            ? 0
            : Math.ceil(payload.fileSize / FIXED_CHUNK_SIZE_BYTES))
      ) {
        return { ok: false, code: 'INVALID_CONTROL_MESSAGE' };
      }
      return { ok: true, message };

    case 'DOWNLOAD_REJECTED':
      if (
        !hasExactKeys(payload, ['transferId', 'fileId', 'reason']) ||
        !isValidTransferId(payload.transferId) ||
        !isValidFileId(payload.fileId) ||
        !DOWNLOAD_REJECT_REASONS.has(payload.reason)
      ) {
        return { ok: false, code: 'INVALID_CONTROL_MESSAGE' };
      }
      return { ok: true, message };

    case 'FLOW_CREDIT':
      if (
        !hasExactKeys(payload, [
          'transferId',
          'fileId',
          'direction',
          'epoch',
          'sequence',
          'maxPlaintextOffsetExclusive',
        ]) ||
        !isValidTransferId(payload.transferId) ||
        !isValidFileId(payload.fileId) ||
        !isValidTransferDirection(payload.direction) ||
        !isValidEpoch(payload.epoch) ||
        !isValidPositiveSafeInt(payload.sequence) ||
        !isValidNonNegativeSafeInt(payload.maxPlaintextOffsetExclusive)
      ) {
        return { ok: false, code: 'INVALID_CONTROL_MESSAGE' };
      }
      return { ok: true, message };

    case 'TRANSFER_PAUSE':
    case 'TRANSFER_RESUME':
      if (
        !hasExactKeys(payload, ['transferId', 'direction', 'epoch']) ||
        !isValidTransferId(payload.transferId) ||
        !isValidTransferDirection(payload.direction) ||
        !isValidEpoch(payload.epoch)
      ) {
        return { ok: false, code: 'INVALID_CONTROL_MESSAGE' };
      }
      return { ok: true, message };

    case 'TRANSFER_CANCEL':
      if (
        !hasExactKeys(payload, ['transferId', 'direction'], ['reason']) ||
        !isValidTransferId(payload.transferId) ||
        !isValidTransferDirection(payload.direction) ||
        (payload.reason !== undefined && !CANCEL_REASONS.has(payload.reason))
      ) {
        return { ok: false, code: 'INVALID_CONTROL_MESSAGE' };
      }
      return { ok: true, message };

    case 'TRANSFER_COMPLETE':
      if (
        !hasExactKeys(payload, [
          'transferId',
          'fileId',
          'direction',
          'epoch',
          'totalPersistedBytes',
        ]) ||
        !isValidTransferId(payload.transferId) ||
        !isValidFileId(payload.fileId) ||
        !isValidTransferDirection(payload.direction) ||
        !isValidEpoch(payload.epoch) ||
        !isValidNonNegativeSafeInt(payload.totalPersistedBytes)
      ) {
        return { ok: false, code: 'INVALID_CONTROL_MESSAGE' };
      }
      return { ok: true, message };

    case 'TRANSFER_ERROR':
      if (
        !hasExactKeys(payload, ['transferId', 'direction', 'code']) ||
        !isValidTransferId(payload.transferId) ||
        !isValidTransferDirection(payload.direction) ||
        !TRANSFER_ERROR_CODES.has(payload.code)
      ) {
        return { ok: false, code: 'INVALID_CONTROL_MESSAGE' };
      }
      return { ok: true, message };

    case 'RESUME_REQUEST':
      if (
        !hasExactKeys(payload, [
          'transferId',
          'fileId',
          'direction',
          'nextEpoch',
          'lastPersistedChunkIndex',
          'persistedPlaintextBytes',
        ]) ||
        !isValidTransferId(payload.transferId) ||
        !isValidFileId(payload.fileId) ||
        !isValidTransferDirection(payload.direction) ||
        !isValidEpoch(payload.nextEpoch) ||
        payload.nextEpoch < 2 ||
        typeof payload.lastPersistedChunkIndex !== 'number' ||
        !Number.isInteger(payload.lastPersistedChunkIndex) ||
        payload.lastPersistedChunkIndex < -1 ||
        payload.lastPersistedChunkIndex > MAX_UINT32 ||
        !isValidNonNegativeSafeInt(payload.persistedPlaintextBytes)
      ) {
        return { ok: false, code: 'INVALID_CONTROL_MESSAGE' };
      }
      return { ok: true, message };

    case 'RESUME_ACCEPTED':
      if (
        !hasExactKeys(payload, [
          'transferId',
          'fileId',
          'direction',
          'epoch',
          'resumeFromChunkIndex',
        ]) ||
        !isValidTransferId(payload.transferId) ||
        !isValidFileId(payload.fileId) ||
        !isValidTransferDirection(payload.direction) ||
        !isValidEpoch(payload.epoch) ||
        payload.epoch < 2 ||
        !isValidNonNegativeSafeInt(payload.resumeFromChunkIndex) ||
        payload.resumeFromChunkIndex > MAX_UINT32
      ) {
        return { ok: false, code: 'INVALID_CONTROL_MESSAGE' };
      }
      return { ok: true, message };

    case 'RESUME_REJECTED':
      if (
        !hasExactKeys(payload, ['transferId', 'fileId', 'reason']) ||
        !isValidTransferId(payload.transferId) ||
        !isValidFileId(payload.fileId) ||
        !RESUME_REJECT_REASONS.has(payload.reason)
      ) {
        return { ok: false, code: 'INVALID_CONTROL_MESSAGE' };
      }
      return { ok: true, message };

    default:
      return { ok: false, code: 'INVALID_CONTROL_MESSAGE' };
  }
}

function buildControlAad(roomId, senderMemberId) {
  return new TextEncoder().encode(
    `${CONTROL_HKDF_INFO}:${roomId}:${senderMemberId}`,
  );
}

/**
 * Encrypts and authenticates a validated ControlMessage into the canonical
 * shipri-control-v1 ControlEnvelope using a fresh 12-byte CSPRNG IV and room+sender AAD.
 */
export async function encryptControlMessage({
  masterKeyBytes,
  roomId,
  senderMemberId,
  message,
}) {
  if (!isValidMemberId(senderMemberId)) {
    throw new TypeError('Expected a valid 16-byte base64url senderMemberId.');
  }
  const validated = validateControlMessage(message);
  if (!validated.ok) {
    throw new TypeError('Control message failed schema validation.');
  }

  const key = await deriveControlKey(masterKeyBytes, roomId);
  const ivBytes = new Uint8Array(AES_GCM_IV_BYTES);
  globalThis.crypto.getRandomValues(ivBytes);

  const plaintext = new TextEncoder().encode(JSON.stringify(validated.message));
  const ciphertextBuffer = await globalThis.crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: ivBytes,
      additionalData: buildControlAad(roomId, senderMemberId),
    },
    key,
    plaintext,
  );

  return {
    v: CONTROL_ENVELOPE_VERSION,
    senderMemberId,
    iv: encodeBase64Url(ivBytes),
    ciphertext: encodeBase64Url(new Uint8Array(ciphertextBuffer)),
  };
}

/**
 * Validates and decrypts a shipri-control-v1 ControlEnvelope. Fails closed on
 * tampered, forged, cross-room, wrong-sender, or schema-invalid messages.
 */
export async function decryptControlMessage({
  masterKeyBytes,
  roomId,
  expectedSenderMemberId,
  envelope,
}) {
  if (!isValidRoomId(roomId)) {
    return { ok: false, code: 'INVALID_ROOM_ID' };
  }
  if (!isPlainObject(envelope)) {
    return { ok: false, code: 'INVALID_ENVELOPE' };
  }
  const keys = Object.keys(envelope);
  if (
    keys.length !== ENVELOPE_KEYS.size ||
    !keys.every((key) => ENVELOPE_KEYS.has(key)) ||
    envelope.v !== CONTROL_ENVELOPE_VERSION ||
    !isValidMemberId(envelope.senderMemberId) ||
    !isValidBase64Url(envelope.iv) ||
    !isValidBase64Url(envelope.ciphertext)
  ) {
    return { ok: false, code: 'INVALID_ENVELOPE' };
  }

  if (
    expectedSenderMemberId !== undefined &&
    envelope.senderMemberId !== expectedSenderMemberId
  ) {
    return { ok: false, code: 'SENDER_MISMATCH' };
  }

  let ivBytes;
  let ciphertextBytes;
  try {
    ivBytes = decodeBase64Url(envelope.iv);
    ciphertextBytes = decodeBase64Url(envelope.ciphertext);
  } catch {
    return { ok: false, code: 'INVALID_ENVELOPE' };
  }

  if (
    ivBytes.byteLength !== AES_GCM_IV_BYTES ||
    ciphertextBytes.byteLength <= AES_GCM_TAG_BYTES
  ) {
    return { ok: false, code: 'INVALID_ENVELOPE' };
  }

  try {
    const key = await deriveControlKey(masterKeyBytes, roomId);
    const plaintextBuffer = await globalThis.crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: ivBytes,
        additionalData: buildControlAad(roomId, envelope.senderMemberId),
      },
      key,
      ciphertextBytes,
    );
    const parsed = JSON.parse(new TextDecoder().decode(plaintextBuffer));
    const validated = validateControlMessage(parsed);
    if (!validated.ok) {
      return { ok: false, code: 'INVALID_CONTROL_MESSAGE' };
    }
    return {
      ok: true,
      senderMemberId: envelope.senderMemberId,
      message: validated.message,
    };
  } catch {
    return { ok: false, code: 'DECRYPTION_FAILED' };
  }
}

/**
 * Creates a sender-side cumulative FLOW_CREDIT window tracker bound to one
 * (transferId, fileId, direction, epoch).
 */
export function createFlowCreditTracker({
  transferId,
  fileId,
  direction,
  epoch,
  initialOffset = 0,
}) {
  if (
    !isValidTransferId(transferId) ||
    !isValidFileId(fileId) ||
    !isValidTransferDirection(direction) ||
    !isValidEpoch(epoch) ||
    !isValidNonNegativeSafeInt(initialOffset)
  ) {
    throw new TypeError('Invalid flow-credit tracker binding parameters.');
  }

  return {
    transferId,
    fileId,
    direction,
    epoch,
    lastSequence: 0,
    maxPlaintextOffsetExclusive: initialOffset,
  };
}

/**
 * Applies a validated FLOW_CREDIT update strictly enforcing transfer, file,
 * direction, and epoch binding plus strictly monotonic sequence and offset.
 * Duplicate, stale, cross-transfer, or reordered updates never expand the window.
 */
export function applyFlowCredit(tracker, message) {
  const validated = validateControlMessage(message);
  if (!validated.ok || message.type !== 'FLOW_CREDIT') {
    return {
      accepted: false,
      reason: 'INVALID_CONTROL_MESSAGE',
      maxPlaintextOffsetExclusive: tracker.maxPlaintextOffsetExclusive,
      lastSequence: tracker.lastSequence,
    };
  }

  const { payload } = message;
  if (payload.transferId !== tracker.transferId) {
    return {
      accepted: false,
      reason: 'TRANSFER_MISMATCH',
      maxPlaintextOffsetExclusive: tracker.maxPlaintextOffsetExclusive,
      lastSequence: tracker.lastSequence,
    };
  }
  if (payload.fileId !== tracker.fileId) {
    return {
      accepted: false,
      reason: 'FILE_MISMATCH',
      maxPlaintextOffsetExclusive: tracker.maxPlaintextOffsetExclusive,
      lastSequence: tracker.lastSequence,
    };
  }
  if (payload.direction !== tracker.direction) {
    return {
      accepted: false,
      reason: 'DIRECTION_MISMATCH',
      maxPlaintextOffsetExclusive: tracker.maxPlaintextOffsetExclusive,
      lastSequence: tracker.lastSequence,
    };
  }
  if (payload.epoch !== tracker.epoch) {
    return {
      accepted: false,
      reason: 'EPOCH_MISMATCH',
      maxPlaintextOffsetExclusive: tracker.maxPlaintextOffsetExclusive,
      lastSequence: tracker.lastSequence,
    };
  }
  if (payload.sequence <= tracker.lastSequence) {
    return {
      accepted: false,
      reason: 'STALE_SEQUENCE',
      maxPlaintextOffsetExclusive: tracker.maxPlaintextOffsetExclusive,
      lastSequence: tracker.lastSequence,
    };
  }
  if (payload.maxPlaintextOffsetExclusive <= tracker.maxPlaintextOffsetExclusive) {
    return {
      accepted: false,
      reason: 'NON_ADVANCING_OFFSET',
      maxPlaintextOffsetExclusive: tracker.maxPlaintextOffsetExclusive,
      lastSequence: tracker.lastSequence,
    };
  }

  tracker.lastSequence = payload.sequence;
  tracker.maxPlaintextOffsetExclusive = payload.maxPlaintextOffsetExclusive;

  return {
    accepted: true,
    maxPlaintextOffsetExclusive: tracker.maxPlaintextOffsetExclusive,
    lastSequence: tracker.lastSequence,
  };
}
