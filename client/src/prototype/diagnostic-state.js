import {
  normalizeSignalingEvent,
  sanitizeEventPayloadSummary,
  sanitizeTextValue,
} from '../signaling/socket-client.js';
import { createInitialDiagnosticChannelState } from './diagnostic-channel.js';
import {
  createInitialIceDiagnosticsState,
  validateIceCredentialsPayload,
} from './ice-diagnostics.js';
import { createInitialWebRtcState } from './webrtc-harness.js';

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
const VALID_ENTRY_ROLES = new Set(['creator', 'joiner']);
const VALID_NEGOTIATION_DUTIES = new Set(['offerer', 'answerer']);
const LIFECYCLE_SERVER_EVENTS = Object.freeze([
  'room:created',
  'room:joined',
  'peer:joined',
  'peer:left',
  'ice:credentials',
  'room:error',
  'disconnect',
]);
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

function normalizeEntryRole(entryRole) {
  return typeof entryRole === 'string' && VALID_ENTRY_ROLES.has(entryRole)
    ? entryRole
    : null;
}

function normalizePeerId(peerId) {
  return typeof peerId === 'string' && SAFE_PEER_ID_PATTERN.test(peerId)
    ? peerId
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

function isSameErrorRecord(first, second) {
  if (!first || !second) {
    return first === second;
  }

  return (
    first.source === second.source &&
    first.code === second.code &&
    first.roomId === second.roomId &&
    first.message === second.message &&
    first.timestamp === second.timestamp
  );
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

function normalizeIceDiagnostics(value) {
  if (value === null) {
    return null;
  }
  if (!isObjectRecord(value)) {
    return createInitialIceDiagnosticsState();
  }
  return createInitialIceDiagnosticsState(value);
}

function normalizeWebRtcState(value) {
  if (value === null) {
    return null;
  }
  if (!isObjectRecord(value)) {
    return createInitialWebRtcState();
  }
  return createInitialWebRtcState(value);
}

function normalizeDiagnosticChannelState(value) {
  if (value === null) {
    return null;
  }
  if (!isObjectRecord(value)) {
    return createInitialDiagnosticChannelState();
  }
  return createInitialDiagnosticChannelState(value);
}

const OPTIONAL_LIFECYCLE_NORMALIZERS = {
  entryRole: normalizeEntryRole,
  selfPeerId: normalizePeerId,
  remotePeerId: normalizePeerId,
  iceDiagnostics: normalizeIceDiagnostics,
  webrtc: normalizeWebRtcState,
  diagnosticChannel: normalizeDiagnosticChannelState,
};

function buildResetOptionalSubStates(baseState) {
  const resets = {};
  if (Object.prototype.hasOwnProperty.call(baseState, 'iceDiagnostics')) {
    resets.iceDiagnostics =
      baseState.iceDiagnostics === null
        ? null
        : createInitialIceDiagnosticsState();
  }
  if (Object.prototype.hasOwnProperty.call(baseState, 'webrtc')) {
    resets.webrtc =
      baseState.webrtc === null ? null : createInitialWebRtcState();
  }
  if (Object.prototype.hasOwnProperty.call(baseState, 'diagnosticChannel')) {
    resets.diagnosticChannel =
      baseState.diagnosticChannel === null
        ? null
        : createInitialDiagnosticChannelState();
  }
  return resets;
}

function copyOptionalLifecycleFields(target, source, requireDefined) {
  for (const [key, normalize] of Object.entries(OPTIONAL_LIFECYCLE_NORMALIZERS)) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) {
      continue;
    }
    if (requireDefined && source[key] === undefined) {
      continue;
    }
    target[key] = normalize(source[key]);
  }
  return target;
}

