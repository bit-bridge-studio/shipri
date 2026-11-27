/**
 * Installs isolated per-context File System Access API stubs, storage quota
 * stubs, and in-memory clipboard stubs before page scripts run.
 */
export async function installPersistenceStub(context, initialOptions = {}) {
  const serializedInitial = {
    unsupportedMode: initialOptions.unsupportedMode ?? null,
    storageQuotaBytes:
      typeof initialOptions.storageQuotaBytes === 'number'
        ? initialOptions.storageQuotaBytes
        : null,
    cancelNextPick: Boolean(initialOptions.cancelNextPick),
    writeDelayMs: Number(initialOptions.writeDelayMs) || 0,
    retainBytes: initialOptions.retainBytes !== false,
  };

  await context.addInitScript((opts) => {
    const CHUNK_HASH_BLOCK = 65_536;
    const savedFiles = [];
    const config = { ...opts };
    const state = {
      config,
      savedFiles,
      clipboardText: '',
      pickerCalls: 0,
    };

    Object.defineProperty(window, '__shipriE2E', {
      configurable: true,
      writable: false,
      value: state,
    });

    if (config.unsupportedMode === 'insecure-context') {
      try {
        Object.defineProperty(window, 'isSecureContext', {
          configurable: true,
          get: () => window.__shipriE2E.config.unsupportedMode !== 'insecure-context',
        });
      } catch {
        // Ignore non-configurable property edge case
      }
    }

    try {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: async (text) => {
            state.clipboardText = String(text);
          },
          readText: async () => state.clipboardText,
        },
      });
    } catch {
      // Fallback if navigator.clipboard is non-configurable
    }

    if (navigator.storage) {
      const origEstimate =
        typeof navigator.storage.estimate === 'function'
          ? navigator.storage.estimate.bind(navigator.storage)
          : null;
      try {
        Object.defineProperty(navigator.storage, 'estimate', {
          configurable: true,
          value: async () => {
            if (typeof state.config.storageQuotaBytes === 'number') {
              return {
                quota: state.config.storageQuotaBytes,
                usage: 0,
              };
            }
            if (origEstimate) {
              return origEstimate();
            }
            return { quota: 1_073_741_824, usage: 0 };
          },
        });
      } catch {
        // Ignore if non-configurable
      }
    }

    if (config.unsupportedMode === 'missing-picker') {
      try {
        delete window.showSaveFilePicker;
      } catch {
        // Fallback overwrite with undefined
        Object.defineProperty(window, 'showSaveFilePicker', {
          configurable: true,
          value: undefined,
        });
      }
      return;
    }

    function toUint8(chunk) {
      if (chunk instanceof Uint8Array) {
        return chunk;
      }
      if (chunk instanceof ArrayBuffer) {
        return new Uint8Array(chunk);
      }
      if (ArrayBuffer.isView(chunk)) {
        return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      }
      if (typeof chunk === 'string') {
        return new TextEncoder().encode(chunk);
      }
      throw new TypeError('Unsupported chunk type passed to writable stub.');
    }

    function uint8ToBase64(bytes) {
      let binary = '';
      const step = 0x8000;
      for (let i = 0; i < bytes.byteLength; i += step) {
        const sub = bytes.subarray(i, Math.min(bytes.byteLength, i + step));
        binary += String.fromCharCode(...sub);
      }
      return btoa(binary);
    }

    function bytesToHex(bytes) {
      return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    }

    window.showSaveFilePicker = (pickerOpts = {}) => {
      state.pickerCalls += 1;
      const hadUserActivation = Boolean(navigator.userActivation?.isActive);
      if (state.config.cancelNextPick) {
        state.config.cancelNextPick = false;
        const err = new DOMException('The user aborted a request.', 'AbortError');
        return Promise.reject(err);
      }

      const retain = state.config.retainBytes !== false;
      const record = {
        id: savedFiles.length + 1,
        suggestedName: pickerOpts?.suggestedName ?? 'download',
        hadUserActivation,
        bytesWritten: 0,
        chunkCount: 0,
        closed: false,
        aborted: false,
        sha256ChainHex: null,
        bytesBase64: null,
      };
      savedFiles.push(record);

      let chain = new Uint8Array(32);
      let pendingTail = new Uint8Array(0);
      const retainedChunks = retain ? [] : null;

      async function advanceChain(block) {
        const combined = new Uint8Array(chain.byteLength + block.byteLength);
        combined.set(chain, 0);
        combined.set(block, chain.byteLength);
        const digest = await crypto.subtle.digest('SHA-256', combined);
        chain = new Uint8Array(digest);
      }

      const writable = {
        async write(rawChunk) {
          const delayMs = Number(state.config.writeDelayMs) || 0;
          if (delayMs > 0) {
            await new Promise((r) => setTimeout(r, delayMs));
          }
          const view = toUint8(rawChunk);
          const copy = new Uint8Array(view);
          record.bytesWritten += copy.byteLength;
          record.chunkCount += 1;

          if (retainedChunks) {
            retainedChunks.push(copy);
          }

          if (copy.byteLength > 0) {
            const merged = new Uint8Array(pendingTail.byteLength + copy.byteLength);
            merged.set(pendingTail, 0);
            merged.set(copy, pendingTail.byteLength);
            let offset = 0;
            while (offset + CHUNK_HASH_BLOCK <= merged.byteLength) {
              await advanceChain(merged.subarray(offset, offset + CHUNK_HASH_BLOCK));
              offset += CHUNK_HASH_BLOCK;
            }
            pendingTail = merged.slice(offset);
          }
        },
        async close() {
          if (record.closed || record.aborted) {
            return;
          }
          if (pendingTail.byteLength > 0 || record.bytesWritten === 0) {
            await advanceChain(pendingTail);
            pendingTail = new Uint8Array(0);
          }
          record.sha256ChainHex = bytesToHex(chain);
          if (retainedChunks) {
            const total = new Uint8Array(record.bytesWritten);
            let pos = 0;
            for (const c of retainedChunks) {
              total.set(c, pos);
              pos += c.byteLength;
            }
            retainedChunks.length = 0;
            record.bytesBase64 = uint8ToBase64(total);
          }
          record.closed = true;
        },
        async abort() {
          if (record.closed || record.aborted) {
            return;
          }
          pendingTail = new Uint8Array(0);
          if (retainedChunks) {
            retainedChunks.length = 0;
          }
          record.aborted = true;
        },
      };

      return Promise.resolve({
        name: record.suggestedName,
        async createWritable() {
          return writable;
        },
      });
    };
  }, serializedInitial);
}

export async function configurePersistenceStub(page, patch = {}) {
  await page.evaluate((nextPatch) => {
    if (!window.__shipriE2E) {
      throw new Error('Persistence stub is not installed on this page.');
    }
    Object.assign(window.__shipriE2E.config, nextPatch);
  }, patch);
}

export async function getSavedFiles(page) {
  const rawRecords = await page.evaluate(() => {
    return (window.__shipriE2E?.savedFiles ?? []).map((item) => ({ ...item }));
  });
  return rawRecords.map((item) => ({
    ...item,
    bytes:
      typeof item.bytesBase64 === 'string'
        ? Buffer.from(item.bytesBase64, 'base64')
        : null,
  }));
}

export async function getStubClipboardText(page) {
  return page.evaluate(() => window.__shipriE2E?.clipboardText ?? '');
}
