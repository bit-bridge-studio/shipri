import { describe, expect, it } from 'vitest';
import { decodeBase64Url, encodeBase64Url } from '../src/crypto/base64url.js';
import {
  encryptFileAdvertisement,
  generateFileId,
} from '../src/crypto/board-metadata.js';
import {
  CONTROL_ENVELOPE_VERSION,
  CONTROL_HKDF_INFO,
  applyFlowCredit,
  createFlowCreditTracker,
  decryptControlMessage,
  deriveControlKey,
  encryptControlMessage,
  formatTransferDirection,
  generateTransferId,
  validateControlMessage,
} from '../src/crypto/control-codec.js';
import {
  generateMasterKey,
  generateMemberId,
} from '../src/crypto/fragment-key.js';

describe('authenticated transfer control messages (ticket [46])', () => {
  it('encrypts, authenticates, and validates every frozen control message type over shipri-control-v1 AEAD', async () => {
    const { masterKeyBytes } = generateMasterKey();
    const roomId = 'ship-83a1';
    const ownerMemberId = generateMemberId();
    const downloaderMemberId = generateMemberId();
    const direction = formatTransferDirection(ownerMemberId, downloaderMemberId);
    const fileId = generateFileId();
    const transferId = generateTransferId();

    expect(CONTROL_HKDF_INFO).toBe('shipri-control-v1');
    expect(CONTROL_ENVELOPE_VERSION).toBe(1);
    expect(decodeBase64Url(transferId).byteLength).toBe(16);

    const key = await deriveControlKey(masterKeyBytes, roomId);
    expect(key.extractable).toBe(false);

    const advertise = await encryptFileAdvertisement({
      masterKeyBytes,
      roomId,
      fileId,
      metadata: {
        fileName: 'archive.tar.gz',
        fileSize: 262144,
        fileType: 'application/gzip',
        chunkSize: 65536,
        totalChunks: 4,
      },
    });

    const allMessages = [
      {
        type: 'PEER_HELLO',
        payload: { memberId: ownerMemberId, protocolVersion: 1 },
      },
      {
        type: 'BOARD_SYNC',
        payload: {
          files: [
            {
              fileId,
              encryptedMetadata: advertise.payload.encryptedMetadata,
            },
          ],
        },
      },
      advertise,
      {
        type: 'FILE_REMOVE',
        payload: { fileId },
      },
      {
        type: 'DOWNLOAD_REQUEST',
        payload: {
          transferId,
          fileId,
          direction,
          initialEpoch: 1,
        },
      },
      {
        type: 'DOWNLOAD_ACCEPTED',
        payload: {
          transferId,
          fileId,
          direction,
          epoch: 1,
          chunkSize: 65536,
          totalChunks: 4,
          fileSize: 262144,
        },
      },
      {
        type: 'DOWNLOAD_REJECTED',
        payload: {
          transferId,
          fileId,
          reason: 'BUSY',
        },
      },
      {
        type: 'FLOW_CREDIT',
        payload: {
          transferId,
          fileId,
          direction,
          epoch: 1,
          sequence: 1,
          maxPlaintextOffsetExclusive: 2_097_152,
        },
      },
      {
        type: 'TRANSFER_PAUSE',
        payload: { transferId, direction, epoch: 1 },
      },
      {
        type: 'TRANSFER_RESUME',
        payload: { transferId, direction, epoch: 1 },
      },
      {
        type: 'TRANSFER_CANCEL',
        payload: { transferId, direction, reason: 'USER_CANCELLED' },
      },
      {
        type: 'TRANSFER_COMPLETE',
        payload: {
          transferId,
          fileId,
          direction,
          epoch: 1,
          totalPersistedBytes: 262144,
        },
      },
      {
        type: 'TRANSFER_ERROR',
        payload: {
          transferId,
          direction,
          code: 'FLOW_CREDIT_EXCEEDED',
        },
      },
      {
        type: 'RESUME_REQUEST',
        payload: {
          transferId,
          fileId,
          direction,
          nextEpoch: 2,
          lastPersistedChunkIndex: 1,
          persistedPlaintextBytes: 131072,
        },
      },
      {
        type: 'RESUME_ACCEPTED',
        payload: {
          transferId,
          fileId,
          direction,
          epoch: 2,
          resumeFromChunkIndex: 2,
        },
      },
      {
        type: 'RESUME_REJECTED',
        payload: {
          transferId,
          fileId,
          reason: 'INVALID_EPOCH',
        },
      },
    ];

    for (const msg of allMessages) {
      const envelope = await encryptControlMessage({
        masterKeyBytes,
        roomId,
        senderMemberId: ownerMemberId,
        message: msg,
      });
      expect(envelope.v).toBe(1);
      expect(envelope.senderMemberId).toBe(ownerMemberId);
      expect(decodeBase64Url(envelope.iv).byteLength).toBe(12);

      const decrypted = await decryptControlMessage({
        masterKeyBytes,
        roomId,
        expectedSenderMemberId: ownerMemberId,
        envelope,
      });
      expect(decrypted).toEqual({
        ok: true,
        senderMemberId: ownerMemberId,
        message: msg,
      });
    }
  });

  it('enforces FLOW_CREDIT transfer, direction, epoch binding and monotonic sequence without expanding window on stale/duplicate/reordered updates', () => {
    const ownerMemberId = generateMemberId();
    const downloaderMemberId = generateMemberId();
    const direction = formatTransferDirection(ownerMemberId, downloaderMemberId);
    const reverseDirection = formatTransferDirection(
      downloaderMemberId,
      ownerMemberId,
    );
    const transferId = generateTransferId();
    const otherTransferId = generateTransferId();
    const fileId = generateFileId();

    const tracker = createFlowCreditTracker({
      transferId,
      fileId,
      direction,
      epoch: 1,
      initialOffset: 0,
    });

    // 1. Valid initial credit grant (sequence 1 -> 2 MiB)
    const r1 = applyFlowCredit(tracker, {
      type: 'FLOW_CREDIT',
      payload: {
        transferId,
        fileId,
        direction,
        epoch: 1,
        sequence: 1,
        maxPlaintextOffsetExclusive: 2_097_152,
      },
    });
    expect(r1).toMatchObject({
      accepted: true,
      maxPlaintextOffsetExclusive: 2_097_152,
      lastSequence: 1,
    });

    // 2. Duplicate sequence 1 with larger offset MUST NOT expand window
    const dup = applyFlowCredit(tracker, {
      type: 'FLOW_CREDIT',
      payload: {
        transferId,
        fileId,
        direction,
        epoch: 1,
        sequence: 1,
        maxPlaintextOffsetExclusive: 9_999_999,
      },
    });
    expect(dup.accepted).toBe(false);
    expect(dup.reason).toBe('STALE_SEQUENCE');
    expect(tracker.maxPlaintextOffsetExclusive).toBe(2_097_152);

    // 3. Valid advance (sequence 3 -> 3 MiB)
    const r3 = applyFlowCredit(tracker, {
      type: 'FLOW_CREDIT',
      payload: {
        transferId,
        fileId,
        direction,
        epoch: 1,
        sequence: 3,
        maxPlaintextOffsetExclusive: 3_145_728,
      },
    });
    expect(r3.accepted).toBe(true);
    expect(tracker.maxPlaintextOffsetExclusive).toBe(3_145_728);

    // 4. Reordered older sequence 2 MUST be ignored
    const reordered = applyFlowCredit(tracker, {
      type: 'FLOW_CREDIT',
      payload: {
        transferId,
        fileId,
        direction,
        epoch: 1,
        sequence: 2,
        maxPlaintextOffsetExclusive: 2_621_440,
      },
    });
    expect(reordered.accepted).toBe(false);
    expect(reordered.reason).toBe('STALE_SEQUENCE');
    expect(tracker.maxPlaintextOffsetExclusive).toBe(3_145_728);

    // 5. Higher sequence with non-increasing offset does not shrink/expand window
    const nonAdvancing = applyFlowCredit(tracker, {
      type: 'FLOW_CREDIT',
      payload: {
        transferId,
        fileId,
        direction,
        epoch: 1,
        sequence: 4,
        maxPlaintextOffsetExclusive: 3_145_728,
      },
    });
    expect(nonAdvancing.accepted).toBe(false);
    expect(nonAdvancing.reason).toBe('NON_ADVANCING_OFFSET');

    // 6. Cross-transfer, wrong-direction, and stale-epoch credits fail closed
    expect(
      applyFlowCredit(tracker, {
        type: 'FLOW_CREDIT',
        payload: {
          transferId: otherTransferId,
          fileId,
          direction,
          epoch: 1,
          sequence: 5,
          maxPlaintextOffsetExclusive: 4_194_304,
        },
      }),
    ).toMatchObject({ accepted: false, reason: 'TRANSFER_MISMATCH' });

    expect(
      applyFlowCredit(tracker, {
        type: 'FLOW_CREDIT',
        payload: {
          transferId,
          fileId,
          direction: reverseDirection,
          epoch: 1,
          sequence: 5,
          maxPlaintextOffsetExclusive: 4_194_304,
        },
      }),
    ).toMatchObject({ accepted: false, reason: 'DIRECTION_MISMATCH' });

    expect(
      applyFlowCredit(tracker, {
        type: 'FLOW_CREDIT',
        payload: {
          transferId,
          fileId,
          direction,
          epoch: 2,
          sequence: 5,
          maxPlaintextOffsetExclusive: 4_194_304,
        },
      }),
    ).toMatchObject({ accepted: false, reason: 'EPOCH_MISMATCH' });

    expect(tracker.maxPlaintextOffsetExclusive).toBe(3_145_728);
  });

  it('fails closed on legacy FLOW_PAUSE/FLOW_RESUME, unknown types, forged envelopes, AAD swaps, and malformed payloads', async () => {
    const { masterKeyBytes } = generateMasterKey();
    const { masterKeyBytes: wrongKeyBytes } = generateMasterKey();
    const roomId = 'ship-83a1';
    const senderMemberId = generateMemberId();
    const otherMemberId = generateMemberId();
    const transferId = generateTransferId();
    const direction = formatTransferDirection(senderMemberId, otherMemberId);

    // Legacy FLOW_PAUSE / FLOW_RESUME and unknown types are rejected
    expect(
      validateControlMessage({
        type: 'FLOW_PAUSE',
        payload: { transferId },
      }).ok,
    ).toBe(false);
    expect(
      validateControlMessage({
        type: 'FLOW_RESUME',
        payload: { transferId },
      }).ok,
    ).toBe(false);
    expect(
      validateControlMessage({
        type: 'UNKNOWN_EVENT',
        payload: {},
      }).ok,
    ).toBe(false);

    // Extra unknown fields rejected
    expect(
      validateControlMessage({
        type: 'TRANSFER_PAUSE',
        payload: { transferId, direction, epoch: 1, extra: 'injected' },
      }).ok,
    ).toBe(false);

    // Forged/tampered AEAD envelope, wrong key, wrong room, and wrong sender fail closed
    const validEnvelope = await encryptControlMessage({
      masterKeyBytes,
      roomId,
      senderMemberId,
      message: {
        type: 'TRANSFER_CANCEL',
        payload: { transferId, direction, reason: 'USER_CANCELLED' },
      },
    });

    expect(
      (
        await decryptControlMessage({
          masterKeyBytes: wrongKeyBytes,
          roomId,
          envelope: validEnvelope,
        })
      ).ok,
    ).toBe(false);

    expect(
      (
        await decryptControlMessage({
          masterKeyBytes,
          roomId: 'ship-9999',
          envelope: validEnvelope,
        })
      ).ok,
    ).toBe(false);

    expect(
      (
        await decryptControlMessage({
          masterKeyBytes,
          roomId,
          expectedSenderMemberId: otherMemberId,
          envelope: validEnvelope,
        })
      ).code,
    ).toBe('SENDER_MISMATCH');

    const ctBytes = decodeBase64Url(validEnvelope.ciphertext);
    ctBytes[0] ^= 0xff;
    expect(
      (
        await decryptControlMessage({
          masterKeyBytes,
          roomId,
          envelope: {
            ...validEnvelope,
            ciphertext: encodeBase64Url(ctBytes),
          },
        })
      ).code,
    ).toBe('DECRYPTION_FAILED');
  });
});
