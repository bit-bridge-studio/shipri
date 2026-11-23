import { sanitizeTextValue } from '../signaling/socket-client.js';

export const DIAGNOSTIC_CHANNEL_LABEL = 'shipri-diagnostic';
export const MAX_DIAGNOSTIC_TEXT_LENGTH = 200;

const DEFAULT_MAX_MESSAGES = 50;
const SAFE_PEER_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

const VALID_CHANNEL_STATES = new Set([
  'none',
  'connecting',
  'open',
  'closing',
  'closed',
]);
const VALID_ROLES = new Set(['offerer', 'answerer']);
const VALID_DIRECTIONS = new Set(['outbound', 'inbound']);
const VALID_MESSAGE_TYPES = new Set(['ping', 'pong', 'text']);

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function normalizeEnum(value, allowedValues, fallback) {
  return typeof value === 'string' && allowedValues.has(value)
    ? value
    : fallback;
}

function normalizePeerId(peerId) {
  return typeof peerId === 'string' && SAFE_PEER_ID_PATTERN.test(peerId)
    ? peerId
    : null;
}

function toNonNegativeInt(value) {
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

function normalizeNonNegativeNumberOrNull(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return null;
  }
  return Math.round(value * 100) / 100;
}

function normalizeIsoTimestamp(timestamp, fallbackMs) {
  if (typeof timestamp === 'string' && timestamp.trim() !== '') {
    return sanitizeTextValue(timestamp, { maxLength: 64 });
  }
  if (typeof timestamp === 'number' && Number.isFinite(timestamp)) {
    return new Date(timestamp).toISOString();
  }
  if (timestamp instanceof Date && !Number.isNaN(timestamp.getTime())) {
    return timestamp.toISOString();
  }
  const ms =
    typeof fallbackMs === 'number' && Number.isFinite(fallbackMs)
      ? fallbackMs
      : Date.now();
  return new Date(ms).toISOString();
}

function sanitizeDiagnosticError(errorLike) {
  if (errorLike === null || errorLike === undefined) {
    return null;
  }

  if (typeof errorLike === 'string' || errorLike instanceof Error) {
    const message = sanitizeTextValue(errorLike, { maxLength: 160 });
    return message ? { code: 'CHANNEL_ERROR', message } : null;
  }

  if (!isPlainObject(errorLike)) {
    return null;
  }

  const code =
    sanitizeTextValue(errorLike.code, { maxLength: 64 }) || 'CHANNEL_ERROR';
  const message =
    sanitizeTextValue(errorLike.message ?? errorLike.error, {
      maxLength: 160,
    }) || 'Diagnostic data channel error.';

  return { code, message };
}

function normalizeMessageEntry(entry, maxLength = MAX_DIAGNOSTIC_TEXT_LENGTH) {
  if (!isPlainObject(entry)) {
    return null;
  }

  const direction = normalizeEnum(entry.direction, VALID_DIRECTIONS, null);
  const type = normalizeEnum(entry.type, VALID_MESSAGE_TYPES, null);
  const id =
    typeof entry.id === 'string'
      ? sanitizeTextValue(entry.id, { maxLength: 64 })
      : '';

  if (!direction || !type || !id) {
    return null;
  }

  let body;
  if (type === 'text') {
    if (typeof entry.body !== 'string') {
      return null;
    }
    const sanitizedBody = sanitizeTextValue(entry.body, { maxLength });
    if (!sanitizedBody) {
      return null;
    }
    body = sanitizedBody;
  }

  const rttMs =
    type === 'pong' ? normalizeNonNegativeNumberOrNull(entry.rttMs) : null;

  return {
    id,
    direction,
    type,
    ...(body !== undefined ? { body } : {}),
    ...(rttMs !== null ? { rttMs } : {}),
    timestamp: normalizeIsoTimestamp(entry.timestamp),
  };
}

/**
 * Validates and sanitizes an outbound or inbound short diagnostic text payload.
 * @param {unknown} rawText
 * @returns {{ ok: true, body: string } | { ok: false, error: { code: string, message: string } }}
 */
