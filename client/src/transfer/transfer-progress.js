const DEFAULT_RATE_WINDOW_MS = 3_000;

function freezeSnapshot(record) {
  return Object.freeze({
    transferId: record.transferId,
    fileId: record.fileId,
    fileName: record.fileName,
    totalBytes: record.totalBytes,
    bytesTransferred: record.bytesTransferred,
    progressPercent: record.progressPercent,
    bytesPerSecond: record.bytesPerSecond,
    etaSeconds: record.etaSeconds,
    role: record.role,
    directionLabel: record.directionLabel,
    direction: record.direction,
    epoch: record.epoch,
    state: record.state,
    errorCode: record.errorCode,
    rejectReason: record.rejectReason,
  });
}

function computeProgressPercent(state, bytesTransferred, totalBytes) {
  if (state === 'completed') {
    return 100;
  }
  if (!totalBytes || totalBytes <= 0) {
    return 0;
  }
  return Math.min(100, Math.round((bytesTransferred / totalBytes) * 1000) / 10);
}

/**
 * Tracks independent per-transferId progress, rolling throughput (B/s), ETA,
 * role/direction labels, and lifecycle states without sharing mutable state
 * across concurrent or opposite-direction transfers.
 */
export function createTransferProgressTracker({
  nowFn = Date.now,
  windowMs = DEFAULT_RATE_WINDOW_MS,
} = {}) {
  const transfers = new Map();

  function recomputeMetrics(record, nowMs) {
    record.progressPercent = computeProgressPercent(
      record.state,
      record.bytesTransferred,
      record.totalBytes,
    );

    if (record.state !== 'active') {
      record.bytesPerSecond = 0;
      record.etaSeconds = null;
      return;
    }

    const cutoff = nowMs - windowMs;
    while (record.samples.length > 2 && record.samples[1].timeMs <= cutoff) {
      record.samples.shift();
    }

    const first = record.samples[0];
    const last = record.samples[record.samples.length - 1];
    const deltaBytes = first && last ? Math.max(0, last.bytes - first.bytes) : 0;
    const deltaMs = first && last ? Math.max(0, last.timeMs - first.timeMs) : 0;

    if (deltaMs > 0 && deltaBytes > 0) {
      record.bytesPerSecond = Math.round((deltaBytes * 1000) / deltaMs);
    } else {
      record.bytesPerSecond = 0;
    }

    if (
      record.bytesPerSecond > 0 &&
      record.totalBytes > record.bytesTransferred
    ) {
      record.etaSeconds = Math.max(
        1,
        Math.ceil(
          (record.totalBytes - record.bytesTransferred) / record.bytesPerSecond,
        ),
      );
    } else {
      record.etaSeconds = null;
    }
  }

  function registerTransfer({
    transferId,
    fileId,
    fileName,
    totalBytes,
    role,
    direction,
    epoch = 1,
    state = 'requesting',
    bytesTransferred = 0,
    errorCode = null,
    rejectReason = null,
  }) {
    const nowMs = nowFn();
    const record = {
      transferId,
      fileId,
      fileName,
      totalBytes,
      bytesTransferred,
      progressPercent: 0,
      bytesPerSecond: 0,
      etaSeconds: null,
      role,
      directionLabel: role === 'owner' ? 'sending' : 'downloading',
      direction,
      epoch,
      state,
      errorCode,
      rejectReason,
      samples: [{ timeMs: nowMs, bytes: bytesTransferred }],
    };
    recomputeMetrics(record, nowMs);
    transfers.set(transferId, record);
    return freezeSnapshot(record);
  }

  function updateTransfer(transferId, patch = {}) {
    const record = transfers.get(transferId);
    if (!record) {
      return null;
    }

    const prevState = record.state;
    const nowMs = nowFn();

    if (typeof patch.state === 'string') {
      record.state = patch.state;
    }
    if (typeof patch.bytesTransferred === 'number') {
      record.bytesTransferred = Math.max(
        record.bytesTransferred,
        patch.bytesTransferred,
      );
    }
    if (typeof patch.epoch === 'number') {
      record.epoch = patch.epoch;
    }
    if (Object.hasOwn(patch, 'errorCode')) {
      record.errorCode = patch.errorCode;
    }
    if (Object.hasOwn(patch, 'rejectReason')) {
      record.rejectReason = patch.rejectReason;
    }

    if (prevState !== 'active' && record.state === 'active') {
      record.samples = [{ timeMs: nowMs, bytes: record.bytesTransferred }];
    } else if (record.state === 'active') {
      const last = record.samples[record.samples.length - 1];
      if (
        !last ||
        record.bytesTransferred > last.bytes ||
        nowMs > last.timeMs
      ) {
        record.samples.push({ timeMs: nowMs, bytes: record.bytesTransferred });
      }
    }

    recomputeMetrics(record, nowMs);
    return freezeSnapshot(record);
  }

  function getTransfer(transferId) {
    const record = transfers.get(transferId);
    return record ? freezeSnapshot(record) : null;
  }

  function getAllTransfers() {
    return Object.freeze(
      Array.from(transfers.values(), (record) => freezeSnapshot(record)),
    );
  }

  function dispose() {
    transfers.clear();
  }

  return Object.freeze({
    registerTransfer,
    updateTransfer,
    getTransfer,
    getAllTransfers,
    dispose,
  });
}