function ensureStateShape(state) {
  if (!isObjectRecord(state)) {
    return createInitialPrototypeState();
  }

  return copyOptionalLifecycleFields(
    {
      connectionStatus: normalizeConnectionStatus(state.connectionStatus),
      roomId: normalizeRoomId(state.roomId),
      peerState: normalizePeerState(state.peerState),
      negotiationDuty: normalizeNegotiationDuty(state.negotiationDuty),
      lastError: state.lastError ? sanitizeErrorRecord(state.lastError) : null,
      eventLog: Array.isArray(state.eventLog) ? state.eventLog : [],
    },
    state,
    false,
  );
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

  return copyOptionalLifecycleFields(
    {
      connectionStatus: normalizeConnectionStatus(source.connectionStatus),
      roomId: normalizeRoomId(source.roomId),
      peerState: normalizePeerState(source.peerState),
      negotiationDuty: normalizeNegotiationDuty(source.negotiationDuty),
      lastError: sanitizeErrorRecord(source.lastError),
      eventLog: rawEventLog
        .slice(-DEFAULT_MAX_LOG_ENTRIES)
        .map((entry) => sanitizeLogEntry(entry)),
    },
    source,
    true,
  );
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
 * Resets active room and peer membership fields back to unaffiliated while preserving eventLog.
 * @param {ReturnType<typeof createInitialPrototypeState>} state
 */
export function resetRoomMembership(state) {
  const baseState = state
    ? ensureStateShape(state)
    : createInitialPrototypeState();

  return {
    ...baseState,
    roomId: null,
    peerState: 'unaffiliated',
    entryRole: null,
    negotiationDuty: null,
    selfPeerId: null,
    remotePeerId: null,
    ...buildResetOptionalSubStates(baseState),
  };
}

/**
 * Transitions an unaffiliated creator into waiting_for_peer upon receiving room:created.
 * @param {ReturnType<typeof createInitialPrototypeState>} state
 * @param {unknown} payload
 */
export function applyRoomCreated(state, payload) {
  const baseState = state
    ? ensureStateShape(state)
    : createInitialPrototypeState();

  if (!isObjectRecord(payload)) {
    return { ...baseState };
  }

  const roomId = normalizeRoomId(payload.roomId);
  if (!roomId) {
    return { ...baseState };
  }

  return {
    ...baseState,
    roomId,
    peerState: 'waiting_for_peer',
    entryRole: 'creator',
    negotiationDuty:
      normalizeNegotiationDuty(payload.negotiationDuty) ?? 'offerer',
    selfPeerId: normalizePeerId(payload.peerId),
    remotePeerId: null,
    lastError: null,
    ...buildResetOptionalSubStates(baseState),
  };
}

/**
 * Transitions an unaffiliated joiner into connected state upon receiving room:joined.
 * @param {ReturnType<typeof createInitialPrototypeState>} state
 * @param {unknown} payload
 */
export function applyRoomJoined(state, payload) {
  const baseState = state
    ? ensureStateShape(state)
    : createInitialPrototypeState();

  if (!isObjectRecord(payload)) {
    return { ...baseState };
  }

  const roomId = normalizeRoomId(payload.roomId);
  if (!roomId) {
    return { ...baseState };
  }

  return {
    ...baseState,
    roomId,
    peerState: 'connected',
    entryRole: 'joiner',
    negotiationDuty:
      normalizeNegotiationDuty(payload.negotiationDuty) ?? 'answerer',
    selfPeerId: normalizePeerId(payload.peerId),
    remotePeerId: null,
    lastError: null,
    ...buildResetOptionalSubStates(baseState),
  };
}

/**
 * Transitions the waiting peer in the matching room into connected state when a peer joins.
 * @param {ReturnType<typeof createInitialPrototypeState>} state
 * @param {unknown} payload
 */
export function applyPeerJoined(state, payload) {
  const baseState = state
    ? ensureStateShape(state)
    : createInitialPrototypeState();

  if (!isObjectRecord(payload)) {
    return { ...baseState };
  }

  const roomId = normalizeRoomId(payload.roomId);
  if (!roomId || baseState.roomId !== roomId) {
    return { ...baseState };
  }

  return {
    ...baseState,
    peerState: 'connected',
    negotiationDuty: baseState.negotiationDuty ?? 'offerer',
    remotePeerId: normalizePeerId(payload.peerId),
  };
}

/**
 * Keeps the remaining peer in waiting_for_peer and promotes it to offerer when the remote peer leaves.
 * @param {ReturnType<typeof createInitialPrototypeState>} state
 * @param {unknown} payload
 */
export function applyPeerLeft(state, payload) {
  const baseState = state
    ? ensureStateShape(state)
    : createInitialPrototypeState();

  if (!isObjectRecord(payload)) {
    return { ...baseState };
  }

  const roomId = normalizeRoomId(payload.roomId);
  if (!roomId || baseState.roomId !== roomId) {
    return { ...baseState };
  }

  const hasWebrtc = Object.prototype.hasOwnProperty.call(baseState, 'webrtc');
  const hasDiagnosticChannel = Object.prototype.hasOwnProperty.call(
    baseState,
    'diagnosticChannel',
  );

  // Regardless of initial entryRole, the remaining peer becomes offerer for the next peer.
  return {
    ...baseState,
    peerState: 'waiting_for_peer',
    negotiationDuty: 'offerer',
    remotePeerId: null,
    ...(hasWebrtc
      ? {
          webrtc:
            baseState.webrtc === null
              ? null
              : createInitialWebRtcState({
                  ...baseState.webrtc,
                  status: 'closed',
                  remoteGeneration: null,
                  activePeerId: null,
                  signalingState: 'closed',
                  iceConnectionState: 'closed',
                  connectionState: 'closed',
                  dataChannelState:
                    baseState.webrtc.dataChannelState === 'none'
                      ? 'none'
                      : 'closed',
                  stalledGathering: false,
                  stalledDiagnostic: null,
                  localDescriptionForwarded: false,
                  queuedCandidateCount: 0,
                }),
        }
      : {}),
    ...(hasDiagnosticChannel
      ? {
          diagnosticChannel:
            baseState.diagnosticChannel === null
              ? null
              : createInitialDiagnosticChannelState({
                  ...baseState.diagnosticChannel,
                  channelState:
                    baseState.diagnosticChannel.channelState === 'none'
                      ? 'none'
                      : 'closed',
                  peerId: null,
                  pendingPingCount: 0,
                }),
        }
      : {}),
  };
}

/**
 * Resets local room membership when the local peer explicitly emits room:leave.
 * @param {ReturnType<typeof createInitialPrototypeState>} state
 * @param {string | { roomId?: unknown }} [targetRoomId]
 */
export function applyLocalRoomLeave(state, targetRoomId) {
  const baseState = state
    ? ensureStateShape(state)
    : createInitialPrototypeState();

  const requestedRoomId =
    typeof targetRoomId === 'string'
      ? targetRoomId.trim()
      : isObjectRecord(targetRoomId) &&
          Object.prototype.hasOwnProperty.call(targetRoomId, 'roomId')
        ? typeof targetRoomId.roomId === 'string'
          ? targetRoomId.roomId.trim()
          : null
        : undefined;

  if (
    requestedRoomId !== undefined &&
    baseState.roomId !== null &&
    requestedRoomId !== baseState.roomId
  ) {
    return { ...baseState };
  }

  return resetRoomMembership(baseState);
}

/**
 * Marks development ICE configuration diagnostics as loading for the target canonical room.
 * @param {ReturnType<typeof createInitialPrototypeState>} state
 * @param {string | { roomId?: unknown }} [targetRoomId]
 */
export function applyIceRequestStarted(state, targetRoomId) {
  const baseState = state
    ? ensureStateShape(state)
    : createInitialPrototypeState();

  const requestedRoomId =
    targetRoomId === undefined
      ? baseState.roomId
      : normalizeRoomId(
          typeof targetRoomId === 'string'
            ? targetRoomId.trim()
            : isObjectRecord(targetRoomId)
              ? targetRoomId.roomId
              : null,
        );

  if (!requestedRoomId) {
    return { ...baseState };
  }

  return {
    ...baseState,
    iceDiagnostics: createInitialIceDiagnosticsState({
      status: 'loading',
      roomId: requestedRoomId,
      lastError: null,
    }),
  };
}

/**
 * Validates an inbound ice:credentials payload and updates iceDiagnostics with a sanitized
 * STUN-only summary or INVALID_ICE_CREDENTIALS failure without dropping room membership.
 * @param {ReturnType<typeof createInitialPrototypeState>} state
 * @param {unknown} payload
 */
export function applyIceCredentials(state, payload) {
  const baseState = state
    ? ensureStateShape(state)
    : createInitialPrototypeState();

  const validation = validateIceCredentialsPayload(payload, {
    expectedRoomId: baseState.roomId ?? undefined,
  });

  if (!validation.ok) {
    const errorRoomId =
      validation.error.roomId ?? baseState.roomId ?? undefined;
    const sanitizedError = sanitizeErrorRecord({
      source: 'ice:credentials',
      code: validation.error.code,
      ...(errorRoomId ? { roomId: errorRoomId } : {}),
      message: validation.error.message,
    });

    return {
      ...baseState,
      lastError: sanitizedError,
      iceDiagnostics: createInitialIceDiagnosticsState({
        status: 'invalid',
        roomId: baseState.roomId ?? validation.error.roomId ?? null,
        lastError: sanitizedError,
      }),
    };
  }

  return {
    ...baseState,
    lastError: null,
    iceDiagnostics: createInitialIceDiagnosticsState({
      status: 'ready',
      roomId: validation.roomId,
      ...validation.summary,
      lastError: null,
    }),
  };
}

/**
 * Records a sanitized room:error payload on lastError without altering active room membership.
 * @param {ReturnType<typeof createInitialPrototypeState>} state
 * @param {unknown} payload
 */
export function applyRoomError(state, payload) {
  const baseState = state
    ? ensureStateShape(state)
    : createInitialPrototypeState();

  const errorInput = isObjectRecord(payload)
    ? {
        ...payload,
        source: 'room:error',
        code:
          typeof payload.code === 'string' && payload.code.trim() !== ''
            ? payload.code
            : 'UNKNOWN_ERROR',
        message:
          typeof payload.message === 'string' && payload.message.trim() !== ''
            ? payload.message
            : typeof payload.error === 'string' && payload.error.trim() !== ''
              ? payload.error
              : 'Unknown room error',
      }
    : {
        source: 'room:error',
        code: 'UNKNOWN_ERROR',
        message:
          sanitizeTextValue(payload, { maxLength: 160 }) ||
          'Unknown room error',
      };

  const sanitizedError = sanitizeErrorRecord(errorInput);

  if (
    sanitizedError &&
    !sanitizedError.timestamp &&
    baseState.lastError?.source === 'room:error' &&
    baseState.lastError.code === sanitizedError.code &&
    baseState.lastError.message === sanitizedError.message &&
    baseState.lastError.roomId === sanitizedError.roomId &&
    baseState.lastError.timestamp
  ) {
    sanitizedError.timestamp = baseState.lastError.timestamp;
  }

  const shouldUpdateIceError =
    baseState.iceDiagnostics?.status === 'loading' ||
    sanitizedError?.code === 'SERVER_BUSY';

  return {
    ...baseState,
    lastError: sanitizedError,
    ...(shouldUpdateIceError
      ? {
          iceDiagnostics: createInitialIceDiagnosticsState({
            status: 'error',
            roomId:
              sanitizedError?.roomId ??
              baseState.iceDiagnostics?.roomId ??
              baseState.roomId ??
              null,
            lastError: sanitizedError,
          }),
        }
      : {}),
  };
}

/**
 * Updates the WebRTC signaling harness state snapshot with sanitized fields.
 * @param {ReturnType<typeof createInitialPrototypeState>} state
 * @param {unknown} webrtcState
 */
export function applyWebRtcState(state, webrtcState) {
  const baseState = state
    ? ensureStateShape(state)
    : createInitialPrototypeState();

  return {
    ...baseState,
    webrtc: normalizeWebRtcState(webrtcState),
  };
}

/**
 * Updates the bidirectional diagnostic data-channel state snapshot with sanitized fields.
 * @param {ReturnType<typeof createInitialPrototypeState>} state
 * @param {unknown} diagnosticChannelState
 */
export function applyDiagnosticChannelState(state, diagnosticChannelState) {
  const baseState = state
    ? ensureStateShape(state)
    : createInitialPrototypeState();

  return {
    ...baseState,
    diagnosticChannel: normalizeDiagnosticChannelState(diagnosticChannelState),
  };
}

/**
 * Clears only lastError while preserving connection status, room membership, and eventLog.
 * @param {ReturnType<typeof createInitialPrototypeState>} state
 */
export function clearLastError(state) {
  const baseState = state
    ? ensureStateShape(state)
    : createInitialPrototypeState();
  const hasIceDiagnosticsError =
    Boolean(baseState.iceDiagnostics) &&
    baseState.iceDiagnostics.lastError !== null;
  const hasWebRtcError =
    Boolean(baseState.webrtc) && baseState.webrtc.lastError !== null;
  const hasDiagnosticChannelError =
    Boolean(baseState.diagnosticChannel) &&
    baseState.diagnosticChannel.lastError !== null;

  return {
    ...baseState,
    lastError: null,
    ...(hasIceDiagnosticsError
      ? {
          iceDiagnostics: {
            ...baseState.iceDiagnostics,
            lastError: null,
          },
        }
      : {}),
    ...(hasWebRtcError
      ? {
          webrtc: {
            ...baseState.webrtc,
            lastError: null,
          },
        }
      : {}),
    ...(hasDiagnosticChannelError
      ? {
          diagnosticChannel: {
            ...baseState.diagnosticChannel,
            lastError: null,
          },
        }
      : {}),
  };
}

/**
 * Returns true when selective error recovery should also clear an unaffiliated draft room input.
 * @param {ReturnType<typeof createInitialPrototypeState>} state
 */
export function shouldClearDraftRoomInput(state) {
  const baseState = state
    ? ensureStateShape(state)
    : createInitialPrototypeState();

  if (baseState.peerState !== 'unaffiliated' || !baseState.lastError) {
    return false;
  }

  return (
    baseState.lastError.source !== 'connect_error' &&
    baseState.lastError.code !== 'CONNECT_ERROR'
  );
}

/**
 * Selectively recovers from an error by clearing only lastError (and optional draft room input
 * when unaffiliated) without clearing valid active room membership or sanitized eventLog.
 * @param {ReturnType<typeof createInitialPrototypeState>} state
 * @param {{ onClearDraft?: Function }} [options]
 */
export function recoverErrorState(state, options = {}) {
  const baseState = state
    ? ensureStateShape(state)
    : createInitialPrototypeState();

  if (
    isObjectRecord(options) &&
    typeof options.onClearDraft === 'function' &&
    shouldClearDraftRoomInput(baseState)
  ) {
    options.onClearDraft();
  }

  return clearLastError(baseState);
}

const SERVER_EVENT_REDUCERS = {
  'room:created': applyRoomCreated,
  'room:joined': applyRoomJoined,
  'peer:joined': applyPeerJoined,
  'peer:left': applyPeerLeft,
  'ice:credentials': applyIceCredentials,
  'room:error': applyRoomError,
  disconnect: (currentState) => resetRoomMembership(currentState),
};

/**
 * Applies a normalized room lifecycle server or disconnect event onto diagnostic state.
 * @param {ReturnType<typeof createInitialPrototypeState>} state
 * @param {string} eventName
 * @param {unknown} [payload]
 */
export function applySignalingServerEvent(state, eventName, payload) {
  if (typeof eventName === 'string') {
    const reducer = SERVER_EVENT_REDUCERS[eventName];
    if (reducer) {
      return reducer(state, payload);
    }
  }

  return state ? ensureStateShape(state) : createInitialPrototypeState();
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

  const nextState = {
    ...baseState,
    connectionStatus: nextStatus,
    lastError: nextLastError,
  };

  const hasDisconnectReason =
    typeof statusSnapshot.disconnectReason === 'string' &&
    statusSnapshot.disconnectReason.trim() !== '';

  if (nextStatus === 'disconnected' && hasDisconnectReason) {
    return resetRoomMembership(nextState);
  }

  return nextState;
}

/**
 * Connects a signaling client status, event, and room lifecycle stream to a state updater.
 * @param {{
 *   getStatus: Function,
 *   subscribeStatus: Function,
 *   subscribeEvents?: Function,
 *   subscribeServerEvent?: Function,
 * }} signalingClient
 * @param {Function} setState
 * @returns {() => void} Cleanup callback that unsubscribes all listeners.
 */
export function bindSignalingClient(signalingClient, setState) {
  if (!signalingClient || typeof setState !== 'function') {
    throw new TypeError(
      'Expected signalingClient and setState function to bind diagnostic state.',
    );
  }

  let lastDeliveredStatusError = null;

  function applyBoundStatusSnapshot(nextStatus) {
    const normalizedStatus = isObjectRecord(nextStatus)
      ? normalizeConnectionStatus(nextStatus.status)
      : 'disconnected';
    const sanitizedIncomingError = isObjectRecord(nextStatus)
      ? sanitizeErrorRecord(nextStatus.lastError)
      : null;

    if (
      isObjectRecord(nextStatus) &&
      normalizedStatus !== 'error' &&
      sanitizedIncomingError !== null &&
      isSameErrorRecord(sanitizedIncomingError, lastDeliveredStatusError)
    ) {
      const { lastError: _ignoredLastError, ...statusWithoutStaleError } =
        nextStatus;
      setState((prev) => applyConnectionStatus(prev, statusWithoutStaleError));
      return;
    }

    lastDeliveredStatusError = sanitizedIncomingError;
    setState((prev) => applyConnectionStatus(prev, nextStatus));
  }

  applyBoundStatusSnapshot(signalingClient.getStatus());

  const unsubscribeStatus = signalingClient.subscribeStatus((nextStatus) => {
    applyBoundStatusSnapshot(nextStatus);
  });

  const unsubscribeEvents =
    typeof signalingClient.subscribeEvents === 'function'
      ? signalingClient.subscribeEvents((entry) => {
          setState((prev) => {
            const withLog = appendSanitizedLogEntry(prev, entry);
            if (entry?.event === 'disconnect') {
              return resetRoomMembership(withLog);
            }
            if (
              entry?.direction === 'outbound' &&
              entry?.event === 'ice:get' &&
              entry?.roomId
            ) {
              return applyIceRequestStarted(withLog, entry.roomId);
            }
            return withLog;
          });
        })
      : () => {};

  const unsubscribeServerEvents =
    typeof signalingClient.subscribeServerEvent === 'function'
      ? LIFECYCLE_SERVER_EVENTS.map((eventName) =>
          signalingClient.subscribeServerEvent(eventName, (payload) => {
            setState((prev) =>
              applySignalingServerEvent(prev, eventName, payload),
            );
          }),
        )
      : [];

  return () => {
    unsubscribeStatus();
    unsubscribeEvents();
    for (const unsubscribe of unsubscribeServerEvents) {
      unsubscribe();
    }
  };
}

/**
 * Creates room lifecycle control actions bound to a signaling client and React-compatible updater.
 * @param {{ createRoom: Function, joinRoom: Function, leaveRoom: Function, requestIce?: Function }} signalingClient
 * @param {Function} setState
 */
export function createRoomLifecycleActions(signalingClient, setState) {
  if (!signalingClient || typeof setState !== 'function') {
    throw new TypeError(
      'Expected signalingClient and setState function to create room lifecycle actions.',
    );
  }

  function createRoom() {
    signalingClient.createRoom();
    return true;
  }

  function joinRoom(rawRoomId) {
    const roomId = typeof rawRoomId === 'string' ? rawRoomId.trim() : '';
    if (!roomId) {
      return false;
    }
    signalingClient.joinRoom(roomId);
    return true;
  }

  function leaveRoom(activeRoomId) {
    const roomId = typeof activeRoomId === 'string' ? activeRoomId.trim() : '';
    if (!roomId) {
      return false;
    }
    signalingClient.leaveRoom(roomId);
    setState((prev) => applyLocalRoomLeave(prev, roomId));
    return true;
  }

  function requestIce(activeRoomId) {
    const roomId = normalizeRoomId(
      typeof activeRoomId === 'string' ? activeRoomId.trim() : '',
    );
    if (!roomId) {
      return false;
    }
    signalingClient.requestIce(roomId);
    setState((prev) => applyIceRequestStarted(prev, roomId));
    return true;
  }

  return Object.freeze({
    createRoom,
    joinRoom,
    leaveRoom,
    requestIce,
  });
}
