import {
  normalizeSignalingEvent,
  sanitizeEventPayloadSummary,
  sanitizeTextValue,
} from '../signaling/socket-client.js';

const VALID_CONNECTION_STATUSES = new Set([
  'disconnected',
  'connecting',
  'connected',
  'error',
]);
const VALID_PEER_STATES = new Set([
  'unaffiliated',
  'waiting_for_peer',
  'connected',
]);
const VALID_NEGOTIATION_DUTIES = new Set(['offerer', 'answerer']);
const VALID_SIGNAL_KINDS = new Set(['sdp', 'ice', 'unknown']);
const VALID_SDP_TYPES = new Set(['offer', 'answer', 'pranswer', 'rollback']);
const VALID_ICE_SCHEMES = new Set(['stun', 'stuns', 'turn', 'turns']);

const ROOM_ID_PATTERN = /^ship-[a-f0-9]{4}$/;
const SAFE_PEER_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const DEFAULT_MAX_LOG_ENTRIES = 200;

function isObjectRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeConnectionStatus(status) {
  return typeof status === 'string' && VALID_CONNECTION_STATUSES.has(status)
    ? status
    : 'disconnected';
}

function normalizeRoomId(roomId) {
  return typeof roomId === 'string' && ROOM_ID_PATTERN.test(roomId)
    ? roomId
    : null;
}

function normalizePeerState(peerState) {
  return typeof peerState === 'string' && VALID_PEER_STATES.has(peerState)
    ? peerState
    : 'unaffiliated';
}

function normalizeNegotiationDuty(duty) {
  return typeof duty === 'string' && VALID_NEGOTIATION_DUTIES.has(duty)
    ? duty
    : null;
}

function sanitizeErrorRecord(errorLike) {
  if (errorLike === null || errorLike === undefined) {
    return null;
  }

  if (typeof errorLike === 'string' || errorLike instanceof Error) {
    const message = sanitizeTextValue(errorLike, { maxLength: 160 });
    return message ? { code: 'UNKNOWN_ERROR', message } : null;
  }

  if (!isObjectRecord(errorLike)) {
    const message = sanitizeTextValue(errorLike, { maxLength: 160 });
    return message ? { code: 'UNKNOWN_ERROR', message } : null;
  }

  const rawMessage = errorLike.message ?? errorLike.error ?? '';
  const message =
    sanitizeTextValue(rawMessage, { maxLength: 160 }) || 'Unknown error';
  const code =
    sanitizeTextValue(errorLike.code, { maxLength: 64 }) || 'UNKNOWN_ERROR';
  const source =
    typeof errorLike.source === 'string'
      ? sanitizeTextValue(errorLike.source, { maxLength: 64 })
      : '';
  const roomId = normalizeRoomId(errorLike.roomId);
  const timestamp =
    typeof errorLike.timestamp === 'string'
      ? sanitizeTextValue(errorLike.timestamp, { maxLength: 64 })
      : '';

  return {
    ...(source ? { source } : {}),
    code,
    ...(roomId ? { roomId } : {}),
    message,
    ...(timestamp ? { timestamp } : {}),
  };
}

function sanitizeLogMeta(meta) {
  if (!isObjectRecord(meta)) {
    return undefined;
  }

  const safeMeta = {};

  if (
    typeof meta.signalKind === 'string' &&
    VALID_SIGNAL_KINDS.has(meta.signalKind)
  ) {
    safeMeta.signalKind = meta.signalKind;
  }
  if (typeof meta.sdpType === 'string' && VALID_SDP_TYPES.has(meta.sdpType)) {
    safeMeta.sdpType = meta.sdpType;
  }
  if (typeof meta.endOfCandidates === 'boolean') {
    safeMeta.endOfCandidates = meta.endOfCandidates;
  }
  if (Number.isInteger(meta.serverCount) && meta.serverCount >= 0) {
    safeMeta.serverCount = meta.serverCount;
  }
  if (Array.isArray(meta.schemes)) {
    const schemes = meta.schemes.filter(
      (scheme) => typeof scheme === 'string' && VALID_ICE_SCHEMES.has(scheme),
    );
    if (schemes.length > 0) {
      safeMeta.schemes = schemes;
    }
  }
  if (typeof meta.hasTurn === 'boolean') {
    safeMeta.hasTurn = meta.hasTurn;
  }
  if (
    typeof meta.negotiationDuty === 'string' &&
    VALID_NEGOTIATION_DUTIES.has(meta.negotiationDuty)
  ) {
    safeMeta.negotiationDuty = meta.negotiationDuty;
  }
  if (typeof meta.reason === 'string') {
    const safeReason = sanitizeTextValue(meta.reason, { maxLength: 80 });
    if (safeReason) {
      safeMeta.reason = safeReason;
    }
  }
  if (typeof meta.code === 'string') {
    const safeCode = sanitizeTextValue(meta.code, { maxLength: 64 });
    if (safeCode) {
      safeMeta.code = safeCode;
    }
  }
  if (typeof meta.message === 'string') {
    const safeMessage = sanitizeTextValue(meta.message, { maxLength: 160 });
    if (safeMessage) {
      safeMeta.message = safeMessage;
    }
  }

  return Object.keys(safeMeta).length > 0 ? safeMeta : undefined;
}

