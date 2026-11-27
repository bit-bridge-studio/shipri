import { decodeBinaryFrameHeader } from '../crypto/binary-framing.js';
import { FIXED_CHUNK_SIZE_BYTES } from '../crypto/board-metadata.js';
import {
  isValidMemberId,
  validateControlMessage,
} from '../crypto/control-codec.js';
import { createChunkCryptoProcessor } from '../workers/chunk-worker-client.js';
import { createDownloaderReceiver } from './downloader-receiver.js';
import { createDownloadNegotiator } from './download-negotiator.js';
import { createOwnerChunkStreamer } from './owner-streamer.js';
import { createTransferProgressTracker } from './transfer-progress.js';

const TERMINAL_STATES = new Set([
  'completed',
  'cancelled',
  'failed',
  'rejected',
]);

function parseDirectionMembers(direction) {
  const parts = typeof direction === 'string' ? direction.split('->') : [];
  if (parts.length !== 2) {
    return null;
  }
  return {
    ownerMemberId: parts[0],
    downloaderMemberId: parts[1],
  };
}

/**
 * Orchestrates independent per-transferId upload and download state machines across
 * equal peers, demultiplexing shipri-binary frames by transferId and isolating
 * progress, speed/ETA, pause/resume, cancellation, and failures across directions.
 */
