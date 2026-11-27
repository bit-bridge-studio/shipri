import {
  decodeBase64Url,
  encodeBase64Url,
  isValidBase64Url,
} from './base64url.js';

export const BOARD_METADATA_HKDF_INFO = 'shipri-board-metadata-v1';
export const FIXED_CHUNK_SIZE_BYTES = 65536;
export const FILE_ID_BYTES = 16;

const CANONICAL_ROOM_ID_PATTERN = /^ship-[a-f0-9]{4}$/;
const ALLOWED_METADATA_KEYS = new Set([
  'fileName',
  'fileSize',
  'fileType',
  'chunkSize',
  'totalChunks',
  'sha256',
]);
const ALLOWED_BLOB_KEYS = new Set(['iv', 'ciphertext']);
const ALLOWED_PAYLOAD_KEYS = new Set(['fileId', 'encryptedMetadata']);
const AES_GCM_IV_BYTES = 12;
const AES_GCM_TAG_BYTES = 16;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isValidRoomId(roomId) {
  return typeof roomId === 'string' && CANONICAL_ROOM_ID_PATTERN.test(roomId);
}

/**
 * Returns true if value is a canonical 16-byte unpadded base64url fileId.
 * @param {unknown} value
 */
export function isValidFileId(value) {
  if (!isValidBase64Url(value)) {
    return false;
  }
  try {
    return decodeBase64Url(value).byteLength === FILE_ID_BYTES;
  } catch {
    return false;
  }
}

/**
 * Generates an opaque 16-byte CSPRNG fileId encoded as unpadded base64url.
 */
export function generateFileId() {
  const bytes = new Uint8Array(FILE_ID_BYTES);
  globalThis.crypto.getRandomValues(bytes);
  return encodeBase64Url(bytes);
}

/**
 * Derives the room-bound non-extractable AES-256-GCM key for file-board metadata
 * encryption via HKDF-SHA256 (salt: "shipri:${roomId}", info: "shipri-board-metadata-v1").
 * @param {Uint8Array} masterKeyBytes
 * @param {string} roomId
 */
export async function deriveBoardMetadataKey(masterKeyBytes, roomId) {
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
      info: encoder.encode(BOARD_METADATA_HKDF_INFO),
    },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/**
 * Validates PlaintextFileMetadata before encryption or after decryption.
 * Rejects control characters, path separators, mismatched chunk counts, or extra keys.
 * @param {unknown} metadata
 */
export function validatePlaintextFileMetadata(metadata) {
  if (!isPlainObject(metadata)) {
    return { ok: false, code: 'INVALID_METADATA' };
  }

  for (const key of Object.keys(metadata)) {
    if (!ALLOWED_METADATA_KEYS.has(key)) {
      return { ok: false, code: 'INVALID_METADATA' };
    }
  }

  const { fileName, fileSize, fileType, chunkSize, totalChunks, sha256 } =
    metadata;

  if (
    typeof fileName !== 'string' ||
    fileName.trim() === '' ||
    fileName.length > 255 ||
    /[\u0000-\u001f\u007f]/.test(fileName) ||
    fileName.includes('/') ||
    fileName.includes('\\') ||
    fileName === '.' ||
    fileName === '..'
  ) {
    return { ok: false, code: 'INVALID_METADATA' };
  }

  if (
    typeof fileSize !== 'number' ||
    !Number.isSafeInteger(fileSize) ||
    fileSize < 0
  ) {
    return { ok: false, code: 'INVALID_METADATA' };
  }

  if (
    typeof fileType !== 'string' ||
    fileType.length > 128 ||
    /[\u0000-\u001f\u007f]/.test(fileType)
  ) {
    return { ok: false, code: 'INVALID_METADATA' };
  }

  if (chunkSize !== FIXED_CHUNK_SIZE_BYTES) {
    return { ok: false, code: 'INVALID_METADATA' };
  }

  const expectedChunks =
    fileSize === 0 ? 0 : Math.ceil(fileSize / FIXED_CHUNK_SIZE_BYTES);
  if (
    typeof totalChunks !== 'number' ||
    !Number.isSafeInteger(totalChunks) ||
    totalChunks !== expectedChunks
  ) {
    return { ok: false, code: 'INVALID_METADATA' };
  }

  if (sha256 !== undefined) {
    if (!isValidBase64Url(sha256)) {
      return { ok: false, code: 'INVALID_METADATA' };
    }
    try {
      if (decodeBase64Url(sha256).byteLength !== 32) {
        return { ok: false, code: 'INVALID_METADATA' };
      }
    } catch {
      return { ok: false, code: 'INVALID_METADATA' };
    }
  }

  return {
    ok: true,
    metadata: {
      fileName,
      fileSize,
      fileType,
      chunkSize,
      totalChunks,
      ...(sha256 !== undefined ? { sha256 } : {}),
    },
  };
}

/**
 * Validates the encryptedMetadata blob shape ({ iv, ciphertext } in unpadded base64url).
 * @param {unknown} blob
 */
