import { FIXED_CHUNK_SIZE_BYTES, isValidFileId } from '../crypto/board-metadata.js';
import {
  applyFlowCredit,
  createFlowCreditTracker,
  isValidEpoch,
  isValidNonNegativeSafeInt,
  isValidTransferDirection,
  isValidTransferId,
  validateControlMessage,
} from '../crypto/control-codec.js';

export const CHUNK_SIZE_BYTES = FIXED_CHUNK_SIZE_BYTES;
export const OWNER_CHANNEL_HIGH_WATER_MARK_BYTES = 1_048_576;
export const OWNER_CHANNEL_LOW_WATER_MARK_BYTES = 262_144;

const TERMINAL_STATES = new Set(['completed', 'cancelled', 'failed']);

/**
 * Streams an owner-held local file over shipri-binary in 64 KiB encrypted
 * frames, enforcing cumulative FLOW_CREDIT limits and RTCDataChannel
 * bufferedAmount high/low watermarks independently without holding the file in RAM.
 */
export function createOwnerChunkStreamer({
  roomId,
  masterKeyBytes,
  transferId,
  fileId,
  direction,
  epoch: initialEpoch = 1,
  fileSize,
  lastModified,
  localBoard,
  binaryChannel: initialBinaryChannel,
  cryptoProcessor,
  sendControlMessage,
  startChunkIndex = 0,
  initialCreditOffset = 0,
  onStateChange,
  onError,
} = {}) {
  if (
    !isValidTransferId(transferId) ||
    !isValidFileId(fileId) ||
    !isValidTransferDirection(direction) ||
    !isValidEpoch(initialEpoch) ||
    !isValidNonNegativeSafeInt(fileSize) ||
    !isValidNonNegativeSafeInt(startChunkIndex)
  ) {
    throw new TypeError('Invalid owner streamer configuration parameters.');
  }

  const totalChunks = fileSize === 0 ? 0 : Math.ceil(fileSize / CHUNK_SIZE_BYTES);
  let epoch = initialEpoch;
  let binaryChannel = initialBinaryChannel;
  let creditTracker = createFlowCreditTracker({
    transferId,
    fileId,
    direction,
    epoch,
    initialOffset: initialCreditOffset,
  });

  let disposed = false;
  let state = 'active';
  let errorCode = null;
  let nextChunkIndex = startChunkIndex;
  let bytesSent = Math.min(fileSize, startChunkIndex * CHUNK_SIZE_BYTES);
  let backpressured = false;
  let pumping = false;
  let pumpRequested = false;
  let pendingFrame = null;

  function getBufferedAmount() {
    const value = binaryChannel?.bufferedAmount;
    return typeof value === 'number' && Number.isFinite(value) && value >= 0
      ? value
      : 0;
  }

  function isBufferedAmountHigh() {
    return getBufferedAmount() >= OWNER_CHANNEL_HIGH_WATER_MARK_BYTES;
  }

  function isBufferedAmountLow() {
    return getBufferedAmount() <= OWNER_CHANNEL_LOW_WATER_MARK_BYTES;
  }

  function getState() {
    return Object.freeze({
      transferId,
      fileId,
      direction,
      epoch,
      fileSize,
      totalChunks,
      nextChunkIndex,
      bytesSent,
      maxPlaintextOffsetExclusive: creditTracker.maxPlaintextOffsetExclusive,
      lastCreditSequence: creditTracker.lastSequence,
      backpressured,
      state,
      errorCode,
    });
  }

  function emitState() {
    if (!disposed && typeof onStateChange === 'function') {
      onStateChange(getState());
    }
  }

  function handleBufferedAmountLow() {
    if (disposed || TERMINAL_STATES.has(state)) {
      return;
    }
    if (backpressured && isBufferedAmountLow()) {
      backpressured = false;
      emitState();
      if (state === 'active') {
        schedulePump();
      }
    }
  }

  let cleanupThresholdListener = () => {};
  function bindChannelThresholdListener(targetChannel) {
    cleanupThresholdListener();
    cleanupThresholdListener = () => {};
    if (!targetChannel || typeof targetChannel !== 'object') {
      return;
    }
    try {
      targetChannel.bufferedAmountLowThreshold = OWNER_CHANNEL_LOW_WATER_MARK_BYTES;
    } catch {
      // Ignore read-only test mocks
    }
    if (typeof targetChannel.addEventListener === 'function') {
      targetChannel.addEventListener('bufferedamountlow', handleBufferedAmountLow);
      cleanupThresholdListener = () => {
        targetChannel.removeEventListener(
          'bufferedamountlow',
          handleBufferedAmountLow,
        );
      };
    } else {
      const previousHandler = targetChannel.onbufferedamountlow ?? null;
      targetChannel.onbufferedamountlow = (event) => {
        if (typeof previousHandler === 'function') {
          previousHandler(event);
        }
        handleBufferedAmountLow();
      };
      cleanupThresholdListener = () => {
        if (targetChannel.onbufferedamountlow !== previousHandler) {
          targetChannel.onbufferedamountlow = previousHandler;
        }
      };
    }
  }
  bindChannelThresholdListener(binaryChannel);

  function cleanupTransferResources() {
    pendingFrame = null;
    cleanupThresholdListener();
    cleanupThresholdListener = () => {};
    if (localBoard && typeof localBoard.unregisterActiveTransfer === 'function') {
      localBoard.unregisterActiveTransfer(transferId);
    }
    if (cryptoProcessor && typeof cryptoProcessor.releaseTransfer === 'function') {
      void cryptoProcessor.releaseTransfer(transferId);
    }
  }

  async function failTransfer(code, notifyPeer = true) {
    if (disposed || TERMINAL_STATES.has(state)) {
      return;
    }
    state = 'failed';
    errorCode = code;
    cleanupTransferResources();
    emitState();

    if (typeof onError === 'function') {
      onError({ code, transferId, direction });
    }

    if (notifyPeer && typeof sendControlMessage === 'function') {
      try {
        await sendControlMessage({
          type: 'TRANSFER_ERROR',
          payload: {
            transferId,
            direction,
            code,
          },
        });
      } catch {
        // Ignore control send errors while already failed
      }
    }
  }

  function tryFlushPendingFrame() {
    if (!pendingFrame) {
      return true;
    }
    if (isBufferedAmountHigh()) {
      backpressured = true;
      emitState();
      return false;
    }
    if (pendingFrame.chunkEnd > creditTracker.maxPlaintextOffsetExclusive) {
      return false;
    }
    if (!binaryChannel || binaryChannel.readyState !== 'open') {
      return false;
    }

    try {
      binaryChannel.send(pendingFrame.frameBuffer);
    } catch {
      void failTransfer('INTERNAL_ERROR');
      return false;
    }

    nextChunkIndex = pendingFrame.chunkIndex + 1;
    bytesSent = pendingFrame.chunkEnd;
    pendingFrame = null;
    emitState();
    return true;
  }

  async function pump() {
    if (pumping) {
      pumpRequested = true;
      return;
    }
    pumping = true;

    try {
      do {
        pumpRequested = false;

        while (!disposed && state === 'active') {
          if (pendingFrame) {
            if (!tryFlushPendingFrame()) {
              break;
            }
            continue;
          }

          if (nextChunkIndex >= totalChunks) {
            break;
          }

          if (isBufferedAmountHigh()) {
            backpressured = true;
            emitState();
            break;
          }
          if (backpressured) {
            if (!isBufferedAmountLow()) {
              break;
            }
            backpressured = false;
            emitState();
          }

          const chunkStart = nextChunkIndex * CHUNK_SIZE_BYTES;
          const chunkEnd = Math.min(fileSize, chunkStart + CHUNK_SIZE_BYTES);
          const expectedLength = chunkEnd - chunkStart;
          const isFinalChunk = nextChunkIndex === totalChunks - 1;

          if (chunkEnd > creditTracker.maxPlaintextOffsetExclusive) {
            break;
          }

          const resolved = localBoard?.resolveFileForTransfer?.(
            transferId,
            fileId,
          );
          const resolvedFile = resolved?.file;
          const resolvedLastMod = Number.isFinite(resolvedFile?.lastModified)
            ? resolvedFile.lastModified
            : 0;
          const baselineLastMod =
            lastModified !== undefined
              ? lastModified
              : resolved?.lastModified ?? 0;

          if (
            !resolvedFile ||
            resolvedFile.size !== fileSize ||
            resolvedLastMod !== baselineLastMod
          ) {
            await failTransfer('FILE_UNREADABLE');
            break;
          }

          let sliceBuffer;
          try {
            const sliceBlob = resolvedFile.slice(chunkStart, chunkEnd);
            sliceBuffer = await sliceBlob.arrayBuffer();
            if (
              !(sliceBuffer instanceof ArrayBuffer) ||
              sliceBuffer.byteLength !== expectedLength
            ) {
              throw new Error('Unexpected chunk byte length.');
            }
          } catch {
            await failTransfer('FILE_UNREADABLE');
            break;
          }

          if (disposed || TERMINAL_STATES.has(state)) {
            break;
          }
          const postSliceLastMod = Number.isFinite(resolvedFile.lastModified)
            ? resolvedFile.lastModified
            : 0;
          if (
            resolvedFile.size !== fileSize ||
            postSliceLastMod !== baselineLastMod
          ) {
            await failTransfer('FILE_UNREADABLE');
            break;
          }

          let encrypted;
          try {
            encrypted = await cryptoProcessor.encryptChunk({
              masterKeyBytes,
              roomId,
              transferId,
              fileId,
              direction,
              epoch,
              chunkIndex: nextChunkIndex,
              plaintextBuffer: sliceBuffer,
              isFinalChunk,
            });
          } catch {
            await failTransfer('INTERNAL_ERROR');
            break;
          }

          if (!encrypted?.ok || !(encrypted.frameBuffer instanceof ArrayBuffer)) {
            await failTransfer('INTERNAL_ERROR');
            break;
          }

          if (disposed || TERMINAL_STATES.has(state)) {
            break;
          }

          pendingFrame = {
            chunkIndex: nextChunkIndex,
            chunkEnd,
            frameBuffer: encrypted.frameBuffer,
          };

          if (state !== 'active') {
            break;
          }

          if (!tryFlushPendingFrame()) {
            break;
          }
        }
      } while (pumpRequested && !disposed && state === 'active');
    } finally {
      pumping = false;
    }
  }

  function schedulePump() {
    if (!disposed && state === 'active') {
      void pump();
    }
  }

  function handleFlowCredit(message) {
    if (disposed || TERMINAL_STATES.has(state)) {
      return { accepted: false, reason: 'TERMINAL_STATE' };
    }
    const result = applyFlowCredit(creditTracker, message);
    if (!result.accepted) {
      return result;
    }
    emitState();
    schedulePump();
    return result;
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
      pendingFrame = null;
      backpressured = false;
    }
    if (state === nextState) {
      return true;
    }
    state = nextState;
    emitState();
    return true;
  }

  function resume() {
    if (disposed || state !== 'paused_by_user') {
      return false;
    }
    state = 'active';
    emitState();
    schedulePump();
    return true;
  }

  function rotateEpochAndResume({
    nextEpoch,
    resumeFromChunkIndex,
    binaryChannel: nextChannel,
  } = {}) {
    if (
      disposed ||
      TERMINAL_STATES.has(state) ||
      !isValidEpoch(nextEpoch) ||
      nextEpoch <= epoch ||
      !Number.isInteger(resumeFromChunkIndex) ||
      resumeFromChunkIndex < 0 ||
      resumeFromChunkIndex > totalChunks
    ) {
      return false;
    }

    pendingFrame = null;
    backpressured = false;
    if (cryptoProcessor && typeof cryptoProcessor.releaseTransfer === 'function') {
      void cryptoProcessor.releaseTransfer(transferId);
    }
    if (nextChannel !== undefined) {
      binaryChannel = nextChannel;
      bindChannelThresholdListener(binaryChannel);
    }

    epoch = nextEpoch;
    nextChunkIndex = resumeFromChunkIndex;
    bytesSent = Math.min(fileSize, resumeFromChunkIndex * CHUNK_SIZE_BYTES);
    creditTracker = createFlowCreditTracker({
      transferId,
      fileId,
      direction,
      epoch: nextEpoch,
      initialOffset: bytesSent,
    });
    state = 'active';
    emitState();
    return true;
  }

  function cancel() {
    if (disposed || TERMINAL_STATES.has(state)) {
      return false;
    }
    state = 'cancelled';
    cleanupTransferResources();
    emitState();
    return true;
  }

  function handleTransferComplete(message) {
    if (disposed || TERMINAL_STATES.has(state)) {
      return false;
    }
    const validated = validateControlMessage(message);
    if (!validated.ok || message.type !== 'TRANSFER_COMPLETE') {
      return false;
    }
    const { payload } = message;
    if (
      payload.transferId !== transferId ||
      payload.fileId !== fileId ||
      payload.direction !== direction ||
      payload.epoch !== epoch ||
      payload.totalPersistedBytes !== fileSize
    ) {
      return false;
    }
    state = 'completed';
    cleanupTransferResources();
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
    cleanupTransferResources();
  }

  return Object.freeze({
    handleFlowCredit,
    pause,
    resume,
    rotateEpochAndResume,
    cancel,
    handleTransferComplete,
    failExternal,
    triggerPump: schedulePump,
    getState,
    dispose,
  });
}
