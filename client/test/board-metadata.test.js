import { describe, expect, it } from 'vitest';
import {
  decodeBase64Url,
  encodeBase64Url,
  isValidBase64Url,
} from '../src/crypto/base64url.js';
import {
  BOARD_METADATA_HKDF_INFO,
  FIXED_CHUNK_SIZE_BYTES,
  decryptFileAdvertisement,
  deriveBoardMetadataKey,
  encryptFileAdvertisement,
  generateFileId,
  validatePlaintextFileMetadata,
} from '../src/crypto/board-metadata.js';
import { generateMasterKey } from '../src/crypto/fragment-key.js';
import { sanitizeEventPayloadSummary } from '../src/signaling/socket-client.js';

describe('encrypted file-board metadata (ticket [45])', () => {
  it('encrypts and decrypts canonical base64url FILE_ADVERTISE payloads with domain-separated HKDF and fresh random IVs', async () => {
    const { masterKeyBytes } = generateMasterKey();
    const roomId = 'ship-83a1';
    const fileId = generateFileId();

    expect(BOARD_METADATA_HKDF_INFO).toBe('shipri-board-metadata-v1');
    expect(FIXED_CHUNK_SIZE_BYTES).toBe(65536);
    expect(decodeBase64Url(fileId).byteLength).toBe(16);

    const key = await deriveBoardMetadataKey(masterKeyBytes, roomId);
    expect(key.extractable).toBe(false);
    expect(key.algorithm).toMatchObject({ name: 'AES-GCM', length: 256 });

    const metadata = {
      fileName: 'quarterly_financial_report.pdf',
      fileSize: 54_200_102,
      fileType: 'application/pdf',
      chunkSize: 65536,
      totalChunks: Math.ceil(54_200_102 / 65536),
      sha256: encodeBase64Url(new Uint8Array(32).fill(0xab)),
    };

    const msg1 = await encryptFileAdvertisement({
      masterKeyBytes,
      roomId,
      fileId,
      metadata,
    });
    const msg2 = await encryptFileAdvertisement({
      masterKeyBytes,
      roomId,
      fileId,
      metadata,
    });

    expect(msg1.type).toBe('FILE_ADVERTISE');
    expect(msg1.payload.fileId).toBe(fileId);
    expect(isValidBase64Url(msg1.payload.encryptedMetadata.iv)).toBe(true);
    expect(isValidBase64Url(msg1.payload.encryptedMetadata.ciphertext)).toBe(
      true,
    );
    expect(
      decodeBase64Url(msg1.payload.encryptedMetadata.iv).byteLength,
    ).toBe(12);
    // Fresh 12-byte random IV ensures distinct ciphertexts for identical metadata
    expect(msg1.payload.encryptedMetadata.iv).not.toBe(
      msg2.payload.encryptedMetadata.iv,
    );

    const decrypted = await decryptFileAdvertisement({
      masterKeyBytes,
      roomId,
      message: msg1,
    });
    expect(decrypted).toEqual({
      ok: true,
      fileId,
      metadata,
    });

    // Zero-byte file round trip
    const emptyFileId = generateFileId();
    const emptyMeta = {
      fileName: 'empty.txt',
      fileSize: 0,
      fileType: 'text/plain',
      chunkSize: 65536,
      totalChunks: 0,
    };
    const emptyMsg = await encryptFileAdvertisement({
      masterKeyBytes,
      roomId,
      fileId: emptyFileId,
      metadata: emptyMeta,
    });
    expect(
      await decryptFileAdvertisement({
        masterKeyBytes,
        roomId,
        message: emptyMsg,
      }),
    ).toEqual({
      ok: true,
      fileId: emptyFileId,
      metadata: emptyMeta,
    });
  });

  it('rejects tampered ciphertext, tampered IV, swapped fileId/roomId AAD, and wrong keys', async () => {
    const { masterKeyBytes } = generateMasterKey();
    const { masterKeyBytes: wrongKeyBytes } = generateMasterKey();
    const roomId = 'ship-41ef';
    const fileId = generateFileId();

    const msg = await encryptFileAdvertisement({
      masterKeyBytes,
      roomId,
      fileId,
      metadata: {
        fileName: 'secret-blueprint.zip',
        fileSize: 131072,
        fileType: 'application/zip',
        chunkSize: 65536,
        totalChunks: 2,
      },
    });

    // 1. Wrong master key
    const wrongKeyResult = await decryptFileAdvertisement({
      masterKeyBytes: wrongKeyBytes,
      roomId,
      message: msg,
    });
    expect(wrongKeyResult.ok).toBe(false);
    expect(wrongKeyResult.code).toBe('DECRYPTION_FAILED');

    // 2. Wrong roomId (HKDF salt + AAD mismatch)
    const wrongRoomResult = await decryptFileAdvertisement({
      masterKeyBytes,
      roomId: 'ship-9999',
      message: msg,
    });
    expect(wrongRoomResult.ok).toBe(false);
    expect(wrongRoomResult.code).toBe('DECRYPTION_FAILED');

    // 3. Swapped fileId (AAD mismatch)
    const swappedFileId = generateFileId();
    const swappedResult = await decryptFileAdvertisement({
      masterKeyBytes,
      roomId,
      message: {
        type: 'FILE_ADVERTISE',
        payload: {
          fileId: swappedFileId,
          encryptedMetadata: msg.payload.encryptedMetadata,
        },
      },
    });
    expect(swappedResult.ok).toBe(false);
    expect(swappedResult.code).toBe('DECRYPTION_FAILED');

    // 4. Tampered ciphertext byte
    const ctBytes = decodeBase64Url(msg.payload.encryptedMetadata.ciphertext);
    ctBytes[0] ^= 0x01;
    const tamperedCtResult = await decryptFileAdvertisement({
      masterKeyBytes,
      roomId,
      message: {
        type: 'FILE_ADVERTISE',
        payload: {
          fileId,
          encryptedMetadata: {
            iv: msg.payload.encryptedMetadata.iv,
            ciphertext: encodeBase64Url(ctBytes),
          },
        },
      },
    });
    expect(tamperedCtResult.ok).toBe(false);
    expect(tamperedCtResult.code).toBe('DECRYPTION_FAILED');

    // 5. Tampered IV byte
    const ivBytes = decodeBase64Url(msg.payload.encryptedMetadata.iv);
    ivBytes[0] ^= 0x80;
    const tamperedIvResult = await decryptFileAdvertisement({
      masterKeyBytes,
      roomId,
      message: {
        type: 'FILE_ADVERTISE',
        payload: {
          fileId,
          encryptedMetadata: {
            iv: encodeBase64Url(ivBytes),
            ciphertext: msg.payload.encryptedMetadata.ciphertext,
          },
        },
      },
    });
    expect(tamperedIvResult.ok).toBe(false);
    expect(tamperedIvResult.code).toBe('DECRYPTION_FAILED');
  });

  it('rejects malformed payloads and invalid metadata without leaking plaintext metadata into wire payloads or logs', async () => {
    const { masterKeyBytes } = generateMasterKey();
    const roomId = 'ship-83a1';
    const fileId = generateFileId();

    expect(
      validatePlaintextFileMetadata({
        fileName: '../etc/passwd',
        fileSize: 100,
        fileType: 'text/plain',
        chunkSize: 65536,
        totalChunks: 1,
      }).ok,
    ).toBe(false);

    expect(
      validatePlaintextFileMetadata({
        fileName: 'good.bin',
        fileSize: 100,
        fileType: 'application/octet-stream',
        chunkSize: 65536,
        totalChunks: 5, // mismatched chunk count
      }).ok,
    ).toBe(false);

    // Malformed wire message rejected before decryption
    expect(
      (
        await decryptFileAdvertisement({
          masterKeyBytes,
          roomId,
          message: {
            type: 'FILE_ADVERTISE',
            payload: {
              fileId,
              encryptedMetadata: {
                iv: 'short',
                ciphertext: 'short',
              },
            },
          },
        })
      ).code,
    ).toBe('INVALID_ADVERTISEMENT');

    // Verify zero plaintext metadata leakage across wire payload and sanitized log summary
    const sensitiveMetadata = {
      fileName: 'confidential_merger_terms_2026.docx',
      fileSize: 987_654,
      fileType: 'application/vnd.openxmlformats-officedocument',
      chunkSize: 65536,
      totalChunks: Math.ceil(987_654 / 65536),
    };
    const encryptedMsg = await encryptFileAdvertisement({
      masterKeyBytes,
      roomId,
      fileId,
      metadata: sensitiveMetadata,
    });

    const wireJson = JSON.stringify(encryptedMsg);
    const logSummary = sanitizeEventPayloadSummary('FILE_ADVERTISE', encryptedMsg.payload);
    expect(wireJson).not.toContain('confidential_merger_terms_2026.docx');
    expect(wireJson).not.toContain('987654');
    expect(wireJson).not.toContain('openxmlformats');
    expect(logSummary).not.toContain('confidential_merger_terms_2026.docx');
    expect(logSummary).not.toContain(encryptedMsg.payload.encryptedMetadata.ciphertext);
  });
});
