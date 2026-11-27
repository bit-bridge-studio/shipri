import { decodeBase64Url, encodeBase64Url } from './base64url.js';
import { FIXED_CHUNK_SIZE_BYTES, isValidFileId } from './board-metadata.js';
import {
  isValidEpoch,
  isValidTransferDirection,
  isValidTransferId,
} from './control-codec.js';

export const BINARY_FRAME_HEADER_BYTES = 52;
export const BINARY_FRAME_MAGIC = 'SHP1';
export const BINARY_FRAME_VERSION = 1;
export const CHUNK_FLAG_NORMAL = 0x00;
export const CHUNK_FLAG_FINAL = 0x01;
export const DIRECTION_CODE_ASCENDING = 0x01;
export const DIRECTION_CODE_DESCENDING = 0x02;
export const FILE_CHUNKS_HKDF_INFO_PREFIX = 'shipri-file-chunks-v1';
export const MAX_PLAINTEXT_CHUNK_BYTES = FIXED_CHUNK_SIZE_BYTES;

const CANONICAL_ROOM_ID_PATTERN = /^ship-[a-f0-9]{4}$/;
const AES_GCM_IV_BYTES = 12;
const AES_GCM_TAG_BYTES = 16;
const MAX_UINT32 = 0xffffffff;
const MAGIC_BYTES = [0x53, 0x48, 0x50, 0x31];

function isValidRoomId(roomId) {
  return typeof roomId === 'string' && CANONICAL_ROOM_ID_PATTERN.test(roomId);
}

