import { detectBrowserPersistenceProfile } from './capability-limits.js';

function sanitizeSuggestedFileName(fileName) {
  if (typeof fileName !== 'string' || fileName.trim() === '') {
    return 'download';
  }
  return fileName;
}

/**
 * Synchronously checks whether the current browser environment supports the
 * verified MVP direct-to-disk File System Access API persistence path.
 */
export function evaluatePersistenceCapability({
  windowObj = globalThis.window,
  navigatorObj = globalThis.navigator,
} = {}) {
  return detectBrowserPersistenceProfile({ windowObj, navigatorObj });
}

/**
 * Safely queries navigator.storage.estimate() in the background for capacity hints.
 * Never throws and never gates user activation.
 */
export async function queryStorageEstimate({
  navigatorObj = globalThis.navigator,
} = {}) {
  const estimateFn = navigatorObj?.storage?.estimate;
  if (typeof estimateFn !== 'function') {
    return Object.freeze({
      quotaBytes: null,
      usageBytes: null,
      availableBytes: null,
    });
  }

  try {
    const estimate = await estimateFn.call(navigatorObj.storage);
    const quotaBytes =
      typeof estimate?.quota === 'number' && Number.isFinite(estimate.quota)
        ? estimate.quota
        : null;
    const usageBytes =
      typeof estimate?.usage === 'number' && Number.isFinite(estimate.usage)
        ? estimate.usage
        : null;
    const availableBytes =
      quotaBytes !== null && usageBytes !== null
        ? Math.max(0, quotaBytes - usageBytes)
        : quotaBytes;

    return Object.freeze({
      quotaBytes,
      usageBytes,
      availableBytes,
    });
  } catch {
    return Object.freeze({
      quotaBytes: null,
      usageBytes: null,
      availableBytes: null,
    });
  }
}

function wrapWritableTarget(fileHandle, writable) {
  let closed = false;
  let aborted = false;

  return Object.freeze({
    fileHandle,
    writable,
    isFinished: () => closed || aborted,
    async write(chunk) {
      if (closed || aborted) {
        throw new Error('Persistence target is no longer writable.');
      }
      await writable.write(chunk);
    },
    async close() {
      if (closed || aborted) {
        return;
      }
      closed = true;
      if (typeof writable.close === 'function') {
        await writable.close();
      }
    },
    async abort(reason) {
      if (closed || aborted) {
        return;
      }
      aborted = true;
      if (typeof writable.abort === 'function') {
        await writable.abort(reason).catch(() => {});
      } else if (typeof writable.close === 'function') {
        await writable.close().catch(() => {});
      }
    },
  });
}

/**
 * Invokes window.showSaveFilePicker() synchronously inside the caller's stack frame
 * before awaiting any asynchronous operations, preserving transient user activation.
 */
export function openSaveTargetSynchronously({
  fileName,
  windowObj = globalThis.window,
} = {}) {
  const capability = evaluatePersistenceCapability({ windowObj });
  if (!capability.supported) {
    return Promise.resolve({
      ok: false,
      cancelled: false,
      code: capability.reason,
      guidance: capability.guidance,
    });
  }

  let pickerPromise;
  try {
    pickerPromise = windowObj.showSaveFilePicker({
      suggestedName: sanitizeSuggestedFileName(fileName),
    });
  } catch (err) {
    if (err?.name === 'AbortError') {
      return Promise.resolve({
        ok: false,
        cancelled: true,
        code: 'SAVE_CANCELLED',
      });
    }
    return Promise.resolve({
      ok: false,
      cancelled: false,
      code: 'PERSISTENCE_OPEN_FAILED',
    });
  }

  return Promise.resolve(pickerPromise).then(
    async (fileHandle) => {
      if (!fileHandle || typeof fileHandle.createWritable !== 'function') {
        return {
          ok: false,
          cancelled: false,
          code: 'PERSISTENCE_OPEN_FAILED',
        };
      }
      let writable = null;
      try {
        writable = await fileHandle.createWritable();
        if (!writable || typeof writable.write !== 'function') {
          return {
            ok: false,
            cancelled: false,
            code: 'PERSISTENCE_OPEN_FAILED',
          };
        }
        return {
          ok: true,
          target: wrapWritableTarget(fileHandle, writable),
        };
      } catch (err) {
        if (writable && typeof writable.abort === 'function') {
          await writable.abort().catch(() => {});
        }
        if (err?.name === 'AbortError') {
          return {
            ok: false,
            cancelled: true,
            code: 'SAVE_CANCELLED',
          };
        }
        return {
          ok: false,
          cancelled: false,
          code: 'PERSISTENCE_OPEN_FAILED',
        };
      }
    },
    (err) => {
      if (err?.name === 'AbortError') {
        return {
          ok: false,
          cancelled: true,
          code: 'SAVE_CANCELLED',
        };
      }
      return {
        ok: false,
        cancelled: false,
        code: 'PERSISTENCE_OPEN_FAILED',
      };
    },
  );
}
