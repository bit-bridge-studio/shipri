import { sanitizeTextValue } from '../signaling/socket-client.js';

const CANONICAL_ROOM_ID_PATTERN = /^ship-[a-f0-9]{4}$/;

const UNKNOWN_ROOM_ERROR_DESCRIPTOR = Object.freeze({
  code: 'UNKNOWN_ERROR',
  category: 'unknown',
  title: 'Unknown room error',
  recoveryGuidance:
    'Inspect the sanitized Event Log for details, clear this error, and retry the operation.',
  preservesMembership: true,
  known: false,
});

/**
 * Metadata and recovery guidance for the stable Backend POC room:error codes
 * plus Socket.IO connection errors.
 */
export const POC_ROOM_ERROR_DESCRIPTORS = Object.freeze({
  ROOM_NOT_FOUND: Object.freeze({
    code: 'ROOM_NOT_FOUND',
    category: 'room',
    title: 'Room not found',
    recoveryGuidance:
      'Verify the canonical room ID (ship-xxxx) or create a new room.',
    preservesMembership: true,
    known: true,
  }),
  ROOM_FULL: Object.freeze({
    code: 'ROOM_FULL',
    category: 'capacity',
    title: 'Room is full',
    recoveryGuidance:
      'This room already has two active peers. Create a new room or join a different room ID.',
    preservesMembership: true,
    known: true,
  }),
  INVALID_ROOM_ID: Object.freeze({
    code: 'INVALID_ROOM_ID',
    category: 'validation',
    title: 'Invalid room ID',
    recoveryGuidance:
      'Enter a canonical room ID matching ship-xxxx using lowercase hex characters.',
    preservesMembership: true,
    known: true,
  }),
  INVALID_PAYLOAD: Object.freeze({
    code: 'INVALID_PAYLOAD',
    category: 'validation',
    title: 'Invalid signaling payload',
    recoveryGuidance:
      'Ensure the emitted event uses a plain object payload with only supported fields.',
    preservesMembership: true,
    known: true,
  }),
  UNAUTHORIZED: Object.freeze({
    code: 'UNAUTHORIZED',
    category: 'authorization',
    title: 'Unauthorized room action',
    recoveryGuidance:
      'Leave your active room before creating or joining another, or join the target room before relaying signals.',
    preservesMembership: true,
    known: true,
  }),
  PEER_UNAVAILABLE: Object.freeze({
    code: 'PEER_UNAVAILABLE',
    category: 'peer',
    title: 'Peer unavailable',
    recoveryGuidance:
      'Wait for a second peer to join this room before forwarding WebRTC signaling data.',
    preservesMembership: true,
    known: true,
  }),
  SERVER_BUSY: Object.freeze({
    code: 'SERVER_BUSY',
    category: 'server',
    title: 'Server configuration unavailable',
    recoveryGuidance:
      'Development ICE configuration is currently unavailable on the signaling server. Retry shortly.',
    preservesMembership: true,
    known: true,
  }),
  CONNECT_ERROR: Object.freeze({
    code: 'CONNECT_ERROR',
    category: 'connection',
    title: 'Signaling connection error',
    recoveryGuidance:
      'Verify that the signaling server is reachable and retry the socket connection.',
    preservesMembership: true,
    known: true,
  }),
});

const CLIENT_DIAGNOSTIC_ERROR_DESCRIPTORS = Object.freeze({
  INVALID_ICE_CREDENTIALS: Object.freeze({
    code: 'INVALID_ICE_CREDENTIALS',
    category: 'validation',
    title: 'Invalid ICE configuration',
    recoveryGuidance:
      'Verify the signaling server STUN configuration and request ICE configuration again.',
    preservesMembership: true,
    known: true,
  }),
});

function isObjectRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeCanonicalRoomId(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return CANONICAL_ROOM_ID_PATTERN.test(trimmed) ? trimmed : null;
}

/**
 * Resolves a stable error descriptor by branching strictly on machine-readable `code`,
 * never on human-readable `message`. Unrecognized or missing codes fall back safely
 * to `UNKNOWN_ERROR`.
 * @param {string | { code?: unknown, message?: unknown } | null | undefined} errorOrCode
 */