function ensureStateShape(state) {
  if (!isObjectRecord(state)) {
    return createInitialPrototypeState();
  }

  return {
    connectionStatus: normalizeConnectionStatus(state.connectionStatus),
    roomId: normalizeRoomId(state.roomId),
    peerState: normalizePeerState(state.peerState),
    negotiationDuty: normalizeNegotiationDuty(state.negotiationDuty),
    lastError: state.lastError ? sanitizeErrorRecord(state.lastError) : null,
    eventLog: Array.isArray(state.eventLog) ? state.eventLog : [],
  };
}

function extractDerivedPayload(entry) {
  const payload = {};
  for (const [key, value] of Object.entries(entry)) {
    if (
      key === 'direction' ||
      key === 'event' ||
      key === 'timestamp' ||
      key === 'now'
    ) {
      continue;
    }
    payload[key] = value;
  }
  return Object.keys(payload).length > 0 ? payload : undefined;
}

/**
 * Creates the initial state object for the diagnostic prototype shell.
 * @param {Record<string, unknown>} [overrides]
 */
export function createInitialPrototypeState(overrides = {}) {
  if (overrides !== undefined && !isObjectRecord(overrides)) {
    throw new TypeError(
      'Initial prototype state overrides must be a plain object.',
    );
  }

  const source = overrides ?? {};
  const rawEventLog = Array.isArray(source.eventLog) ? source.eventLog : [];

  return {
    connectionStatus: normalizeConnectionStatus(source.connectionStatus),
    roomId: normalizeRoomId(source.roomId),
    peerState: normalizePeerState(source.peerState),
    negotiationDuty: normalizeNegotiationDuty(source.negotiationDuty),
    lastError: sanitizeErrorRecord(source.lastError),
    eventLog: rawEventLog
      .slice(-DEFAULT_MAX_LOG_ENTRIES)
      .map((entry) => sanitizeLogEntry(entry)),
  };
}

/**
 * Normalizes and redacts a signaling or diagnostic event entry before storing or displaying it.
 * @param {unknown} entry
 * @param {{ now?: () => string | number | Date }} [options]
 */
export function sanitizeLogEntry(entry, options = {}) {
  if (entry instanceof Error) {
    return normalizeSignalingEvent({
      direction: 'local',
      event: 'diagnostic',
      payload: sanitizeTextValue(entry),
      now: options.now,
    });
  }

  if (!isObjectRecord(entry)) {
    return normalizeSignalingEvent({
      direction: 'local',
      event: 'diagnostic',
      payload: entry,
      now: options.now,
    });
  }

  if (
    Object.prototype.hasOwnProperty.call(entry, 'payload') &&
    entry.payload !== undefined
  ) {
    const normalized = normalizeSignalingEvent({
      direction: entry.direction,
      event: entry.event ?? 'unknown',
      payload: entry.payload,
      timestamp: entry.timestamp,
      now: options.now,
    });
    const fallbackRoomId = normalized.roomId ?? normalizeRoomId(entry.roomId);
    const fallbackCode =
      normalized.code ??
      (typeof entry.code === 'string'
        ? sanitizeTextValue(entry.code, { maxLength: 64 }) || undefined
        : undefined);

    return {
      ...normalized,
      ...(fallbackRoomId ? { roomId: fallbackRoomId } : {}),
      ...(fallbackCode ? { code: fallbackCode } : {}),
    };
  }

  const hasSummary =
    entry.summary !== undefined &&
    entry.summary !== null &&
    (typeof entry.summary !== 'string' || entry.summary.trim() !== '');

  if (hasSummary) {
    const base = normalizeSignalingEvent({
      direction: entry.direction,
      event: entry.event ?? 'unknown',
      timestamp: entry.timestamp,
      now: options.now,
    });
    const safeSummary =
      typeof entry.summary === 'string'
        ? sanitizeTextValue(entry.summary)
        : sanitizeEventPayloadSummary(base.event, entry.summary);
    const safeRoomId = normalizeRoomId(entry.roomId) ?? undefined;
    const safePeerId =
      typeof entry.peerId === 'string' && SAFE_PEER_ID_PATTERN.test(entry.peerId)
        ? entry.peerId
        : undefined;
    const safeCode =
      typeof entry.code === 'string'
        ? sanitizeTextValue(entry.code, { maxLength: 64 }) || undefined
        : undefined;
    const safeMeta = sanitizeLogMeta(entry.meta);

    return {
      timestamp: base.timestamp,
      direction: base.direction,
      event: base.event,
      ...(safeRoomId ? { roomId: safeRoomId } : {}),
      ...(safePeerId ? { peerId: safePeerId } : {}),
      ...(safeCode ? { code: safeCode } : {}),
      summary: safeSummary || base.summary,
      ...(safeMeta ? { meta: safeMeta } : {}),
    };
  }

  return normalizeSignalingEvent({
    direction: entry.direction,
    event: entry.event ?? 'unknown',
    payload: extractDerivedPayload(entry),
    timestamp: entry.timestamp,
    now: options.now,
  });
}