export function validateDiagnosticText(rawText) {
  if (typeof rawText !== 'string') {
    return {
      ok: false,
      error: {
        code: 'INVALID_DIAGNOSTIC_TEXT',
        message: 'Diagnostic text must be a non-empty string.',
      },
    };
  }

  const trimmed = rawText.trim();
  if (trimmed === '') {
    return {
      ok: false,
      error: {
        code: 'INVALID_DIAGNOSTIC_TEXT',
        message: 'Diagnostic text cannot be empty or whitespace.',
      },
    };
  }

  if (trimmed.length > MAX_DIAGNOSTIC_TEXT_LENGTH) {
    return {
      ok: false,
      error: {
        code: 'DIAGNOSTIC_TEXT_TOO_LONG',
        message: `Diagnostic text must not exceed ${MAX_DIAGNOSTIC_TEXT_LENGTH} characters.`,
      },
    };
  }

  const sanitizedBody = sanitizeTextValue(trimmed, {
    maxLength: MAX_DIAGNOSTIC_TEXT_LENGTH,
  });
  if (!sanitizedBody) {
    return {
      ok: false,
      error: {
        code: 'INVALID_DIAGNOSTIC_TEXT',
        message: 'Diagnostic text cannot be empty or whitespace.',
      },
    };
  }

  return {
    ok: true,
    body: sanitizedBody,
  };
}

/**
 * Creates the initial sanitized state snapshot for the bidirectional diagnostic data channel.
 * @param {Record<string, unknown>} [overrides]
 */
export function createInitialDiagnosticChannelState(overrides = {}) {
  if (overrides !== undefined && !isPlainObject(overrides)) {
    throw new TypeError(
      'Initial diagnostic channel state overrides must be a plain object.',
    );
  }

  const source = overrides ?? {};
  const rawLabel =
    typeof source.label === 'string'
      ? sanitizeTextValue(source.label, { maxLength: 64 })
      : '';
  const rawMessages = Array.isArray(source.messages) ? source.messages : [];
  const normalizedMessages = rawMessages
    .slice(-DEFAULT_MAX_MESSAGES)
    .map((entry) => normalizeMessageEntry(entry))
    .filter(Boolean);

  return {
    channelState: normalizeEnum(
      source.channelState,
      VALID_CHANNEL_STATES,
      'none',
    ),
    label: rawLabel || null,
    role: normalizeEnum(source.role, VALID_ROLES, null),
    peerId: normalizePeerId(source.peerId),
    generation: toNonNegativeInt(source.generation),
    lastRttMs: normalizeNonNegativeNumberOrNull(source.lastRttMs),
    pingsSent: toNonNegativeInt(source.pingsSent),
    pongsReceived: toNonNegativeInt(source.pongsReceived),
    pendingPingCount: toNonNegativeInt(source.pendingPingCount),
    messagesSent: toNonNegativeInt(source.messagesSent),
    messagesReceived: toNonNegativeInt(source.messagesReceived),
    messages: normalizedMessages,
    lastError: sanitizeDiagnosticError(source.lastError),
  };
}

/**
 * Creates a bidirectional diagnostic RTCDataChannel controller supporting ping/pong RTT
 * measurement and short text exchange initiated by either equal peer.
 * @param {{
 *   signalingClient?: {
 *     subscribeStatus?: Function,
 *     subscribeEvents?: Function,
 *     subscribeServerEvent?: Function,
 *   },
 *   onStateChange?: (state: ReturnType<typeof createInitialDiagnosticChannelState>) => void,
 *   onError?: (error: { code: string, message: string }) => void,
 *   now?: () => number | Date | string,
 *   maxMessages?: number,
 *   createId?: (prefix: string, sequence: number) => string,
 * }} [options]
 */
