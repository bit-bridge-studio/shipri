const ROOM_ID_PATTERN = /^ship-[a-f0-9]{4}$/;
const ALLOWED_ICE_ENTRY_KEYS = new Set(['urls', 'username', 'credential']);
const STUN_SCHEMES = new Set(['stun', 'stuns']);
const TURN_SCHEMES = new Set(['turn', 'turns']);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseIceScheme(rawUrl) {
  if (typeof rawUrl !== 'string') {
    return null;
  }
  const trimmed = rawUrl.trim();
  if (trimmed === '' || /\s/.test(trimmed)) {
    return null;
  }
  const match = /^([a-z][a-z0-9+.-]*):(.+)$/i.exec(trimmed);
  if (!match) {
    return null;
  }
  const scheme = match[1].toLowerCase();
  if (!STUN_SCHEMES.has(scheme) && !TURN_SCHEMES.has(scheme)) {
    return null;
  }
  const remainder = match[2];
  if (remainder.startsWith('//') || remainder.trim() === '') {
    return null;
  }
  return { scheme, url: trimmed };
}

function createInvalidIceError(message, roomId) {
  return {
    code: 'INVALID_ICE_CREDENTIALS',
    ...(roomId ? { roomId } : {}),
    message,
  };
}

/**
 * Validates an inbound production ice:credentials payload containing STUN and
 * optional/required ephemeral TURN entries without exposing credentials in errors.
 * @param {unknown} payload
 * @param {{ expectedRoomId?: string, requireTurn?: boolean }} [options]
 */
export function validateProductionIceServers(payload, options = {}) {
  const safeOptions = isPlainObject(options) ? options : {};
  const expectedRoomId =
    typeof safeOptions.expectedRoomId === 'string' &&
    ROOM_ID_PATTERN.test(safeOptions.expectedRoomId)
      ? safeOptions.expectedRoomId
      : null;
  const requireTurn = safeOptions.requireTurn === true;

  if (!isPlainObject(payload)) {
    return {
      ok: false,
      error: createInvalidIceError(
        'ICE configuration payload must be an object.',
        expectedRoomId,
      ),
    };
  }

  const roomId =
    typeof payload.roomId === 'string' && ROOM_ID_PATTERN.test(payload.roomId)
      ? payload.roomId
      : null;
  if (!roomId) {
    return {
      ok: false,
      error: createInvalidIceError(
        'ICE configuration payload is missing a canonical roomId.',
        expectedRoomId,
      ),
    };
  }

  if (expectedRoomId && roomId !== expectedRoomId) {
    return {
      ok: false,
      error: createInvalidIceError(
        'ICE configuration roomId does not match the active room.',
        roomId,
      ),
    };
  }

  if (!Array.isArray(payload.iceServers) || payload.iceServers.length === 0) {
    return {
      ok: false,
      error: createInvalidIceError(
        'ICE configuration must provide at least one valid server entry.',
        roomId,
      ),
    };
  }

  const sanitizedServers = [];
  let stunCount = 0;
  let turnCount = 0;

  for (const entry of payload.iceServers) {
    if (!isPlainObject(entry)) {
      return {
        ok: false,
        error: createInvalidIceError(
          'Each ICE server entry must be a plain object.',
          roomId,
        ),
      };
    }

    for (const key of Object.keys(entry)) {
      if (!ALLOWED_ICE_ENTRY_KEYS.has(key)) {
        return {
          ok: false,
          error: createInvalidIceError(
            'ICE server entry contains an unsupported field.',
            roomId,
          ),
        };
      }
    }

    const rawUrls = Array.isArray(entry.urls)
      ? entry.urls
      : typeof entry.urls === 'string'
        ? [entry.urls]
        : null;
    if (!rawUrls || rawUrls.length === 0) {
      return {
        ok: false,
        error: createInvalidIceError(
          'ICE server entry must contain at least one URL.',
          roomId,
        ),
      };
    }

    const normalizedUrls = [];
    let entryHasTurn = false;
    for (const rawUrl of rawUrls) {
      const parsed = parseIceScheme(rawUrl);
      if (!parsed) {
        return {
          ok: false,
          error: createInvalidIceError(
            'ICE server entry contains an unsupported or malformed URL.',
            roomId,
          ),
        };
      }
      normalizedUrls.push(parsed.url);
      if (TURN_SCHEMES.has(parsed.scheme)) {
        entryHasTurn = true;
        turnCount += 1;
      } else {
        stunCount += 1;
      }
    }

    const hasUsername =
      typeof entry.username === 'string' && entry.username.trim() !== '';
    const hasCredential =
      typeof entry.credential === 'string' && entry.credential.trim() !== '';

    if (entryHasTurn && (!hasUsername || !hasCredential)) {
      return {
        ok: false,
        error: createInvalidIceError(
          'TURN server entries must include non-empty ephemeral credentials.',
          roomId,
        ),
      };
    }

    if (
      !entryHasTurn &&
      (entry.username !== undefined || entry.credential !== undefined)
    ) {
      return {
        ok: false,
        error: createInvalidIceError(
          'STUN-only server entries must not include TURN credentials.',
          roomId,
        ),
      };
    }

    sanitizedServers.push({
      urls: normalizedUrls.length === 1 ? normalizedUrls[0] : normalizedUrls,
      ...(entryHasTurn
        ? { username: entry.username, credential: entry.credential }
        : {}),
    });
  }

  if (requireTurn && turnCount === 0) {
    return {
      ok: false,
      error: createInvalidIceError(
        'Production relay policy requires at least one TURN server entry.',
        roomId,
      ),
    };
  }

  return {
    ok: true,
    roomId,
    iceServers: sanitizedServers,
    stunCount,
    turnCount,
    hasTurn: turnCount > 0,
  };
}
