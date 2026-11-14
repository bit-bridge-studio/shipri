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

const STUN_ENDPOINT_PATTERN = /^stuns?:([^:\s/?#]+):(\d{1,5})$/;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
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

function parseStringList(rawValue, defaults, configName, validateItem) {
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

function validateStunUrl(entry) {
  const match = STUN_ENDPOINT_PATTERN.exec(entry);
  if (!match) {
    throw new Error(
      `Invalid STUN_URLS configuration: "${entry}" must be a valid stun:host:port or stuns:host:port URL.`,
    );
  }

  const port = Number.parseInt(match[2], 10);
  if (
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    String(port) !== match[2]
  ) {
    throw new Error(
      `Invalid STUN_URLS configuration: "${entry}" has an invalid port number.`,
    );
  }

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

/**
 * Resolves development-only STUN-only `iceServers` entries from runtime config.
 * Dynamic TURN credentials are excluded from the Backend POC and deferred to production.
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
 * Loads and validates Backend POC runtime configuration from an environment map.
 */
export function loadConfig(env = process.env) {
  if (!isPlainObject(env)) {
    throw new Error('Invalid configuration: environment must be a plain object.');
  }

  return Object.freeze({
    port: parsePort(env.PORT),
    allowedOrigins: parseAllowedOrigins(env.ALLOWED_ORIGINS),
    stunUrls: parseStunUrls(env.STUN_URLS),
  });
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

  return Object.freeze({
    port: parsePort(options.port !== undefined ? options.port : baseEnv.PORT),
    allowedOrigins: parseAllowedOrigins(
      options.allowedOrigins !== undefined
        ? options.allowedOrigins
        : baseEnv.ALLOWED_ORIGINS,
    ),
    stunUrls: resolveRuntimeStunUrls(rawStunUrls),
  });
}
