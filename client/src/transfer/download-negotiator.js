import { FIXED_CHUNK_SIZE_BYTES, isValidFileId } from '../crypto/board-metadata.js';
import {
  formatTransferDirection,
  generateTransferId,
  isValidMemberId,
  isValidTransferId,
  validateControlMessage,
} from '../crypto/control-codec.js';
import {
  evaluatePersistenceCapability,
  openSaveTargetSynchronously,
  queryStorageEstimate,
} from '../persistence/file-persistence.js';

const ACTIVE_DIRECTION_STATES = new Set([
  'preparing_persistence',
  'requesting',
  'active',
  'paused_by_user',
  'paused_reconnecting',
  'resuming',
]);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function snapshotSession(session) {
  return Object.freeze({
    transferId: session.transferId,
    fileId: session.fileId,
    fileName: session.fileName,
    fileSize: session.fileSize,
    fileType: session.fileType,
    chunkSize: session.chunkSize,
    totalChunks: session.totalChunks,
    direction: session.direction,
    role: session.role,
    epoch: session.epoch,
    state: session.state,
    rejectReason: session.rejectReason ?? null,
    errorCode: session.errorCode ?? null,
  });
}

function parseDirectionMembers(direction) {
  const parts = typeof direction === 'string' ? direction.split('->') : [];
  if (parts.length !== 2) {
    return null;
  }
  return { ownerMemberId: parts[0], downloaderMemberId: parts[1] };
}

/**
 * Coordinates persistence pre-evaluation, synchronous click-time save dialog
 * opening, DOWNLOAD_REQUEST creation after persistence opens, and owner-side
 * single-transfer-per-direction DOWNLOAD_ACCEPTED / DOWNLOAD_REJECTED handling.
 */
