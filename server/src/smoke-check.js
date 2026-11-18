import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { io } from 'socket.io-client';

export const DEFAULT_STAGING_BASE_URL = 'https://poc.shipri.app';
export const DEFAULT_SMOKE_TIMEOUT_MS = 5_000;

const CANONICAL_ROOM_ID_PATTERN = /^ship-[a-f0-9]{4}$/;

function validateBaseUrl(rawBaseUrl) {
  if (rawBaseUrl === undefined) {
    return DEFAULT_STAGING_BASE_URL;
  }

  if (typeof rawBaseUrl !== 'string') {
    throw new Error(
      'Invalid SMOKE_BASE_URL configuration: URL must be a non-empty HTTP(S) URL.',
    );
  }

  const trimmed = rawBaseUrl.trim();
  if (trimmed.length === 0) {
    throw new Error(
      'Invalid SMOKE_BASE_URL configuration: URL must be a non-empty HTTP(S) URL.',
    );
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(trimmed);
  } catch {
    throw new Error(
      `Invalid SMOKE_BASE_URL configuration: "${trimmed}" is not a valid URL.`,
    );
  }

  const isHttpScheme =
    parsedUrl.protocol === 'https:' || parsedUrl.protocol === 'http:';
  if (!isHttpScheme) {
    throw new Error(
      `Invalid SMOKE_BASE_URL configuration: "${trimmed}" must use http:// or https://.`,
    );
  }

  const hasCredentials = parsedUrl.username !== '' || parsedUrl.password !== '';
  if (hasCredentials || parsedUrl.search !== '' || parsedUrl.hash !== '') {
    throw new Error(
      `Invalid SMOKE_BASE_URL configuration: "${trimmed}" must not include credentials, query, or fragment.`,
    );
  }

  const normalizedPath = parsedUrl.pathname.replace(/\/+$/, '');
  return `${parsedUrl.origin}${normalizedPath}`;
}

function validateSmokeOrigin(rawOrigin, fallbackOrigin) {
  if (rawOrigin === undefined) {
    return fallbackOrigin;
  }

  if (typeof rawOrigin !== 'string') {
    throw new Error(
      'Invalid SMOKE_ORIGIN configuration: origin must be a canonical HTTP(S) origin.',
    );
  }

  const trimmed = rawOrigin.trim();
  if (trimmed === '' || trimmed === '*') {
    throw new Error(
      `Invalid SMOKE_ORIGIN configuration: "${trimmed}" is not an allowed canonical origin.`,
    );
  }

  let parsedOrigin;
  try {
    parsedOrigin = new URL(trimmed);
  } catch {
    throw new Error(
      `Invalid SMOKE_ORIGIN configuration: "${trimmed}" is not a valid HTTP(S) origin.`,
    );
  }

  const isHttpScheme =
    parsedOrigin.protocol === 'https:' || parsedOrigin.protocol === 'http:';
  const hasCredentials =
    parsedOrigin.username !== '' || parsedOrigin.password !== '';
  if (!isHttpScheme || hasCredentials || trimmed !== parsedOrigin.origin) {
    throw new Error(
      `Invalid SMOKE_ORIGIN configuration: "${trimmed}" must be a canonical HTTP(S) origin without path, query, or fragment.`,
    );
  }

  return trimmed;
}

function validateTimeoutMs(rawTimeout) {
  if (rawTimeout === undefined) {
    return DEFAULT_SMOKE_TIMEOUT_MS;
  }

  if (typeof rawTimeout !== 'string' && typeof rawTimeout !== 'number') {
    throw new Error(
      'Invalid SMOKE_TIMEOUT_MS configuration: expected a positive integer in milliseconds.',
    );
  }

  const normalized = String(rawTimeout).trim();
  if (!/^\d+$/.test(normalized)) {
    throw new Error(
      'Invalid SMOKE_TIMEOUT_MS configuration: expected a positive integer in milliseconds.',
    );
  }

  const timeoutMs = Number.parseInt(normalized, 10);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error(
      'Invalid SMOKE_TIMEOUT_MS configuration: expected a positive integer in milliseconds.',
    );
  }

  return timeoutMs;
}

