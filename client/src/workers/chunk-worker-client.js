import { createChunkWorkerMessageHandler } from './chunk-crypto.worker.js';

/**
 * Main-thread client facade over the dedicated chunk encryption/decryption
 * worker using zero-copy Transferable ArrayBuffer handoffs, with an identical
 * in-process async handler when Dedicated Workers are unavailable (e.g. Node/Vitest).
 */
export function createChunkCryptoProcessor({ workerFactory } = {}) {
  let disposed = false;
  let nextRequestId = 1;
  const pending = new Map();

  function settlePending(message) {
    if (!message || typeof message !== 'object') {
      return;
    }
    const entry = pending.get(message.id);
    if (!entry) {
      return;
    }
    pending.delete(message.id);
    entry.resolve(message);
  }

  let worker = null;
  if (typeof workerFactory === 'function') {
    worker = workerFactory();
  } else if (typeof globalThis.Worker === 'function') {
    try {
      worker = new globalThis.Worker(
        new URL('./chunk-crypto.worker.js', import.meta.url),
        { type: 'module' },
      );
    } catch {
      worker = null;
    }
  }

  let inProcessHandler = null;
  if (worker) {
    worker.onmessage = (event) => settlePending(event?.data);
    worker.onerror = () => {
      for (const entry of pending.values()) {
        entry.resolve({ ok: false, code: 'INTERNAL_ERROR' });
      }
      pending.clear();
    };
  } else {
    inProcessHandler = createChunkWorkerMessageHandler((response) => {
      settlePending(response);
    });
  }

  function dispatch(action, payload, transferList = []) {
    if (disposed) {
      return Promise.resolve({ ok: false, code: 'DISPOSED' });
    }

    const id = nextRequestId++;
    return new Promise((resolve) => {
      pending.set(id, { resolve });
      const message = { id, action, payload };
      if (worker) {
        worker.postMessage(message, transferList);
      } else {
        void inProcessHandler({ data: message });
      }
    });
  }

  async function encryptChunk({
    masterKeyBytes,
    roomId,
    transferId,
    fileId,
    direction,
    epoch,
    chunkIndex,
    plaintextBuffer,
    isFinalChunk = false,
  }) {
    const transferList =
      plaintextBuffer instanceof ArrayBuffer ? [plaintextBuffer] : [];
    return dispatch(
      'ENCRYPT_CHUNK',
      {
        masterKeyBytes,
        roomId,
        transferId,
        fileId,
        direction,
        epoch,
        chunkIndex,
        plaintextBuffer,
        isFinalChunk,
      },
      transferList,
    );
  }

  async function decryptChunk({
    masterKeyBytes,
    roomId,
    expectedTransferId,
    expectedFileId,
    expectedDirection,
    expectedEpoch,
    expectedChunkIndex,
    frameBuffer,
  }) {
    const transferList = frameBuffer instanceof ArrayBuffer ? [frameBuffer] : [];
    const response = await dispatch(
      'DECRYPT_CHUNK',
      {
        masterKeyBytes,
        roomId,
        expectedTransferId,
        expectedFileId,
        expectedDirection,
        expectedEpoch,
        expectedChunkIndex,
        frameBuffer,
      },
      transferList,
    );
    if (!response.ok) {
      return response;
    }
    return {
      ok: true,
      header: response.header,
      plaintextBuffer: response.plaintextBuffer,
      plaintextBytes: new Uint8Array(response.plaintextBuffer),
    };
  }

  function releaseTransfer(transferId) {
    if (disposed || typeof transferId !== 'string') {
      return Promise.resolve({ ok: true });
    }
    return dispatch('RELEASE_TRANSFER', { transferId });
  }

  function dispose() {
    if (disposed) {
      return;
    }
    disposed = true;
    for (const entry of pending.values()) {
      entry.resolve({ ok: false, code: 'DISPOSED' });
    }
    pending.clear();

    if (worker) {
      try {
        worker.postMessage({ action: 'DISPOSE' });
        worker.terminate?.();
      } catch {
        // Ignore termination failures
      }
      worker = null;
    } else if (inProcessHandler) {
      void inProcessHandler({ data: { action: 'DISPOSE' } });
      inProcessHandler = null;
    }
  }

  return Object.freeze({
    encryptChunk,
    decryptChunk,
    releaseTransfer,
    dispose,
  });
}