export function createDiagnosticChannelController(options = {}) {
  if (options !== undefined && !isPlainObject(options)) {
    throw new TypeError(
      'Diagnostic channel controller options must be a plain object.',
    );
  }

  const safeOptions = options ?? {};
  const { signalingClient, onStateChange, onError, createId } = safeOptions;

  if (safeOptions.now !== undefined && typeof safeOptions.now !== 'function') {
    throw new TypeError('Expected now option to be a function.');
  }
  if (createId !== undefined && typeof createId !== 'function') {
    throw new TypeError('Expected createId option to be a function.');
  }

  const now = safeOptions.now ?? (() => Date.now());
  const maxMessages =
    Number.isInteger(safeOptions.maxMessages) && safeOptions.maxMessages > 0
      ? safeOptions.maxMessages
      : DEFAULT_MAX_MESSAGES;

  const stateSubscribers = new Set();
  if (typeof onStateChange === 'function') {
    stateSubscribers.add(onStateChange);
  }

  let disposed = false;
  let activeChannel = null;
  let activeAttachmentId = 0;
  let detachChannelListeners = null;
  let messageSeq = 0;
  const pendingPings = new Map();

  let currentState = createInitialDiagnosticChannelState();

  function resolveClockMs() {
    const value = now();
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
    if (value instanceof Date && Number.isFinite(value.getTime())) {
      return value.getTime();
    }
    if (typeof value === 'string') {
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
    return Date.now();
  }

  function cloneStateSnapshot(state) {
    return {
      ...state,
      messages: state.messages.map((entry) => ({ ...entry })),
      lastError: state.lastError ? { ...state.lastError } : null,
    };
  }

  function emitState(partial = {}) {
    if (disposed) {
      return cloneStateSnapshot(currentState);
    }
    const nextMessages = Array.isArray(partial.messages)
      ? partial.messages.slice(-maxMessages)
      : currentState.messages.slice(-maxMessages);

    currentState = createInitialDiagnosticChannelState({
      ...currentState,
      ...partial,
      messages: nextMessages,
    });

    const snapshot = cloneStateSnapshot(currentState);
    for (const subscriber of [...stateSubscribers]) {
      subscriber(snapshot);
    }
    return snapshot;
  }

  function recordError(errorLike) {
    const safeError = sanitizeDiagnosticError(errorLike);
    if (!safeError) {
      return null;
    }
    emitState({ lastError: safeError });
    if (typeof onError === 'function') {
      onError({ ...safeError });
    }
    return safeError;
  }

  function nextMessageId(prefix) {
    messageSeq += 1;
    if (createId) {
      const custom = sanitizeTextValue(createId(prefix, messageSeq), {
        maxLength: 64,
      });
      if (custom) {
        return custom;
      }
    }
    return `${prefix}-${messageSeq}`;
  }

  function appendMessage(entry) {
    const next = [...currentState.messages, entry];
    return next.length > maxMessages ? next.slice(-maxMessages) : next;
  }

  function teardownCurrentChannel() {
    const channel = activeChannel;
    const cleanupListeners = detachChannelListeners;
    activeChannel = null;
    detachChannelListeners = null;
    activeAttachmentId += 1;
    pendingPings.clear();

    if (typeof cleanupListeners === 'function') {
      cleanupListeners();
    }
    if (channel && channel.onmessage !== null) {
      channel.onmessage = null;
    }
    return channel !== null;
  }

  function detachChannel(detachOptions = {}) {
    if (disposed) {
      return false;
    }
    const safeDetach = isPlainObject(detachOptions) ? detachOptions : {};
    if (
      safeDetach.targetChannel !== undefined &&
      activeChannel !== safeDetach.targetChannel
    ) {
      return false;
    }

    const hadChannel = teardownCurrentChannel();
    const fallbackState = hadChannel ? 'closed' : 'none';
    const nextChannelState = normalizeEnum(
      safeDetach.channelState,
      VALID_CHANNEL_STATES,
      fallbackState,
    );

    emitState({
      channelState: nextChannelState,
      peerId: null,
      pendingPingCount: 0,
    });
    return hadChannel;
  }

  function reset() {
    if (disposed) {
      return false;
    }
    const hadChannel = teardownCurrentChannel();
    const alreadyInitial =
      !hadChannel &&
      currentState.channelState === 'none' &&
      currentState.label === null &&
      currentState.role === null &&
      currentState.peerId === null &&
      currentState.generation === 0 &&
      currentState.lastRttMs === null &&
      currentState.pingsSent === 0 &&
      currentState.pongsReceived === 0 &&
      currentState.pendingPingCount === 0 &&
      currentState.messagesSent === 0 &&
      currentState.messagesReceived === 0 &&
      currentState.messages.length === 0 &&
      currentState.lastError === null;

    if (alreadyInitial) {
      return false;
    }

    currentState = createInitialDiagnosticChannelState();
    const snapshot = cloneStateSnapshot(currentState);
    for (const subscriber of [...stateSubscribers]) {
      subscriber(snapshot);
    }
    return true;
  }

  function clearError() {
    if (disposed || currentState.lastError === null) {
      return false;
    }
    emitState({ lastError: null });
    return true;
  }

  function parseInboundMessage(rawData) {
    if (typeof rawData !== 'string') {
      return {
        ok: false,
        error: {
          code: 'INVALID_DIAGNOSTIC_MESSAGE',
          message: 'Inbound diagnostic message must be a JSON text frame.',
        },
      };
    }

    let parsed;
    try {
      parsed = JSON.parse(rawData);
    } catch {
      return {
        ok: false,
        error: {
          code: 'INVALID_DIAGNOSTIC_MESSAGE',
          message: 'Received malformed JSON on diagnostic data channel.',
        },
      };
    }

    if (!isPlainObject(parsed)) {
      return {
        ok: false,
        error: {
          code: 'INVALID_DIAGNOSTIC_MESSAGE',
          message: 'Diagnostic data channel payload must be a JSON object.',
        },
      };
    }

    const type = normalizeEnum(parsed.type, VALID_MESSAGE_TYPES, null);
    const id =
      typeof parsed.id === 'string'
        ? sanitizeTextValue(parsed.id, { maxLength: 64 })
        : '';

    if (
      !type ||
      !id ||
      typeof parsed.sentAt !== 'number' ||
      !Number.isFinite(parsed.sentAt) ||
      parsed.sentAt < 0
    ) {
      return {
        ok: false,
        error: {
          code: 'INVALID_DIAGNOSTIC_MESSAGE',
          message:
            'Diagnostic message requires valid type, id, and sentAt fields.',
        },
      };
    }

    if (type === 'pong') {
      if (
        typeof parsed.repliedAt !== 'number' ||
        !Number.isFinite(parsed.repliedAt) ||
        parsed.repliedAt < 0
      ) {
        return {
          ok: false,
          error: {
            code: 'INVALID_DIAGNOSTIC_MESSAGE',
            message: 'Diagnostic pong message requires a valid repliedAt value.',
          },
        };
      }
      return {
        ok: true,
        message: {
          type: 'pong',
          id,
          rawId: parsed.id,
          sentAt: parsed.sentAt,
          repliedAt: parsed.repliedAt,
        },
      };
    }

    if (type === 'text') {
      const textValidation = validateDiagnosticText(parsed.body);
      if (!textValidation.ok) {
        return {
          ok: false,
          error: textValidation.error,
        };
      }
      return {
        ok: true,
        message: {
          type: 'text',
          id,
          sentAt: parsed.sentAt,
          body: textValidation.body,
        },
      };
    }

    return {
      ok: true,
      message: {
        type: 'ping',
        id,
        sentAt: parsed.sentAt,
      },
    };
  }

  function handleInboundPing(channel, message) {
    const receivedAt = resolveClockMs();
    const inboundEntry = {
      id: message.id,
      direction: 'inbound',
      type: 'ping',
      timestamp: normalizeIsoTimestamp(receivedAt, receivedAt),
    };

    const messagesAfterInbound = appendMessage(inboundEntry);
    const nextReceived = currentState.messagesReceived + 1;

    if (channel.readyState !== 'open') {
      emitState({
        messages: messagesAfterInbound,
        messagesReceived: nextReceived,
      });
      recordError({
        code: 'CHANNEL_NOT_OPEN',
        message: 'Diagnostic channel is not open to send automatic pong reply.',
      });
      return;
    }

    const repliedAt = resolveClockMs();
    const pongPayload = {
      type: 'pong',
      id: message.id,
      sentAt: message.sentAt,
      repliedAt,
    };

    try {
      channel.send(JSON.stringify(pongPayload));
    } catch (error) {
      emitState({
        messages: messagesAfterInbound,
        messagesReceived: nextReceived,
      });
      recordError({
        code: 'CHANNEL_SEND_FAILED',
        message:
          sanitizeTextValue(error, { maxLength: 160 }) ||
          'Failed to send automatic pong reply.',
      });
      return;
    }

    const outboundEntry = {
      id: message.id,
      direction: 'outbound',
      type: 'pong',
      timestamp: normalizeIsoTimestamp(repliedAt, repliedAt),
    };
    const messagesAfterReply = [...messagesAfterInbound, outboundEntry];

    emitState({
      messages: messagesAfterReply,
      messagesReceived: nextReceived,
      messagesSent: currentState.messagesSent + 1,
      lastError: null,
    });
  }

  function handleInboundPong(message) {
    const receivedAt = resolveClockMs();
    const pendingKey = pendingPings.has(message.rawId)
      ? message.rawId
      : pendingPings.has(message.id)
        ? message.id
        : null;

    let rttMs = null;
    if (pendingKey !== null) {
      const pending = pendingPings.get(pendingKey);
      pendingPings.delete(pendingKey);
      rttMs = normalizeNonNegativeNumberOrNull(receivedAt - pending.sentAt);
    }

    const inboundEntry = {
      id: message.id,
      direction: 'inbound',
      type: 'pong',
      ...(rttMs !== null ? { rttMs } : {}),
      timestamp: normalizeIsoTimestamp(receivedAt, receivedAt),
    };

    emitState({
      lastRttMs: rttMs !== null ? rttMs : currentState.lastRttMs,
      pongsReceived: currentState.pongsReceived + 1,
      pendingPingCount: pendingPings.size,
      messagesReceived: currentState.messagesReceived + 1,
      messages: appendMessage(inboundEntry),
      lastError: null,
    });
  }

  function handleInboundText(message) {
    const receivedAt = resolveClockMs();
    const inboundEntry = {
      id: message.id,
      direction: 'inbound',
      type: 'text',
      body: message.body,
      timestamp: normalizeIsoTimestamp(receivedAt, receivedAt),
    };

    emitState({
      messagesReceived: currentState.messagesReceived + 1,
      messages: appendMessage(inboundEntry),
      lastError: null,
    });
  }

  function attachChannel(channel, meta = {}) {
    if (disposed) {
      return () => {};
    }

    if (!channel || typeof channel.send !== 'function') {
      recordError({
        code: 'INVALID_DIAGNOSTIC_CHANNEL',
        message: 'Expected a valid RTCDataChannel instance.',
      });
      return () => {};
    }

    const rawLabel =
      typeof channel.label === 'string' && channel.label.trim() !== ''
        ? sanitizeTextValue(channel.label, { maxLength: 64 })
        : DIAGNOSTIC_CHANNEL_LABEL;

    if (rawLabel !== DIAGNOSTIC_CHANNEL_LABEL) {
      recordError({
        code: 'INVALID_DIAGNOSTIC_CHANNEL',
        message: 'Unexpected diagnostic data channel label.',
      });
      return () => {};
    }

    if (activeChannel === channel) {
      const boundAttachmentId = activeAttachmentId;
      return (reason) => {
        if (disposed || activeAttachmentId !== boundAttachmentId) {
          return;
        }
        if (reason === 'reset') {
          reset();
          return;
        }
        detachChannel({ channelState: 'closed', targetChannel: channel });
      };
    }

    teardownCurrentChannel();

    const attachmentId = activeAttachmentId;
    activeChannel = channel;

    const safeMeta = isPlainObject(meta) ? meta : {};
    const initialReadyState = normalizeEnum(
      channel.readyState,
      VALID_CHANNEL_STATES,
      'connecting',
    );
    const safeRole = normalizeEnum(safeMeta.role, VALID_ROLES, null);
    const safePeerId = normalizePeerId(safeMeta.peerId);
    const safeGeneration = toNonNegativeInt(safeMeta.generation);

    const isCurrentAttachment = () =>
      !disposed &&
      activeChannel === channel &&
      activeAttachmentId === attachmentId;

    const handleOpen = () => {
      if (!isCurrentAttachment()) {
        return;
      }
      emitState({ channelState: 'open' });
    };

    const handleClose = () => {
      if (!isCurrentAttachment()) {
        return;
      }
      teardownCurrentChannel();
      emitState({
        channelState: 'closed',
        pendingPingCount: 0,
      });
    };

    const handleError = (event) => {
      if (!isCurrentAttachment()) {
        return;
      }
      const rawErr =
        event?.error ??
        event?.message ??
        'Diagnostic data channel encountered an error.';
      recordError({
        code: 'CHANNEL_ERROR',
        message:
          sanitizeTextValue(rawErr, { maxLength: 160 }) ||
          'Diagnostic data channel encountered an error.',
      });
    };

    const handleMessage = (event) => {
      if (!isCurrentAttachment()) {
        return;
      }

      const parsed = parseInboundMessage(event?.data);
      if (!parsed.ok) {
        recordError(parsed.error);
        return;
      }

      if (parsed.message.type === 'ping') {
        handleInboundPing(channel, parsed.message);
        return;
      }
      if (parsed.message.type === 'pong') {
        handleInboundPong(parsed.message);
        return;
      }
      handleInboundText(parsed.message);
    };

    channel.onmessage = handleMessage;

    if (
      typeof channel.addEventListener === 'function' &&
      typeof channel.removeEventListener === 'function'
    ) {
      channel.addEventListener('open', handleOpen);
      channel.addEventListener('close', handleClose);
      channel.addEventListener('error', handleError);
      detachChannelListeners = () => {
        channel.removeEventListener('open', handleOpen);
        channel.removeEventListener('close', handleClose);
        channel.removeEventListener('error', handleError);
        if (channel.onmessage === handleMessage) {
          channel.onmessage = null;
        }
      };
    } else {
      const prevOnOpen = channel.onopen;
      const prevOnClose = channel.onclose;
      const prevOnError = channel.onerror;

      channel.onopen = (event) => {
        if (typeof prevOnOpen === 'function') {
          prevOnOpen(event);
        }
        handleOpen();
      };
      channel.onclose = (event) => {
        if (typeof prevOnClose === 'function') {
          prevOnClose(event);
        }
        handleClose();
      };
      channel.onerror = (event) => {
        if (typeof prevOnError === 'function') {
          prevOnError(event);
        }
        handleError(event);
      };

      detachChannelListeners = () => {
        if (channel.onmessage === handleMessage) {
          channel.onmessage = null;
        }
      };
    }

    emitState({
      channelState: initialReadyState,
      label: rawLabel,
      role: safeRole,
      peerId: safePeerId,
      generation: safeGeneration,
      lastRttMs: null,
      pingsSent: 0,
      pongsReceived: 0,
      pendingPingCount: 0,
      messagesSent: 0,
      messagesReceived: 0,
      messages: [],
      lastError: null,
    });

    return (reason) => {
      if (disposed || activeAttachmentId !== attachmentId) {
        return;
      }
      if (reason === 'reset') {
        reset();
        return;
      }
      detachChannel({ channelState: 'closed', targetChannel: channel });
    };
  }

  function sendPing() {
    if (disposed) {
      return {
        ok: false,
        error: {
          code: 'CHANNEL_DISPOSED',
          message: 'Diagnostic channel controller has been disposed.',
        },
      };
    }

    if (!activeChannel || activeChannel.readyState !== 'open') {
      const safeError = recordError({
        code: 'CHANNEL_NOT_OPEN',
        message: 'Diagnostic data channel must be open before sending a ping.',
      });
      return { ok: false, error: safeError };
    }

    const sentAt = resolveClockMs();
    const id = nextMessageId('ping');
    const payload = {
      type: 'ping',
      id,
      sentAt,
    };

    // Register pending ping before synchronous send() in case mock/loopback invokes reply inline.
    pendingPings.set(id, { sentAt });

    try {
      activeChannel.send(JSON.stringify(payload));
    } catch (error) {
      pendingPings.delete(id);
      const safeError = recordError({
        code: 'CHANNEL_SEND_FAILED',
        message:
          sanitizeTextValue(error, { maxLength: 160 }) ||
          'Failed to send diagnostic ping.',
      });
      return { ok: false, error: safeError };
    }

    const outboundEntry = {
      id,
      direction: 'outbound',
      type: 'ping',
      timestamp: normalizeIsoTimestamp(sentAt, sentAt),
    };

    // Synchronous test relays may have already resolved the pong inside send(); merge cleanly.
    const pingAlreadyResolved = !pendingPings.has(id);
    const messagesWithPing = pingAlreadyResolved
      ? [
          ...currentState.messages.slice(0, -1),
          outboundEntry,
          currentState.messages[currentState.messages.length - 1],
        ]
      : appendMessage(outboundEntry);

    emitState({
      pingsSent: currentState.pingsSent + 1,
      pendingPingCount: pendingPings.size,
      messagesSent: currentState.messagesSent + 1,
      messages: messagesWithPing,
      lastError: null,
    });

    return { ok: true, id, message: payload };
  }

  function sendText(rawText) {
    if (disposed) {
      return {
        ok: false,
        error: {
          code: 'CHANNEL_DISPOSED',
          message: 'Diagnostic channel controller has been disposed.',
        },
      };
    }

    if (!activeChannel || activeChannel.readyState !== 'open') {
      const safeError = recordError({
        code: 'CHANNEL_NOT_OPEN',
        message: 'Diagnostic data channel must be open before sending text.',
      });
      return { ok: false, error: safeError };
    }

    const validation = validateDiagnosticText(rawText);
    if (!validation.ok) {
      const safeError = recordError(validation.error);
      return { ok: false, error: safeError };
    }

    const sentAt = resolveClockMs();
    const id = nextMessageId('text');
    const payload = {
      type: 'text',
      id,
      sentAt,
      body: validation.body,
    };

    const insertIndex = currentState.messages.length;
    try {
      activeChannel.send(JSON.stringify(payload));
    } catch (error) {
      const safeError = recordError({
        code: 'CHANNEL_SEND_FAILED',
        message:
          sanitizeTextValue(error, { maxLength: 160 }) ||
          'Failed to send diagnostic text.',
      });
      return { ok: false, error: safeError };
    }

    const outboundEntry = {
      id,
      direction: 'outbound',
      type: 'text',
      body: validation.body,
      timestamp: normalizeIsoTimestamp(sentAt, sentAt),
    };

    const nextMessages = [...currentState.messages];
    nextMessages.splice(insertIndex, 0, outboundEntry);

    emitState({
      messagesSent: currentState.messagesSent + 1,
      messages: nextMessages,
      lastError: null,
    });

    return { ok: true, id, message: payload };
  }

  function subscribeState(listener) {
    if (typeof listener !== 'function') {
      throw new TypeError('Expected state subscriber to be a function.');
    }
    stateSubscribers.add(listener);
    return () => {
      stateSubscribers.delete(listener);
    };
  }

  const signalingUnsubscribers = [];
  if (signalingClient) {
    if (typeof signalingClient.subscribeStatus === 'function') {
      signalingUnsubscribers.push(
        signalingClient.subscribeStatus((statusSnapshot) => {
          if (!isPlainObject(statusSnapshot)) {
            return;
          }
          const hasDisconnectReason =
            typeof statusSnapshot.disconnectReason === 'string' &&
            statusSnapshot.disconnectReason.trim() !== '';
          if (statusSnapshot.status === 'disconnected' && hasDisconnectReason) {
            reset();
          }
        }),
      );
    }

    if (typeof signalingClient.subscribeEvents === 'function') {
      signalingUnsubscribers.push(
        signalingClient.subscribeEvents((entry) => {
          if (!isPlainObject(entry)) {
            return;
          }
          if (
            entry.event === 'disconnect' ||
            (entry.direction === 'outbound' && entry.event === 'room:leave')
          ) {
            reset();
          }
        }),
      );
    }

    if (typeof signalingClient.subscribeServerEvent === 'function') {
      for (const eventName of ['room:created', 'room:joined', 'disconnect']) {
        signalingUnsubscribers.push(
          signalingClient.subscribeServerEvent(eventName, () => {
            reset();
          }),
        );
      }
    }
  }

  function dispose() {
    if (disposed) {
      return;
    }
    disposed = true;
    teardownCurrentChannel();
    for (const unsubscribe of signalingUnsubscribers) {
      unsubscribe();
    }
    signalingUnsubscribers.length = 0;
    stateSubscribers.clear();
  }

  return Object.freeze({
    getState: () => cloneStateSnapshot(currentState),
    subscribeState,
    attachChannel,
    detachChannel,
    sendPing,
    sendText,
    clearError,
    reset,
    dispose,
  });
}