export function resolveRoomErrorDescriptor(errorOrCode) {
  let rawCode = '';
  if (typeof errorOrCode === 'string') {
    rawCode = errorOrCode;
  } else if (isObjectRecord(errorOrCode) && typeof errorOrCode.code === 'string') {
    rawCode = errorOrCode.code;
  }

  const normalizedCode = sanitizeTextValue(rawCode, { maxLength: 64 }).trim();
  if (normalizedCode !== '') {
    if (
      Object.prototype.hasOwnProperty.call(
        POC_ROOM_ERROR_DESCRIPTORS,
        normalizedCode,
      )
    ) {
      return POC_ROOM_ERROR_DESCRIPTORS[normalizedCode];
    }
    if (
      Object.prototype.hasOwnProperty.call(
        CLIENT_DIAGNOSTIC_ERROR_DESCRIPTORS,
        normalizedCode,
      )
    ) {
      return CLIENT_DIAGNOSTIC_ERROR_DESCRIPTORS[normalizedCode];
    }
  }

  return UNKNOWN_ROOM_ERROR_DESCRIPTOR;
}

function resolveUnauthorizedInvocation(context = {}) {
  const activeRoomId = normalizeCanonicalRoomId(context.roomId);
  const targetRoomId = normalizeCanonicalRoomId(context.targetRoomId);

  if (activeRoomId) {
    if (targetRoomId && targetRoomId !== activeRoomId) {
      return {
        event: 'ice:get',
        payload: { roomId: targetRoomId },
      };
    }
    return {
      event: 'room:create',
      payload: {},
    };
  }

  return {
    event: 'ice:get',
    payload: { roomId: targetRoomId ?? 'ship-0000' },
  };
}

/**
 * Preset malformed and invalid-state test scenarios dispatched via `emitRaw`
 * to exercise Backend POC validation and error handling without crashing UI state.
 */
export const MALFORMED_TEST_SCENARIOS = Object.freeze([
  Object.freeze({
    id: 'invalid-payload-non-object',
    label: 'Invalid Payload (Non-Object)',
    expectedCode: 'INVALID_PAYLOAD',
    event: 'room:join',
    payload: 'not-a-plain-object',
    description: 'Emit room:join with a non-object string payload.',
    resolveInvocation: () => ({
      event: 'room:join',
      payload: 'not-a-plain-object',
    }),
  }),
  Object.freeze({
    id: 'invalid-payload-extra-field',
    label: 'Invalid Payload (Extra Field)',
    expectedCode: 'INVALID_PAYLOAD',
    event: 'room:join',
    payload: Object.freeze({
      roomId: 'ship-0000',
      unsupportedField: 'validation-test',
    }),
    description: 'Emit room:join with an unsupported top-level field.',
    resolveInvocation: (context = {}) => ({
      event: 'room:join',
      payload: {
        roomId:
          normalizeCanonicalRoomId(context.targetRoomId) ??
          normalizeCanonicalRoomId(context.roomId) ??
          'ship-0000',
        unsupportedField: 'validation-test',
      },
    }),
  }),
  Object.freeze({
    id: 'invalid-room-id',
    label: 'Invalid Room ID',
    expectedCode: 'INVALID_ROOM_ID',
    event: 'room:join',
    payload: Object.freeze({ roomId: 'invalid-room-id' }),
    description: 'Emit room:join with a non-canonical roomId format.',
    resolveInvocation: (context = {}) => {
      const draft =
        typeof context.targetRoomId === 'string'
          ? context.targetRoomId.trim()
          : '';
      const invalidId =
        draft !== '' && !CANONICAL_ROOM_ID_PATTERN.test(draft)
          ? draft
          : 'invalid-room-id';
      return {
        event: 'room:join',
        payload: { roomId: invalidId },
      };
    },
  }),
  Object.freeze({
    id: 'room-not-found',
    label: 'Room Not Found',
    expectedCode: 'ROOM_NOT_FOUND',
    event: 'room:join',
    payload: Object.freeze({ roomId: 'ship-0000' }),
    description: 'Emit room:join for a canonical roomId with no active room.',
    resolveInvocation: (context = {}) => {
      const activeRoomId = normalizeCanonicalRoomId(context.roomId);
      const missingRoomId =
        activeRoomId === 'ship-0000' ? 'ship-0001' : 'ship-0000';
      return {
        event: 'room:join',
        payload: { roomId: missingRoomId },
      };
    },
  }),
  Object.freeze({
    id: 'unauthorized-action',
    label: 'Unauthorized Action',
    expectedCode: 'UNAUTHORIZED',
    event: 'ice:get',
    payload: Object.freeze({ roomId: 'ship-0000' }),
    description:
      'Emit room:create while in a room or ice:get for an unauthorized room.',
    resolveInvocation: resolveUnauthorizedInvocation,
  }),
  Object.freeze({
    id: 'peer-unavailable-signal',
    label: 'Peer Unavailable Signal',
    expectedCode: 'PEER_UNAVAILABLE',
    event: 'signal:forward',
    payload: Object.freeze({
      roomId: 'ship-0000',
      signalData: Object.freeze({ type: 'offer' }),
    }),
    description:
      'Emit signal:forward when no second peer is present in the room.',
    resolveInvocation: (context = {}) => ({
      event: 'signal:forward',
      payload: {
        roomId:
          normalizeCanonicalRoomId(context.roomId) ??
          normalizeCanonicalRoomId(context.targetRoomId) ??
          'ship-0000',
        signalData: { type: 'offer' },
      },
    }),
  }),
]);

