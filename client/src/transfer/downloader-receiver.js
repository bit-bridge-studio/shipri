import {
  BINARY_FRAME_HEADER_BYTES,
  MAX_PLAINTEXT_CHUNK_BYTES,
  decodeBinaryFrameHeader,
  resolveDirectionCode,
} from '../crypto/binary-framing.js';
import { isValidFileId } from '../crypto/board-metadata.js';
import {
  isValidEpoch,
  isValidNonNegativeSafeInt,
  isValidTransferDirection,
  isValidTransferId,
} from '../crypto/control-codec.js';

export const RECEIVER_INITIAL_CREDIT_WINDOW_BYTES = 2_097_152;
export const MAX_IN_FLIGHT_BYTES = 2_097_152;
export const RECEIVER_CREDIT_GRANT_STEP_BYTES = 524_288;
export const RECEIVER_MAX_QUEUED_BYTES = 4_194_304;

const AES_GCM_TAG_BYTES = 16;
const TERMINAL_STATES = new Set(['completed', 'cancelled', 'failed']);

function resolveFrameArrayBuffer(frameBuffer) {
  if (frameBuffer instanceof ArrayBuffer) {
    return frameBuffer;
  }
  if (ArrayBuffer.isView(frameBuffer)) {
    if (
      frameBuffer.byteOffset === 0 &&
      frameBuffer.byteLength === frameBuffer.buffer.byteLength
    ) {
      return frameBuffer.buffer;
    }
    return frameBuffer.buffer.slice(
      frameBuffer.byteOffset,
      frameBuffer.byteOffset + frameBuffer.byteLength,
    );
  }
  return null;
}

/**
 * Receives encrypted binary frames for a single transfer, enforces a strict
 * byte-bounded decrypt/write queue and cumulative FLOW_CREDIT window driven
 * by actual persisted bytes, and writes directly to the File System Access target.
 */
