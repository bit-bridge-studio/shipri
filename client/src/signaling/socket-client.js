import { io } from 'socket.io-client';

export const DEFAULT_SIGNALING_URL = 'http://localhost:5001';

const ROOM_ID_PATTERN = /^ship-[a-f0-9]{4}$/;
const SAFE_PEER_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const SAFE_SDP_TYPES = new Set(['offer', 'answer', 'pranswer', 'rollback']);
const ALLOWED_ICE_SCHEMES = new Set(['stun', 'stuns', 'turn', 'turns']);
const VALID_DIRECTIONS = new Set(['outbound', 'inbound', 'local']);

const POC_SERVER_EVENTS = Object.freeze([
  'room:created',
  'room:joined',
  'peer:joined',
  'peer:left',
  'signal:receive',
  'ice:credentials',
  'room:error',
]);

const REDACTED_KEY_NAMES = new Set([
  'signaldata',
  'sdp',
  'candidate',
  'iceservers',
  'username',
  'credential',
  'credentialtype',
  'turnsharedsecret',
  'turnsecret',
  'password',
  'secret',
  'token',
  'authtoken',
  'authverifier',
  'authverifierhash',
  'roomtoken',
  'accesstoken',
  'refreshtoken',
  'authorization',
  'key',
  'masterkey',
  'encryptionkey',
  'hashkey',
  'shareurl',
  'url',
  'fileid',
  'fileboard',
  'files',
  'filename',
  'filesize',
  'filetype',
  'mimetype',
  'sha256',
  'metadata',
  'encryptedmetadata',
  'ciphertext',
  'plaintext',
  'iv',
  'chunk',
  'chunks',
  'chunkdata',
  'chunkindex',
  'transferid',
  'epoch',
  'file',
  'blob',
  'arraybuffer',
  'buffer',
  'data',
]);

const DEFAULT_MAX_SUMMARY_LENGTH = 240;

function isObjectRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isBinaryLike(value) {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    return true;
  }
  if (typeof Blob !== 'undefined' && value instanceof Blob) {
    return true;
  }
  return false;
}

function normalizeKeyName(key) {
  return String(key).toLowerCase().replace(/[_-]/g, '');
}

function normalizeTimestamp(timestamp, now) {
  const raw =
    timestamp !== undefined
      ? timestamp
      : typeof now === 'function'
        ? now()
        : new Date().toISOString();

  if (typeof raw === 'string' && raw.trim() !== '') {
    return raw;
  }
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return new Date(raw).toISOString();
  }
  if (raw instanceof Date && !Number.isNaN(raw.getTime())) {
    return raw.toISOString();
  }
  return new Date().toISOString();
}

function extractCanonicalRoomId(payload) {
  if (!isObjectRecord(payload) || typeof payload.roomId !== 'string') {
    return undefined;
  }
  return ROOM_ID_PATTERN.test(payload.roomId) ? payload.roomId : undefined;
}

function extractSafePeerId(payload) {
  if (!isObjectRecord(payload) || typeof payload.peerId !== 'string') {
    return undefined;
  }
  return SAFE_PEER_ID_PATTERN.test(payload.peerId)
    ? payload.peerId
    : undefined;
}

function extractErrorMessage(errorLike) {
  if (typeof errorLike === 'string') {
    return errorLike;
  }
  if (errorLike instanceof Error) {
    return errorLike.message;
  }
  if (isObjectRecord(errorLike) && typeof errorLike.message === 'string') {
    return errorLike.message;
  }
  return '';
}

function extractErrorCode(errorLike) {
  if (isObjectRecord(errorLike) && typeof errorLike.code === 'string') {
    const sanitized = sanitizeTextValue(errorLike.code, { maxLength: 64 });
    return sanitized || undefined;
  }
  return undefined;
}