function toUint8View(value) {
  if (value instanceof Uint8Array) {
    return value;
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new TypeError('Expected an ArrayBuffer or TypedArray.');
}

/**
 * Resolves the compact 1-byte wire direction code from the canonical
 * protocol-stable owner->downloader direction token.
 * @param {string} direction
 */
export function resolveDirectionCode(direction) {
  if (!isValidTransferDirection(direction)) {
    throw new TypeError('Expected a valid ownerMemberId->downloaderMemberId direction.');
  }
  const [ownerMemberId, downloaderMemberId] = direction.split('->');
  return ownerMemberId < downloaderMemberId
    ? DIRECTION_CODE_ASCENDING
    : DIRECTION_CODE_DESCENDING;
}

/**
 * Builds the deterministic 12-byte big-endian AES-GCM IV for a chunk index
 * within a unique (roomId, transferId, direction, epoch) key domain.
 * @param {number} chunkIndex
 */
export function buildChunkIv(chunkIndex) {
  if (!Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex > MAX_UINT32) {
    throw new RangeError('chunkIndex must be a valid uint32.');
  }
  const buffer = new ArrayBuffer(AES_GCM_IV_BYTES);
  const view = new DataView(buffer);
  view.setBigUint64(4, BigInt(chunkIndex), false);
  return new Uint8Array(buffer);
}

/**
 * Derives a non-extractable 256-bit AES-GCM chunk key strictly bound to
 * (roomId, transferId, direction, epoch) via HKDF-SHA256.
 */
export async function deriveTransferEpochKey({
  masterKeyBytes,
  roomId,
  transferId,
  direction,
  epoch,
}) {
  if (
    !(masterKeyBytes instanceof Uint8Array) ||
    masterKeyBytes.byteLength !== 32
  ) {
    throw new TypeError('Expected a 32-byte Uint8Array master key.');
  }
  if (!isValidRoomId(roomId)) {
    throw new TypeError('Expected a canonical roomId matching ship-[a-f0-9]{4}.');
  }
  if (!isValidTransferId(transferId)) {
    throw new TypeError('Expected a valid 16-byte base64url transferId.');
  }
  if (!isValidTransferDirection(direction)) {
    throw new TypeError('Expected a valid transfer direction token.');
  }
  if (!isValidEpoch(epoch)) {
    throw new RangeError('epoch must be a positive uint32 integer.');
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
      info: encoder.encode(
        `${FILE_CHUNKS_HKDF_INFO_PREFIX}:${transferId}:${direction}:${epoch}`,
      ),
    },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/**
 * Encodes the fixed 52-byte deterministic big-endian binary frame header
 * used directly as AES-GCM additionalData (AAD).
 */
export function encodeBinaryFrameHeader({
  transferId,
  fileId,
  direction,
  epoch,
  chunkIndex,
  plaintextLength,
  isFinalChunk = false,
}) {
  if (!isValidTransferId(transferId)) {
    throw new TypeError('Expected a canonical 16-byte base64url transferId.');
  }
  if (!isValidFileId(fileId)) {
    throw new TypeError('Expected a canonical 16-byte base64url fileId.');
  }
  if (!isValidEpoch(epoch)) {
    throw new RangeError('epoch must be a positive uint32 integer.');
  }
  if (!Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex > MAX_UINT32) {
    throw new RangeError('chunkIndex must be a valid uint32 integer.');
  }
  if (
    !Number.isInteger(plaintextLength) ||
    plaintextLength < 0 ||
    plaintextLength > MAX_PLAINTEXT_CHUNK_BYTES
  ) {
    throw new RangeError(
      `plaintextLength must be between 0 and ${MAX_PLAINTEXT_CHUNK_BYTES}.`,
    );
  }
  if (plaintextLength === 0 && !(isFinalChunk && chunkIndex === 0)) {
    throw new RangeError('Empty chunk requires isFinalChunk=true and chunkIndex=0.');
  }

  const directionCode = resolveDirectionCode(direction);
  const transferBytes = decodeBase64Url(transferId);
  const fileBytes = decodeBase64Url(fileId);
  const flags = isFinalChunk ? CHUNK_FLAG_FINAL : CHUNK_FLAG_NORMAL;

  const header = new Uint8Array(BINARY_FRAME_HEADER_BYTES);
  header.set(MAGIC_BYTES, 0);
  header[4] = BINARY_FRAME_VERSION;
  header[5] = flags;
  header[6] = directionCode;
  header[7] = 0x00;
  header.set(transferBytes, 8);
  header.set(fileBytes, 24);

  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  view.setUint32(40, epoch, false);
  view.setUint32(44, chunkIndex, false);
  view.setUint32(48, plaintextLength, false);

  return header;
}

/**
 * Parses and structurally validates the 52-byte binary frame header.
 * Returns { ok: false, code: 'INVALID_FRAME' } on any structural anomaly.
 */
export function decodeBinaryFrameHeader(frameBuffer) {
  let bytes;
  try {
    bytes = toUint8View(frameBuffer);
  } catch {
    return { ok: false, code: 'INVALID_FRAME' };
  }

  if (bytes.byteLength < BINARY_FRAME_HEADER_BYTES) {
    return { ok: false, code: 'INVALID_FRAME' };
  }

  for (let i = 0; i < MAGIC_BYTES.length; i += 1) {
    if (bytes[i] !== MAGIC_BYTES[i]) {
      return { ok: false, code: 'INVALID_FRAME' };
    }
  }

  const version = bytes[4];
  const flags = bytes[5];
  const directionCode = bytes[6];
  const reserved = bytes[7];

  if (
    version !== BINARY_FRAME_VERSION ||
    (flags !== CHUNK_FLAG_NORMAL && flags !== CHUNK_FLAG_FINAL) ||
    (directionCode !== DIRECTION_CODE_ASCENDING &&
      directionCode !== DIRECTION_CODE_DESCENDING) ||
    reserved !== 0x00
  ) {
    return { ok: false, code: 'INVALID_FRAME' };
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const epoch = view.getUint32(40, false);
  const chunkIndex = view.getUint32(44, false);
  const plaintextLength = view.getUint32(48, false);

  if (epoch < 1 || plaintextLength > MAX_PLAINTEXT_CHUNK_BYTES) {
    return { ok: false, code: 'INVALID_FRAME' };
  }
  if (plaintextLength === 0 && !(flags === CHUNK_FLAG_FINAL && chunkIndex === 0)) {
    return { ok: false, code: 'INVALID_FRAME' };
  }

  const transferId = encodeBase64Url(bytes.subarray(8, 24));
  const fileId = encodeBase64Url(bytes.subarray(24, 40));
  const headerBytes = bytes.slice(0, BINARY_FRAME_HEADER_BYTES);

  return {
    ok: true,
    magic: BINARY_FRAME_MAGIC,
    version,
    flags,
    isFinalChunk: flags === CHUNK_FLAG_FINAL,
    directionCode,
    reserved,
    transferId,
    fileId,
    epoch,
    chunkIndex,
    plaintextLength,
    headerBytes,
  };
}

/**
 * Encrypts a single plaintext chunk and binds its 52-byte deterministic binary
 * header as AES-GCM AAD, returning one framed ArrayBuffer.
 */
export async function encryptBinaryChunkFrame({
  masterKeyBytes,
  chunkKey,
  roomId,
  transferId,
  fileId,
  direction,
  epoch,
  chunkIndex,
  plaintext,
  isFinalChunk = false,
}) {
  const plaintextView = toUint8View(plaintext);
  if (plaintextView.byteLength > MAX_PLAINTEXT_CHUNK_BYTES) {
    throw new RangeError(
      `Chunk exceeds maximum plaintext length (${MAX_PLAINTEXT_CHUNK_BYTES} bytes).`,
    );
  }

  const headerBytes = encodeBinaryFrameHeader({
    transferId,
    fileId,
    direction,
    epoch,
    chunkIndex,
    plaintextLength: plaintextView.byteLength,
    isFinalChunk,
  });

  const resolvedKey =
    chunkKey ??
    (await deriveTransferEpochKey({
      masterKeyBytes,
      roomId,
      transferId,
      direction,
      epoch,
    }));

  const ciphertextBuffer = await globalThis.crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: buildChunkIv(chunkIndex),
      additionalData: headerBytes,
    },
    resolvedKey,
    plaintextView,
  );

  const ciphertextView = new Uint8Array(ciphertextBuffer);
  const frame = new Uint8Array(
    BINARY_FRAME_HEADER_BYTES + ciphertextView.byteLength,
  );
  frame.set(headerBytes, 0);
  frame.set(ciphertextView, BINARY_FRAME_HEADER_BYTES);
  return frame.buffer;
}

/**
 * Strictly validates binary frame structure, transfer/file/direction/epoch/chunk
 * bindings, and AES-GCM AAD authentication tag. Always fails closed.
 */
export async function decryptBinaryChunkFrame({
  masterKeyBytes,
  chunkKey,
  roomId,
  expectedTransferId,
  expectedFileId,
  expectedDirection,
  expectedEpoch,
  expectedChunkIndex,
  frameBuffer,
}) {
  const header = decodeBinaryFrameHeader(frameBuffer);
  if (!header.ok) {
    return header;
  }

  const bytes = toUint8View(frameBuffer);
  const expectedTotalLength =
    BINARY_FRAME_HEADER_BYTES + header.plaintextLength + AES_GCM_TAG_BYTES;
  if (bytes.byteLength !== expectedTotalLength) {
    return { ok: false, code: 'INVALID_FRAME' };
  }

  if (expectedTransferId !== undefined && header.transferId !== expectedTransferId) {
    return { ok: false, code: 'TRANSFER_MISMATCH' };
  }
  if (expectedFileId !== undefined && header.fileId !== expectedFileId) {
    return { ok: false, code: 'FILE_MISMATCH' };
  }
  if (expectedDirection !== undefined) {
    let expectedDirCode;
    try {
      expectedDirCode = resolveDirectionCode(expectedDirection);
    } catch {
      return { ok: false, code: 'DIRECTION_MISMATCH' };
    }
    if (header.directionCode !== expectedDirCode) {
      return { ok: false, code: 'DIRECTION_MISMATCH' };
    }
  }
  if (expectedEpoch !== undefined && header.epoch !== expectedEpoch) {
    return { ok: false, code: 'EPOCH_MISMATCH' };
  }
  if (
    expectedChunkIndex !== undefined &&
    header.chunkIndex !== expectedChunkIndex
  ) {
    return { ok: false, code: 'CHUNK_ORDER_MISMATCH' };
  }

  try {
    const resolvedKey =
      chunkKey ??
      (await deriveTransferEpochKey({
        masterKeyBytes,
        roomId,
        transferId: header.transferId,
        direction: expectedDirection,
        epoch: header.epoch,
      }));

    const ciphertextSlice = bytes.subarray(BINARY_FRAME_HEADER_BYTES);
    const plaintext = await globalThis.crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: buildChunkIv(header.chunkIndex),
        additionalData: header.headerBytes,
      },
      resolvedKey,
      ciphertextSlice,
    );

    if (plaintext.byteLength !== header.plaintextLength) {
      return { ok: false, code: 'INVALID_FRAME' };
    }

    return {
      ok: true,
      header,
      plaintext,
    };
  } catch {
    return { ok: false, code: 'AUTH_FAILED' };
  }
}