export function createTransferCoordinator({
  roomId,
  masterKeyBytes,
  localMemberId,
  getRemoteMemberId,
  localBoard,
  remoteBoard,
  getBinaryChannel,
  sendControlMessage,
  cryptoProcessor: providedCryptoProcessor,
  windowObj = globalThis.window,
  navigatorObj = globalThis.navigator,
  graceWindowMs = 60_000,
  setTimeoutFn = globalThis.setTimeout,
  clearTimeoutFn = globalThis.clearTimeout,
  nowFn = Date.now,
  onChange,
  onError,
} = {}) {
  if (!isValidMemberId(localMemberId)) {
    throw new TypeError('Expected a valid 16-byte base64url localMemberId.');
  }

  let disposed = false;
  let disconnectGraceTimer = null;
  const cryptoProcessor =
    providedCryptoProcessor ?? createChunkCryptoProcessor();
  const ownsCryptoProcessor = !providedCryptoProcessor;

  const progressTracker = createTransferProgressTracker({ nowFn });
  const ownerStreamers = new Map();
  const downloaderReceivers = new Map();
  const pendingResumeEpochs = new Map();

  function cancelDisconnectGraceTimer() {
    if (disconnectGraceTimer !== null) {
      clearTimeoutFn(disconnectGraceTimer);
      disconnectGraceTimer = null;
    }
  }

  function emitChange() {
    if (!disposed && typeof onChange === 'function') {
      onChange(progressTracker.getAllTransfers());
    }
  }

  function emitError(error) {
    if (!disposed && typeof onError === 'function') {
      onError(error);
    }
  }

  function getRemoteId() {
    return typeof getRemoteMemberId === 'function' ? getRemoteMemberId() : null;
  }

  function getActiveBinaryChannel() {
    return typeof getBinaryChannel === 'function' ? getBinaryChannel() : null;
  }

  async function safeSendControl(message) {
    if (disposed || typeof sendControlMessage !== 'function') {
      return;
    }
    await sendControlMessage(message);
  }

  const negotiator = createDownloadNegotiator({
    localMemberId,
    getRemoteMemberId,
    remoteBoard,
    localBoard,
    sendControlMessage,
    windowObj,
    navigatorObj,
    onError,
    onSessionChange: (sessions) => {
      for (const session of sessions) {
        const existing = progressTracker.getTransfer(session.transferId);
        if (!existing) {
          progressTracker.registerTransfer({
            transferId: session.transferId,
            fileId: session.fileId,
            fileName: session.fileName,
            totalBytes: session.fileSize,
            role: session.role,
            direction: session.direction,
            epoch: session.epoch,
            state: session.state,
            errorCode: session.errorCode,
            rejectReason: session.rejectReason,
          });
        } else if (
          !TERMINAL_STATES.has(existing.state) ||
          session.state === existing.state
        ) {
          progressTracker.updateTransfer(session.transferId, {
            state: session.state,
            epoch: session.epoch,
            errorCode: session.errorCode,
            rejectReason: session.rejectReason,
          });
        }
      }
      emitChange();
    },
    onOutgoingAccepted: async (session) => {
      if (disposed) {
        return;
      }
      const resolved = localBoard?.resolveFileForTransfer?.(
        session.transferId,
        session.fileId,
      );
      const streamer = createOwnerChunkStreamer({
        roomId,
        masterKeyBytes,
        transferId: session.transferId,
        fileId: session.fileId,
        direction: session.direction,
        epoch: session.epoch,
        fileSize: session.fileSize,
        lastModified: resolved?.lastModified,
        localBoard,
        binaryChannel: getActiveBinaryChannel(),
        cryptoProcessor,
        sendControlMessage,
        onError,
        onStateChange: (streamerState) => {
          negotiator.updateSessionState(session.transferId, streamerState.state, {
            epoch: streamerState.epoch,
            errorCode: streamerState.errorCode,
          });
          progressTracker.updateTransfer(session.transferId, {
            state: streamerState.state,
            bytesTransferred: streamerState.bytesSent,
            epoch: streamerState.epoch,
            errorCode: streamerState.errorCode,
          });
          emitChange();
        },
      });
      ownerStreamers.set(session.transferId, streamer);
      progressTracker.registerTransfer({
        transferId: session.transferId,
        fileId: session.fileId,
        fileName: session.fileName,
        totalBytes: session.fileSize,
        role: 'owner',
        direction: session.direction,
        epoch: session.epoch,
        state: 'active',
        bytesTransferred: 0,
      });
      emitChange();
    },
    onDownloadAccepted: async (session, persistenceTarget) => {
      if (disposed) {
        return;
      }
      const receiver = createDownloaderReceiver({
        roomId,
        masterKeyBytes,
        transferId: session.transferId,
        fileId: session.fileId,
        direction: session.direction,
        epoch: session.epoch,
        fileSize: session.fileSize,
        persistenceTarget,
        cryptoProcessor,
        sendControlMessage,
        onError,
        onStateChange: (rxState) => {
          negotiator.updateSessionState(session.transferId, rxState.state, {
            epoch: rxState.epoch,
            errorCode: rxState.errorCode,
          });
          progressTracker.updateTransfer(session.transferId, {
            state: rxState.state,
            bytesTransferred: rxState.lastPersistedPlaintextOffset,
            epoch: rxState.epoch,
            errorCode: rxState.errorCode,
          });
          emitChange();
        },
      });
      downloaderReceivers.set(session.transferId, receiver);
      progressTracker.updateTransfer(session.transferId, {
        state: 'active',
        epoch: session.epoch,
      });
      emitChange();
      await receiver.activate();
    },
  });

  function getActor(transferId) {
    const streamer = ownerStreamers.get(transferId);
    if (streamer) {
      return { role: 'owner', actor: streamer };
    }
    const receiver = downloaderReceivers.get(transferId);
    if (receiver) {
      return { role: 'downloader', actor: receiver };
    }
    return null;
  }

  function verifyCounterparty(direction, senderMemberId) {
    const members = parseDirectionMembers(direction);
    if (!members || !isValidMemberId(senderMemberId)) {
      return false;
    }
    if (senderMemberId === localMemberId) {
      return false;
    }
    return (
      (localMemberId === members.ownerMemberId &&
        senderMemberId === members.downloaderMemberId) ||
      (localMemberId === members.downloaderMemberId &&
        senderMemberId === members.ownerMemberId)
    );
  }

  function handleBinaryFrame(frameBuffer) {
    if (disposed) {
      return { ok: true, ignored: true };
    }
    const header = decodeBinaryFrameHeader(frameBuffer);
    if (!header.ok) {
      emitError({ code: 'INVALID_FRAME' });
      return { ok: false, code: 'INVALID_FRAME' };
    }

    const receiver = downloaderReceivers.get(header.transferId);
    if (receiver) {
      return receiver.handleBinaryFrame(frameBuffer);
    }

    const tracked = progressTracker.getTransfer(header.transferId);
    if (tracked && tracked.role === 'downloader' && TERMINAL_STATES.has(tracked.state)) {
      return { ok: true, ignored: true };
    }

    emitError({ code: 'INVALID_FRAME', transferId: header.transferId });
    return { ok: false, code: 'INVALID_FRAME' };
  }

  async function handleControlMessage(message, senderMemberId) {
    if (disposed) {
      return { ok: false, code: 'DISPOSED' };
    }
    const validated = validateControlMessage(message);
    if (!validated.ok) {
      if (message?.type === 'DOWNLOAD_REQUEST') {
        return negotiator.handleControlMessage(message, senderMemberId);
      }
      emitError({ code: validated.code });
      return { ok: false, code: validated.code };
    }

    const { type, payload } = message;

    if (
      type === 'DOWNLOAD_REQUEST' ||
      type === 'DOWNLOAD_ACCEPTED' ||
      type === 'DOWNLOAD_REJECTED'
    ) {
      return negotiator.handleControlMessage(message, senderMemberId);
    }

    if (type === 'FLOW_CREDIT') {
      const streamer = ownerStreamers.get(payload.transferId);
      if (!streamer) {
        return { ok: true, ignored: true };
      }
      if (!verifyCounterparty(payload.direction, senderMemberId)) {
        return { ok: false, code: 'SENDER_MISMATCH' };
      }
      return streamer.handleFlowCredit(message);
    }

    if (type === 'TRANSFER_PAUSE') {
      const found = getActor(payload.transferId);
      if (!found || !verifyCounterparty(payload.direction, senderMemberId)) {
        return { ok: true, ignored: true };
      }
      const actorState = found.actor.getState();
      if (
        actorState.direction !== payload.direction ||
        actorState.epoch !== payload.epoch
      ) {
        return { ok: true, ignored: true };
      }
      found.actor.pause('paused_by_user');
      negotiator.updateSessionState(payload.transferId, 'paused_by_user');
      progressTracker.updateTransfer(payload.transferId, {
        state: 'paused_by_user',
      });
      emitChange();
      return { ok: true };
    }

    if (type === 'TRANSFER_RESUME') {
      const found = getActor(payload.transferId);
      if (!found || !verifyCounterparty(payload.direction, senderMemberId)) {
        return { ok: true, ignored: true };
      }
      const actorState = found.actor.getState();
      if (
        actorState.direction !== payload.direction ||
        actorState.epoch !== payload.epoch
      ) {
        return { ok: true, ignored: true };
      }
      await found.actor.resume();
      negotiator.updateSessionState(payload.transferId, 'active');
      progressTracker.updateTransfer(payload.transferId, {
        state: 'active',
      });
      emitChange();
      return { ok: true };
    }

    if (type === 'TRANSFER_CANCEL') {
      const found = getActor(payload.transferId);
      if (found) {
        if (!verifyCounterparty(payload.direction, senderMemberId)) {
          return { ok: false, code: 'SENDER_MISMATCH' };
        }
        pendingResumeEpochs.delete(payload.transferId);
        await found.actor.cancel();
        negotiator.updateSessionState(payload.transferId, 'cancelled', {
          clearPersistenceTarget: true,
        });
        progressTracker.updateTransfer(payload.transferId, {
          state: 'cancelled',
        });
        emitChange();
        return { ok: true };
      }

      const pendingSession = negotiator.getSession(payload.transferId);
      if (
        pendingSession &&
        pendingSession.state === 'requesting' &&
        verifyCounterparty(payload.direction, senderMemberId)
      ) {
        negotiator.updateSessionState(payload.transferId, 'cancelled', {
          abortPersistenceTarget: true,
        });
        progressTracker.updateTransfer(payload.transferId, {
          state: 'cancelled',
        });
        emitChange();
      }
      return { ok: true, ignored: !pendingSession };
    }

    if (type === 'TRANSFER_COMPLETE') {
      const streamer = ownerStreamers.get(payload.transferId);
      if (!streamer || !verifyCounterparty(payload.direction, senderMemberId)) {
        return { ok: true, ignored: true };
      }
      const ok = streamer.handleTransferComplete(message);
      if (ok) {
        negotiator.updateSessionState(payload.transferId, 'completed');
        progressTracker.updateTransfer(payload.transferId, {
          state: 'completed',
          bytesTransferred: streamer.getState().fileSize,
        });
        emitChange();
      }
      return { ok };
    }

    if (type === 'TRANSFER_ERROR') {
      const found = getActor(payload.transferId);
      if (!found || !verifyCounterparty(payload.direction, senderMemberId)) {
        return { ok: true, ignored: true };
      }
      pendingResumeEpochs.delete(payload.transferId);
      await found.actor.failExternal(payload.code);
      negotiator.updateSessionState(payload.transferId, 'failed', {
        errorCode: payload.code,
      });
      progressTracker.updateTransfer(payload.transferId, {
        state: 'failed',
        errorCode: payload.code,
      });
      emitError({
        code: payload.code,
        transferId: payload.transferId,
        direction: payload.direction,
      });
      emitChange();
      return { ok: true };
    }

    if (type === 'RESUME_REQUEST') {
      const members = parseDirectionMembers(payload.direction);
      if (
        !members ||
        !verifyCounterparty(payload.direction, senderMemberId) ||
        senderMemberId !== members.downloaderMemberId
      ) {
        return { ok: false, code: 'SENDER_MISMATCH' };
      }

      const streamer = ownerStreamers.get(payload.transferId);
      const stState = streamer?.getState?.();
      if (!streamer || !stState || TERMINAL_STATES.has(stState.state)) {
        try {
          await safeSendControl({
            type: 'RESUME_REJECTED',
            payload: {
              transferId: payload.transferId,
              fileId: payload.fileId,
              reason: 'NOT_FOUND',
            },
          });
        } catch {
          // Ignore send failures
        }
        return { ok: false, code: 'NOT_FOUND' };
      }

      const expectedBytes =
        payload.lastPersistedChunkIndex === -1
          ? 0
          : payload.lastPersistedChunkIndex < stState.totalChunks
            ? Math.min(
                stState.fileSize,
                (payload.lastPersistedChunkIndex + 1) * FIXED_CHUNK_SIZE_BYTES,
              )
            : -1;

      if (
        payload.fileId !== stState.fileId ||
        payload.direction !== stState.direction ||
        payload.nextEpoch <= stState.epoch ||
        payload.persistedPlaintextBytes !== expectedBytes
      ) {
        try {
          await safeSendControl({
            type: 'RESUME_REJECTED',
            payload: {
              transferId: payload.transferId,
              fileId: payload.fileId,
              reason: 'INVALID_EPOCH',
            },
          });
        } catch {
          // Ignore send failures
        }
        return { ok: false, code: 'INVALID_EPOCH' };
      }

      const readable = await localBoard.verifyLocalFileReadable(payload.fileId);
      if (disposed || streamer.getState().epoch >= payload.nextEpoch) {
        return { ok: false, code: 'INVALID_EPOCH' };
      }

      if (!readable?.ok) {
        const rejectReason =
          readable?.code === 'NOT_FOUND' ? 'NOT_FOUND' : 'FILE_CHANGED';
        await streamer.failExternal('FILE_UNREADABLE');
        negotiator.updateSessionState(payload.transferId, 'failed', {
          errorCode: rejectReason,
        });
        progressTracker.updateTransfer(payload.transferId, {
          state: 'failed',
          errorCode: rejectReason,
        });
        emitError({
          code: rejectReason,
          transferId: payload.transferId,
          direction: payload.direction,
        });
        emitChange();
        try {
          await safeSendControl({
            type: 'RESUME_REJECTED',
            payload: {
              transferId: payload.transferId,
              fileId: payload.fileId,
              reason: rejectReason,
            },
          });
        } catch {
          // Ignore send failures
        }
        return { ok: false, code: rejectReason };
      }

      const resumeFromChunkIndex = payload.lastPersistedChunkIndex + 1;
      const rotated = streamer.rotateEpochAndResume({
        nextEpoch: payload.nextEpoch,
        resumeFromChunkIndex,
        binaryChannel: getActiveBinaryChannel(),
      });
      if (!rotated) {
        try {
          await safeSendControl({
            type: 'RESUME_REJECTED',
            payload: {
              transferId: payload.transferId,
              fileId: payload.fileId,
              reason: 'INVALID_EPOCH',
            },
          });
        } catch {
          // Ignore send failures
        }
        return { ok: false, code: 'INVALID_EPOCH' };
      }

      negotiator.updateSessionState(payload.transferId, 'active', {
        epoch: payload.nextEpoch,
      });
      progressTracker.updateTransfer(payload.transferId, {
        state: 'active',
        epoch: payload.nextEpoch,
        bytesTransferred: payload.persistedPlaintextBytes,
      });
      emitChange();

      try {
        await safeSendControl({
          type: 'RESUME_ACCEPTED',
          payload: {
            transferId: payload.transferId,
            fileId: payload.fileId,
            direction: payload.direction,
            epoch: payload.nextEpoch,
            resumeFromChunkIndex,
          },
        });
      } catch {
        // Channel might drop again before retry
      }
      return { ok: true, epoch: payload.nextEpoch };
    }

    if (type === 'RESUME_ACCEPTED') {
      const receiver = downloaderReceivers.get(payload.transferId);
      const expectedEpoch = pendingResumeEpochs.get(payload.transferId);
      if (
        !receiver ||
        expectedEpoch === undefined ||
        !verifyCounterparty(payload.direction, senderMemberId)
      ) {
        return { ok: true, ignored: true };
      }

      const rxState = receiver.getState();
      if (
        payload.epoch !== expectedEpoch ||
        payload.fileId !== rxState.fileId ||
        payload.direction !== rxState.direction ||
        payload.resumeFromChunkIndex !== rxState.lastPersistedChunkIndex + 1
      ) {
        pendingResumeEpochs.delete(payload.transferId);
        await receiver.failExternal('EPOCH_MISMATCH');
        negotiator.updateSessionState(payload.transferId, 'failed', {
          errorCode: 'EPOCH_MISMATCH',
        });
        progressTracker.updateTransfer(payload.transferId, {
          state: 'failed',
          errorCode: 'EPOCH_MISMATCH',
        });
        emitError({ code: 'EPOCH_MISMATCH', transferId: payload.transferId });
        emitChange();
        return { ok: false, code: 'EPOCH_MISMATCH' };
      }

      pendingResumeEpochs.delete(payload.transferId);
      await receiver.rotateEpochAndResume(payload.epoch);
      negotiator.updateSessionState(payload.transferId, 'active', {
        epoch: payload.epoch,
      });
      progressTracker.updateTransfer(payload.transferId, {
        state: 'active',
        epoch: payload.epoch,
      });
      emitChange();
      return { ok: true, epoch: payload.epoch };
    }

    if (type === 'RESUME_REJECTED') {
      const receiver = downloaderReceivers.get(payload.transferId);
      if (!receiver || !pendingResumeEpochs.has(payload.transferId)) {
        return { ok: true, ignored: true };
      }
      const rxState = receiver.getState();
      if (
        payload.fileId !== rxState.fileId ||
        !verifyCounterparty(rxState.direction, senderMemberId)
      ) {
        return { ok: true, ignored: true };
      }

      pendingResumeEpochs.delete(payload.transferId);
      await receiver.failExternal(payload.reason);
      negotiator.updateSessionState(payload.transferId, 'failed', {
        errorCode: payload.reason,
      });
      progressTracker.updateTransfer(payload.transferId, {
        state: 'failed',
        errorCode: payload.reason,
      });
      emitError({
        code: payload.reason,
        transferId: payload.transferId,
        direction: rxState.direction,
      });
      emitChange();
      return { ok: true };
    }

    return { ok: true, ignored: true };
  }

  function pauseTransfer(transferId) {
    if (disposed) {
      return false;
    }
    const found = getActor(transferId);
    if (!found) {
      return false;
    }
    const current = found.actor.getState();
    if (current.state !== 'active') {
      return false;
    }
    const paused = found.actor.pause('paused_by_user');
    if (!paused) {
      return false;
    }
    negotiator.updateSessionState(transferId, 'paused_by_user');
    progressTracker.updateTransfer(transferId, { state: 'paused_by_user' });
    emitChange();
    void safeSendControl({
      type: 'TRANSFER_PAUSE',
      payload: {
        transferId,
        direction: current.direction,
        epoch: current.epoch,
      },
    }).catch(() => {});
    return true;
  }

  async function resumeTransfer(transferId) {
    if (disposed) {
      return false;
    }
    const found = getActor(transferId);
    if (!found) {
      return false;
    }
    const current = found.actor.getState();
    if (current.state !== 'paused_by_user') {
      return false;
    }
    const resumed = await found.actor.resume();
    if (!resumed) {
      return false;
    }
    negotiator.updateSessionState(transferId, 'active');
    progressTracker.updateTransfer(transferId, { state: 'active' });
    emitChange();
    try {
      await safeSendControl({
        type: 'TRANSFER_RESUME',
        payload: {
          transferId,
          direction: current.direction,
          epoch: current.epoch,
        },
      });
    } catch {
      // Ignore send failures if peer disconnected
    }
    return true;
  }

  async function cancelTransfer(transferId) {
    if (disposed) {
      return false;
    }
    const found = getActor(transferId);
    if (found) {
      const current = found.actor.getState();
      if (TERMINAL_STATES.has(current.state)) {
        return false;
      }
      pendingResumeEpochs.delete(transferId);
      await found.actor.cancel();
      negotiator.updateSessionState(transferId, 'cancelled', {
        clearPersistenceTarget: true,
      });
      progressTracker.updateTransfer(transferId, { state: 'cancelled' });
      emitChange();
      try {
        await safeSendControl({
          type: 'TRANSFER_CANCEL',
          payload: {
            transferId,
            direction: current.direction,
            reason: 'USER_CANCELLED',
          },
        });
      } catch {
        // Ignore control failures during cancel
      }
      return true;
    }

    const pendingSession = negotiator.getSession(transferId);
    if (!pendingSession || pendingSession.state !== 'requesting') {
      return false;
    }
    negotiator.updateSessionState(transferId, 'cancelled', {
      abortPersistenceTarget: true,
    });
    progressTracker.updateTransfer(transferId, { state: 'cancelled' });
    emitChange();
    try {
      await safeSendControl({
        type: 'TRANSFER_CANCEL',
        payload: {
          transferId,
          direction: pendingSession.direction,
          reason: 'USER_CANCELLED',
        },
      });
    } catch {
      // Ignore control failures during cancel
    }
    return true;
  }

  function handlePeerDisconnected() {
    if (disposed) {
      return;
    }
    cancelDisconnectGraceTimer();

    for (const session of negotiator.getSessions()) {
      if (session.state === 'requesting') {
        negotiator.updateSessionState(session.transferId, 'cancelled', {
          abortPersistenceTarget: true,
        });
        progressTracker.updateTransfer(session.transferId, {
          state: 'cancelled',
        });
      }
    }

    for (const [transferId, streamer] of ownerStreamers.entries()) {
      const st = streamer.getState();
      if (st.state === 'active' || st.state === 'paused_by_user') {
        streamer.pause('paused_reconnecting');
        negotiator.updateSessionState(transferId, 'paused_reconnecting');
        progressTracker.updateTransfer(transferId, {
          state: 'paused_reconnecting',
        });
      }
    }

    for (const [transferId, receiver] of downloaderReceivers.entries()) {
      const st = receiver.getState();
      pendingResumeEpochs.delete(transferId);
      if (st.state === 'active' || st.state === 'paused_by_user') {
        receiver.pause('paused_reconnecting');
        negotiator.updateSessionState(transferId, 'paused_reconnecting');
        progressTracker.updateTransfer(transferId, {
          state: 'paused_reconnecting',
        });
      } else {
        const tracked = progressTracker.getTransfer(transferId);
        if (tracked?.state === 'resuming') {
          negotiator.updateSessionState(transferId, 'paused_reconnecting');
          progressTracker.updateTransfer(transferId, {
            state: 'paused_reconnecting',
          });
        }
      }
    }

    disconnectGraceTimer = setTimeoutFn(() => {
      disconnectGraceTimer = null;
      if (disposed) {
        return;
      }
      for (const [transferId, streamer] of ownerStreamers.entries()) {
        if (!TERMINAL_STATES.has(streamer.getState().state)) {
          void streamer.failExternal('INTERNAL_ERROR');
          negotiator.updateSessionState(transferId, 'failed', {
            errorCode: 'INTERNAL_ERROR',
          });
          progressTracker.updateTransfer(transferId, {
            state: 'failed',
            errorCode: 'INTERNAL_ERROR',
          });
        }
      }
      for (const [transferId, receiver] of downloaderReceivers.entries()) {
        pendingResumeEpochs.delete(transferId);
        if (!TERMINAL_STATES.has(receiver.getState().state)) {
          void receiver.failExternal('INTERNAL_ERROR');
          negotiator.updateSessionState(transferId, 'failed', {
            errorCode: 'INTERNAL_ERROR',
          });
          progressTracker.updateTransfer(transferId, {
            state: 'failed',
            errorCode: 'INTERNAL_ERROR',
          });
        }
      }
      emitChange();
    }, graceWindowMs);

    emitChange();
  }

  async function handlePeerReconnected() {
    if (disposed) {
      return;
    }
    cancelDisconnectGraceTimer();
    const remoteId = getRemoteId();

    for (const [transferId, streamer] of ownerStreamers.entries()) {
      const st = streamer.getState();
      if (
        !TERMINAL_STATES.has(st.state) &&
        !verifyCounterparty(st.direction, remoteId)
      ) {
        await streamer.failExternal('AUTH_FAILED');
        negotiator.updateSessionState(transferId, 'failed', {
          errorCode: 'AUTH_FAILED',
        });
        progressTracker.updateTransfer(transferId, {
          state: 'failed',
          errorCode: 'AUTH_FAILED',
        });
      }
    }

    for (const [transferId, receiver] of downloaderReceivers.entries()) {
      const st = receiver.getState();
      if (st.state !== 'paused_reconnecting') {
        continue;
      }
      if (!verifyCounterparty(st.direction, remoteId)) {
        await receiver.failExternal('AUTH_FAILED');
        negotiator.updateSessionState(transferId, 'failed', {
          errorCode: 'AUTH_FAILED',
        });
        progressTracker.updateTransfer(transferId, {
          state: 'failed',
          errorCode: 'AUTH_FAILED',
        });
        continue;
      }

      await receiver.waitForWriteQueue();
      if (disposed) {
        return;
      }
      const latest = receiver.getState();
      if (latest.state !== 'paused_reconnecting') {
        continue;
      }

      const nextEpoch = latest.epoch + 1;
      pendingResumeEpochs.set(transferId, nextEpoch);
      negotiator.updateSessionState(transferId, 'resuming');
      progressTracker.updateTransfer(transferId, { state: 'resuming' });
      emitChange();

      try {
        await safeSendControl({
          type: 'RESUME_REQUEST',
          payload: {
            transferId,
            fileId: latest.fileId,
            direction: latest.direction,
            nextEpoch,
            lastPersistedChunkIndex: latest.lastPersistedChunkIndex,
            persistedPlaintextBytes: latest.lastPersistedPlaintextOffset,
          },
        });
      } catch {
        // Channel dropped again before send; handlePeerDisconnected handles cleanup
      }
    }
  }

  function dispose() {
    if (disposed) {
      return;
    }
    disposed = true;
    cancelDisconnectGraceTimer();
    pendingResumeEpochs.clear();
    for (const streamer of ownerStreamers.values()) {
      streamer.dispose();
    }
    for (const receiver of downloaderReceivers.values()) {
      receiver.dispose();
    }
    ownerStreamers.clear();
    downloaderReceivers.clear();
    negotiator.dispose();
    progressTracker.dispose();
    if (ownsCryptoProcessor) {
      cryptoProcessor.dispose();
    }
  }

  return Object.freeze({
    requestDownload: (fileId) => negotiator.requestRemoteFile(fileId),
    refreshRemoteCapabilities: (entries) =>
      negotiator.preEvaluateAdvertisements(entries),
    getCapabilities: () => negotiator.getCapabilities(),
    getPreEvaluatedEntry: (fileId) => negotiator.getPreEvaluatedEntry(fileId),
    pauseTransfer,
    resumeTransfer,
    cancelTransfer,
    handlePeerDisconnected,
    handlePeerReconnected,
    handleControlMessage,
    handleBinaryFrame,
    getTransfer: (transferId) => progressTracker.getTransfer(transferId),
    getTransfers: () => progressTracker.getAllTransfers(),
    getRemoteMemberId: getRemoteId,
    dispose,
  });
}