function summarizeSignalData(signalData) {
  if (!isObjectRecord(signalData)) {
    return { signalKind: 'unknown' };
  }

  const descriptionSource = isObjectRecord(signalData.description)
    ? signalData.description
    : signalData;

  if (typeof descriptionSource.type === 'string') {
    const normalizedType = descriptionSource.type.toLowerCase();
    if (SAFE_SDP_TYPES.has(normalizedType)) {
      return { signalKind: 'sdp', sdpType: normalizedType };
    }
  }

  if (typeof descriptionSource.sdp === 'string') {
    return { signalKind: 'sdp' };
  }

  if (
    Object.prototype.hasOwnProperty.call(signalData, 'candidate') ||
    signalData.type === 'ice' ||
    signalData.type === 'candidate'
  ) {
    const endOfCandidates =
      signalData.candidate === null ||
      signalData.candidate === '' ||
      (isObjectRecord(signalData.candidate) &&
        (signalData.candidate.candidate === '' ||
          signalData.candidate.candidate === null));
    return endOfCandidates
      ? { signalKind: 'ice', endOfCandidates: true }
      : { signalKind: 'ice' };
  }

  return { signalKind: 'unknown' };
}

function formatSignalLabel(signalMeta) {
  if (signalMeta.signalKind === 'sdp') {
    return signalMeta.sdpType ? `sdp (${signalMeta.sdpType})` : 'sdp';
  }
  if (signalMeta.signalKind === 'ice') {
    return signalMeta.endOfCandidates ? 'ice (end-of-candidates)' : 'ice';
  }
  return 'unknown';
}

function collectIceSchemes(rawUrls, schemeSet) {
  const urlList = Array.isArray(rawUrls) ? rawUrls : [rawUrls];
  for (const entry of urlList) {
    if (typeof entry !== 'string') {
      continue;
    }
    const colonIndex = entry.indexOf(':');
    if (colonIndex <= 0) {
      continue;
    }
    const scheme = entry.slice(0, colonIndex).trim().toLowerCase();
    if (ALLOWED_ICE_SCHEMES.has(scheme)) {
      schemeSet.add(scheme);
    }
  }
}

function summarizeIceServers(iceServers) {
  if (!Array.isArray(iceServers)) {
    return {
      valid: false,
      serverCount: 0,
      schemes: [],
      hasTurn: false,
    };
  }

  const schemeSet = new Set();
  for (const server of iceServers) {
    if (isObjectRecord(server) && server.urls !== undefined) {
      collectIceSchemes(server.urls, schemeSet);
    }
  }

  const schemes = [...schemeSet];
  return {
    valid: iceServers.length > 0 && schemes.length > 0,
    serverCount: iceServers.length,
    schemes,
    hasTurn: schemeSet.has('turn') || schemeSet.has('turns'),
  };
}

function summarizeGenericPayload(eventName, payload) {
  if (payload === undefined || payload === null) {
    return `Event ${eventName}`;
  }
  if (isBinaryLike(payload)) {
    return `Event ${eventName} ([REDACTED_BINARY])`;
  }
  if (!isObjectRecord(payload)) {
    if (typeof payload === 'string') {
      const safeText = sanitizeTextValue(payload, { maxLength: 120 });
      return safeText ? `Event ${eventName}: ${safeText}` : `Event ${eventName}`;
    }
    return `Event ${eventName}`;
  }

  const entries = [];
  for (const [key, value] of Object.entries(payload).slice(0, 8)) {
    const safeKey = sanitizeTextValue(key, { maxLength: 40 });
    if (!safeKey) {
      continue;
    }
    if (REDACTED_KEY_NAMES.has(normalizeKeyName(key))) {
      entries.push(`${safeKey}=[REDACTED]`);
      continue;
    }
    if (isBinaryLike(value)) {
      entries.push(`${safeKey}=[REDACTED_BINARY]`);
      continue;
    }
    if (typeof value === 'string') {
      entries.push(`${safeKey}=${sanitizeTextValue(value, { maxLength: 64 })}`);
      continue;
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
      entries.push(`${safeKey}=${String(value)}`);
      continue;
    }
    if (Array.isArray(value)) {
      entries.push(`${safeKey}=[array:${value.length}]`);
      continue;
    }
    if (isObjectRecord(value)) {
      entries.push(`${safeKey}=[object]`);
    }
  }

  return entries.length > 0
    ? `Event ${eventName} (${entries.join(', ')})`
    : `Event ${eventName}`;
}

