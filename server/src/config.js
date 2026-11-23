export const DEFAULT_NODE_ENV = 'development';
export const DEFAULT_PORT = 5001;

export const DEFAULT_ALLOWED_ORIGINS = Object.freeze([
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
]);

export const DEFAULT_STUN_URLS = Object.freeze([
  'stun:stun.l.google.com:19302',
  'stun:stun1.l.google.com:19302',
]);

export const DEFAULT_TRUST_PROXY = false;
export const DEFAULT_MAX_ROOMS = 5_000;
export const DEFAULT_ROOM_IDLE_TTL_MS = 1_800_000;
export const DEFAULT_ROOM_MAX_LIFETIME_MS = 14_400_000;
export const DEFAULT_ROOM_CLEANUP_INTERVAL_MS = 60_000;
export const DEFAULT_ROOM_CREATE_RATE_LIMIT_MAX = 10;
export const DEFAULT_ROOM_CREATE_RATE_LIMIT_WINDOW_MS = 60_000;
export const DEFAULT_TURN_URLS = Object.freeze([]);
export const DEFAULT_TURN_CREDENTIAL_TTL_SECONDS = 7_200;

const ALLOWED_NODE_ENVS = new Set(['development', 'production', 'test']);
const TRUST_PROXY_KEYWORDS = new Set(['loopback', 'linklocal', 'uniquelocal']);
const STUN_ENDPOINT_PATTERN = /^stuns?:([^:\s/?#]+):(\d{1,5})$/;
const TURN_ENDPOINT_PATTERN =
  /^turns?:([^:\s/?#]+):(\d{1,5})(?:\?transport=(udp|tcp))?$/;
const IPV4_OR_CIDR_PATTERN = /^(\d{1,3}\.){3}\d{1,3}(\/\d{1,2})?$/;
const IPV6_OR_CIDR_PATTERN = /^[0-9a-fA-F:]+(\/\d{1,3})?$/;

const configTurnSecrets = new WeakMap();

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseNodeEnv(rawNodeEnv) {
  if (rawNodeEnv === undefined) {
    return DEFAULT_NODE_ENV;
  }

  if (typeof rawNodeEnv !== 'string') {
    throw new Error(
      'Invalid NODE_ENV configuration: expected development, production, or test.',
    );
  }

  const normalized = rawNodeEnv.trim();
  if (!ALLOWED_NODE_ENVS.has(normalized)) {
    throw new Error(
      `Invalid NODE_ENV configuration: "${rawNodeEnv}" must be development, production, or test.`,
    );
  }

  return normalized;
}

function parsePort(rawPort) {
  if (rawPort === undefined) {
    return DEFAULT_PORT;
  }

  if (typeof rawPort !== 'string' && typeof rawPort !== 'number') {
    throw new Error(
      'Invalid PORT configuration: PORT must be an integer between 1 and 65535.',
    );
  }

  const normalized = String(rawPort).trim();
  if (!/^\d+$/.test(normalized)) {
    throw new Error(
      'Invalid PORT configuration: PORT must be an integer between 1 and 65535.',
    );
  }

  const port = Number.parseInt(normalized, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(
      'Invalid PORT configuration: PORT must be an integer between 1 and 65535.',
    );
  }

  return port;
}

function parseBoolean(rawValue, defaultValue, configName) {
  if (rawValue === undefined) {
    return defaultValue;
  }

  if (typeof rawValue === 'boolean') {
    return rawValue;
  }

  if (typeof rawValue === 'string') {
    const normalized = rawValue.trim().toLowerCase();
    if (normalized === 'true') {
      return true;
    }
    if (normalized === 'false') {
      return false;
    }
  }

  throw new Error(
    `Invalid ${configName} configuration: expected true or false.`,
  );
}

function parseIntegerInRange(rawValue, defaultValue, min, max, configName) {
  if (rawValue === undefined) {
    return defaultValue;
  }

  if (typeof rawValue !== 'string' && typeof rawValue !== 'number') {
    throw new Error(
      `Invalid ${configName} configuration: expected an integer between ${min} and ${max}.`,
    );
  }

  const normalized = String(rawValue).trim();
  if (!/^\d+$/.test(normalized)) {
    throw new Error(
      `Invalid ${configName} configuration: expected an integer between ${min} and ${max}.`,
    );
  }

  const parsed = Number.parseInt(normalized, 10);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(
      `Invalid ${configName} configuration: expected an integer between ${min} and ${max}.`,
    );
  }

  return parsed;
}

function parseTrustProxy(rawTrustProxy) {
  if (rawTrustProxy === undefined) {
    return DEFAULT_TRUST_PROXY;
  }

  if (typeof rawTrustProxy === 'boolean') {
    return rawTrustProxy;
  }

  if (typeof rawTrustProxy === 'number') {
    if (!Number.isInteger(rawTrustProxy) || rawTrustProxy < 0) {
      throw new Error(
        'Invalid TRUST_PROXY configuration: numeric hop count must be a non-negative integer.',
      );
    }
    return rawTrustProxy;
  }

  if (typeof rawTrustProxy !== 'string') {
    throw new Error(
      'Invalid TRUST_PROXY configuration: expected boolean, non-negative integer, or trusted proxy specification.',
    );
  }

  const normalized = rawTrustProxy.trim();
  if (normalized.length === 0) {
    throw new Error(
      'Invalid TRUST_PROXY configuration: value must not be empty.',
    );
  }

  const lower = normalized.toLowerCase();
  if (lower === 'true') {
    return true;
  }
  if (lower === 'false') {
    return false;
  }
  if (/^\d+$/.test(normalized)) {
    return Number.parseInt(normalized, 10);
  }
  if (/^-?\d+(\.\d+)?$/.test(normalized)) {
    throw new Error(
      'Invalid TRUST_PROXY configuration: numeric hop count must be a non-negative integer.',
    );
  }

  const entries = normalized
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (entries.length === 0) {
    throw new Error(
      'Invalid TRUST_PROXY configuration: value must not be empty.',
    );
  }

  for (const entry of entries) {
    const entryLower = entry.toLowerCase();
    const isKeyword = TRUST_PROXY_KEYWORDS.has(entryLower);
    const isIpv4 = IPV4_OR_CIDR_PATTERN.test(entry);
    const isIpv6 = entry.includes(':') && IPV6_OR_CIDR_PATTERN.test(entry);
    if (!isKeyword && !isIpv4 && !isIpv6) {
      throw new Error(
        `Invalid TRUST_PROXY configuration: "${entry}" is not a supported proxy setting.`,
      );
    }
  }

  return entries.join(',');
}

function parseStringList(
  rawValue,
  defaults,
  configName,
  validateItem,
  { allowEmpty = false } = {},
) {
  if (rawValue === undefined) {
    return Object.freeze([...defaults]);
  }

  let rawEntries;
  if (typeof rawValue === 'string') {
    rawEntries = rawValue.split(',');
  } else if (Array.isArray(rawValue)) {
    if (rawValue.some((entry) => typeof entry !== 'string')) {
      throw new Error(
        `Invalid ${configName} configuration: entries must be strings.`,
      );
    }
    rawEntries = rawValue;
  } else {
    throw new Error(
      `Invalid ${configName} configuration: expected a comma-separated string or string array.`,
    );
  }

  const normalizedEntries = rawEntries
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  if (normalizedEntries.length === 0) {
    if (allowEmpty) {
      return Object.freeze([]);
    }
    throw new Error(
      `Invalid ${configName} configuration: at least one valid entry is required.`,
    );
  }

  const validated = normalizedEntries.map(validateItem);
  return Object.freeze([...new Set(validated)]);
}

function validateOrigin(entry) {
  if (entry === '*') {
    throw new Error(
      'Invalid ALLOWED_ORIGINS configuration: wildcard "*" origin is not allowed.',
    );
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(entry);
  } catch {
    throw new Error(
      `Invalid ALLOWED_ORIGINS configuration: "${entry}" is not a valid HTTP(S) origin.`,
    );
  }

  const isHttpScheme =
    parsedUrl.protocol === 'http:' || parsedUrl.protocol === 'https:';
  const hasCredentials = parsedUrl.username !== '' || parsedUrl.password !== '';
  if (!isHttpScheme || hasCredentials || entry !== parsedUrl.origin) {
    throw new Error(
      `Invalid ALLOWED_ORIGINS configuration: "${entry}" must be a canonical HTTP(S) origin without path, query, or fragment.`,
    );
  }

  return entry;
}

function validateIceEndpointPort(portText, entry, configName) {
  const port = Number.parseInt(portText, 10);
  if (
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    String(port) !== portText
  ) {
    throw new Error(
      `Invalid ${configName} configuration: "${entry}" has an invalid port number.`,
    );
  }
}

function validateStunUrl(entry) {
  const match = STUN_ENDPOINT_PATTERN.exec(entry);
  if (!match) {
    throw new Error(
      `Invalid STUN_URLS configuration: "${entry}" must be a valid stun:host:port or stuns:host:port URL.`,
    );
  }

  validateIceEndpointPort(match[2], entry, 'STUN_URLS');
  return entry;
}

function validateTurnUrl(entry) {
  const match = TURN_ENDPOINT_PATTERN.exec(entry);
  if (!match) {
    throw new Error(
      `Invalid TURN_URLS configuration: "${entry}" must be a valid turn: or turns: URL with host, port, and optional udp/tcp transport.`,
    );
  }

  validateIceEndpointPort(match[2], entry, 'TURN_URLS');
  return entry;
}

function parseAllowedOrigins(rawOrigins) {
  return parseStringList(
    rawOrigins,
    DEFAULT_ALLOWED_ORIGINS,
    'ALLOWED_ORIGINS',
    validateOrigin,
  );
}

function parseStunUrls(rawStunUrls) {
  return parseStringList(
    rawStunUrls,
    DEFAULT_STUN_URLS,
    'STUN_URLS',
    validateStunUrl,
  );
}

function parseTurnUrls(rawTurnUrls) {
  return parseStringList(
    rawTurnUrls,
    DEFAULT_TURN_URLS,
    'TURN_URLS',
    validateTurnUrl,
    { allowEmpty: true },
  );
}

function resolveRuntimeStunUrls(rawStunUrls) {
  if (rawStunUrls === undefined) {
    return Object.freeze([...DEFAULT_STUN_URLS]);
  }

  try {
    return parseStunUrls(rawStunUrls);
  } catch {
    return Object.freeze([]);
  }
}

function resolveRuntimeTurnUrls(rawTurnUrls) {
  if (rawTurnUrls === undefined) {
    return Object.freeze([...DEFAULT_TURN_URLS]);
  }

  try {
    return parseTurnUrls(rawTurnUrls);
  } catch {
    return Object.freeze([]);
  }
}

function normalizeTurnSharedSecret(rawSecret) {
  if (rawSecret === undefined || rawSecret === null) {
    return null;
  }

  if (typeof rawSecret !== 'string') {
    throw new Error(
      'Invalid TURN_SHARED_SECRET configuration: secret must be a string.',
    );
  }

  const trimmed = rawSecret.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function buildValidatedConfig(values, turnSharedSecret) {
  const nodeEnv = parseNodeEnv(values.nodeEnv);
  const requireRoomAuth = parseBoolean(
    values.requireRoomAuth,
    nodeEnv === 'production',
    'REQUIRE_ROOM_AUTH',
  );

  if (nodeEnv === 'production' && !requireRoomAuth) {
    throw new Error(
      'Invalid REQUIRE_ROOM_AUTH configuration: REQUIRE_ROOM_AUTH=false is forbidden when NODE_ENV=production.',
    );
  }

  const roomIdleTtlMs = parseIntegerInRange(
    values.roomIdleTtlMs,
    DEFAULT_ROOM_IDLE_TTL_MS,
    1,
    86_400_000,
    'ROOM_IDLE_TTL_MS',
  );
  const roomMaxLifetimeMs = parseIntegerInRange(
    values.roomMaxLifetimeMs,
    DEFAULT_ROOM_MAX_LIFETIME_MS,
    1,
    86_400_000,
    'ROOM_MAX_LIFETIME_MS',
  );

  if (roomIdleTtlMs > roomMaxLifetimeMs) {
    throw new Error(
      'Invalid ROOM_IDLE_TTL_MS configuration: ROOM_IDLE_TTL_MS must not exceed ROOM_MAX_LIFETIME_MS.',
    );
  }

  const config = Object.freeze({
    nodeEnv,
    port: parsePort(values.port),
    allowedOrigins: parseAllowedOrigins(values.allowedOrigins),
    trustProxy: parseTrustProxy(values.trustProxy),
    requireRoomAuth,
    maxRooms: parseIntegerInRange(
      values.maxRooms,
      DEFAULT_MAX_ROOMS,
      1,
      65_536,
      'MAX_ROOMS',
    ),
    roomIdleTtlMs,
    roomMaxLifetimeMs,
    roomCleanupIntervalMs: parseIntegerInRange(
      values.roomCleanupIntervalMs,
      DEFAULT_ROOM_CLEANUP_INTERVAL_MS,
      1,
      86_400_000,
      'ROOM_CLEANUP_INTERVAL_MS',
    ),
    roomCreateRateLimitMax: parseIntegerInRange(
      values.roomCreateRateLimitMax,
      DEFAULT_ROOM_CREATE_RATE_LIMIT_MAX,
      1,
      100_000,
      'ROOM_CREATE_RATE_LIMIT_MAX',
    ),
    roomCreateRateLimitWindowMs: parseIntegerInRange(
      values.roomCreateRateLimitWindowMs,
      DEFAULT_ROOM_CREATE_RATE_LIMIT_WINDOW_MS,
      1,
      86_400_000,
      'ROOM_CREATE_RATE_LIMIT_WINDOW_MS',
    ),
    stunUrls: values.stunUrls,
    turnUrls: values.turnUrls,
    turnCredentialTtlSeconds: parseIntegerInRange(
      values.turnCredentialTtlSeconds,
      DEFAULT_TURN_CREDENTIAL_TTL_SECONDS,
      60,
      86_400,
      'TURN_CREDENTIAL_TTL_SECONDS',
    ),
    requireTurn: parseBoolean(values.requireTurn, false, 'REQUIRE_TURN'),
  });

  if (turnSharedSecret !== null) {
    configTurnSecrets.set(config, turnSharedSecret);
  }

  return config;
}

/**
 * Returns the non-enumerable TURN shared secret associated with a validated config object.
 */
export function getTurnSharedSecret(config) {
  return configTurnSecrets.get(config) ?? null;
}

/**
 * Resolves development-only STUN-only `iceServers` entries from runtime config.
 * Dynamic TURN credentials are added in BE-4 (`ice-service.js`).
 */
export function resolveDevelopmentIceServers(stunUrls) {
  if (stunUrls === undefined) {
    return { ok: false };
  }

  try {
    const validated = parseStunUrls(stunUrls);
    return {
      ok: true,
      iceServers: [{ urls: [...validated] }],
    };
  } catch {
    return { ok: false };
  }
}

/**
 * Loads and validates signaling runtime configuration from an environment map.
 */
export function loadConfig(env = process.env) {
  if (!isPlainObject(env)) {
    throw new Error('Invalid configuration: environment must be a plain object.');
  }

  const turnSharedSecret = normalizeTurnSharedSecret(env.TURN_SHARED_SECRET);

  return buildValidatedConfig(
    {
      nodeEnv: env.NODE_ENV,
      port: env.PORT,
      allowedOrigins: env.ALLOWED_ORIGINS,
      trustProxy: env.TRUST_PROXY,
      requireRoomAuth: env.REQUIRE_ROOM_AUTH,
      maxRooms: env.MAX_ROOMS,
      roomIdleTtlMs: env.ROOM_IDLE_TTL_MS,
      roomMaxLifetimeMs: env.ROOM_MAX_LIFETIME_MS,
      roomCleanupIntervalMs: env.ROOM_CLEANUP_INTERVAL_MS,
      roomCreateRateLimitMax: env.ROOM_CREATE_RATE_LIMIT_MAX,
      roomCreateRateLimitWindowMs: env.ROOM_CREATE_RATE_LIMIT_WINDOW_MS,
      stunUrls: parseStunUrls(env.STUN_URLS),
      turnUrls: parseTurnUrls(env.TURN_URLS),
      turnCredentialTtlSeconds: env.TURN_CREDENTIAL_TTL_SECONDS,
      requireTurn: env.REQUIRE_TURN,
    },
    turnSharedSecret,
  );
}

/**
 * Resolves and validates server configuration from explicit overrides or environment variables.
 */
export function resolveServerConfig(options = {}) {
  if (options === undefined) {
    return loadConfig();
  }

  if (!isPlainObject(options)) {
    throw new Error(
      'Invalid server configuration options: options must be a plain object.',
    );
  }

  const baseEnv = options.env !== undefined ? options.env : process.env;
  if (!isPlainObject(baseEnv)) {
    throw new Error(
      'Invalid server configuration options: env must be a plain object.',
    );
  }

  const rawStunUrls =
    options.stunUrls !== undefined ? options.stunUrls : baseEnv.STUN_URLS;
  const rawTurnUrls =
    options.turnUrls !== undefined ? options.turnUrls : baseEnv.TURN_URLS;
  const inheritedSecret = configTurnSecrets.get(options) ?? null;
  const turnSharedSecret =
    options.turnSharedSecret !== undefined
      ? normalizeTurnSharedSecret(options.turnSharedSecret)
      : inheritedSecret ??
        normalizeTurnSharedSecret(baseEnv.TURN_SHARED_SECRET);

  return buildValidatedConfig(
    {
      nodeEnv: options.nodeEnv !== undefined ? options.nodeEnv : baseEnv.NODE_ENV,
      port: options.port !== undefined ? options.port : baseEnv.PORT,
      allowedOrigins:
        options.allowedOrigins !== undefined
          ? options.allowedOrigins
          : baseEnv.ALLOWED_ORIGINS,
      trustProxy:
        options.trustProxy !== undefined
          ? options.trustProxy
          : baseEnv.TRUST_PROXY,
      requireRoomAuth:
        options.requireRoomAuth !== undefined
          ? options.requireRoomAuth
          : baseEnv.REQUIRE_ROOM_AUTH,
      maxRooms:
        options.maxRooms !== undefined ? options.maxRooms : baseEnv.MAX_ROOMS,
      roomIdleTtlMs:
        options.roomIdleTtlMs !== undefined
          ? options.roomIdleTtlMs
          : baseEnv.ROOM_IDLE_TTL_MS,
      roomMaxLifetimeMs:
        options.roomMaxLifetimeMs !== undefined
          ? options.roomMaxLifetimeMs
          : baseEnv.ROOM_MAX_LIFETIME_MS,
      roomCleanupIntervalMs:
        options.roomCleanupIntervalMs !== undefined
          ? options.roomCleanupIntervalMs
          : baseEnv.ROOM_CLEANUP_INTERVAL_MS,
      roomCreateRateLimitMax:
        options.roomCreateRateLimitMax !== undefined
          ? options.roomCreateRateLimitMax
          : baseEnv.ROOM_CREATE_RATE_LIMIT_MAX,
      roomCreateRateLimitWindowMs:
        options.roomCreateRateLimitWindowMs !== undefined
          ? options.roomCreateRateLimitWindowMs
          : baseEnv.ROOM_CREATE_RATE_LIMIT_WINDOW_MS,
      stunUrls: resolveRuntimeStunUrls(rawStunUrls),
      turnUrls: resolveRuntimeTurnUrls(rawTurnUrls),
      turnCredentialTtlSeconds:
        options.turnCredentialTtlSeconds !== undefined
          ? options.turnCredentialTtlSeconds
          : baseEnv.TURN_CREDENTIAL_TTL_SECONDS,
      requireTurn:
        options.requireTurn !== undefined
          ? options.requireTurn
          : baseEnv.REQUIRE_TURN,
    },
    turnSharedSecret,
  );
}