function resolveScenarioDefinition(scenarioOrId) {
  if (typeof scenarioOrId === 'string') {
    const trimmed = scenarioOrId.trim();
    return (
      MALFORMED_TEST_SCENARIOS.find((scenario) => scenario.id === trimmed) ??
      null
    );
  }

  if (
    isObjectRecord(scenarioOrId) &&
    typeof scenarioOrId.event === 'string' &&
    scenarioOrId.event.trim() !== ''
  ) {
    return scenarioOrId;
  }

  return null;
}

/**
 * Dispatches a malformed or validation test scenario through `signalingClient.emitRaw`
 * safely without crashing, sanitizing any local error text.
 * @param {{ emitRaw?: Function }} signalingClient
 * @param {string | { id?: string, expectedCode?: string, event: string, payload?: unknown, resolveInvocation?: Function }} scenarioOrId
 * @param {{ roomId?: string | null, targetRoomId?: string, payload?: unknown }} [context]
 */
export function runValidationScenario(
  signalingClient,
  scenarioOrId,
  context = {},
) {
  const scenario = resolveScenarioDefinition(scenarioOrId);
  if (!scenario) {
    return {
      ok: false,
      scenarioId: typeof scenarioOrId === 'string' ? scenarioOrId : 'unknown',
      expectedCode: 'UNKNOWN_ERROR',
      event: null,
      error: {
        code: 'UNKNOWN_ERROR',
        message: 'Unknown validation scenario.',
      },
    };
  }

  const safeContext = isObjectRecord(context) ? context : {};
  const invocation =
    typeof scenario.resolveInvocation === 'function'
      ? scenario.resolveInvocation(safeContext)
      : {
          event: scenario.event,
          payload: Object.prototype.hasOwnProperty.call(safeContext, 'payload')
            ? safeContext.payload
            : scenario.payload,
        };

  const eventName =
    typeof invocation?.event === 'string' && invocation.event.trim() !== ''
      ? invocation.event.trim()
      : scenario.event;
  const payload = Object.prototype.hasOwnProperty.call(safeContext, 'payload')
    ? safeContext.payload
    : invocation?.payload;

  if (!signalingClient || typeof signalingClient.emitRaw !== 'function') {
    return {
      ok: false,
      scenarioId: scenario.id ?? eventName,
      expectedCode: scenario.expectedCode ?? 'UNKNOWN_ERROR',
      event: eventName,
      error: {
        code: 'CONNECT_ERROR',
        message: 'Signaling client is unavailable.',
      },
    };
  }

  try {
    signalingClient.emitRaw(eventName, payload);
    return {
      ok: true,
      scenarioId: scenario.id ?? eventName,
      expectedCode: scenario.expectedCode ?? 'UNKNOWN_ERROR',
      event: eventName,
    };
  } catch (error) {
    const safeMessage =
      sanitizeTextValue(error, { maxLength: 160 }) ||
      'Unable to emit validation scenario.';
    return {
      ok: false,
      scenarioId: scenario.id ?? eventName,
      expectedCode: scenario.expectedCode ?? 'UNKNOWN_ERROR',
      event: eventName,
      error: {
        code: 'CONNECT_ERROR',
        message: safeMessage,
      },
    };
  }
}