function buildNormalizedPayloadDetails(safeEvent, payload) {
  const roomId = extractCanonicalRoomId(payload);
  const peerId = extractSafePeerId(payload);
  const roomLabel = roomId ?? (isObjectRecord(payload) && 'roomId' in payload ? '(invalid roomId)' : '(missing roomId)');

  switch (safeEvent) {
    case 'connect':
      return {
        summary: 'Connected to signaling server',
      };

    case 'disconnect': {
      const reason =
        sanitizeTextValue(
          typeof payload === 'string'
            ? payload
            : isObjectRecord(payload)
              ? payload.reason
              : '',
          { maxLength: 80 },
        ) || 'unknown';
      return {
        summary: `Disconnected (${reason})`,
        meta: { reason },
      };
    }

    case 'connect_error': {
      const message =
        sanitizeTextValue(extractErrorMessage(payload), { maxLength: 160 }) ||
        'Unknown connection error';
      const code = extractErrorCode(payload);
      return {
        code,
        summary: `Connection error: ${message}`,
        meta: {
          message,
          ...(code ? { code } : {}),
        },
      };
    }

    case 'room:create':
      return {
        summary: 'Create room',
      };

    case 'room:created': {
      const duty =
        isObjectRecord(payload) &&
        (payload.negotiationDuty === 'offerer' ||
          payload.negotiationDuty === 'answerer')
          ? payload.negotiationDuty
          : 'offerer';
      return {
        roomId,
        peerId,
        summary: `Room ${roomLabel} created (duty: ${duty})`,
        meta: { negotiationDuty: duty },
      };
    }

    case 'room:join':
      return {
        roomId,
        summary: roomId ? `Join room ${roomId}` : 'Join room (invalid roomId)',
      };

    case 'room:joined': {
      const duty =
        isObjectRecord(payload) &&
        (payload.negotiationDuty === 'offerer' ||
          payload.negotiationDuty === 'answerer')
          ? payload.negotiationDuty
          : 'answerer';
      return {
        roomId,
        peerId,
        summary: `Joined room ${roomLabel} (duty: ${duty})`,
        meta: { negotiationDuty: duty },
      };
    }

    case 'peer:joined':
      return {
        roomId,
        peerId,
        summary: `Peer joined room ${roomLabel}`,
      };

    case 'room:leave':
      return {
        roomId,
        summary: roomId ? `Leave room ${roomId}` : 'Leave room (invalid roomId)',
      };

    case 'peer:left': {
      const rawReason = isObjectRecord(payload) ? payload.reason : '';
      const reason =
        rawReason === 'leave' || rawReason === 'disconnect'
          ? rawReason
          : sanitizeTextValue(rawReason, { maxLength: 40 }) || 'unknown';
      return {
        roomId,
        peerId,
        summary: `Peer left room ${roomLabel} (${reason})`,
        meta: { reason },
      };
    }

    case 'ice:get':
      return {
        roomId,
        summary: roomId
          ? `Request ICE config for ${roomId}`
          : 'Request ICE config (invalid roomId)',
      };

    case 'ice:credentials': {
      const iceSummary = summarizeIceServers(
        isObjectRecord(payload) ? payload.iceServers : undefined,
      );
      const schemeList =
        iceSummary.schemes.length > 0 ? iceSummary.schemes.join(', ') : 'none';
      return {
        roomId,
        summary: iceSummary.valid
          ? `Received ICE config for ${roomLabel} (${iceSummary.serverCount} server(s), schemes: ${schemeList})`
          : `Received invalid ICE config for ${roomLabel}`,
        meta: {
          serverCount: iceSummary.serverCount,
          schemes: iceSummary.schemes,
          hasTurn: iceSummary.hasTurn,
        },
      };
    }

    case 'signal:forward': {
      const signalMeta = summarizeSignalData(
        isObjectRecord(payload) ? payload.signalData : undefined,
      );
      const label = formatSignalLabel(signalMeta);
      return {
        roomId,
        summary: `Forward ${label} signal for ${roomLabel}`,
        meta: signalMeta,
      };
    }

    case 'signal:receive': {
      const signalMeta = summarizeSignalData(
        isObjectRecord(payload) ? payload.signalData : undefined,
      );
      const label = formatSignalLabel(signalMeta);
      return {
        roomId,
        peerId,
        summary: `Receive ${label} signal in ${roomLabel}`,
        meta: signalMeta,
      };
    }

    case 'room:error': {
      const code = extractErrorCode(payload) ?? 'UNKNOWN_ERROR';
      const message =
        sanitizeTextValue(extractErrorMessage(payload), { maxLength: 160 }) ||
        'Unknown room error';
      return {
        roomId,
        code,
        summary: `Room error (${code}): ${message}`,
        meta: {
          code,
          message,
        },
      };
    }

    default:
      return {
        roomId,
        peerId,
        code: extractErrorCode(payload),
        summary: summarizeGenericPayload(safeEvent, payload),
      };
  }
}