export function createDownloaderReceiver({
  roomId,
  masterKeyBytes,
  transferId,
  fileId,
  direction,
  epoch = 1,
  fileSize,
  persistenceTarget,
  cryptoProcessor,
  sendControlMessage,
  initialPersistedChunkIndex = -1,
  initialPersistedBytes = 0,
  onStateChange,
  onError,
} = {}) {
  if (
    !isValidTransferId(transferId) ||
    !isValidFileId(fileId) ||
    !isValidTransferDirection(direction) ||
    !isValidEpoch(epoch) ||
    !isValidNonNegativeSafeInt(fileSize) ||
    !isValidNonNegativeSafeInt(initialPersistedBytes) ||
    !persistenceTarget ||
    typeof persistenceTarget.write !== 'function' ||
    typeof persistenceTarget.close !== 'function' ||
    typeof persistenceTarget.abort !== 'function'
  ) {
    throw new TypeError('Invalid downloader receiver configuration parameters.');
  }

  const expectedDirectionCode = resolveDirectionCode(direction);
  const totalChunks =
    fileSize === 0 ? 0 : Math.ceil(fileSize / MAX_PLAINTEXT_CHUNK_BYTES);

  let disposed = false;
  let failing = false;
  let activated = false;
  let epochRotated = false;
  let currentEpoch = epoch;
  let state = 'requesting';
  let errorCode = null;
  let nextExpectedChunkIndex = initialPersistedChunkIndex + 1;
  let lastPersistedChunkIndex = initialPersistedChunkIndex;
  let lastPersistedPlaintextOffset = initialPersistedBytes;
  let grantedMaxPlaintextOffsetExclusive = initialPersistedBytes;
  let creditSequence = 0;
  let queuedBytes = 0;
  let queuedFrames = 0;
  let maxObservedQueuedBytes = 0;
  let maxObservedInFlightBudget = 0;
  let writeQueue = Promise.resolve();

  function getState() {
    return Object.freeze({
      transferId,
      fileId,
      direction,
      epoch: currentEpoch,
      fileSize,
      totalChunks,
      nextExpectedChunkIndex,
      lastPersistedChunkIndex,
      lastPersistedPlaintextOffset,
      bytesReceived: lastPersistedPlaintextOffset,
      grantedMaxPlaintextOffsetExclusive,
      creditSequence,
      queuedBytes,
      queuedFrames,
      maxObservedQueuedBytes,
      maxObservedInFlightBudget,
      state,
      errorCode,
    });
  }

  function emitState() {
    if (!disposed && typeof onStateChange === 'function') {
      onStateChange(getState());
    }
  }

  async function safeSendControl(message) {
    if (disposed || typeof sendControlMessage !== 'function') {
      return;
    }
    try {
      await sendControlMessage(message);
    } catch {
      // Ignore send errors if channel is torn down
    }
  }

  function releaseProcessor() {
    if (cryptoProcessor && typeof cryptoProcessor.releaseTransfer === 'function') {
      void cryptoProcessor.releaseTransfer(transferId);
    }
  }

  async function abortTargetSafely() {
    if (persistenceTarget && typeof persistenceTarget.abort === 'function') {
      await persistenceTarget.abort().catch(() => {});
    }
  }

  async function failTransfer(code, notifyPeer = true) {
    if (disposed || failing || TERMINAL_STATES.has(state)) {
      return;
    }
    failing = true;
    errorCode = code;
    queuedBytes = 0;
    queuedFrames = 0;
    releaseProcessor();

    await Promise.all([
      abortTargetSafely(),
      notifyPeer
        ? safeSendControl({
            type: 'TRANSFER_ERROR',
            payload: {
              transferId,
              direction,
              code,
            },
          })
        : Promise.resolve(),
    ]);

    if (disposed) {
      return;
    }
    state = 'failed';
    emitState();

    if (typeof onError === 'function') {
      onError({ code, transferId, direction });
    }
  }

  function trackBudgetWatermark() {
    const budget = Math.max(
      0,
      grantedMaxPlaintextOffsetExclusive - lastPersistedPlaintextOffset,
    );
    if (budget > maxObservedInFlightBudget) {
      maxObservedInFlightBudget = budget;
    }
  }

  async function issueCreditWindow(forceInitial = false) {
    if (disposed || TERMINAL_STATES.has(state) || state !== 'active') {
      return;
    }
    const candidateLimit = Math.min(
      fileSize,
      lastPersistedPlaintextOffset + RECEIVER_INITIAL_CREDIT_WINDOW_BYTES,
    );
    if (candidateLimit <= grantedMaxPlaintextOffsetExclusive) {
      return;
    }

    const deltaFromGranted = candidateLimit - grantedMaxPlaintextOffsetExclusive;
    const remainingWindow =
      grantedMaxPlaintextOffsetExclusive - lastPersistedPlaintextOffset;
    const shouldGrant =
      forceInitial ||
      deltaFromGranted >= RECEIVER_CREDIT_GRANT_STEP_BYTES ||
      remainingWindow <= RECEIVER_INITIAL_CREDIT_WINDOW_BYTES / 2 ||
      candidateLimit === fileSize;

    if (!shouldGrant) {
      return;
    }

    creditSequence += 1;
    grantedMaxPlaintextOffsetExclusive = candidateLimit;
    trackBudgetWatermark();
    emitState();

    await safeSendControl({
      type: 'FLOW_CREDIT',
      payload: {
        transferId,
        fileId,
        direction,
        epoch: currentEpoch,
        sequence: creditSequence,
        maxPlaintextOffsetExclusive: grantedMaxPlaintextOffsetExclusive,
      },
    });
  }

  async function activate() {
    if (disposed || TERMINAL_STATES.has(state)) {
      return { ok: false, code: 'TERMINAL_STATE' };
    }
    activated = true;

    if (fileSize === 0 || lastPersistedPlaintextOffset >= fileSize) {
      try {
        await persistenceTarget.close();
      } catch {
        await failTransfer('PERSISTENCE_FAILED');
        return { ok: false, code: 'PERSISTENCE_FAILED' };
      }
      state = 'completed';
      releaseProcessor();
      emitState();
      await safeSendControl({
        type: 'TRANSFER_COMPLETE',
        payload: {
          transferId,
          fileId,
          direction,
          epoch: currentEpoch,
          totalPersistedBytes: lastPersistedPlaintextOffset,
        },
      });
      return { ok: true, state: getState() };
    }

    state = 'active';
    emitState();
    await issueCreditWindow(true);
    return { ok: true, state: getState() };
  }

  async function persistChunk({
    frameBuffer,
    chunkIndex,
    chunkEndOffset,
    plaintextLength,
    epochAtReceive,
  }) {
    if (
      disposed ||
      failing ||
      TERMINAL_STATES.has(state) ||
      state === 'paused_reconnecting' ||
      epochAtReceive !== currentEpoch
    ) {
      return;
    }

    let decrypted;
    try {
      decrypted = await cryptoProcessor.decryptChunk({
        masterKeyBytes,
        roomId,
        expectedTransferId: transferId,
        expectedFileId: fileId,
        expectedDirection: direction,
        expectedEpoch: epochAtReceive,
        expectedChunkIndex: chunkIndex,
        frameBuffer,
      });
    } catch {
      await failTransfer('AUTH_FAILED');
      return;
    }

    if (
      disposed ||
      failing ||
      TERMINAL_STATES.has(state) ||
      state === 'paused_reconnecting' ||
      epochAtReceive !== currentEpoch
    ) {
      return;
    }

    if (!decrypted?.ok || !decrypted.plaintextBytes) {
      const code =
        decrypted?.code === 'INVALID_FRAME' ? 'INVALID_FRAME' : 'AUTH_FAILED';
      await failTransfer(code);
      return;
    }

    if (decrypted.plaintextBytes.byteLength !== plaintextLength) {
      await failTransfer('INVALID_FRAME');
      return;
    }

    try {
      await persistenceTarget.write(decrypted.plaintextBytes);
    } catch (err) {
      const code =
        err?.name === 'QuotaExceededError'
          ? 'QUOTA_EXCEEDED'
          : 'PERSISTENCE_FAILED';
      await failTransfer(code);
      return;
    }

    if (
      disposed ||
      failing ||
      TERMINAL_STATES.has(state) ||
      epochAtReceive !== currentEpoch
    ) {
      return;
    }

    queuedBytes = Math.max(0, queuedBytes - plaintextLength);
    queuedFrames = Math.max(0, queuedFrames - 1);
    lastPersistedChunkIndex = chunkIndex;
    lastPersistedPlaintextOffset = chunkEndOffset;
    if (state === 'paused_reconnecting') {
      nextExpectedChunkIndex = lastPersistedChunkIndex + 1;
    }
    emitState();

    if (lastPersistedPlaintextOffset === fileSize) {
      try {
        await persistenceTarget.close();
      } catch {
        await failTransfer('PERSISTENCE_FAILED');
        return;
      }
      if (disposed || TERMINAL_STATES.has(state)) {
        return;
      }
      state = 'completed';
      releaseProcessor();
      emitState();
      await safeSendControl({
        type: 'TRANSFER_COMPLETE',
        payload: {
          transferId,
          fileId,
          direction,
          epoch: currentEpoch,
          totalPersistedBytes: fileSize,
        },
      });
      return;
    }

    await issueCreditWindow(false);
  }

  function handleBinaryFrame(rawFrame) {
    if (
      disposed ||
      failing ||
      TERMINAL_STATES.has(state) ||
      state === 'paused_reconnecting'
    ) {
      return { ok: true, ignored: true };
    }
    if (!activated) {
      void failTransfer('FLOW_CREDIT_EXCEEDED');
      return { ok: false, code: 'FLOW_CREDIT_EXCEEDED' };
    }

    const frameBuffer = resolveFrameArrayBuffer(rawFrame);
    if (!frameBuffer) {
      void failTransfer('INVALID_FRAME');
      return { ok: false, code: 'INVALID_FRAME' };
    }

    const header = decodeBinaryFrameHeader(frameBuffer);
    if (!header.ok) {
      void failTransfer('INVALID_FRAME');
      return { ok: false, code: 'INVALID_FRAME' };
    }

    const expectedTotalBytes =
      BINARY_FRAME_HEADER_BYTES + header.plaintextLength + AES_GCM_TAG_BYTES;
    if (frameBuffer.byteLength !== expectedTotalBytes) {
      void failTransfer('INVALID_FRAME');
      return { ok: false, code: 'INVALID_FRAME' };
    }

    if (
      header.transferId !== transferId ||
      header.fileId !== fileId ||
      header.directionCode !== expectedDirectionCode
    ) {
      void failTransfer('INVALID_FRAME');
      return { ok: false, code: 'INVALID_FRAME' };
    }

    if (header.epoch !== currentEpoch) {
      if (epochRotated && header.epoch < currentEpoch) {
        return { ok: true, ignored: true };
      }
      void failTransfer('EPOCH_MISMATCH');
      return { ok: false, code: 'EPOCH_MISMATCH' };
    }

    if (totalChunks === 0 || header.chunkIndex >= totalChunks) {
      void failTransfer('INVALID_FRAME');
      return { ok: false, code: 'INVALID_FRAME' };
    }

    if (header.chunkIndex !== nextExpectedChunkIndex) {
      void failTransfer('INVALID_FRAME');
      return { ok: false, code: 'INVALID_FRAME' };
    }

    const expectedStart = header.chunkIndex * MAX_PLAINTEXT_CHUNK_BYTES;
    const expectedEnd = Math.min(fileSize, expectedStart + MAX_PLAINTEXT_CHUNK_BYTES);
    const expectedPlaintextLen = expectedEnd - expectedStart;
    const expectedIsFinal = header.chunkIndex === totalChunks - 1;

    if (
      header.plaintextLength !== expectedPlaintextLen ||
      header.isFinalChunk !== expectedIsFinal
    ) {
      void failTransfer('INVALID_FRAME');
      return { ok: false, code: 'INVALID_FRAME' };
    }

    if (expectedEnd > grantedMaxPlaintextOffsetExclusive) {
      void failTransfer('FLOW_CREDIT_EXCEEDED');
      return { ok: false, code: 'FLOW_CREDIT_EXCEEDED' };
    }

    if (queuedBytes + header.plaintextLength > RECEIVER_MAX_QUEUED_BYTES) {
      void failTransfer('FLOW_CREDIT_EXCEEDED');
      return { ok: false, code: 'FLOW_CREDIT_EXCEEDED' };
    }

    nextExpectedChunkIndex += 1;
    queuedBytes += header.plaintextLength;
    queuedFrames += 1;
    if (queuedBytes > maxObservedQueuedBytes) {
      maxObservedQueuedBytes = queuedBytes;
    }
    emitState();

    const epochAtReceive = currentEpoch;
    writeQueue = writeQueue.then(
      () =>
        persistChunk({
          frameBuffer,
          chunkIndex: header.chunkIndex,
          chunkEndOffset: expectedEnd,
          plaintextLength: header.plaintextLength,
          epochAtReceive,
        }),
      () =>
        persistChunk({
          frameBuffer,
          chunkIndex: header.chunkIndex,
          chunkEndOffset: expectedEnd,
          plaintextLength: header.plaintextLength,
          epochAtReceive,
        }),
    );

    return { ok: true, queuedChunkIndex: header.chunkIndex };
  }

  function pause(nextState = 'paused_by_user') {
    if (
      disposed ||
      TERMINAL_STATES.has(state) ||
      (nextState !== 'paused_by_user' && nextState !== 'paused_reconnecting')
    ) {
      return false;
    }
    if (nextState === 'paused_reconnecting') {
      queuedBytes = 0;
      queuedFrames = 0;
      nextExpectedChunkIndex = lastPersistedChunkIndex + 1;
    }
    if (state === nextState) {
      return true;
    }
    state = nextState;
    emitState();
    return true;
  }

  async function resume() {
    if (disposed || state !== 'paused_by_user') {
      return false;
    }
    state = 'active';
    emitState();
    await issueCreditWindow(false);
    return true;
  }

  async function rotateEpochAndResume(nextEpoch) {
    if (
      disposed ||
      TERMINAL_STATES.has(state) ||
      !isValidEpoch(nextEpoch) ||
      nextEpoch <= currentEpoch
    ) {
      return false;
    }
    releaseProcessor();
    epochRotated = true;
    currentEpoch = nextEpoch;
    creditSequence = 0;
    queuedBytes = 0;
    queuedFrames = 0;
    nextExpectedChunkIndex = lastPersistedChunkIndex + 1;
    grantedMaxPlaintextOffsetExclusive = lastPersistedPlaintextOffset;
    state = 'active';
    emitState();
    await issueCreditWindow(true);
    return true;
  }

  function waitForWriteQueue() {
    return writeQueue.catch(() => {});
  }

  async function cancel() {
    if (disposed || TERMINAL_STATES.has(state)) {
      return false;
    }
    state = 'cancelled';
    queuedBytes = 0;
    queuedFrames = 0;
    await abortTargetSafely();
    releaseProcessor();
    emitState();
    return true;
  }

  function failExternal(code = 'INTERNAL_ERROR') {
    return failTransfer(code, false);
  }

  function dispose() {
    if (disposed) {
      return;
    }
    disposed = true;
    queuedBytes = 0;
    queuedFrames = 0;
    void abortTargetSafely();
    releaseProcessor();
  }

  return Object.freeze({
    activate,
    handleBinaryFrame,
    pause,
    resume,
    rotateEpochAndResume,
    waitForWriteQueue,
    cancel,
    failExternal,
    getState,
    dispose,
  });
}