export function validateEncryptedMetadataBlob(blob) {
  if (!isPlainObject(blob)) {
    return { ok: false, code: 'INVALID_ADVERTISEMENT' };
  }
  const keys = Object.keys(blob);
  if (
    keys.length !== ALLOWED_BLOB_KEYS.size ||
    !keys.every((key) => ALLOWED_BLOB_KEYS.has(key))
  ) {
    return { ok: false, code: 'INVALID_ADVERTISEMENT' };
  }

  if (!isValidBase64Url(blob.iv) || !isValidBase64Url(blob.ciphertext)) {
    return { ok: false, code: 'INVALID_ADVERTISEMENT' };
  }

  let ivBytes;
  let ciphertextBytes;
  try {
    ivBytes = decodeBase64Url(blob.iv);
    ciphertextBytes = decodeBase64Url(blob.ciphertext);
  } catch {
    return { ok: false, code: 'INVALID_ADVERTISEMENT' };
  }

  if (
    ivBytes.byteLength !== AES_GCM_IV_BYTES ||
    ciphertextBytes.byteLength <= AES_GCM_TAG_BYTES
  ) {
    return { ok: false, code: 'INVALID_ADVERTISEMENT' };
  }

  return { ok: true, ivBytes, ciphertextBytes };
}

function buildMetadataAad(roomId, fileId) {
  return new TextEncoder().encode(`${BOARD_METADATA_HKDF_INFO}:${roomId}:${fileId}`);
}

/**
 * Encrypts PlaintextFileMetadata into the canonical base64url FILE_ADVERTISE message
 * using a fresh 12-byte CSPRNG IV and room+fileId AAD.
 */
export async function encryptFileAdvertisement({
  masterKeyBytes,
  roomId,
  fileId,
  metadata,
}) {
  if (!isValidFileId(fileId)) {
    throw new TypeError('Expected a canonical 16-byte base64url fileId.');
  }
  const validatedMeta = validatePlaintextFileMetadata(metadata);
  if (!validatedMeta.ok) {
    throw new TypeError('File metadata failed validation.');
  }

  const key = await deriveBoardMetadataKey(masterKeyBytes, roomId);
  const ivBytes = new Uint8Array(AES_GCM_IV_BYTES);
  globalThis.crypto.getRandomValues(ivBytes);

  const plaintextBytes = new TextEncoder().encode(
    JSON.stringify(validatedMeta.metadata),
  );
  const ciphertextBuffer = await globalThis.crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: ivBytes,
      additionalData: buildMetadataAad(roomId, fileId),
    },
    key,
    plaintextBytes,
  );

  return {
    type: 'FILE_ADVERTISE',
    payload: {
      fileId,
      encryptedMetadata: {
        iv: encodeBase64Url(ivBytes),
        ciphertext: encodeBase64Url(new Uint8Array(ciphertextBuffer)),
      },
    },
  };
}

/**
 * Validates and decrypts a canonical FILE_ADVERTISE payload. Fails closed without
 * exposing raw ciphertext or plaintext in returned errors.
 */
export async function decryptFileAdvertisement({
  masterKeyBytes,
  roomId,
  message,
}) {
  if (!isValidRoomId(roomId)) {
    return { ok: false, code: 'INVALID_ROOM_ID' };
  }
  if (!isPlainObject(message) || message.type !== 'FILE_ADVERTISE') {
    return { ok: false, code: 'INVALID_ADVERTISEMENT' };
  }
  const payload = message.payload;
  if (!isPlainObject(payload)) {
    return { ok: false, code: 'INVALID_ADVERTISEMENT' };
  }
  const payloadKeys = Object.keys(payload);
  if (
    payloadKeys.length !== ALLOWED_PAYLOAD_KEYS.size ||
    !payloadKeys.every((key) => ALLOWED_PAYLOAD_KEYS.has(key))
  ) {
    return { ok: false, code: 'INVALID_ADVERTISEMENT' };
  }
  if (!isValidFileId(payload.fileId)) {
    return { ok: false, code: 'INVALID_ADVERTISEMENT' };
  }

  const blobValidation = validateEncryptedMetadataBlob(
    payload.encryptedMetadata,
  );
  if (!blobValidation.ok) {
    return blobValidation;
  }

  try {
    const key = await deriveBoardMetadataKey(masterKeyBytes, roomId);
    const plaintextBuffer = await globalThis.crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: blobValidation.ivBytes,
        additionalData: buildMetadataAad(roomId, payload.fileId),
      },
      key,
      blobValidation.ciphertextBytes,
    );
    const parsed = JSON.parse(new TextDecoder().decode(plaintextBuffer));
    const validatedMeta = validatePlaintextFileMetadata(parsed);
    if (!validatedMeta.ok) {
      return { ok: false, code: 'INVALID_METADATA' };
    }

    return {
      ok: true,
      fileId: payload.fileId,
      metadata: validatedMeta.metadata,
    };
  } catch {
    return { ok: false, code: 'DECRYPTION_FAILED' };
  }
}
