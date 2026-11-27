import {
  decodeBinaryFrameHeader,
  decryptBinaryChunkFrame,
  deriveTransferEpochKey,
  encryptBinaryChunkFrame,
} from '../crypto/binary-framing.js';

function buildCacheKey(roomId, transferId, direction, epoch) {
  return `${roomId}:${transferId}:${direction}:${epoch}`;
}

function toTightArrayBuffer(bufferOrView) {
  if (bufferOrView instanceof ArrayBuffer) {
    return bufferOrView;
  }
  const view = new Uint8Array(
    bufferOrView.buffer,
    bufferOrView.byteOffset,
    bufferOrView.byteLength,
  );
  return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
}

/**
 * Creates a DedicatedWorker-compatible message handler that caches per-epoch
 * AES-256-GCM CryptoKeys and transfers framed/plaintext ArrayBuffers zero-copy.
 */
export function createChunkWorkerMessageHandler(postMessageFn) {
  const epochKeyCache = new Map();

  async function resolveEpochKey({
    masterKeyBytes,
    roomId,
    transferId,
    direction,
    epoch,
  }) {
    const cacheKey = buildCacheKey(roomId, transferId, direction, epoch);
    let key = epochKeyCache.get(cacheKey);
    if (!key) {
      key = await deriveTransferEpochKey({
        masterKeyBytes,
        roomId,
        transferId,
        direction,
        epoch,
      });
      epochKeyCache.set(cacheKey, key);
    }
    return key;
  }

  function evictTransferKeys(transferId) {
    const marker = `:${transferId}:`;
    for (const cacheKey of epochKeyCache.keys()) {
      if (cacheKey.includes(marker)) {
        epochKeyCache.delete(cacheKey);
      }
    }
  }

  return async function handleWorkerMessage(event) {
    const msg = event?.data;
    if (!msg || typeof msg !== 'object') {
      return;
    }

    const { id, action, payload } = msg;

    try {
      if (action === 'ENCRYPT_CHUNK') {
        const {
          masterKeyBytes,
          roomId,
          transferId,
          fileId,
          direction,
          epoch,
          chunkIndex,
          plaintextBuffer,
          isFinalChunk,
        } = payload;
        const chunkKey = await resolveEpochKey({
          masterKeyBytes,
          roomId,
          transferId,
          direction,
          epoch,
        });
        const frameBuffer = await encryptBinaryChunkFrame({
          chunkKey,
          transferId,
          fileId,
          direction,
          epoch,
          chunkIndex,
          plaintext: plaintextBuffer,
          isFinalChunk,
        });
        postMessageFn(
          { id, ok: true, frameBuffer },
          [frameBuffer],
        );
        return;
      }

      if (action === 'DECRYPT_CHUNK') {
        const {
          masterKeyBytes,
          roomId,
          expectedTransferId,
          expectedFileId,
          expectedDirection,
          expectedEpoch,
          expectedChunkIndex,
          frameBuffer,
        } = payload;

        const header = decodeBinaryFrameHeader(frameBuffer);
        if (!header.ok) {
          postMessageFn({ id, ok: false, code: header.code });
          return;
        }

        let chunkKey;
        if (
          typeof expectedTransferId === 'string' &&
          typeof expectedDirection === 'string' &&
          typeof expectedEpoch === 'number' &&
          header.transferId === expectedTransferId &&
          header.epoch === expectedEpoch
        ) {
          try {
            chunkKey = await resolveEpochKey({
              masterKeyBytes,
              roomId,
              transferId: expectedTransferId,
              direction: expectedDirection,
              epoch: expectedEpoch,
            });
          } catch {
            chunkKey = undefined;
          }
        }

        const decrypted = await decryptBinaryChunkFrame({
          masterKeyBytes,
          chunkKey,
          roomId,
          expectedTransferId,
          expectedFileId,
          expectedDirection,
          expectedEpoch,
          expectedChunkIndex,
          frameBuffer,
        });

        if (!decrypted.ok) {
          postMessageFn({ id, ok: false, code: decrypted.code });
          return;
        }

        const plaintextBuffer = toTightArrayBuffer(decrypted.plaintext);
        postMessageFn(
          {
            id,
            ok: true,
            header: decrypted.header,
            plaintextBuffer,
          },
          [plaintextBuffer],
        );
        return;
      }

      if (action === 'RELEASE_TRANSFER') {
        if (typeof payload?.transferId === 'string') {
          evictTransferKeys(payload.transferId);
        }
        if (id !== undefined) {
          postMessageFn({ id, ok: true });
        }
        return;
      }

      if (action === 'DISPOSE') {
        epochKeyCache.clear();
        if (id !== undefined) {
          postMessageFn({ id, ok: true });
        }
        return;
      }

      if (id !== undefined) {
        postMessageFn({ id, ok: false, code: 'UNKNOWN_WORKER_ACTION' });
      }
    } catch {
      if (id !== undefined) {
        postMessageFn({ id, ok: false, code: 'INTERNAL_ERROR' });
      }
    }
  };
}

const isDedicatedWorker =
  typeof globalThis.DedicatedWorkerGlobalScope !== 'undefined' ||
  (typeof globalThis.document === 'undefined' &&
    typeof globalThis.postMessage === 'function' &&
    typeof globalThis.process === 'undefined');

if (isDedicatedWorker) {
  const handler = createChunkWorkerMessageHandler((message, transfer) => {
    globalThis.postMessage(message, transfer);
  });
  globalThis.onmessage = (event) => {
    void handler(event);
  };
}