const LOCALHOST_HOSTNAMES = new Set([
  'localhost',
  '::1',
  '[::1]',
  '0.0.0.0',
]);

function isLocalHostname(hostname) {
  const normalized = hostname.toLowerCase();
  return (
    LOCALHOST_HOSTNAMES.has(normalized) ||
    normalized.endsWith('.localhost') ||
    /^127(?:\.\d{1,3}){3}$/.test(normalized)
  );
}

function parseValidatedHttpOrigin(rawUrl, options = {}) {
  const trimmed = rawUrl.trim();
  let parsedUrl;
  try {
    parsedUrl = new URL(trimmed);
  } catch {
    throw new Error(
      'Invalid VITE_SIGNALING_URL configuration: must be a valid HTTP(S) origin.',
    );
  }

  if (options.requireHttps === true) {
    if (parsedUrl.protocol !== 'https:') {
      throw new Error(
        'Invalid VITE_SIGNALING_URL configuration: protocol must be https:.',
      );
    }
  } else if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new Error(
      'Invalid VITE_SIGNALING_URL configuration: protocol must be http: or https:.',
    );
  }

  const hasAuthorityAt = /^https?:\/\/[^/?#]*@/i.test(trimmed);
  if (parsedUrl.username !== '' || parsedUrl.password !== '' || hasAuthorityAt) {
    throw new Error(
      'Invalid VITE_SIGNALING_URL configuration: embedded credentials are not allowed.',
    );
  }

  if (parsedUrl.search !== '' || trimmed.includes('?')) {
    throw new Error(
      'Invalid VITE_SIGNALING_URL configuration: query parameters are not allowed.',
    );
  }

  if (parsedUrl.hash !== '' || trimmed.includes('#')) {
    throw new Error(
      'Invalid VITE_SIGNALING_URL configuration: URL hash fragments are not allowed.',
    );
  }

  if (parsedUrl.pathname !== '/') {
    throw new Error(
      'Invalid VITE_SIGNALING_URL configuration: URL path is not allowed; specify an origin only.',
    );
  }

  if (!parsedUrl.hostname || parsedUrl.origin === 'null') {
    throw new Error(
      'Invalid VITE_SIGNALING_URL configuration: must be a valid HTTP(S) origin.',
    );
  }

  return parsedUrl;
}

function resolveDefaultSignalingUrl(options = {}) {
  const safeOptions = isObjectRecord(options) ? options : {};
  const candidate =
    safeOptions.locationOrigin ??
    safeOptions.fallbackOrigin ??
    globalThis.window?.location?.origin;

  if (typeof candidate !== 'string' || candidate.trim() === '') {
    return DEFAULT_SIGNALING_URL;
  }

  try {
    const parsedUrl = parseValidatedHttpOrigin(candidate, { requireHttps: true });
    if (isLocalHostname(parsedUrl.hostname)) {
      return DEFAULT_SIGNALING_URL;
    }
    return parsedUrl.origin;
  } catch {
    return DEFAULT_SIGNALING_URL;
  }
}

function readDefaultViteEnv() {
  // Access import.meta.env without optional chaining so Vite statically inlines VITE_* env vars.
  if (typeof import.meta !== 'undefined' && import.meta.env) {
    return {
      ...import.meta.env,
      ...(import.meta.env.VITE_SIGNALING_URL !== undefined
        ? { VITE_SIGNALING_URL: import.meta.env.VITE_SIGNALING_URL }
        : {}),
    };
  }
  return {};
}

/**
 * Resolves and validates the signaling server origin from environment variables.
 * Falls back to a safe non-localhost HTTPS origin when provided or active in the browser,
 * otherwise defaults to http://localhost:5001 when VITE_SIGNALING_URL is missing or blank.
 * @param {Record<string, unknown>} [env]
 * @param {{ locationOrigin?: string, fallbackOrigin?: string }} [options]
 * @returns {string} Canonical HTTP(S) origin without a trailing slash.
 */