export function createDownloadNegotiator({
  localMemberId,
  getRemoteMemberId,
  remoteBoard,
  localBoard,
  sendControlMessage,
  windowObj = globalThis.window,
  navigatorObj = globalThis.navigator,
  onSessionChange,
  onDownloadAccepted,
  onOutgoingAccepted,
  onError,
} = {}) {
  if (!isValidMemberId(localMemberId)) {
    throw new TypeError('Expected a valid 16-byte base64url localMemberId.');
  }

  let disposed = false;
  let pendingIncomingPrepare = false;
  let lastCapability = evaluatePersistenceCapability({ windowObj });
  let lastStorageEstimate = Object.freeze({
    quotaBytes: null,
    usageBytes: null,
    availableBytes: null,
  });
  let estimateGeneration = 0;

  const sessions = new Map();
  const pendingOutgoingDirections = new Set();
  const preEvaluated = new Map();

  function emitError(error) {
    if (!disposed && typeof onError === 'function') {
      onError(error);
    }
  }

  function emitSessionsChanged() {
    if (!disposed && typeof onSessionChange === 'function') {
      onSessionChange(getSessions());
    }
  }

  function hasActiveTransferInDirection(direction) {
    for (const session of sessions.values()) {
      if (
        session.direction === direction &&
        ACTIVE_DIRECTION_STATES.has(session.state)
      ) {
        return true;
      }
    }
    return false;
  }

  function buildPreEvaluatedEntry(entry, capability, storageEstimate) {
    const insufficientStorage = Boolean(
      storageEstimate.availableBytes !== null &&
        entry.fileSize > storageEstimate.availableBytes,
    );
    return Object.freeze({
      fileId: entry.fileId,
      canDownload: Boolean(
        capability.supported &&
          entry.availability === 'available' &&
          !insufficientStorage,
      ),
      insufficientStorage,
      capability,
      storageEstimate,
    });
  }

  function syncPreEvaluatedCache(entries) {
    const seen = new Set();
    let changed = false;

    for (const entry of entries) {
      if (!entry || !isValidFileId(entry.fileId)) {
        continue;
      }
      seen.add(entry.fileId);
      const next = buildPreEvaluatedEntry(
        entry,
        lastCapability,
        lastStorageEstimate,
      );
      const prev = preEvaluated.get(entry.fileId);
      if (
        !prev ||
        prev.canDownload !== next.canDownload ||
        prev.insufficientStorage !== next.insufficientStorage ||
        prev.capability.supported !== next.capability.supported ||
        prev.storageEstimate.availableBytes !== next.storageEstimate.availableBytes
      ) {
        changed = true;
      }
      preEvaluated.set(entry.fileId, next);
    }

    for (const existingFileId of preEvaluated.keys()) {
      if (!seen.has(existingFileId)) {
        preEvaluated.delete(existingFileId);
        changed = true;
      }
    }

    return changed;
  }

  function preEvaluateAdvertisements(entries = remoteBoard?.getEntries?.() ?? []) {
    if (disposed) {
      return Promise.resolve(lastStorageEstimate);
    }
    lastCapability = evaluatePersistenceCapability({ windowObj });
    const list = Array.isArray(entries) ? entries : [];
    const immediateChange = syncPreEvaluatedCache(list);
    if (immediateChange) {
      emitSessionsChanged();
    }

    const gen = ++estimateGeneration;
    return queryStorageEstimate({ navigatorObj }).then((estimate) => {
      if (disposed || gen !== estimateGeneration) {
        return estimate;
      }
      lastStorageEstimate = estimate;
      const latestEntries = remoteBoard?.getEntries?.() ?? list;
      const updated = syncPreEvaluatedCache(
        Array.isArray(latestEntries) ? latestEntries : [],
      );
      if (updated) {
        emitSessionsChanged();
      }
      return estimate;
    });
  }

  async function safeSendControl(message) {
    if (disposed || typeof sendControlMessage !== 'function') {
      throw new Error('Control transport is unavailable.');
    }
    await sendControlMessage(message);
  }

  async function sendReject(transferId, fileId, reason) {
    try {
      await safeSendControl({
        type: 'DOWNLOAD_REJECTED',
        payload: { transferId, fileId, reason },
      });
    } catch {
      // Ignore transport errors while reporting rejections
    }
  }

  /**
   * Preserves transient browser user activation by synchronously calling
   * showSaveFilePicker() before awaiting any promises.
   */
  function requestRemoteFile(fileId) {
    if (disposed) {
      return Promise.resolve({ ok: false, code: 'DISPOSED' });
    }
    if (!isValidFileId(fileId)) {
      return Promise.resolve({ ok: false, code: 'INVALID_FILE_ID' });
    }

    const entry = remoteBoard?.getEntry?.(fileId) ?? null;
    if (!entry || entry.availability !== 'available') {
      return Promise.resolve({ ok: false, code: 'UNAVAILABLE' });
    }

    const remoteMemberId =
      typeof getRemoteMemberId === 'function' ? getRemoteMemberId() : null;
    if (!isValidMemberId(remoteMemberId) || remoteMemberId === localMemberId) {
      return Promise.resolve({ ok: false, code: 'PEER_UNAVAILABLE' });
    }

    lastCapability = evaluatePersistenceCapability({ windowObj });
    if (!lastCapability.supported) {
      return Promise.resolve({
        ok: false,
        code: lastCapability.reason,
        guidance: lastCapability.guidance,
      });
    }

    const cachedEval = preEvaluated.get(fileId);
    const insufficientStorage =
      cachedEval?.insufficientStorage ??
      Boolean(
        lastStorageEstimate.availableBytes !== null &&
          entry.fileSize > lastStorageEstimate.availableBytes,
      );
    if (insufficientStorage) {
      return Promise.resolve({ ok: false, code: 'LIMIT_EXCEEDED' });
    }

    const incomingDirection = formatTransferDirection(
      remoteMemberId,
      localMemberId,
    );
    if (
      pendingIncomingPrepare ||
      hasActiveTransferInDirection(incomingDirection)
    ) {
      return Promise.resolve({ ok: false, code: 'DIRECTION_BUSY' });
    }

    pendingIncomingPrepare = true;
    const openPromise = openSaveTargetSynchronously({
      fileName: entry.fileName,
      windowObj,
    });

    return openPromise.then(async (openResult) => {
      if (!openResult.ok) {
        pendingIncomingPrepare = false;
        return {
          ok: false,
          ...(openResult.cancelled ? { cancelled: true } : {}),
          code: openResult.code,
          ...(openResult.guidance ? { guidance: openResult.guidance } : {}),
        };
      }

      const currentRemoteId =
        typeof getRemoteMemberId === 'function' ? getRemoteMemberId() : null;
      const latestEntry = remoteBoard?.getEntry?.(fileId) ?? null;
      if (
        disposed ||
        currentRemoteId !== remoteMemberId ||
        !latestEntry ||
        latestEntry.availability !== 'available'
      ) {
        pendingIncomingPrepare = false;
        await openResult.target.abort();
        return { ok: false, code: 'UNAVAILABLE' };
      }

      const transferId = generateTransferId();
      const session = {
        transferId,
        fileId: latestEntry.fileId,
        fileName: latestEntry.fileName,
        fileSize: latestEntry.fileSize,
        fileType: latestEntry.fileType,
        chunkSize: latestEntry.chunkSize,
        totalChunks: latestEntry.totalChunks,
        direction: incomingDirection,
        role: 'downloader',
        epoch: 1,
        state: 'requesting',
        rejectReason: null,
        errorCode: null,
        persistenceTarget: openResult.target,
      };
      sessions.set(transferId, session);
      pendingIncomingPrepare = false;
      emitSessionsChanged();

      try {
        await safeSendControl({
          type: 'DOWNLOAD_REQUEST',
          payload: {
            transferId,
            fileId: latestEntry.fileId,
            direction: incomingDirection,
            initialEpoch: 1,
          },
        });
      } catch {
        await session.persistenceTarget?.abort();
        session.persistenceTarget = null;
        session.state = 'failed';
        session.errorCode = 'INTERNAL_ERROR';
        emitError({ code: 'INTERNAL_ERROR', transferId });
        emitSessionsChanged();
        return { ok: false, transferId, code: 'INTERNAL_ERROR' };
      }

      return {
        ok: true,
        transferId,
        session: snapshotSession(session),
      };
    });
  }

  async function handleDownloadRequest(message, senderMemberId) {
    const rawPayload = isPlainObject(message?.payload) ? message.payload : null;
    const rawTransferId = rawPayload?.transferId;
    const rawFileId = rawPayload?.fileId;

    const validated = validateControlMessage(message);
    if (!isValidMemberId(senderMemberId) || senderMemberId === localMemberId) {
      emitError({ code: 'INVALID_REQUEST' });
      return { ok: false, code: 'INVALID_REQUEST' };
    }

    const expectedDirection = formatTransferDirection(
      localMemberId,
      senderMemberId,
    );

    if (
      !validated.ok ||
      rawPayload.direction !== expectedDirection ||
      rawPayload.initialEpoch !== 1 ||
      sessions.has(rawPayload.transferId)
    ) {
      if (isValidTransferId(rawTransferId) && isValidFileId(rawFileId)) {
        await sendReject(rawTransferId, rawFileId, 'INVALID_REQUEST');
      }
      emitError({ code: 'INVALID_REQUEST', transferId: rawTransferId });
      return { ok: false, code: 'INVALID_REQUEST' };
    }

    const { transferId, fileId } = rawPayload;

    if (
      pendingOutgoingDirections.has(expectedDirection) ||
      hasActiveTransferInDirection(expectedDirection)
    ) {
      await sendReject(transferId, fileId, 'BUSY');
      return { ok: false, code: 'BUSY', transferId };
    }

    const advertised = localBoard?.getAdvertisedEntry?.(fileId) ?? null;
    if (!advertised) {
      await sendReject(transferId, fileId, 'NOT_FOUND');
      return { ok: false, code: 'NOT_FOUND', transferId };
    }

    pendingOutgoingDirections.add(expectedDirection);
    let readable;
    try {
      readable = await localBoard.verifyLocalFileReadable(fileId);
    } finally {
      pendingOutgoingDirections.delete(expectedDirection);
    }

    if (disposed) {
      return { ok: false, code: 'DISPOSED' };
    }

    if (!readable?.ok) {
      const reason = readable?.code === 'NOT_FOUND' ? 'NOT_FOUND' : 'UNAVAILABLE';
      await sendReject(transferId, fileId, reason);
      return { ok: false, code: reason, transferId };
    }

    if (hasActiveTransferInDirection(expectedDirection)) {
      await sendReject(transferId, fileId, 'BUSY');
      return { ok: false, code: 'BUSY', transferId };
    }

    const registered = localBoard.registerActiveTransfer(transferId, fileId);
    if (!registered) {
      await sendReject(transferId, fileId, 'NOT_FOUND');
      return { ok: false, code: 'NOT_FOUND', transferId };
    }

    const session = {
      transferId,
      fileId,
      fileName: advertised.fileName,
      fileSize: advertised.fileSize,
      fileType: advertised.fileType,
      chunkSize: FIXED_CHUNK_SIZE_BYTES,
      totalChunks: advertised.totalChunks,
      direction: expectedDirection,
      role: 'owner',
      epoch: 1,
      state: 'active',
      rejectReason: null,
      errorCode: null,
      persistenceTarget: null,
    };
    sessions.set(transferId, session);
    const snapshot = snapshotSession(session);
    emitSessionsChanged();

    if (typeof onOutgoingAccepted === 'function') {
      await onOutgoingAccepted(snapshot);
    }

    try {
      await safeSendControl({
        type: 'DOWNLOAD_ACCEPTED',
        payload: {
          transferId,
          fileId,
          direction: expectedDirection,
          epoch: 1,
          chunkSize: FIXED_CHUNK_SIZE_BYTES,
          totalChunks: advertised.totalChunks,
          fileSize: advertised.fileSize,
        },
      });
    } catch {
      session.state = 'failed';
      session.errorCode = 'INTERNAL_ERROR';
      localBoard.unregisterActiveTransfer(transferId);
      emitError({ code: 'INTERNAL_ERROR', transferId });
      emitSessionsChanged();
      return { ok: false, code: 'INTERNAL_ERROR', transferId };
    }

    return { ok: true, transferId, session: snapshot };
  }

  async function handleDownloadAccepted(message, senderMemberId) {
    const validated = validateControlMessage(message);
    if (!validated.ok) {
      emitError({ code: validated.code });
      return { ok: false, code: validated.code };
    }

    const { payload } = message;
    const session = sessions.get(payload.transferId);
    if (
      !session ||
      session.role !== 'downloader' ||
      session.state !== 'requesting'
    ) {
      return { ok: true, ignored: true };
    }

    const members = parseDirectionMembers(session.direction);
    if (
      !members ||
      senderMemberId !== members.ownerMemberId ||
      payload.fileId !== session.fileId ||
      payload.direction !== session.direction ||
      payload.epoch !== 1 ||
      payload.chunkSize !== session.chunkSize ||
      payload.fileSize !== session.fileSize ||
      payload.totalChunks !== session.totalChunks
    ) {
      await session.persistenceTarget?.abort();
      session.persistenceTarget = null;
      session.state = 'failed';
      session.errorCode = 'INVALID_CONTROL_MESSAGE';
      emitError({
        code: 'INVALID_CONTROL_MESSAGE',
        transferId: session.transferId,
      });
      emitSessionsChanged();
      return { ok: false, code: 'INVALID_CONTROL_MESSAGE' };
    }

    session.state = 'active';
    const target = session.persistenceTarget;
    const snapshot = snapshotSession(session);
    emitSessionsChanged();

    if (typeof onDownloadAccepted === 'function') {
      await onDownloadAccepted(snapshot, target);
    }

    return { ok: true, session: snapshot };
  }

  async function handleDownloadRejected(message, senderMemberId) {
    const validated = validateControlMessage(message);
    if (!validated.ok) {
      emitError({ code: validated.code });
      return { ok: false, code: validated.code };
    }

    const { payload } = message;
    const session = sessions.get(payload.transferId);
    if (
      !session ||
      session.role !== 'downloader' ||
      session.state !== 'requesting'
    ) {
      return { ok: true, ignored: true };
    }

    const members = parseDirectionMembers(session.direction);
    if (
      !members ||
      senderMemberId !== members.ownerMemberId ||
      payload.fileId !== session.fileId
    ) {
      return { ok: true, ignored: true };
    }

    await session.persistenceTarget?.abort();
    session.persistenceTarget = null;
    session.state = 'rejected';
    session.rejectReason = payload.reason;
    const snapshot = snapshotSession(session);
    emitSessionsChanged();

    return { ok: true, session: snapshot };
  }

  function handleControlMessage(message, senderMemberId) {
    if (disposed || !isPlainObject(message)) {
      return Promise.resolve({ ok: false, code: 'INVALID_CONTROL_MESSAGE' });
    }
    if (message.type === 'DOWNLOAD_REQUEST') {
      return handleDownloadRequest(message, senderMemberId);
    }
    if (message.type === 'DOWNLOAD_ACCEPTED') {
      return handleDownloadAccepted(message, senderMemberId);
    }
    if (message.type === 'DOWNLOAD_REJECTED') {
      return handleDownloadRejected(message, senderMemberId);
    }
    return Promise.resolve({ ok: true, ignored: true });
  }

  function updateSessionState(transferId, nextState, patch = {}) {
    const session = sessions.get(transferId);
    if (!session) {
      return null;
    }
    if (typeof nextState === 'string') {
      session.state = nextState;
    }
    if (Object.hasOwn(patch, 'epoch')) {
      session.epoch = patch.epoch;
    }
    if (Object.hasOwn(patch, 'errorCode')) {
      session.errorCode = patch.errorCode;
    }
    if (Object.hasOwn(patch, 'rejectReason')) {
      session.rejectReason = patch.rejectReason;
    }
    if (patch.clearPersistenceTarget) {
      session.persistenceTarget = null;
    }
    const snapshot = snapshotSession(session);
    emitSessionsChanged();
    return snapshot;
  }

  function getSession(transferId) {
    const session = sessions.get(transferId);
    return session ? snapshotSession(session) : null;
  }

  function getSessions() {
    return Object.freeze(
      Array.from(sessions.values(), (session) => snapshotSession(session)),
    );
  }

  function getPreEvaluatedEntry(fileId) {
    return preEvaluated.get(fileId) ?? null;
  }

  function getCapabilities() {
    lastCapability = evaluatePersistenceCapability({ windowObj });
    return {
      capability: lastCapability,
      storageEstimate: lastStorageEstimate,
    };
  }

  function dispose() {
    if (disposed) {
      return;
    }
    disposed = true;
    pendingIncomingPrepare = false;
    pendingOutgoingDirections.clear();
    estimateGeneration += 1;

    for (const session of sessions.values()) {
      if (session.persistenceTarget && !session.persistenceTarget.isFinished()) {
        void session.persistenceTarget.abort();
      }
      session.persistenceTarget = null;
      if (session.role === 'owner' && localBoard) {
        localBoard.unregisterActiveTransfer(session.transferId);
      }
    }
    sessions.clear();
    preEvaluated.clear();
  }

  return Object.freeze({
    preEvaluateAdvertisements,
    requestRemoteFile,
    handleControlMessage,
    updateSessionState,
    getSession,
    getSessions,
    getPreEvaluatedEntry,
    getCapabilities,
    dispose,
  });
}