/**
 * Resolves and validates Backend POC staging smoke check settings without secrets.
 */
export function resolveSmokeCheckConfig(env = process.env) {
  const baseUrl = validateBaseUrl(env?.SMOKE_BASE_URL);
  const parsedBaseOrigin = new URL(baseUrl).origin;
  const origin = validateSmokeOrigin(env?.SMOKE_ORIGIN, parsedBaseOrigin);
  const timeoutMs = validateTimeoutMs(env?.SMOKE_TIMEOUT_MS);
  const requireHttps = env?.SMOKE_ALLOW_HTTP !== 'true';

  return Object.freeze({
    baseUrl,
    origin,
    timeoutMs,
    requireHttps,
  });
}

function assertHttpsRequired(config) {
  if (config.requireHttps && !config.baseUrl.startsWith('https://')) {
    throw new Error(
      `Staging smoke checks require an https:// target URL (received "${config.baseUrl}"). Set SMOKE_ALLOW_HTTP=true only for local testing.`,
    );
  }
}

/**
 * Verifies GET /health HTTP status, Cache-Control, CORS origin header, and JSON payload.
 */
export async function verifyHealthEndpoint(config) {
  assertHttpsRequired(config);

  const healthUrl = `${config.baseUrl}/health`;
  const response = await fetch(healthUrl, {
    method: 'GET',
    headers: { Origin: config.origin },
    signal: AbortSignal.timeout(config.timeoutMs),
  });

  if (response.status !== 200) {
    throw new Error(
      `Health check returned HTTP ${response.status} from ${healthUrl}.`,
    );
  }

  const cacheControl = response.headers.get('cache-control');
  if (cacheControl !== 'no-store') {
    throw new Error(
      `Health check expected Cache-Control "no-store", received "${cacheControl}".`,
    );
  }

  const allowOrigin = response.headers.get('access-control-allow-origin');
  if (allowOrigin !== config.origin) {
    throw new Error(
      `Health check CORS check failed for Origin "${config.origin}": access-control-allow-origin was "${allowOrigin}".`,
    );
  }

  let body;
  try {
    body = await response.json();
  } catch (error) {
    throw new Error(
      `Health check returned invalid JSON from ${healthUrl}: ${error.message}`,
    );
  }

  const hasValidShape =
    body !== null &&
    typeof body === 'object' &&
    !Array.isArray(body) &&
    body.status === 'ok' &&
    Number.isInteger(body.roomsCount) &&
    body.roomsCount >= 0;

  if (!hasValidShape) {
    throw new Error(
      `Health check returned invalid health payload from ${healthUrl}: ${JSON.stringify(body)}.`,
    );
  }

  return {
    status: body.status,
    roomsCount: body.roomsCount,
    allowOrigin,
  };
}

function waitForSocketConnection(socket, timeoutMs) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      socket.off('connect', handleConnect);
      socket.off('connect_error', handleConnectError);
    };

    const handleConnect = () => {
      cleanup();
      resolve();
    };

    const handleConnectError = (error) => {
      cleanup();
      reject(
        new Error(
          `Socket.IO WebSocket connection failed: ${error?.message || 'unknown error'}`,
        ),
      );
    };

    const timer = setTimeout(() => {
      cleanup();
      reject(
        new Error(
          `Socket.IO WebSocket connection timed out after ${timeoutMs}ms.`,
        ),
      );
    }, timeoutMs);

    socket.once('connect', handleConnect);
    socket.once('connect_error', handleConnectError);
    socket.connect();
  });
}

