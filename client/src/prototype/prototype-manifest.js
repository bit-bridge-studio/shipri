import { sanitizeTextValue } from '../signaling/socket-client.js';
import {
  MALFORMED_TEST_SCENARIOS,
  POC_ROOM_ERROR_DESCRIPTORS,
  resolveRoomErrorDescriptor,
} from './room-errors.js';

/**
 * Inventory of strictly prototype-only modules under client/src/ that must be
 * removed or replaced during Part 4 (frontend_development_plan.md).
 */
export const PROTOTYPE_ONLY_MODULES = Object.freeze([
  Object.freeze({
    path: 'client/src/App.jsx',
    kind: 'prototype-shell',
    description:
      'Diagnostic prototype shell UI for manual room, WebRTC, NAT/TURN, and error-scenario inspection.',
    removeOrReplaceInPart4: true,
  }),
  Object.freeze({
    path: 'client/src/prototype/diagnostic-channel.js',
    kind: 'prototype-module',
    description:
      'Plaintext shipri-diagnostic RTCDataChannel ping/pong and short text controller.',
    removeOrReplaceInPart4: true,
  }),
  Object.freeze({
    path: 'client/src/prototype/diagnostic-state.js',
    kind: 'prototype-module',
    description:
      'Diagnostic shell reducer state and sanitized event-log binder for prototype controls.',
    removeOrReplaceInPart4: true,
  }),
  Object.freeze({
    path: 'client/src/prototype/ice-diagnostics.js',
    kind: 'prototype-module',
    description:
      'ICE credentials summary validator and diagnostic state helper for prototype UI panels.',
    removeOrReplaceInPart4: true,
  }),
  Object.freeze({
    path: 'client/src/prototype/prototype-manifest.js',
    kind: 'prototype-module',
    description:
      'Prototype-only module inventory and full-backend acceptance descriptor registry.',
    removeOrReplaceInPart4: true,
  }),
  Object.freeze({
    path: 'client/src/prototype/room-auth.js',
    kind: 'prototype-module',
    description:
      'Prototype-only HKDF-SHA256 room authorization token and verifier helper (replaced by Part 4 E2EE key manager).',
    removeOrReplaceInPart4: true,
  }),
  Object.freeze({
    path: 'client/src/prototype/room-errors.js',
    kind: 'prototype-module',
    description:
      'Prototype error descriptors and raw malformed-input validation trigger presets.',
    removeOrReplaceInPart4: true,
  }),
  Object.freeze({
    path: 'client/src/prototype/webrtc-harness.js',
    kind: 'prototype-module',
    description:
      'Prototype RTCPeerConnection signaling, trickle ICE, and NAT/forced-TURN diagnostic harness.',
    removeOrReplaceInPart4: true,
  }),
]);

/**
 * Reusable client modules that can be isolated and carried into Part 4
 * without prototype diagnostic dependencies.
 */
export const REUSABLE_CLIENT_MODULES = Object.freeze([
  Object.freeze({
    path: 'client/src/signaling/socket-client.js',
    kind: 'reusable-transport',
    description:
      'Isolated Socket.IO signaling transport wrapper with strict URL validation and log sanitization.',
    removeOrReplaceInPart4: false,
  }),
]);

/**
 * Full-backend error descriptors extending POC_ROOM_ERROR_DESCRIPTORS with
 * BE-3 rate-limit feedback without mutating POC_ROOM_ERROR_DESCRIPTORS.
 */
export const FULL_BACKEND_ERROR_DESCRIPTORS = Object.freeze({
  ...POC_ROOM_ERROR_DESCRIPTORS,
  RATE_LIMITED: Object.freeze({
    code: 'RATE_LIMITED',
    category: 'rate_limit',
    title: 'Rate limit exceeded',
    recoveryGuidance:
      'Wait for the signaling rate-limit window to reset before retrying the request.',
    preservesMembership: true,
    known: true,
  }),
});

/**
 * Resolves full-backend room error codes (including RATE_LIMITED) while keeping
 * POC resolveRoomErrorDescriptor behavior unchanged.
 * @param {string | { code?: unknown, message?: unknown } | null | undefined} errorOrCode
 */
export function resolveFullBackendErrorDescriptor(errorOrCode) {
  let rawCode = '';
  if (typeof errorOrCode === 'string') {
    rawCode = errorOrCode;
  } else if (
    errorOrCode &&
    typeof errorOrCode === 'object' &&
    typeof errorOrCode.code === 'string'
  ) {
    rawCode = errorOrCode.code;
  }

  const normalizedCode = sanitizeTextValue(rawCode, { maxLength: 64 }).trim();
  if (
    normalizedCode !== '' &&
    Object.prototype.hasOwnProperty.call(
      FULL_BACKEND_ERROR_DESCRIPTORS,
      normalizedCode,
    )
  ) {
    return FULL_BACKEND_ERROR_DESCRIPTORS[normalizedCode];
  }

  return resolveRoomErrorDescriptor(errorOrCode);
}

/**
 * Full-backend validation and authorization override scenarios extending
 * MALFORMED_TEST_SCENARIOS without mutating the POC preset array.
 */
export const FULL_BACKEND_VALIDATION_SCENARIOS = Object.freeze([
  ...MALFORMED_TEST_SCENARIOS,
  Object.freeze({
    id: 'missing-auth-token',
    label: 'Missing Room Auth Token',
    expectedCode: 'INVALID_PAYLOAD',
    event: 'room:join',
    payload: Object.freeze({ roomId: 'ship-0000' }),
    description:
      'Emit room:join without authToken when REQUIRE_ROOM_AUTH=true.',
    resolveInvocation: (context = {}) => ({
      event: 'room:join',
      payload: {
        roomId:
          typeof context.targetRoomId === 'string' &&
          context.targetRoomId.trim() !== ''
            ? context.targetRoomId.trim()
            : typeof context.roomId === 'string' && context.roomId.trim() !== ''
              ? context.roomId.trim()
              : 'ship-0000',
      },
    }),
  }),
  Object.freeze({
    id: 'invalid-auth-token',
    label: 'Invalid Room Auth Token',
    expectedCode: 'UNAUTHORIZED',
    event: 'room:join',
    payload: Object.freeze({
      roomId: 'ship-0000',
      authToken: 'invalid-prototype-auth-token',
    }),
    description:
      'Emit room:join with a mismatched authToken to verify UNAUTHORIZED precedence.',
    resolveInvocation: (context = {}) => ({
      event: 'room:join',
      payload: {
        roomId:
          typeof context.targetRoomId === 'string' &&
          context.targetRoomId.trim() !== ''
            ? context.targetRoomId.trim()
            : typeof context.roomId === 'string' && context.roomId.trim() !== ''
              ? context.roomId.trim()
              : 'ship-0000',
        authToken: 'invalid-prototype-auth-token',
      },
    }),
  }),
]);
