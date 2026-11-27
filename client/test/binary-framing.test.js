import { describe, expect, it } from 'vitest';
import {
  BINARY_FRAME_HEADER_BYTES,
  BINARY_FRAME_MAGIC,
  BINARY_FRAME_VERSION,
  CHUNK_FLAG_FINAL,
  CHUNK_FLAG_NORMAL,
  FILE_CHUNKS_HKDF_INFO_PREFIX,
  MAX_PLAINTEXT_CHUNK_BYTES,
  buildChunkIv,
  decodeBinaryFrameHeader,
  decryptBinaryChunkFrame,
  deriveTransferEpochKey,
  encodeBinaryFrameHeader,
  encryptBinaryChunkFrame,
  resolveDirectionCode,
} from '../src/crypto/binary-framing.js';
import { generateFileId } from '../src/crypto/board-metadata.js';
import {
  formatTransferDirection,
  generateTransferId,
} from '../src/crypto/control-codec.js';
import {
  generateMasterKey,
  generateMemberId,
} from '../src/crypto/fragment-key.js';

describe('epoch-safe encrypted binary framing (ticket [47])', () => {
  it('encodes deterministic 52-byte headers as AAD and performs round trips across boundary chunk sizes', async () => {
    const { masterKeyBytes } = generateMasterKey();
    const roomId = 'ship-83a1';
    const ownerMemberId = generateMemberId();
    const downloaderMemberId = generateMemberId();
    const direction = formatTransferDirection(ownerMemberId, downloaderMemberId);
    const transferId = generateTransferId();
    const fileId = generateFileId();

    expect(BINARY_FRAME_HEADER_BYTES).toBe(52);
    expect(BINARY_FRAME_MAGIC).toBe('SHP1');
    expect(BINARY_FRAME_VERSION).toBe(1);
    expect(MAX_PLAINTEXT_CHUNK_BYTES).toBe(65536);
    expect(FILE_CHUNKS_HKDF_INFO_PREFIX).toBe('shipri-file-chunks-v1');

    const key = await deriveTransferEpochKey({
      masterKeyBytes,
      roomId,
      transferId,
      direction,
      epoch: 1,
    });
    expect(key.extractable).toBe(false);

    // Check deterministic 12-byte big-endian chunk IV
    const iv0 = buildChunkIv(0);
    const iv258 = buildChunkIv(258);
    expect(iv0.byteLength).toBe(12);
    expect(Array.from(iv0)).toEqual(new Array(12).fill(0));
    expect(iv258[10]).toBe(1);
    expect(iv258[11]).toBe(2);

    // Check header encode/decode boundary (1 byte and 64 KiB)
    for (const size of [1, 65536]) {
      const plaintext = new Uint8Array(size);
      plaintext.fill(size === 1 ? 0x42 : 0xa5);
      const flags = size === 1 ? CHUNK_FLAG_FINAL : CHUNK_FLAG_NORMAL;

      const frameBuffer = await encryptBinaryChunkFrame({
        masterKeyBytes,
        roomId,
        transferId,
        fileId,
        direction,
        epoch: 1,
        chunkIndex: size === 1 ? 1 : 0,
        plaintext,
        isFinalChunk: size === 1,
      });

      expect(frameBuffer.byteLength).toBe(52 + size + 16);

      const header = decodeBinaryFrameHeader(frameBuffer);
      expect(header).toMatchObject({
        magic: 'SHP1',
        version: 1,
        flags,
        directionCode: resolveDirectionCode(direction),
        reserved: 0,
        transferId,
        fileId,
        epoch: 1,
        chunkIndex: size === 1 ? 1 : 0,
        plaintextLength: size,
      });

      const decrypted = await decryptBinaryChunkFrame({
        masterKeyBytes,
        roomId,
        expectedTransferId: transferId,
        expectedFileId: fileId,
        expectedDirection: direction,
        expectedEpoch: 1,
        expectedChunkIndex: size === 1 ? 1 : 0,
        frameBuffer,
      });

      expect(decrypted.ok).toBe(true);
      expect(new Uint8Array(decrypted.plaintext)).toEqual(plaintext);
      expect(decrypted.header.isFinalChunk).toBe(size === 1);
    }

    // Reject oversized >64 KiB plaintext chunks
    await expect(
      encryptBinaryChunkFrame({
        masterKeyBytes,
        roomId,
        transferId,
        fileId,
        direction,
        epoch: 1,
        chunkIndex: 0,
        plaintext: new Uint8Array(65537),
      }),
    ).rejects.toThrow();
  });

  it('guarantees zero key/IV reuse across simultaneous transfers and resumed epoch increments using identical chunkIndex values', async () => {
    const { masterKeyBytes } = generateMasterKey();
    const roomId = 'ship-83a1';
    const peerA = generateMemberId();
    const peerB = generateMemberId();
    const dirAtoB = formatTransferDirection(peerA, peerB);
    const dirBtoA = formatTransferDirection(peerB, peerA);
    const transfer1 = generateTransferId();
    const transfer2 = generateTransferId();
    const file1 = generateFileId();
    const file2 = generateFileId();

    const identicalPlaintext = new TextEncoder().encode(
      'IDENTICAL_CHUNK_ZERO_PAYLOAD',
    );

    const frameT1Epoch1 = await encryptBinaryChunkFrame({
      masterKeyBytes,
      roomId,
      transferId: transfer1,
      fileId: file1,
      direction: dirAtoB,
      epoch: 1,
      chunkIndex: 0,
      plaintext: identicalPlaintext,
    });

    const frameT2ReverseEpoch1 = await encryptBinaryChunkFrame({
      masterKeyBytes,
      roomId,
      transferId: transfer2,
      fileId: file2,
      direction: dirBtoA,
      epoch: 1,
      chunkIndex: 0,
      plaintext: identicalPlaintext,
    });

    const frameT1Epoch2 = await encryptBinaryChunkFrame({
      masterKeyBytes,
      roomId,
      transferId: transfer1,
      fileId: file1,
      direction: dirAtoB,
      epoch: 2,
      chunkIndex: 0,
      plaintext: identicalPlaintext,
    });

    // Ciphertext portions must all be distinct despite identical chunkIndex=0 & plaintext
    const cipher1 = new Uint8Array(frameT1Epoch1, 52);
    const cipher2 = new Uint8Array(frameT2ReverseEpoch1, 52);
    const cipher3 = new Uint8Array(frameT1Epoch2, 52);
    expect(cipher1).not.toEqual(cipher2);
    expect(cipher1).not.toEqual(cipher3);
    expect(cipher2).not.toEqual(cipher3);

    // Cross-transfer decryption fails closed
    expect(
      (
        await decryptBinaryChunkFrame({
          masterKeyBytes,
          roomId,
          expectedTransferId: transfer1,
          expectedFileId: file1,
          expectedDirection: dirAtoB,
          expectedEpoch: 1,
          expectedChunkIndex: 0,
          frameBuffer: frameT2ReverseEpoch1,
        })
      ).ok,
    ).toBe(false);

    // Stale epoch 1 frame rejected when session expects epoch 2
    expect(
      (
        await decryptBinaryChunkFrame({
          masterKeyBytes,
          roomId,
          expectedTransferId: transfer1,
          expectedFileId: file1,
          expectedDirection: dirAtoB,
          expectedEpoch: 2,
          expectedChunkIndex: 0,
          frameBuffer: frameT1Epoch1,
        })
      ).code,
    ).toBe('EPOCH_MISMATCH');
  });

  it('fails closed on tampered headers, AAD mismatch, tag corruption, wrong direction, non-zero reserved byte, or out-of-order chunkIndex', async () => {
    const { masterKeyBytes } = generateMasterKey();
    const { masterKeyBytes: wrongKeyBytes } = generateMasterKey();
    const roomId = 'ship-83a1';
    const peerA = generateMemberId();
    const peerB = generateMemberId();
    const direction = formatTransferDirection(peerA, peerB);
    const reverseDirection = formatTransferDirection(peerB, peerA);
    const transferId = generateTransferId();
    const fileId = generateFileId();

    const frame = await encryptBinaryChunkFrame({
      masterKeyBytes,
      roomId,
      transferId,
      fileId,
      direction,
      epoch: 1,
      chunkIndex: 3,
      plaintext: new Uint8Array([1, 2, 3, 4, 5]),
    });

    // 1. Out-of-order chunkIndex
    expect(
      (
        await decryptBinaryChunkFrame({
          masterKeyBytes,
          roomId,
          expectedTransferId: transferId,
          expectedFileId: fileId,
          expectedDirection: direction,
          expectedEpoch: 1,
          expectedChunkIndex: 4,
          frameBuffer: frame,
        })
      ).code,
    ).toBe('CHUNK_ORDER_MISMATCH');

    // 2. Wrong direction
    expect(
      (
        await decryptBinaryChunkFrame({
          masterKeyBytes,
          roomId,
          expectedTransferId: transferId,
          expectedFileId: fileId,
          expectedDirection: reverseDirection,
          expectedEpoch: 1,
          expectedChunkIndex: 3,
          frameBuffer: frame,
        })
      ).code,
    ).toBe('DIRECTION_MISMATCH');

    // 3. Wrong master key (tag failure)
    expect(
      (
        await decryptBinaryChunkFrame({
          masterKeyBytes: wrongKeyBytes,
          roomId,
          expectedTransferId: transferId,
          expectedFileId: fileId,
          expectedDirection: direction,
          expectedEpoch: 1,
          expectedChunkIndex: 3,
          frameBuffer: frame,
        })
      ).code,
    ).toBe('AUTH_FAILED');

    // 4. Tampered reserved byte -> INVALID_FRAME
    const reservedTamper = new Uint8Array(frame.slice(0));
    reservedTamper[7] = 0x01;
    expect(decodeBinaryFrameHeader(reservedTamper.buffer).ok).toBe(false);

    // 5. Tampered ciphertext/tag byte -> AUTH_FAILED
    const tagTamper = new Uint8Array(frame.slice(0));
    tagTamper[tagTamper.length - 1] ^= 0xff;
    expect(
      (
        await decryptBinaryChunkFrame({
          masterKeyBytes,
          roomId,
          expectedTransferId: transferId,
          expectedFileId: fileId,
          expectedDirection: direction,
          expectedEpoch: 1,
          expectedChunkIndex: 3,
          frameBuffer: tagTamper.buffer,
        })
      ).code,
    ).toBe('AUTH_FAILED');

    // 6. Tampered header flags without re-signing -> AAD verification fails (AUTH_FAILED)
    const headerTamper = new Uint8Array(frame.slice(0));
    headerTamper[5] = CHUNK_FLAG_FINAL;
    expect(
      (
        await decryptBinaryChunkFrame({
          masterKeyBytes,
          roomId,
          expectedTransferId: transferId,
          expectedFileId: fileId,
          expectedDirection: direction,
          expectedEpoch: 1,
          expectedChunkIndex: 3,
          frameBuffer: headerTamper.buffer,
        })
      ).code,
    ).toBe('AUTH_FAILED');

    // 7. Truncated frame -> INVALID_FRAME
    expect(decodeBinaryFrameHeader(frame.slice(0, 20)).ok).toBe(false);
    expect(
      (
        await decryptBinaryChunkFrame({
          masterKeyBytes,
          roomId,
          expectedTransferId: transferId,
          expectedFileId: fileId,
          expectedDirection: direction,
          expectedEpoch: 1,
          expectedChunkIndex: 3,
          frameBuffer: frame.slice(0, 60),
        })
      ).code,
    ).toBe('INVALID_FRAME');
  });
});