/**
 * Appends a sanitized log entry in strict chronological order (oldest to newest).
 * @param {ReturnType<typeof createInitialPrototypeState>} state
 * @param {unknown} entry
 * @param {{ now?: () => string | number | Date, maxEntries?: number }} [options]
 */
export function appendSanitizedLogEntry(state, entry, options = {}) {
  const baseState = state
    ? ensureStateShape(state)
    : createInitialPrototypeState();
  const maxEntries =
    Number.isInteger(options.maxEntries) && options.maxEntries > 0
      ? options.maxEntries
      : DEFAULT_MAX_LOG_ENTRIES;

  const sanitizedEntry = sanitizeLogEntry(entry, { now: options.now });
  const nextLog = [...baseState.eventLog, sanitizedEntry];

  return {
    ...baseState,
    eventLog: nextLog.length > maxEntries ? nextLog.slice(-maxEntries) : nextLog,
  };
}

/**
 * Clears all event log entries while preserving connection, room, peer, duty, and error fields.
 * @param {ReturnType<typeof createInitialPrototypeState>} state
 */
export function clearEventLog(state) {
  const baseState = state
    ? ensureStateShape(state)
    : createInitialPrototypeState();

  return {
    ...baseState,
    eventLog: [],
  };
}

/**
 * Applies a signaling client status snapshot onto diagnostic shell state with sanitized errors.
 * @param {ReturnType<typeof createInitialPrototypeState>} state
 * @param {unknown} statusSnapshot
 */
export function applyConnectionStatus(state, statusSnapshot) {
  const baseState = state
    ? ensureStateShape(state)
    : createInitialPrototypeState();

  if (typeof statusSnapshot === 'string') {
    return {
      ...baseState,
      connectionStatus: normalizeConnectionStatus(statusSnapshot),
    };
  }

  if (!isObjectRecord(statusSnapshot)) {
    return { ...baseState };
  }

  const nextStatus =
    statusSnapshot.status !== undefined
      ? normalizeConnectionStatus(statusSnapshot.status)
      : statusSnapshot.connected === true
        ? 'connected'
        : baseState.connectionStatus;

  const hasLastErrorField = Object.prototype.hasOwnProperty.call(
    statusSnapshot,
    'lastError',
  );
  const nextLastError = hasLastErrorField
    ? sanitizeErrorRecord(statusSnapshot.lastError)
    : baseState.lastError;

  return {
    ...baseState,
    connectionStatus: nextStatus,
    lastError: nextLastError,
  };
}

/**
 * Connects a signaling client status and event stream to a React-compatible state updater.
 * @param {{ getStatus: Function, subscribeStatus: Function, subscribeEvents?: Function }} signalingClient
 * @param {Function} setState
 * @returns {() => void} Cleanup callback that unsubscribes all listeners.
 */
export function bindSignalingClient(signalingClient, setState) {
  if (!signalingClient || typeof setState !== 'function') {
    throw new TypeError(
      'Expected signalingClient and setState function to bind diagnostic state.',
    );
  }

  setState((prev) => applyConnectionStatus(prev, signalingClient.getStatus()));

  const unsubscribeStatus = signalingClient.subscribeStatus((nextStatus) => {
    setState((prev) => applyConnectionStatus(prev, nextStatus));
  });

  const unsubscribeEvents =
    typeof signalingClient.subscribeEvents === 'function'
      ? signalingClient.subscribeEvents((entry) => {
          setState((prev) => appendSanitizedLogEntry(prev, entry));
        })
      : () => {};

  return () => {
    unsubscribeStatus();
    unsubscribeEvents();
  };
}
