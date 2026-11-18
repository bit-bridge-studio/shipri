import { randomBytes } from 'node:crypto';

export const ROOM_ID_PATTERN = /^ship-[a-f0-9]{4}$/;
export const PEER_ID_PATTERN = /^peer-[a-f0-9]{16}$/;
export const MAX_ROOM_ID_ATTEMPTS = 65_536;

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Generates a canonical `ship-[a-f0-9]{4}` room identifier using Node.js CSPRNG.
 */
export function generateRoomId(randomBytesFn = randomBytes) {
  const bytes = randomBytesFn(2);
  return `ship-${bytes.toString('hex')}`;
}

/**
 * Generates an opaque peer identifier using Node.js CSPRNG.
 */
export function generatePeerId(randomBytesFn = randomBytes) {
  const bytes = randomBytesFn(8);
  return `peer-${bytes.toString('hex')}`;
}

/**
 * Checks whether a value matches the canonical `ship-[a-f0-9]{4}` room ID format.
 */
export function isValidRoomId(value) {
  return typeof value === 'string' && ROOM_ID_PATTERN.test(value);
}

/**
 * Allocates a room identifier that does not collide with active in-memory rooms.
 */
export function allocateUniqueRoomId(activeRooms, createId = generateRoomId) {
  for (let attempt = 0; attempt < MAX_ROOM_ID_ATTEMPTS; attempt += 1) {
    const candidate = createId();
    if (!activeRooms.has(candidate)) {
      return candidate;
    }
  }

  throw new Error('Unable to allocate a unique room ID.');
}

/**
 * Builds a `room:error` payload, attaching `roomId` only when it is canonically valid.
 */
export function createRoomError(code, message, roomId) {
  return isValidRoomId(roomId)
    ? { roomId, code, message }
    : { code, message };
}

function validatePayloadEnvelope(payload, allowedKeys, invalidMessage) {
  if (!isPlainObject(payload)) {
    return {
      ok: false,
      error: createRoomError('INVALID_PAYLOAD', invalidMessage),
    };
  }

  const hasUnsupportedField = Object.keys(payload).some(
    (key) => !allowedKeys.includes(key),
  );
  if (hasUnsupportedField) {
    return {
      ok: false,
      error: createRoomError('INVALID_PAYLOAD', invalidMessage, payload.roomId),
    };
  }

  return { ok: true };
}

/**
 * Validates the `room:create` payload envelope.
 */
export function validateRoomCreatePayload(payload) {
  if (!isPlainObject(payload) || Object.keys(payload).length > 0) {
    return {
      ok: false,
      error: createRoomError('INVALID_PAYLOAD', 'Invalid room:create payload.'),
    };
  }

  return { ok: true };
}

/**
 * Validates the `room:join` payload according to protocol error precedence.
 */
export function validateRoomJoinPayload(payload) {
  const envelope = validatePayloadEnvelope(
    payload,
    ['roomId'],
    'Invalid room:join payload.',
  );
  if (!envelope.ok) {
    return envelope;
  }

  if (!isValidRoomId(payload.roomId)) {
    return {
      ok: false,
      error: createRoomError('INVALID_ROOM_ID', 'Invalid room ID format.'),
    };
  }

  return { ok: true, roomId: payload.roomId };
}

/**
 * Validates the `signal:forward` payload according to protocol error precedence.
 */
export function validateSignalForwardPayload(payload) {
  const envelope = validatePayloadEnvelope(
    payload,
    ['roomId', 'signalData'],
    'Invalid signal:forward payload.',
  );
  if (!envelope.ok) {
    return envelope;
  }

  if (!isPlainObject(payload.signalData)) {
    return {
      ok: false,
      error: createRoomError(
        'INVALID_PAYLOAD',
        'Invalid signal:forward payload.',
        payload.roomId,
      ),
    };
  }

  if (!isValidRoomId(payload.roomId)) {
    return {
      ok: false,
      error: createRoomError('INVALID_ROOM_ID', 'Invalid room ID format.'),
    };
  }

  return {
    ok: true,
    roomId: payload.roomId,
    signalData: payload.signalData,
  };
}
