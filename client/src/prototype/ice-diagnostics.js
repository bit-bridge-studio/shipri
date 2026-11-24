import { sanitizeTextValue } from '../signaling/socket-client.js';

const ROOM_ID_PATTERN = /^ship-[a-f0-9]{4}$/;
const HOSTNAME_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/;
const IPV6_HOST_PATTERN = /^\[[0-9A-Fa-f:.%]+\]$/;
const PORT_PATTERN = /^\d{1,5}$/;

const ALLOWED_ICE_SCHEMES = new Set(['stun', 'stuns', 'turn', 'turns']);
const STUN_SCHEMES = new Set(['stun', 'stuns']);
const TURN_SCHEMES = new Set(['turn', 'turns']);
const VALID_ICE_STATUSES = new Set([
  'idle',
  'loading',
  'ready',
  'invalid',
  'error',
]);

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isValidRoomId(roomId) {
  return typeof roomId === 'string' && ROOM_ID_PATTERN.test(roomId);
}

function parseAuthority(authority) {
  if (!authority) {
    return { ok: false, reason: 'uri' };
  }

  let host = '';
  let portStr;

  if (authority.startsWith('[')) {
    const closeIdx = authority.indexOf(']');
    if (closeIdx <= 1) {
      return { ok: false, reason: 'uri' };
    }
    host = authority.slice(0, closeIdx + 1);
    if (!IPV6_HOST_PATTERN.test(host) || !host.includes(':')) {
      return { ok: false, reason: 'uri' };
    }
    const remainder = authority.slice(closeIdx + 1);
    if (remainder !== '') {
      if (!remainder.startsWith(':')) {
        return { ok: false, reason: 'uri' };
      }
      portStr = remainder.slice(1);
    }
  } else {
    const firstColon = authority.indexOf(':');
    const lastColon = authority.lastIndexOf(':');
    if (firstColon !== lastColon) {
      return { ok: false, reason: 'uri' };
    }
    host = firstColon === -1 ? authority : authority.slice(0, firstColon);
    portStr =
      firstColon === -1 ? undefined : authority.slice(firstColon + 1);
    if (!HOSTNAME_PATTERN.test(host) || host.includes('..')) {
      return { ok: false, reason: 'uri' };
    }
  }

  if (portStr !== undefined) {
    if (!PORT_PATTERN.test(portStr)) {
      return { ok: false, reason: 'port' };
    }
    const port = Number.parseInt(portStr, 10);
    if (
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65535 ||
      String(port) !== portStr
    ) {
      return { ok: false, reason: 'port' };
    }
  }

  return { ok: true };
}