export function resolveSignalingUrl(env = readDefaultViteEnv(), options = {}) {
  if (env === null || typeof env !== 'object' || Array.isArray(env)) {
    throw new Error(
      'Invalid signaling environment configuration: env must be an object.',
    );
  }

  const rawUrl = env.VITE_SIGNALING_URL;
  if (rawUrl === undefined || rawUrl === null) {
    return resolveDefaultSignalingUrl(options);
  }

  if (typeof rawUrl !== 'string') {
    throw new Error(
      'Invalid VITE_SIGNALING_URL configuration: URL must be a string.',
    );
  }

  const trimmed = rawUrl.trim();
  if (trimmed === '') {
    return resolveDefaultSignalingUrl(options);
  }

  return parseValidatedHttpOrigin(trimmed).origin;
}

/**
 * Redacts SDP payloads, ICE candidate details, TURN secrets, URL key fragments,
 * auth tokens, and private file metadata from arbitrary text before logging or display.
 * @param {unknown} value
 * @param {{ maxLength?: number }} [options]
 * @returns {string}
 */
export function sanitizeTextValue(value, options = {}) {
  if (value === null || value === undefined) {
    return '';
  }

  const maxLength =
    Number.isInteger(options.maxLength) && options.maxLength > 0
      ? options.maxLength
      : DEFAULT_MAX_SUMMARY_LENGTH;

  let text =
    typeof value === 'string'
      ? value
      : value instanceof Error
        ? value.message
        : String(value);

  // Strip full SDP descriptions before collapsing newlines.
  text = text.replace(
    /(?:^|(?<=[\r\n:]\s*|\s))v=0[\r\n]+[\s\S]*?(?=(?:\r?\n\r?\n|$))/gi,
    '[REDACTED_SDP]',
  );
  text = text.replace(
    /\ba=(?:ice-pwd|ice-ufrag|fingerprint|tls-id):[^\r\n\s]*/gi,
    'a=[REDACTED_SDP_ATTR]',
  );
  text = text.replace(/(?:a=)?candidate:[^\r\n]*/gi, '[REDACTED_ICE_CANDIDATE]');
  text = text.replace(/\b[ocm]=IN\s+IP[46]\s+[^\r\n]+/gi, '[REDACTED_SDP_ADDR]');

  // Strip embedded authority credentials in HTTP(S), WS(S), STUN, and TURN URLs.
  text = text.replace(
    /(https?:\/\/|wss?:\/\/|turns?:|stuns?:)([^/\s:@?#]+)(?::([^/\s@?#]*))?@/gi,
    '$1[REDACTED]@',
  );

  // Strip URL fragment keys/secrets and sensitive query parameters.
  text = text.replace(
    /#((?:key|token|secret|auth|password))=[^\s"'<>]*/gi,
    '#$1=[REDACTED]',
  );
  text = text.replace(
    /(https?:\/\/[^\s"'<>#]+)#(?!(?:key|token|secret|auth|password)=\[REDACTED\])([^\s"'<>]+)/gi,
    '$1#[REDACTED]',
  );
  text = text.replace(
    /#[^\s"'<>]*?(?:key|token|secret|auth|password)=[^\s"'<>]*/gi,
    '#[REDACTED]',
  );
  text = text.replace(
    /([?&](?:token|auth|authToken|roomToken|accessToken|refreshToken|authorization|credential|username|secret|password|key)=)[^\s&#"'`<>]*/gi,
    '$1[REDACTED]',
  );

  // Strip bearer tokens, space-separated auth tokens/verifiers, and JWT-like structures.
  text = text.replace(
    /\b(Bearer|token|auth[_-]?token|auth[_-]?verifier)\s+[A-Za-z0-9._~+/=-]{16,}/gi,
    '$1 [REDACTED]',
  );
  text = text.replace(
    /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    '[REDACTED_TOKEN]',
  );

  // Strip key-value secrets and private file-board/chunk/metadata fields.
  text = text.replace(
    /\b(TURN_SHARED_SECRET|credential|username|password|secret|auth[_-]?token|auth[_-]?verifier|room[_-]?token|access[_-]?token|refresh[_-]?token|authorization|master[_-]?key|encryption[_-]?key|fileName|fileSize|fileType|mimeType|sha256|fileBoard|encryptedMetadata|ciphertext|plaintext|chunkData|iv)\b(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}\]]+)/gi,
    '$1$2[REDACTED]',
  );

  const singleLine = text.replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  if (singleLine.length <= maxLength) {
    return singleLine;
  }
  return `${singleLine.slice(0, Math.max(1, maxLength - 3))}...`;
}

/**
 * Produces a concise, sanitized summary string for a signaling event payload.
 * @param {string | unknown} eventOrPayload
 * @param {unknown} [maybePayload]
 * @returns {string}
 */
export function sanitizeEventPayloadSummary(eventOrPayload, maybePayload) {
  const hasTwoArgs = arguments.length >= 2 || typeof eventOrPayload === 'string';
  const eventName = hasTwoArgs
    ? sanitizeTextValue(eventOrPayload, { maxLength: 64 }) || 'unknown'
    : 'unknown';
  const payload = hasTwoArgs ? maybePayload : eventOrPayload;
  return buildNormalizedPayloadDetails(eventName, payload).summary;
}

/**
 * Normalizes an inbound, outbound, or local signaling event into a sanitized record
 * suitable for diagnostic logs and state reducers.
 * @param {{
 *   direction?: 'outbound' | 'inbound' | 'local',
 *   event: string,
 *   payload?: unknown,
 *   timestamp?: string | number | Date,
 *   now?: () => string | number | Date,
 * }} input
 * @returns {{
 *   timestamp: string,
 *   direction: 'outbound' | 'inbound' | 'local',
 *   event: string,
 *   roomId?: string,
 *   peerId?: string,
 *   code?: string,
 *   summary: string,
 *   meta?: Record<string, unknown>,
 * }}
 */
export function normalizeSignalingEvent(input = {}) {
  const direction = VALID_DIRECTIONS.has(input.direction)
    ? input.direction
    : 'local';
  const safeEvent =
    sanitizeTextValue(input.event, { maxLength: 64 }) || 'unknown';
  const timestamp = normalizeTimestamp(input.timestamp, input.now);
  const details = buildNormalizedPayloadDetails(safeEvent, input.payload);

  const normalized = {
    timestamp,
    direction,
    event: safeEvent,
    ...(details.roomId ? { roomId: details.roomId } : {}),
    ...(details.peerId ? { peerId: details.peerId } : {}),
    ...(details.code ? { code: details.code } : {}),
    summary: details.summary,
    ...(details.meta ? { meta: details.meta } : {}),
  };

  return normalized;
}

/**
 * Creates an isolated Socket.IO signaling client that manages connection lifecycle,
 * subscriptions, sanitized event normalization, and deterministic cleanup outside React.
 * @param {{
 *   env?: Record<string, unknown>,
 *   url?: string,
 *   locationOrigin?: string,
 *   fallbackOrigin?: string,
 *   ioFactory?: Function,
 *   now?: () => string | number | Date,
 * }} [options]
 */
export function createSignalingClient(options = {}) {
  if (!isObjectRecord(options)) {
    throw new TypeError('Signaling client options must be a plain object.');
  }

  if (options.ioFactory !== undefined && typeof options.ioFactory !== 'function') {
    throw new TypeError('Expected ioFactory option to be a function.');
  }

  if (options.now !== undefined && typeof options.now !== 'function') {
    throw new TypeError('Expected now option to be a function.');
  }

  const resolvedUrl =
    options.url !== undefined
      ? resolveSignalingUrl({ VITE_SIGNALING_URL: options.url })
      : resolveSignalingUrl(options.env ?? readDefaultViteEnv(), {
          locationOrigin: options.locationOrigin,
          fallbackOrigin: options.fallbackOrigin,
        });

  const ioFactory = options.ioFactory ?? io;
  const now = options.now ?? (() => new Date().toISOString());

  let socket = null;
  let disposed = false;
  let status = 'disconnected';
  let lastError = null;
  let disconnectReason = null;

  const registeredSocketListeners = [];
  const statusSubscribers = new Set();
  const eventSubscribers = new Set();
  const serverEventSubscribers = new Map();

  function getStatusSnapshot() {
    return {
      status,
      connected: status === 'connected',
      url: resolvedUrl,
      lastError: lastError ? { ...lastError } : null,
      disconnectReason,
    };
  }

  function notifyStatusSubscribers() {
    const snapshot = getStatusSnapshot();
    for (const subscriber of [...statusSubscribers]) {
      subscriber(snapshot);
    }
  }

  function emitNormalizedEvent(direction, event, payload) {
    const entry = normalizeSignalingEvent({
      direction,
      event,
      payload,
      now,
    });
    for (const subscriber of [...eventSubscribers]) {
      subscriber(entry);
    }
    return entry;
  }

  function notifyServerEventSubscribers(event, payload) {
    const listeners = serverEventSubscribers.get(event);
    if (!listeners || listeners.size === 0) {
      return;
    }
    for (const listener of [...listeners]) {
      listener(payload);
    }
  }

  function handleConnect() {
    if (disposed) {
      return;
    }
    status = 'connected';
    lastError = null;
    disconnectReason = null;
    notifyStatusSubscribers();
    emitNormalizedEvent('inbound', 'connect');
  }

  function handleDisconnect(reason) {
    if (disposed) {
      return;
    }
    const safeReason =
      sanitizeTextValue(reason, { maxLength: 80 }) || 'unknown';
    status = 'disconnected';
    disconnectReason = safeReason;
    notifyStatusSubscribers();
    emitNormalizedEvent('inbound', 'disconnect', safeReason);
  }

  function handleConnectError(error) {
    if (disposed) {
      return;
    }
    const normalized = normalizeSignalingEvent({
      direction: 'inbound',
      event: 'connect_error',
      payload: error,
      now,
    });
    status = 'error';
    lastError = {
      source: 'connect_error',
      code: normalized.code ?? 'CONNECT_ERROR',
      message: normalized.meta?.message ?? 'Unknown connection error',
      timestamp: normalized.timestamp,
    };
    notifyStatusSubscribers();
    for (const subscriber of [...eventSubscribers]) {
      subscriber(normalized);
    }
  }

  function handleServerEvent(event, payload) {
    if (disposed) {
      return;
    }
    const normalized = emitNormalizedEvent('inbound', event, payload);

    if (event === 'room:error') {
      lastError = {
        source: 'room:error',
        code: normalized.code ?? 'UNKNOWN_ERROR',
        ...(normalized.roomId ? { roomId: normalized.roomId } : {}),
        message: normalized.meta?.message ?? normalized.summary,
        timestamp: normalized.timestamp,
      };
      notifyStatusSubscribers();
    }

    notifyServerEventSubscribers(event, payload);
  }

  function registerSocketListener(targetSocket, event, handler) {
    targetSocket.on(event, handler);
    registeredSocketListeners.push([event, handler]);
  }

  function attachSocketListeners(targetSocket) {
    registerSocketListener(targetSocket, 'connect', handleConnect);
    registerSocketListener(targetSocket, 'disconnect', handleDisconnect);
    registerSocketListener(targetSocket, 'connect_error', handleConnectError);

    for (const event of POC_SERVER_EVENTS) {
      registerSocketListener(targetSocket, event, (payload) => {
        handleServerEvent(event, payload);
      });
    }
  }

  function detachSocketListeners(targetSocket) {
    for (const [event, handler] of registeredSocketListeners) {
      if (typeof targetSocket.off === 'function') {
        targetSocket.off(event, handler);
      } else if (typeof targetSocket.removeListener === 'function') {
        targetSocket.removeListener(event, handler);
      }
    }
    registeredSocketListeners.length = 0;
  }

  function ensureConnectedForEmit(event) {
    if (disposed) {
      throw new Error('Signaling client has been disposed.');
    }
    if (!socket || !socket.connected || status !== 'connected') {
      throw new Error(
        `Cannot emit "${event}": signaling client is not connected.`,
      );
    }
  }

  function emitSocketEvent(event, payload) {
    ensureConnectedForEmit(event);
    socket.emit(event, payload);
    emitNormalizedEvent('outbound', event, payload);
  }

  function connect() {
    if (disposed) {
      throw new Error('Cannot connect a disposed signaling client.');
    }
    if (status === 'connected' || status === 'connecting') {
      return getStatusSnapshot();
    }

    status = 'connecting';
    disconnectReason = null;
    notifyStatusSubscribers();

    try {
      if (!socket) {
        socket = ioFactory(resolvedUrl, { autoConnect: false });
        attachSocketListeners(socket);
      }

      if (!socket.connected) {
        socket.connect();
      } else {
        handleConnect();
      }
    } catch (error) {
      const normalized = emitNormalizedEvent('local', 'connect_error', error);
      status = 'error';
      lastError = {
        source: 'connect_error',
        code: normalized.code ?? 'CONNECT_ERROR',
        message: normalized.meta?.message ?? 'Failed to initialize signaling connection',
        timestamp: normalized.timestamp,
      };
      notifyStatusSubscribers();
    }

    return getStatusSnapshot();
  }

  function subscribeStatus(listener) {
    if (typeof listener !== 'function') {
      throw new TypeError('Expected status subscriber to be a function.');
    }
    statusSubscribers.add(listener);
    return () => {
      statusSubscribers.delete(listener);
    };
  }

  function subscribeEvents(listener) {
    if (typeof listener !== 'function') {
      throw new TypeError('Expected event subscriber to be a function.');
    }
    eventSubscribers.add(listener);
    return () => {
      eventSubscribers.delete(listener);
    };
  }

  function subscribeServerEvent(event, listener) {
    if (typeof event !== 'string' || event.trim() === '') {
      throw new TypeError('Expected server event name to be a non-empty string.');
    }
    if (typeof listener !== 'function') {
      throw new TypeError('Expected server event listener to be a function.');
    }

    let listeners = serverEventSubscribers.get(event);
    if (!listeners) {
      listeners = new Set();
      serverEventSubscribers.set(event, listeners);
    }
    listeners.add(listener);

    return () => {
      const current = serverEventSubscribers.get(event);
      if (!current) {
        return;
      }
      current.delete(listener);
      if (current.size === 0) {
        serverEventSubscribers.delete(event);
      }
    };
  }

  function createRoom(payload = {}) {
    emitSocketEvent('room:create', payload);
  }

  function joinRoom(roomIdOrPayload) {
    const payload =
      typeof roomIdOrPayload === 'string'
        ? { roomId: roomIdOrPayload }
        : roomIdOrPayload;
    emitSocketEvent('room:join', payload);
  }

  function leaveRoom(roomIdOrPayload) {
    const payload =
      typeof roomIdOrPayload === 'string'
        ? { roomId: roomIdOrPayload }
        : roomIdOrPayload;
    emitSocketEvent('room:leave', payload);
  }

  function requestIce(roomIdOrPayload) {
    const payload =
      typeof roomIdOrPayload === 'string'
        ? { roomId: roomIdOrPayload }
        : roomIdOrPayload;
    emitSocketEvent('ice:get', payload);
  }

  function forwardSignal(roomIdOrPayload, maybeSignalData) {
    const payload =
      typeof roomIdOrPayload === 'string'
        ? { roomId: roomIdOrPayload, signalData: maybeSignalData }
        : roomIdOrPayload;
    emitSocketEvent('signal:forward', payload);
  }

  function emitRaw(event, payload) {
    if (typeof event !== 'string' || event.trim() === '') {
      throw new TypeError('Expected raw event name to be a non-empty string.');
    }
    emitSocketEvent(event, payload);
  }

  function dispose() {
    if (disposed) {
      return;
    }
    disposed = true;
    status = 'disconnected';
    disconnectReason = null;

    const activeSocket = socket;
    socket = null;

    if (activeSocket) {
      detachSocketListeners(activeSocket);
      if (typeof activeSocket.disconnect === 'function') {
        activeSocket.disconnect();
      }
    }

    statusSubscribers.clear();
    eventSubscribers.clear();
    serverEventSubscribers.clear();
  }

  return Object.freeze({
    getUrl: () => resolvedUrl,
    getStatus: getStatusSnapshot,
    subscribeStatus,
    subscribeEvents,
    subscribeServerEvent,
    connect,
    createRoom,
    joinRoom,
    leaveRoom,
    requestIce,
    forwardSignal,
    emitRaw,
    dispose,
  });
}