function createRoomOverSocket(socket, timeoutMs) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      socket.off('room:created', handleCreated);
      socket.off('room:error', handleRoomError);
    };

    const handleCreated = (payload) => {
      cleanup();
      resolve(payload);
    };

    const handleRoomError = (error) => {
      cleanup();
      const code = error?.code || 'UNKNOWN_ERROR';
      const message = error?.message || 'room:create failed';
      reject(new Error(`Socket.IO room:create failed (${code}): ${message}`));
    };

    const timer = setTimeout(() => {
      cleanup();
      reject(
        new Error(`Timed out waiting for room:created after ${timeoutMs}ms.`),
      );
    }, timeoutMs);

    socket.once('room:created', handleCreated);
    socket.once('room:error', handleRoomError);
    socket.emit('room:create', {});
  });
}

function closeSocketAndWait(socket) {
  const ws = socket?.io?.engine?.transport?.ws;
  if (!ws || typeof ws.once !== 'function' || ws.readyState >= 2) {
    socket.removeAllListeners();
    socket.disconnect();
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      resolve();
    };

    // Wait briefly for the underlying WebSocket close frame so server cleanup finishes before returning.
    const timer = setTimeout(finish, 250);
    ws.once('close', finish);
    socket.removeAllListeners();
    socket.disconnect();
  });
}

/**
 * Verifies remote Socket.IO connectivity over WebSocket/WSS and cleans up the probe room.
 */
export async function verifyWssSocketConnection(config) {
  assertHttpsRequired(config);

  const socket = io(config.baseUrl, {
    autoConnect: false,
    forceNew: true,
    reconnection: false,
    transports: ['websocket'],
    timeout: config.timeoutMs,
    extraHeaders: {
      Origin: config.origin,
    },
  });

  try {
    await waitForSocketConnection(socket, config.timeoutMs);

    const created = await createRoomOverSocket(socket, config.timeoutMs);
    if (
      !created ||
      typeof created.roomId !== 'string' ||
      !CANONICAL_ROOM_ID_PATTERN.test(created.roomId) ||
      created.negotiationDuty !== 'offerer'
    ) {
      throw new Error(
        `Unexpected room:created payload during smoke check: ${JSON.stringify(created)}.`,
      );
    }

    socket.emit('room:leave', { roomId: created.roomId });

    return {
      transport: socket.io.engine.transport.name,
      secure: config.baseUrl.startsWith('https://'),
      roomId: created.roomId,
    };
  } finally {
    await closeSocketAndWait(socket);
  }
}

/**
 * Runs the Backend POC staging health and WSS Socket.IO smoke checks.
 */
export async function runStagingSmokeChecks({ env = process.env } = {}) {
  const config = resolveSmokeCheckConfig(env);
  assertHttpsRequired(config);

  const health = await verifyHealthEndpoint(config);
  const socket = await verifyWssSocketConnection(config);

  return {
    ok: true,
    baseUrl: config.baseUrl,
    origin: config.origin,
    health,
    socket,
  };
}

/**
 * Executes the staging smoke checks and formats pass/fail output with an exit code.
 */
export async function runStagingSmokeCli({
  env = process.env,
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  try {
    const result = await runStagingSmokeChecks({ env });
    stdout.write(
      `[PASS] Backend POC staging smoke checks passed for ${result.baseUrl} (health=${result.health.status}, roomsCount=${result.health.roomsCount}, transport=${result.socket.transport}, roomId=${result.socket.roomId})\n`,
    );
    return 0;
  } catch (error) {
    stderr.write(
      `[FAIL] Backend POC staging smoke checks failed: ${error?.message || error}\n`,
    );
    return 1;
  }
}

function isDirectExecution() {
  if (!process.argv[1]) {
    return false;
  }

  try {
    return (
      realpathSync(process.argv[1]) ===
      realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
}

if (isDirectExecution()) {
  const exitCode = await runStagingSmokeCli();
  process.exitCode = exitCode;
}