function parseIceEndpointUrl(rawUrl) {
  if (
    typeof rawUrl !== 'string' ||
    rawUrl === '' ||
    rawUrl !== rawUrl.trim() ||
    /\s/.test(rawUrl)
  ) {
    return { ok: false, reason: 'uri' };
  }

  const colonIndex = rawUrl.indexOf(':');
  if (colonIndex <= 0) {
    return { ok: false, reason: 'uri' };
  }

  const scheme = rawUrl.slice(0, colonIndex).toLowerCase();
  if (!ALLOWED_ICE_SCHEMES.has(scheme)) {
    return { ok: false, reason: 'scheme' };
  }

  const body = rawUrl.slice(colonIndex + 1);
  if (!body || body.startsWith('//') || /[@/#]/.test(body)) {
    return { ok: false, reason: 'uri' };
  }

  const isTurn = TURN_SCHEMES.has(scheme);
  let authority = body;
  const queryIndex = body.indexOf('?');

  if (queryIndex !== -1) {
    if (!isTurn) {
      return { ok: false, reason: 'uri' };
    }
    if (queryIndex === body.length - 1) {
      return { ok: false, reason: 'uri' };
    }
    authority = body.slice(0, queryIndex);
  }

  const authorityResult = parseAuthority(authority);
  if (!authorityResult.ok) {
    return authorityResult;
  }

  return {
    ok: true,
    scheme,
    isTurn,
  };
}

function buildInvalidIceError(message, roomId) {
  const safeMessage =
    sanitizeTextValue(message, { maxLength: 160 }) ||
    'Invalid ICE configuration payload.';

  return {
    ok: false,
    error: {
      code: 'INVALID_ICE_CREDENTIALS',
      ...(isValidRoomId(roomId) ? { roomId } : {}),
      message: safeMessage,
    },
  };
}

function sanitizeDiagnosticError(errorLike) {
  if (errorLike === null || errorLike === undefined) {
    return null;
  }

  if (typeof errorLike === 'string' || errorLike instanceof Error) {
    const message = sanitizeTextValue(errorLike, { maxLength: 160 });
    return message ? { code: 'UNKNOWN_ERROR', message } : null;
  }

  if (!isPlainObject(errorLike)) {
    return null;
  }

  const code =
    sanitizeTextValue(errorLike.code, { maxLength: 64 }) || 'UNKNOWN_ERROR';
  const message =
    sanitizeTextValue(errorLike.message ?? errorLike.error, {
      maxLength: 160,
    }) || 'Unknown ICE error';
  const roomId = isValidRoomId(errorLike.roomId) ? errorLike.roomId : undefined;

  return {
    code,
    ...(roomId ? { roomId } : {}),
    message,
  };
}

function toNonNegativeInt(value) {
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

/**
 * Creates the initial sanitized state structure for ICE configuration diagnostics.
 * @param {Record<string, unknown>} [overrides]
 */
export function createInitialIceDiagnosticsState(overrides = {}) {
  if (overrides !== undefined && !isPlainObject(overrides)) {
    throw new TypeError(
      'Initial ICE diagnostics state overrides must be a plain object.',
    );
  }

  const source = overrides ?? {};
  const status =
    typeof source.status === 'string' && VALID_ICE_STATUSES.has(source.status)
      ? source.status
      : 'idle';
  const roomId = isValidRoomId(source.roomId) ? source.roomId : null;
  const serverEntryCount = toNonNegativeInt(source.serverEntryCount);
  const endpointCount = toNonNegativeInt(source.endpointCount);
  const stunCount = toNonNegativeInt(source.stunCount);
  const turnCount = toNonNegativeInt(source.turnCount);

  const schemeSet = new Set();
  if (Array.isArray(source.schemes)) {
    for (const scheme of source.schemes) {
      if (typeof scheme === 'string') {
        const normalized = scheme.trim().toLowerCase();
        if (ALLOWED_ICE_SCHEMES.has(normalized)) {
          schemeSet.add(normalized);
        }
      }
    }
  }

  const isStunOnly =
    typeof source.isStunOnly === 'boolean'
      ? source.isStunOnly
      : stunCount > 0 && turnCount === 0;

  return {
    status,
    roomId,
    serverEntryCount,
    endpointCount,
    schemes: [...schemeSet],
    stunCount,
    turnCount,
    isStunOnly,
    endpointsRedacted: true,
    lastError: sanitizeDiagnosticError(source.lastError),
  };
}

/**
 * Summarizes an RTCIceServer list into counts and schemes without exposing endpoints or credentials.
 * @param {unknown} iceServers
 */
export function summarizeIceServers(iceServers) {
  if (!Array.isArray(iceServers)) {
    return {
      serverEntryCount: 0,
      endpointCount: 0,
      schemes: [],
      stunCount: 0,
      turnCount: 0,
      isStunOnly: false,
      endpointsRedacted: true,
    };
  }

  const schemeSet = new Set();
  let stunCount = 0;
  let turnCount = 0;
  let invalidEndpointCount = 0;

  for (const entry of iceServers) {
    if (!isPlainObject(entry) || entry.urls === undefined) {
      continue;
    }

    const urlList = Array.isArray(entry.urls) ? entry.urls : [entry.urls];
    for (const rawUrl of urlList) {
      const parsed = parseIceEndpointUrl(rawUrl);
      if (!parsed.ok) {
        invalidEndpointCount += 1;
        continue;
      }

      schemeSet.add(parsed.scheme);
      if (parsed.isTurn) {
        turnCount += 1;
      } else if (STUN_SCHEMES.has(parsed.scheme)) {
        stunCount += 1;
      }
    }
  }

  const endpointCount = stunCount + turnCount;

  return {
    serverEntryCount: iceServers.length,
    endpointCount,
    schemes: [...schemeSet],
    stunCount,
    turnCount,
    isStunOnly: stunCount > 0 && turnCount === 0 && invalidEndpointCount === 0,
    endpointsRedacted: true,
  };
}

/**
 * Validates a Backend POC STUN-only ice:credentials payload and returns either normalized
 * iceServers plus a redacted summary or a structured INVALID_ICE_CREDENTIALS error.
 * @param {unknown} payload
 * @param {{ expectedRoomId?: string }} [options]
 */
export function validateIceCredentialsPayload(payload, options = {}) {
  if (!isPlainObject(payload)) {
    return buildInvalidIceError('ICE credentials payload must be a plain object.');
  }

  const safeOptions = isPlainObject(options) ? options : {};
  const allowTurn = safeOptions.allowTurn === true;
  const expectedRoomId =
    typeof safeOptions.expectedRoomId === 'string' &&
    safeOptions.expectedRoomId.trim() !== ''
      ? safeOptions.expectedRoomId.trim()
      : undefined;

  if (!isValidRoomId(payload.roomId)) {
    return buildInvalidIceError(
      'Invalid or missing roomId in ICE configuration payload.',
    );
  }

  const roomId = payload.roomId;
  if (expectedRoomId !== undefined && roomId !== expectedRoomId) {
    return buildInvalidIceError(
      'ICE configuration roomId does not match the active room.',
      isValidRoomId(expectedRoomId) ? expectedRoomId : roomId,
    );
  }

  const hasUnexpectedTopLevelKey = Object.keys(payload).some(
    (key) => key !== 'roomId' && key !== 'iceServers',
  );
  if (hasUnexpectedTopLevelKey) {
    return buildInvalidIceError(
      'Unexpected auth or unsupported fields in development STUN-only ICE payload.',
      roomId,
    );
  }

  if (!Array.isArray(payload.iceServers) || payload.iceServers.length === 0) {
    return buildInvalidIceError(
      'ICE configuration payload must include a non-empty iceServers array.',
      roomId,
    );
  }

  const normalizedIceServers = [];
  for (const entry of payload.iceServers) {
    if (!isPlainObject(entry)) {
      return buildInvalidIceError(
        'Each iceServers entry must be a plain object.',
        roomId,
      );
    }

    const allowedEntryKeys = allowTurn
      ? new Set(['urls', 'username', 'credential'])
      : new Set(['urls']);
    const hasUnexpectedEntryKey = Object.keys(entry).some(
      (key) => !allowedEntryKeys.has(key),
    );
    if (hasUnexpectedEntryKey) {
      return buildInvalidIceError(
        allowTurn
          ? 'Unexpected unsupported fields in ICE server entry.'
          : 'Unexpected auth or unsupported fields in development STUN-only ICE server entry.',
        roomId,
      );
    }

    const isStringUrls = typeof entry.urls === 'string';
    const isArrayUrls = Array.isArray(entry.urls);
    if (!isStringUrls && !isArrayUrls) {
      return buildInvalidIceError(
        'Each iceServers entry must include at least one STUN URL.',
        roomId,
      );
    }

    const urlList = isArrayUrls ? entry.urls : [entry.urls];
    if (urlList.length === 0) {
      return buildInvalidIceError(
        'Each iceServers entry must include at least one STUN URL.',
        roomId,
      );
    }

    let entryHasTurn = false;
    let entryHasStun = false;
    for (const rawUrl of urlList) {
      const parsed = parseIceEndpointUrl(rawUrl);
      if (!parsed.ok) {
        if (parsed.reason === 'scheme') {
          return buildInvalidIceError(
            allowTurn
              ? 'Invalid ICE server URL scheme; expected stun:, stuns:, turn:, or turns:.'
              : 'Invalid ICE server URL scheme; expected stun: or stuns:.',
            roomId,
          );
        }
        if (parsed.reason === 'port') {
          return buildInvalidIceError(
            'Invalid port number in STUN server URI.',
            roomId,
          );
        }
        return buildInvalidIceError(
          'Invalid STUN server URI in ICE configuration payload.',
          roomId,
        );
      }

      if (parsed.isTurn) {
        if (!allowTurn) {
          return buildInvalidIceError(
            'TURN servers are not supported in POC development STUN-only ICE mode.',
            roomId,
          );
        }
        entryHasTurn = true;
      } else {
        entryHasStun = true;
      }
    }

    if (entryHasTurn) {
      if (entryHasStun) {
        return buildInvalidIceError(
          'ICE server entry must not mix STUN and TURN URLs.',
          roomId,
        );
      }
      if (
        typeof entry.username !== 'string' ||
        entry.username.trim() === '' ||
        typeof entry.credential !== 'string' ||
        entry.credential.trim() === ''
      ) {
        return buildInvalidIceError(
          'TURN ICE server entries must include non-empty username and credential strings.',
          roomId,
        );
      }

      normalizedIceServers.push({
        urls: isArrayUrls ? [...entry.urls] : entry.urls,
        username: entry.username,
        credential: entry.credential,
      });
      continue;
    }

    if (entry.username !== undefined || entry.credential !== undefined) {
      return buildInvalidIceError(
        'STUN-only ICE server entries must not include TURN credentials.',
        roomId,
      );
    }

    normalizedIceServers.push({
      urls: isArrayUrls ? [...entry.urls] : entry.urls,
    });
  }

  const summary = summarizeIceServers(normalizedIceServers);
  if ((!allowTurn && !summary.isStunOnly) || summary.endpointCount === 0) {
    return buildInvalidIceError(
      'ICE configuration payload must include valid development STUN endpoints.',
      roomId,
    );
  }

  return {
    ok: true,
    roomId,
    iceServers: normalizedIceServers,
    summary,
  };
}
