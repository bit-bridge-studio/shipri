import { FIXED_CHUNK_SIZE_BYTES } from '../crypto/board-metadata.js';

export const PROTOCOL_MAX_CHUNKS = 0x100000000;
export const PROTOCOL_MAX_FILE_SIZE_BYTES =
  PROTOCOL_MAX_CHUNKS * FIXED_CHUNK_SIZE_BYTES;

export const DEFERRED_PERSISTENCE_EXTENSIONS = Object.freeze({
  serviceWorkerStreaming: Object.freeze({
    enabled: false,
    status: 'deferred_future_extension',
    reason: 'Requires separate browser-support approval before implementation.',
  }),
  indexedDbBuffering: Object.freeze({
    enabled: false,
    status: 'deferred_future_extension',
    reason:
      'Size-limited fallback requires separate browser-support approval.',
  }),
});

const UNSUPPORTED_GUIDANCE = Object.freeze({
  INSECURE_CONTEXT:
    'Direct file saving requires a secure HTTPS context (or localhost) with the File System Access API. Service Worker and IndexedDB fallbacks are not enabled.',
  MISSING_FILE_SYSTEM_ACCESS_API:
    'This browser does not support window.showSaveFilePicker() for direct-to-disk streaming. Use desktop Chromium (Chrome, Edge, Brave, Opera) over HTTPS or localhost; Service Worker and IndexedDB fallbacks are not enabled.',
});

function formatLimitBytes(bytes) {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) {
    return '0 bytes';
  }
  if (bytes >= 1024 ** 4) {
    const tb = bytes / 1024 ** 4;
    return `${Number.isInteger(tb) ? tb : tb.toFixed(2)} TiB (${bytes} bytes)`;
  }
  if (bytes >= 1024 ** 3) {
    return `${(bytes / 1024 ** 3).toFixed(2)} GiB (${bytes} bytes)`;
  }
  if (bytes >= 1024 ** 2) {
    return `${(bytes / 1024 ** 2).toFixed(1)} MiB (${bytes} bytes)`;
  }
  return `${bytes} bytes`;
}

/**
 * Feature-detects the verified File System Access MVP direct-to-disk path
 * strictly from runtime browser capabilities without enabling deferred
 * Service Worker or IndexedDB fallbacks.
 */
export function detectBrowserPersistenceProfile({
  windowObj = globalThis.window,
  navigatorObj = globalThis.navigator,
} = {}) {
  void navigatorObj;
  const isSecureContext = Boolean(windowObj?.isSecureContext);
  if (!isSecureContext) {
    return Object.freeze({
      supported: false,
      mode: 'unsupported',
      reason: 'INSECURE_CONTEXT',
      guidance: UNSUPPORTED_GUIDANCE.INSECURE_CONTEXT,
      maxProtocolFileSizeBytes: PROTOCOL_MAX_FILE_SIZE_BYTES,
      deferredExtensions: DEFERRED_PERSISTENCE_EXTENSIONS,
    });
  }

  const hasSaveFilePicker = typeof windowObj?.showSaveFilePicker === 'function';
  if (!hasSaveFilePicker) {
    return Object.freeze({
      supported: false,
      mode: 'unsupported',
      reason: 'MISSING_FILE_SYSTEM_ACCESS_API',
      guidance: UNSUPPORTED_GUIDANCE.MISSING_FILE_SYSTEM_ACCESS_API,
      maxProtocolFileSizeBytes: PROTOCOL_MAX_FILE_SIZE_BYTES,
      deferredExtensions: DEFERRED_PERSISTENCE_EXTENSIONS,
    });
  }

  return Object.freeze({
    supported: true,
    mode: 'file-system-access',
    reason: null,
    guidance: null,
    maxProtocolFileSizeBytes: PROTOCOL_MAX_FILE_SIZE_BYTES,
    deferredExtensions: DEFERRED_PERSISTENCE_EXTENSIONS,
  });
}

/**
 * Evaluates whether a remote file size can be persisted under the current
 * browser capability, protocol 256 TiB limit, and estimated local storage.
 */
export function evaluateFilePersistenceEligibility({
  fileSize,
  capability,
  storageEstimate,
} = {}) {
  const effectiveCapability =
    capability ?? detectBrowserPersistenceProfile();
  const availableBytes =
    typeof storageEstimate?.availableBytes === 'number' &&
    Number.isFinite(storageEstimate.availableBytes) &&
    storageEstimate.availableBytes >= 0
      ? storageEstimate.availableBytes
      : null;
  const effectiveMaxBytes =
    availableBytes !== null
      ? Math.min(PROTOCOL_MAX_FILE_SIZE_BYTES, availableBytes)
      : PROTOCOL_MAX_FILE_SIZE_BYTES;

  if (!effectiveCapability.supported) {
    return Object.freeze({
      eligible: false,
      reason: effectiveCapability.reason,
      guidance: effectiveCapability.guidance,
      insufficientStorage: false,
      exceedsProtocolLimit: false,
      maxBytes: 0,
    });
  }

  if (
    typeof fileSize !== 'number' ||
    !Number.isSafeInteger(fileSize) ||
    fileSize < 0 ||
    fileSize > PROTOCOL_MAX_FILE_SIZE_BYTES
  ) {
    return Object.freeze({
      eligible: false,
      reason: 'LIMIT_EXCEEDED',
      guidance: `File exceeds the protocol 256 TiB chunked transfer limit (${formatLimitBytes(PROTOCOL_MAX_FILE_SIZE_BYTES)}).`,
      insufficientStorage: false,
      exceedsProtocolLimit: true,
      maxBytes: PROTOCOL_MAX_FILE_SIZE_BYTES,
    });
  }

  if (availableBytes !== null && fileSize > availableBytes) {
    return Object.freeze({
      eligible: false,
      reason: 'LIMIT_EXCEEDED',
      guidance: `File exceeds estimated available local storage (${formatLimitBytes(availableBytes)}). Free disk space before downloading.`,
      insufficientStorage: true,
      exceedsProtocolLimit: false,
      maxBytes: effectiveMaxBytes,
    });
  }

  return Object.freeze({
    eligible: true,
    reason: null,
    guidance: null,
    insufficientStorage: false,
    exceedsProtocolLimit: false,
    maxBytes: effectiveMaxBytes,
  });
}
