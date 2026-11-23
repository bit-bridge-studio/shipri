import { sanitizeTextValue } from '../signaling/socket-client.js';
import { validateIceCredentialsPayload } from './ice-diagnostics.js';

export const ICE_GATHERING_STALL_TIMEOUT_MS = 5000;
export const DIAGNOSTIC_CHANNEL_LABEL = 'shipri-diagnostic';

const ROOM_ID_PATTERN = /^ship-[a-f0-9]{4}$/;
const SAFE_PEER_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

const VALID_HARNESS_STATUSES = new Set([
  'idle',
  'negotiating',
  'connected',
  'closed',
  'failed',
]);
const VALID_SIGNALING_STATES = new Set([
  'idle',
  'stable',
  'have-local-offer',
  'have-remote-offer',
  'have-local-pranswer',
  'have-remote-pranswer',
  'closed',
]);
const VALID_ICE_GATHERING_STATES = new Set(['new', 'gathering', 'complete']);
const VALID_ICE_CONNECTION_STATES = new Set([
  'new',
  'checking',
  'connected',
  'completed',
  'failed',
  'disconnected',
  'closed',
]);
const VALID_PEER_CONNECTION_STATES = new Set([
  'new',
  'connecting',
  'connected',
  'disconnected',
  'failed',
  'closed',
]);
const VALID_DATA_CHANNEL_STATES = new Set([
  'none',
  'connecting',
  'open',
  'closing',
  'closed',
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

function normalizePeerId(peerId) {
  return typeof peerId === 'string' && SAFE_PEER_ID_PATTERN.test(peerId)
    ? peerId
    : null;
}

function toNonNegativeInt(value) {
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

function normalizePositiveIntOrNull(value) {
  return Number.isInteger(value) && value > 0 ? value : null;
}

function normalizeEnum(value, allowedValues, fallback) {
  return typeof value === 'string' && allowedValues.has(value)
    ? value
    : fallback;
}

function sanitizeWebRtcError(errorLike, fallbackRoomId) {
  if (errorLike === null || errorLike === undefined) {
    return null;
  }

  if (typeof errorLike === 'string' || errorLike instanceof Error) {
    const message = sanitizeTextValue(errorLike, { maxLength: 160 });
    if (!message) {
      return null;
    }
    return {
      code: 'WEBRTC_NEGOTIATION_ERROR',
      ...(isValidRoomId(fallbackRoomId) ? { roomId: fallbackRoomId } : {}),
      message,
    };
  }

  if (!isPlainObject(errorLike)) {
    return null;
  }

  const code =
    sanitizeTextValue(errorLike.code, { maxLength: 64 }) ||
    'WEBRTC_NEGOTIATION_ERROR';
  const message =
    sanitizeTextValue(errorLike.message ?? errorLike.error, {
      maxLength: 160,
    }) || 'WebRTC signaling error';
  const roomId = isValidRoomId(errorLike.roomId)
    ? errorLike.roomId
    : isValidRoomId(fallbackRoomId)
      ? fallbackRoomId
      : undefined;

  return {
    code,
    ...(roomId ? { roomId } : {}),
    message,
  };
}

function serializeCandidate(candidate) {
  if (candidate === null) {
    return null;
  }
  if (typeof candidate.toJSON === 'function') {
    return candidate.toJSON();
  }
  return {
    candidate: candidate.candidate,
    sdpMid: candidate.sdpMid ?? null,
    sdpMLineIndex: candidate.sdpMLineIndex ?? null,
    ...(candidate.usernameFragment !== undefined
      ? { usernameFragment: candidate.usernameFragment }
      : {}),
  };
}

function isValidCandidatePayload(candidate) {
  if (candidate === null || typeof candidate === 'string') {
    return true;
  }
  return isPlainObject(candidate);
}

/**
 * Creates the initial sanitized state snapshot for the WebRTC signaling harness.
 * @param {Record<string, unknown>} [overrides]
 */
export function createInitialWebRtcState(overrides = {}) {
  if (overrides !== undefined && !isPlainObject(overrides)) {
    throw new TypeError(
      'Initial WebRTC state overrides must be a plain object.',
    );
  }

  const source = overrides ?? {};
  const stalledGathering = Boolean(source.stalledGathering);
  const rawDiagnostic =
    typeof source.stalledDiagnostic === 'string'
      ? sanitizeTextValue(source.stalledDiagnostic, { maxLength: 160 })
      : '';

  return {
    status: normalizeEnum(source.status, VALID_HARNESS_STATUSES, 'idle'),
    generation: toNonNegativeInt(source.generation),
    remoteGeneration: normalizePositiveIntOrNull(source.remoteGeneration),
    activePeerId: normalizePeerId(source.activePeerId),
    signalingState: normalizeEnum(
      source.signalingState,
      VALID_SIGNALING_STATES,
      'idle',
    ),
    iceGatheringState: normalizeEnum(
      source.iceGatheringState,
      VALID_ICE_GATHERING_STATES,
      'new',
    ),
    iceConnectionState: normalizeEnum(
      source.iceConnectionState,
      VALID_ICE_CONNECTION_STATES,
      'new',
    ),
    connectionState: normalizeEnum(
      source.connectionState,
      VALID_PEER_CONNECTION_STATES,
      'new',
    ),
    dataChannelState: normalizeEnum(
      source.dataChannelState,
      VALID_DATA_CHANNEL_STATES,
      'none',
    ),
    stalledGathering,
    stalledDiagnostic: rawDiagnostic || null,
    localDescriptionForwarded: Boolean(source.localDescriptionForwarded),
    localCandidatesSent: toNonNegativeInt(source.localCandidatesSent),
    remoteCandidatesReceived: toNonNegativeInt(source.remoteCandidatesReceived),
    remoteCandidatesQueued: toNonNegativeInt(source.remoteCandidatesQueued),
    remoteCandidatesApplied: toNonNegativeInt(source.remoteCandidatesApplied),
    queuedCandidateCount: toNonNegativeInt(source.queuedCandidateCount),
    staleEventsIgnored: toNonNegativeInt(source.staleEventsIgnored),
    lastError: sanitizeWebRtcError(source.lastError),
  };
}

/**
 * Creates a generation-scoped WebRTC signaling harness implementing immediate SDP forwarding,
 * trickle ICE exchange, early remote candidate queuing, five-second gathering bound diagnostics,
 * peer:left teardown, and stale peerId/generation filtering without blocking application messages.
 * @param {{
 *   signalingClient: {
 *     getStatus?: Function,
 *     subscribeStatus?: Function,
 *     subscribeEvents?: Function,
 *     subscribeServerEvent?: Function,
 *     forwardSignal: Function,
 *     requestIce?: Function,
 *   },
 *   peerConnectionFactory?: (config: { iceServers: Array<{ urls: string | string[] }>, iceTransportPolicy: string, roomId: string, peerId: string, generation: number }) => RTCPeerConnection,
 *   onStateChange?: (state: ReturnType<typeof createInitialWebRtcState>) => void,
 *   onDataChannel?: (channel: RTCDataChannel, meta: { role: 'offerer' | 'answerer', generation: number, peerId: string }) => void,
 *   onError?: (error: { code: string, message: string, roomId?: string }) => void,
 *   setTimer?: (fn: () => void, ms: number) => unknown,
 *   clearTimer?: (id: unknown) => void,
 *   iceGatheringTimeoutMs?: number,
 *   autoRequestIce?: boolean,
 *   autoNegotiate?: boolean,
 *   iceServers?: Array<{ urls: string | string[] }>,
 * }} options
 */
export function createWebRtcHarness(options = {}) {
  if (!isPlainObject(options)) {
    throw new TypeError('WebRTC harness options must be a plain object.');
  }

  const {
    signalingClient,
    peerConnectionFactory,
    onStateChange,
    onDataChannel,
    onError,
  } = options;

  if (!signalingClient || typeof signalingClient.forwardSignal !== 'function') {
    throw new TypeError(
      'Expected signalingClient with forwardSignal() to create WebRTC harness.',
    );
  }

  if (
    peerConnectionFactory !== undefined &&
    typeof peerConnectionFactory !== 'function'
  ) {
    throw new TypeError(
      'Expected peerConnectionFactory option to be a function.',
    );
  }

  const setTimer =
    options.setTimer ?? ((fn, ms) => globalThis.setTimeout(fn, ms));
  const clearTimer =
    options.clearTimer ?? ((id) => globalThis.clearTimeout(id));
  const iceGatheringTimeoutMs =
    Number.isInteger(options.iceGatheringTimeoutMs) &&
    options.iceGatheringTimeoutMs > 0
      ? options.iceGatheringTimeoutMs
      : ICE_GATHERING_STALL_TIMEOUT_MS;
  const autoRequestIce = options.autoRequestIce !== false;
  const autoNegotiate = options.autoNegotiate !== false;

  const stateSubscribers = new Set();
  if (typeof onStateChange === 'function') {
    stateSubscribers.add(onStateChange);
  }

  let disposed = false;
  let connectionStatus = 'disconnected';
  let activeRoomId = null;
  let peerState = 'unaffiliated';
  let negotiationDuty = null;
  let selfPeerId = null;
  let activeRemotePeerId = null;
  const retiredPeerIds = new Set();

  let iceServers = Array.isArray(options.iceServers)
    ? options.iceServers
    : null;
  let iceRequestedForRoom = false;
  let pendingNegotiation = false;
  let pendingOffer = null;

  let activePc = null;
  let activeDataChannel = null;
  let localGeneration = 0;
  let activeSessionGeneration = null;
  let expectedRemoteGeneration = null;
  let remoteDescriptionSet = false;
  let applyingRemoteDescription = false;
  let flushingCandidates = false;
  let pendingRemoteCandidates = [];
  let iceGatheringTimerId = null;

  let currentState = createInitialWebRtcState();

  function cloneStateSnapshot(state) {
    return {
      ...state,
      lastError: state.lastError ? { ...state.lastError } : null,
    };
  }

  function emitState(partial = {}) {
    currentState = createInitialWebRtcState({
      ...currentState,
      ...partial,
      generation: localGeneration,
      remoteGeneration: expectedRemoteGeneration,
      activePeerId: activeRemotePeerId,
      queuedCandidateCount: pendingRemoteCandidates.length,
    });
    const snapshot = cloneStateSnapshot(currentState);
    for (const subscriber of [...stateSubscribers]) {
      subscriber(snapshot);
    }
    return snapshot;
  }

  function clearIceGatheringTimer() {
    if (iceGatheringTimerId !== null) {
      clearTimer(iceGatheringTimerId);
      iceGatheringTimerId = null;
    }
  }

  function armIceGatheringTimer(sessionGen, pc) {
    if (iceGatheringTimerId !== null) {
      return;
    }
    if (!isSessionActive(sessionGen, pc)) {
      return;
    }
    if (pc.iceGatheringState === 'complete') {
      return;
    }

    iceGatheringTimerId = setTimer(() => {
      iceGatheringTimerId = null;
      if (!isSessionActive(sessionGen, pc)) {
        return;
      }
      if (pc.iceGatheringState === 'complete') {
        return;
      }
      emitState({
        stalledGathering: true,
        stalledDiagnostic: `ICE candidate gathering exceeded ${iceGatheringTimeoutMs}ms; initial SDP was not delayed and late candidates continue trickling.`,
      });
    }, iceGatheringTimeoutMs);
  }

  function isSessionActive(sessionGen, pc) {
    return (
      !disposed &&
      activeSessionGeneration !== null &&
      sessionGen === activeSessionGeneration &&
      pc !== null &&
      pc === activePc
    );
  }

  function detachDataChannel(channel) {
    if (!channel) {
      return;
    }
    channel.onopen = null;
    channel.onclose = null;
    channel.onerror = null;
  }

  function attachDataChannel(channel, role, sessionGen, pc) {
    if (!channel || !isSessionActive(sessionGen, pc)) {
      return;
    }

    if (activeDataChannel && activeDataChannel !== channel) {
      detachDataChannel(activeDataChannel);
    }
    activeDataChannel = channel;

    const initialReadyState = normalizeEnum(
      channel.readyState,
      VALID_DATA_CHANNEL_STATES,
      'connecting',
    );
    emitState({ dataChannelState: initialReadyState });

    channel.onopen = () => {
      if (!isSessionActive(sessionGen, pc) || activeDataChannel !== channel) {
        return;
      }
      emitState({ dataChannelState: 'open' });
    };

    channel.onclose = () => {
      if (!isSessionActive(sessionGen, pc) || activeDataChannel !== channel) {
        return;
      }
      emitState({ dataChannelState: 'closed' });
    };

    channel.onerror = () => {
      if (!isSessionActive(sessionGen, pc) || activeDataChannel !== channel) {
        return;
      }
      emitState({
        lastError: sanitizeWebRtcError(
          {
            code: 'WEBRTC_DATACHANNEL_ERROR',
            message: 'Diagnostic data channel encountered an error.',
          },
          activeRoomId,
        ),
      });
    };

    if (typeof onDataChannel === 'function') {
      onDataChannel(channel, {
        role,
        generation: sessionGen,
        peerId: activeRemotePeerId,
      });
    }
  }

  function detachPeerConnection(pc) {
    if (!pc) {
      return;
    }
    pc.onicecandidate = null;
    pc.onicegatheringstatechange = null;
    pc.oniceconnectionstatechange = null;
    pc.onconnectionstatechange = null;
    pc.onsignalingstatechange = null;
    pc.ondatachannel = null;
  }

  function closeActiveResources() {
    clearIceGatheringTimer();

    const channel = activeDataChannel;
    activeDataChannel = null;
    if (channel) {
      detachDataChannel(channel);
      if (channel.readyState !== 'closed' && typeof channel.close === 'function') {
        try {
          channel.close();
        } catch {
          // Ignore close errors on already-closing channels.
        }
      }
    }

    const pc = activePc;
    activePc = null;
    if (pc) {
      detachPeerConnection(pc);
      if (typeof pc.close === 'function') {
        try {
          pc.close();
        } catch {
          // Ignore close errors on already-closed connections.
        }
      }
    }

    remoteDescriptionSet = false;
    applyingRemoteDescription = false;
    flushingCandidates = false;
  }

  function teardownActiveSession({
    nextStatus = 'closed',
    incrementGeneration = true,
    preserveStaleCount = true,
  } = {}) {
    const hadDataChannel = activeDataChannel !== null;
    closeActiveResources();

    activeSessionGeneration = null;
    expectedRemoteGeneration = null;
    pendingNegotiation = false;
    pendingOffer = null;
    pendingRemoteCandidates = [];

    if (incrementGeneration) {
      localGeneration += 1;
    }

    emitState({
      status: nextStatus,
      signalingState: nextStatus === 'idle' ? 'idle' : 'closed',
      iceGatheringState: 'new',
      iceConnectionState: nextStatus === 'idle' ? 'new' : 'closed',
      connectionState: nextStatus === 'idle' ? 'new' : 'closed',
      dataChannelState:
        nextStatus === 'idle' ? 'none' : hadDataChannel ? 'closed' : 'none',
      stalledGathering: false,
      stalledDiagnostic: null,
      localDescriptionForwarded: false,
      staleEventsIgnored: preserveStaleCount
        ? currentState.staleEventsIgnored
        : 0,
      lastError: null,
    });
  }

  function resetAllRoomState() {
    closeActiveResources();
    activeRoomId = null;
    peerState = 'unaffiliated';
    negotiationDuty = null;
    selfPeerId = null;
    activeRemotePeerId = null;
    retiredPeerIds.clear();
    iceServers = Array.isArray(options.iceServers) ? options.iceServers : null;
    iceRequestedForRoom = false;
    pendingNegotiation = false;
    pendingOffer = null;
    localGeneration = 0;
    activeSessionGeneration = null;
    expectedRemoteGeneration = null;
    pendingRemoteCandidates = [];

    currentState = createInitialWebRtcState();
    const snapshot = cloneStateSnapshot(currentState);
    for (const subscriber of [...stateSubscribers]) {
      subscriber(snapshot);
    }
  }

  function syncPeerConnectionStates(sessionGen, pc) {
    if (!isSessionActive(sessionGen, pc)) {
      return;
    }

    const signalingState = normalizeEnum(
      pc.signalingState,
      VALID_SIGNALING_STATES,
      currentState.signalingState,
    );
    const iceGatheringState = normalizeEnum(
      pc.iceGatheringState,
      VALID_ICE_GATHERING_STATES,
      currentState.iceGatheringState,
    );
    const iceConnectionState = normalizeEnum(
      pc.iceConnectionState,
      VALID_ICE_CONNECTION_STATES,
      currentState.iceConnectionState,
    );
    const connectionState = normalizeEnum(
      pc.connectionState,
      VALID_PEER_CONNECTION_STATES,
      currentState.connectionState,
    );

    let nextStatus = currentState.status;
    if (connectionState === 'failed' || iceConnectionState === 'failed') {
      nextStatus = 'failed';
    } else if (
      connectionState === 'connected' ||
      iceConnectionState === 'connected' ||
      iceConnectionState === 'completed'
    ) {
      nextStatus = 'connected';
    } else if (connectionState === 'closed' || signalingState === 'closed') {
      nextStatus = 'closed';
    }

    const gatheringCompleted = iceGatheringState === 'complete';
    if (gatheringCompleted) {
      clearIceGatheringTimer();
    }

    emitState({
      status: nextStatus,
      signalingState,
      iceGatheringState,
      iceConnectionState,
      connectionState,
      ...(gatheringCompleted
        ? { stalledGathering: false, stalledDiagnostic: null }
        : {}),
    });
  }

  function createPeerConnectionInstance(config) {
    if (peerConnectionFactory) {
      return peerConnectionFactory(config);
    }
    if (typeof globalThis.RTCPeerConnection !== 'function') {
      throw new Error('RTCPeerConnection is unavailable in this environment.');
    }
    return new globalThis.RTCPeerConnection({
      iceServers: config.iceServers,
      iceTransportPolicy: config.iceTransportPolicy,
    });
  }

  function bindPeerConnectionListeners(sessionGen, pc) {
    pc.onicecandidate = (event) => {
      if (!isSessionActive(sessionGen, pc)) {
        return;
      }

      if (!event || event.candidate === null || event.candidate === undefined) {
        clearIceGatheringTimer();
        emitState({
          iceGatheringState: normalizeEnum(
            pc.iceGatheringState,
            VALID_ICE_GATHERING_STATES,
            'complete',
          ),
          stalledGathering: false,
          stalledDiagnostic: null,
        });
        return;
      }

      if (
        connectionStatus !== 'connected' ||
        !activeRoomId ||
        peerState !== 'connected'
      ) {
        return;
      }

      const serialized = serializeCandidate(event.candidate);
      try {
        signalingClient.forwardSignal(activeRoomId, {
          candidate: serialized,
          generation: expectedRemoteGeneration,
        });
        emitState({
          localCandidatesSent: currentState.localCandidatesSent + 1,
        });
      } catch (error) {
        if (!isSessionActive(sessionGen, pc)) {
          return;
        }
        const safeError = sanitizeWebRtcError(error, activeRoomId);
        emitState({ status: 'failed', lastError: safeError });
        if (safeError && typeof onError === 'function') {
          onError(safeError);
        }
      }
    };

    pc.onicegatheringstatechange = () => {
      if (!isSessionActive(sessionGen, pc)) {
        return;
      }
      if (pc.iceGatheringState === 'gathering') {
        armIceGatheringTimer(sessionGen, pc);
      }
      syncPeerConnectionStates(sessionGen, pc);
    };

    pc.oniceconnectionstatechange = () => {
      syncPeerConnectionStates(sessionGen, pc);
    };

    pc.onconnectionstatechange = () => {
      syncPeerConnectionStates(sessionGen, pc);
    };

    pc.onsignalingstatechange = () => {
      syncPeerConnectionStates(sessionGen, pc);
    };

    pc.ondatachannel = (event) => {
      if (!isSessionActive(sessionGen, pc) || !event?.channel) {
        return;
      }
      attachDataChannel(event.channel, 'answerer', sessionGen, pc);
    };
  }

  async function applySingleCandidate(sessionGen, pc, candidate) {
    if (!isSessionActive(sessionGen, pc)) {
      return;
    }
    try {
      await pc.addIceCandidate(candidate);
      if (!isSessionActive(sessionGen, pc)) {
        return;
      }
      emitState({
        remoteCandidatesApplied: currentState.remoteCandidatesApplied + 1,
      });
    } catch (error) {
      if (!isSessionActive(sessionGen, pc)) {
        return;
      }
      const safeError = sanitizeWebRtcError(error, activeRoomId);
      emitState({
        status: 'failed',
        lastError: safeError,
      });
      if (safeError && typeof onError === 'function') {
        onError(safeError);
      }
    }
  }

  async function flushPendingCandidates(sessionGen, pc) {
    if (flushingCandidates || !isSessionActive(sessionGen, pc)) {
      return;
    }
    flushingCandidates = true;
    try {
      while (pendingRemoteCandidates.length > 0) {
        if (!isSessionActive(sessionGen, pc)) {
          return;
        }
        const nextEntry = pendingRemoteCandidates.shift();
        emitState({ queuedCandidateCount: pendingRemoteCandidates.length });

        const matchesSession =
          nextEntry.peerId === activeRemotePeerId &&
          nextEntry.generation === expectedRemoteGeneration;
        if (!matchesSession) {
          emitState({
            staleEventsIgnored: currentState.staleEventsIgnored + 1,
          });
          continue;
        }

        await applySingleCandidate(sessionGen, pc, nextEntry.candidate);
      }
    } finally {
      flushingCandidates = false;
    }
  }

  function requestIceIfNeeded() {
    if (
      disposed ||
      connectionStatus !== 'connected' ||
      !activeRoomId ||
      iceServers !== null ||
      iceRequestedForRoom ||
      typeof signalingClient.requestIce !== 'function'
    ) {
      return false;
    }
    iceRequestedForRoom = true;
    signalingClient.requestIce(activeRoomId);
    return true;
  }

  async function beginOffererNegotiation(overrideIceServers) {
    if (
      disposed ||
      connectionStatus !== 'connected' ||
      !activeRoomId ||
      peerState !== 'connected' ||
      negotiationDuty !== 'offerer' ||
      !activeRemotePeerId
    ) {
      return false;
    }

    const effectiveIceServers = Array.isArray(overrideIceServers)
      ? overrideIceServers
      : iceServers;

    if (!Array.isArray(effectiveIceServers) || effectiveIceServers.length === 0) {
      pendingNegotiation = true;
      if (!requestIceIfNeeded() && !iceRequestedForRoom) {
        pendingNegotiation = false;
        const safeError = sanitizeWebRtcError(
          {
            code: 'INVALID_ICE_CREDENTIALS',
            message:
              'Valid ICE configuration is required before starting WebRTC negotiation.',
          },
          activeRoomId,
        );
        emitState({ status: 'failed', lastError: safeError });
        if (safeError && typeof onError === 'function') {
          onError(safeError);
        }
      }
      return false;
    }

    pendingNegotiation = false;
    closeActiveResources();

    localGeneration += 1;
    const sessionGen = localGeneration;
    activeSessionGeneration = sessionGen;
    expectedRemoteGeneration = sessionGen;
    pendingRemoteCandidates = [];

    let pc;
    try {
      pc = createPeerConnectionInstance({
        iceServers: effectiveIceServers,
        iceTransportPolicy: 'all',
        roomId: activeRoomId,
        peerId: activeRemotePeerId,
        generation: sessionGen,
      });
    } catch (error) {
      activeSessionGeneration = null;
      expectedRemoteGeneration = null;
      const safeError = sanitizeWebRtcError(
        {
          code: 'WEBRTC_UNAVAILABLE',
          message:
            sanitizeTextValue(error, { maxLength: 160 }) ||
            'RTCPeerConnection creation failed.',
        },
        activeRoomId,
      );
      emitState({ status: 'failed', lastError: safeError });
      if (safeError && typeof onError === 'function') {
        onError(safeError);
      }
      return false;
    }

    activePc = pc;
    bindPeerConnectionListeners(sessionGen, pc);

    emitState({
      status: 'negotiating',
      signalingState: normalizeEnum(
        pc.signalingState,
        VALID_SIGNALING_STATES,
        'stable',
      ),
      iceGatheringState: normalizeEnum(
        pc.iceGatheringState,
        VALID_ICE_GATHERING_STATES,
        'new',
      ),
      iceConnectionState: normalizeEnum(
        pc.iceConnectionState,
        VALID_ICE_CONNECTION_STATES,
        'new',
      ),
      connectionState: normalizeEnum(
        pc.connectionState,
        VALID_PEER_CONNECTION_STATES,
        'new',
      ),
      dataChannelState: 'none',
      stalledGathering: false,
      stalledDiagnostic: null,
      localDescriptionForwarded: false,
      localCandidatesSent: 0,
      remoteCandidatesReceived: 0,
      remoteCandidatesQueued: 0,
      remoteCandidatesApplied: 0,
      lastError: null,
    });

    try {
      if (typeof pc.createDataChannel === 'function') {
        const channel = pc.createDataChannel(DIAGNOSTIC_CHANNEL_LABEL, {
          ordered: true,
        });
        attachDataChannel(channel, 'offerer', sessionGen, pc);
      }

      const offer = await pc.createOffer();
      if (!isSessionActive(sessionGen, pc)) {
        return false;
      }

      await pc.setLocalDescription(offer);
      if (!isSessionActive(sessionGen, pc)) {
        return false;
      }

      const localDescription = pc.localDescription ?? offer;
      signalingClient.forwardSignal(activeRoomId, {
        type: localDescription.type ?? 'offer',
        sdp: localDescription.sdp,
        generation: sessionGen,
      });

      emitState({ localDescriptionForwarded: true });
      syncPeerConnectionStates(sessionGen, pc);
      armIceGatheringTimer(sessionGen, pc);
      return true;
    } catch (error) {
      if (!isSessionActive(sessionGen, pc)) {
        return false;
      }
      clearIceGatheringTimer();
      const safeError = sanitizeWebRtcError(error, activeRoomId);
      emitState({ status: 'failed', lastError: safeError });
      if (safeError && typeof onError === 'function') {
        onError(safeError);
      }
      return false;
    }
  }

  async function beginAnswererNegotiation(peerId, offerSignalData) {
    if (
      disposed ||
      connectionStatus !== 'connected' ||
      !activeRoomId ||
      peerState !== 'connected' ||
      negotiationDuty !== 'answerer'
    ) {
      return false;
    }

    if (!Array.isArray(iceServers) || iceServers.length === 0) {
      pendingOffer = { roomId: activeRoomId, peerId, signalData: offerSignalData };
      requestIceIfNeeded();
      return false;
    }

    pendingOffer = null;
    closeActiveResources();

    localGeneration += 1;
    const sessionGen = localGeneration;
    const remoteGen = offerSignalData.generation;
    activeRemotePeerId = peerId;
    activeSessionGeneration = sessionGen;
    expectedRemoteGeneration = remoteGen;

    let pc;
    try {
      pc = createPeerConnectionInstance({
        iceServers,
        iceTransportPolicy: 'all',
        roomId: activeRoomId,
        peerId,
        generation: sessionGen,
      });
    } catch (error) {
      activeSessionGeneration = null;
      expectedRemoteGeneration = null;
      const safeError = sanitizeWebRtcError(
        {
          code: 'WEBRTC_UNAVAILABLE',
          message:
            sanitizeTextValue(error, { maxLength: 160 }) ||
            'RTCPeerConnection creation failed.',
        },
        activeRoomId,
      );
      emitState({ status: 'failed', lastError: safeError });
      if (safeError && typeof onError === 'function') {
        onError(safeError);
      }
      return false;
    }

    activePc = pc;
    bindPeerConnectionListeners(sessionGen, pc);

    emitState({
      status: 'negotiating',
      signalingState: normalizeEnum(
        pc.signalingState,
        VALID_SIGNALING_STATES,
        'stable',
      ),
      iceGatheringState: normalizeEnum(
        pc.iceGatheringState,
        VALID_ICE_GATHERING_STATES,
        'new',
      ),
      iceConnectionState: normalizeEnum(
        pc.iceConnectionState,
        VALID_ICE_CONNECTION_STATES,
        'new',
      ),
      connectionState: normalizeEnum(
        pc.connectionState,
        VALID_PEER_CONNECTION_STATES,
        'new',
      ),
      dataChannelState: 'none',
      stalledGathering: false,
      stalledDiagnostic: null,
      localDescriptionForwarded: false,
      localCandidatesSent: 0,
      remoteCandidatesApplied: 0,
      lastError: null,
    });

    try {
      applyingRemoteDescription = true;
      await pc.setRemoteDescription({
        type: 'offer',
        sdp: offerSignalData.sdp,
      });
      if (!isSessionActive(sessionGen, pc)) {
        return false;
      }

      applyingRemoteDescription = false;
      remoteDescriptionSet = true;
      syncPeerConnectionStates(sessionGen, pc);

      await flushPendingCandidates(sessionGen, pc);
      if (!isSessionActive(sessionGen, pc)) {
        return false;
      }

      const answer = await pc.createAnswer();
      if (!isSessionActive(sessionGen, pc)) {
        return false;
      }

      await pc.setLocalDescription(answer);
      if (!isSessionActive(sessionGen, pc)) {
        return false;
      }

      const localDescription = pc.localDescription ?? answer;
      signalingClient.forwardSignal(activeRoomId, {
        type: localDescription.type ?? 'answer',
        sdp: localDescription.sdp,
        generation: remoteGen,
      });

      emitState({ localDescriptionForwarded: true });
      syncPeerConnectionStates(sessionGen, pc);
      armIceGatheringTimer(sessionGen, pc);
      return true;
    } catch (error) {
      if (!isSessionActive(sessionGen, pc)) {
        return false;
      }
      applyingRemoteDescription = false;
      clearIceGatheringTimer();
      const safeError = sanitizeWebRtcError(error, activeRoomId);
      emitState({ status: 'failed', lastError: safeError });
      if (safeError && typeof onError === 'function') {
        onError(safeError);
      }
      return false;
    }
  }

  async function handleInboundAnswer(signalData) {
    const pc = activePc;
    const sessionGen = activeSessionGeneration;
    if (
      !isSessionActive(sessionGen, pc) ||
      negotiationDuty !== 'offerer' ||
      remoteDescriptionSet ||
      applyingRemoteDescription
    ) {
      emitState({ staleEventsIgnored: currentState.staleEventsIgnored + 1 });
      return false;
    }

    if (typeof signalData.sdp !== 'string' || signalData.sdp.length === 0) {
      emitState({ staleEventsIgnored: currentState.staleEventsIgnored + 1 });
      return false;
    }

    try {
      applyingRemoteDescription = true;
      await pc.setRemoteDescription({
        type: 'answer',
        sdp: signalData.sdp,
      });
      if (!isSessionActive(sessionGen, pc)) {
        return false;
      }

      applyingRemoteDescription = false;
      remoteDescriptionSet = true;
      syncPeerConnectionStates(sessionGen, pc);

      await flushPendingCandidates(sessionGen, pc);
      return true;
    } catch (error) {
      if (!isSessionActive(sessionGen, pc)) {
        return false;
      }
      applyingRemoteDescription = false;
      const safeError = sanitizeWebRtcError(error, activeRoomId);
      emitState({ status: 'failed', lastError: safeError });
      if (safeError && typeof onError === 'function') {
        onError(safeError);
      }
      return false;
    }
  }

  function handleSignalReceive(payload) {
    if (disposed || !isPlainObject(payload)) {
      return;
    }

    const roomId = isValidRoomId(payload.roomId) ? payload.roomId : null;
    const peerId = normalizePeerId(payload.peerId);
    const signalData = isPlainObject(payload.signalData)
      ? payload.signalData
      : null;

    if (
      connectionStatus !== 'connected' ||
      !activeRoomId ||
      roomId !== activeRoomId ||
      peerState !== 'connected' ||
      !peerId ||
      retiredPeerIds.has(peerId) ||
      !signalData
    ) {
      emitState({ staleEventsIgnored: currentState.staleEventsIgnored + 1 });
      return;
    }

    const generation = signalData.generation;
    if (!Number.isInteger(generation) || generation <= 0) {
      emitState({ staleEventsIgnored: currentState.staleEventsIgnored + 1 });
      return;
    }

    const isOffer = signalData.type === 'offer';
    const isAnswer = signalData.type === 'answer';
    const hasCandidate = Object.prototype.hasOwnProperty.call(
      signalData,
      'candidate',
    );

    if (isOffer) {
      if (
        negotiationDuty !== 'answerer' ||
        activeRemotePeerId !== null ||
        activePc !== null ||
        pendingOffer !== null ||
        typeof signalData.sdp !== 'string' ||
        signalData.sdp.length === 0
      ) {
        emitState({ staleEventsIgnored: currentState.staleEventsIgnored + 1 });
        return;
      }
      void beginAnswererNegotiation(peerId, signalData);
      return;
    }

    if (isAnswer) {
      if (
        negotiationDuty !== 'offerer' ||
        peerId !== activeRemotePeerId ||
        generation !== expectedRemoteGeneration
      ) {
        emitState({ staleEventsIgnored: currentState.staleEventsIgnored + 1 });
        return;
      }
      void handleInboundAnswer(signalData);
      return;
    }

    if (hasCandidate && isValidCandidatePayload(signalData.candidate)) {
      if (activeRemotePeerId === null) {
        if (negotiationDuty !== 'answerer') {
          emitState({ staleEventsIgnored: currentState.staleEventsIgnored + 1 });
          return;
        }
        pendingRemoteCandidates.push({
          peerId,
          generation,
          candidate: signalData.candidate,
        });
        emitState({
          remoteCandidatesReceived: currentState.remoteCandidatesReceived + 1,
          remoteCandidatesQueued: currentState.remoteCandidatesQueued + 1,
        });
        return;
      }

      if (
        peerId !== activeRemotePeerId ||
        generation !== expectedRemoteGeneration
      ) {
        emitState({ staleEventsIgnored: currentState.staleEventsIgnored + 1 });
        return;
      }

      const nextReceived = currentState.remoteCandidatesReceived + 1;
      if (
        !activePc ||
        !remoteDescriptionSet ||
        applyingRemoteDescription ||
        flushingCandidates
      ) {
        pendingRemoteCandidates.push({
          peerId,
          generation,
          candidate: signalData.candidate,
        });
        emitState({
          remoteCandidatesReceived: nextReceived,
          remoteCandidatesQueued: currentState.remoteCandidatesQueued + 1,
        });
        return;
      }

      emitState({ remoteCandidatesReceived: nextReceived });
      void applySingleCandidate(
        activeSessionGeneration,
        activePc,
        signalData.candidate,
      );
      return;
    }

    emitState({ staleEventsIgnored: currentState.staleEventsIgnored + 1 });
  }

  function handleRoomCreated(payload) {
    if (disposed || !isPlainObject(payload)) {
      return;
    }
    const roomId = isValidRoomId(payload.roomId) ? payload.roomId : null;
    if (!roomId) {
      return;
    }

    resetAllRoomState();
    activeRoomId = roomId;
    selfPeerId = normalizePeerId(payload.peerId);
    peerState = 'waiting_for_peer';
    negotiationDuty =
      payload.negotiationDuty === 'answerer' ? 'answerer' : 'offerer';
    emitState();
  }

  function handleRoomJoined(payload) {
    if (disposed || !isPlainObject(payload)) {
      return;
    }
    const roomId = isValidRoomId(payload.roomId) ? payload.roomId : null;
    if (!roomId) {
      return;
    }

    resetAllRoomState();
    activeRoomId = roomId;
    selfPeerId = normalizePeerId(payload.peerId);
    peerState = 'connected';
    negotiationDuty =
      payload.negotiationDuty === 'offerer' ? 'offerer' : 'answerer';
    emitState();

    if (autoRequestIce) {
      requestIceIfNeeded();
    }
  }

  function handlePeerJoined(payload) {
    if (disposed || !isPlainObject(payload)) {
      return;
    }
    const roomId = isValidRoomId(payload.roomId) ? payload.roomId : null;
    const peerId = normalizePeerId(payload.peerId);
    if (!roomId || roomId !== activeRoomId || !peerId) {
      return;
    }

    closeActiveResources();
    retiredPeerIds.delete(peerId);
    activeRemotePeerId = peerId;
    peerState = 'connected';
    negotiationDuty = negotiationDuty ?? 'offerer';
    pendingOffer = null;
    pendingRemoteCandidates = [];
    expectedRemoteGeneration = null;
    activeSessionGeneration = null;

    emitState({
      status: 'idle',
      signalingState: 'idle',
      iceGatheringState: 'new',
      iceConnectionState: 'new',
      connectionState: 'new',
      dataChannelState: 'none',
      stalledGathering: false,
      stalledDiagnostic: null,
      localDescriptionForwarded: false,
      lastError: null,
    });

    if (autoNegotiate && negotiationDuty === 'offerer') {
      if (Array.isArray(iceServers) && iceServers.length > 0) {
        void beginOffererNegotiation();
      } else if (autoRequestIce) {
        pendingNegotiation = true;
        requestIceIfNeeded();
      }
    }
  }

  function handlePeerLeft(payload) {
    if (disposed || !isPlainObject(payload)) {
      return;
    }
    const roomId = isValidRoomId(payload.roomId) ? payload.roomId : null;
    if (!roomId || roomId !== activeRoomId) {
      return;
    }

    const departedPeerId = normalizePeerId(payload.peerId);
    if (departedPeerId) {
      retiredPeerIds.add(departedPeerId);
    }

    activeRemotePeerId = null;
    peerState = 'waiting_for_peer';
    negotiationDuty = 'offerer';

    teardownActiveSession({
      nextStatus: 'closed',
      incrementGeneration: true,
      preserveStaleCount: true,
    });
  }

  function handleIceCredentials(payload) {
    if (disposed || !activeRoomId) {
      return;
    }

    const validation = validateIceCredentialsPayload(payload, {
      expectedRoomId: activeRoomId,
    });
    if (!validation.ok) {
      iceRequestedForRoom = false;
      if (pendingNegotiation || pendingOffer) {
        pendingNegotiation = false;
        pendingOffer = null;
        emitState({
          status: 'failed',
          lastError: validation.error,
        });
      }
      return;
    }

    iceServers = validation.iceServers;
    iceRequestedForRoom = false;

    if (
      pendingNegotiation &&
      peerState === 'connected' &&
      negotiationDuty === 'offerer' &&
      activeRemotePeerId
    ) {
      void beginOffererNegotiation();
      return;
    }

    if (
      pendingOffer &&
      pendingOffer.roomId === activeRoomId &&
      peerState === 'connected' &&
      negotiationDuty === 'answerer' &&
      !retiredPeerIds.has(pendingOffer.peerId)
    ) {
      const queuedOffer = pendingOffer;
      pendingOffer = null;
      void beginAnswererNegotiation(queuedOffer.peerId, queuedOffer.signalData);
    }
  }

  function handleRoomError(payload) {
    if (disposed || !isPlainObject(payload)) {
      return;
    }
    const code = sanitizeTextValue(payload.code, { maxLength: 64 });
    if (code === 'SERVER_BUSY') {
      iceRequestedForRoom = false;
      if (pendingNegotiation) {
        pendingNegotiation = false;
        emitState({
          status: 'failed',
          lastError: sanitizeWebRtcError(payload, activeRoomId),
        });
      }
      return;
    }
    if (code === 'PEER_UNAVAILABLE' && currentState.status === 'negotiating') {
      emitState({
        lastError: sanitizeWebRtcError(payload, activeRoomId),
      });
    }
  }

  function handleLocalLeave(targetRoomId) {
    if (disposed) {
      return;
    }
    if (
      typeof targetRoomId === 'string' &&
      activeRoomId !== null &&
      targetRoomId.trim() !== activeRoomId
    ) {
      return;
    }
    resetAllRoomState();
  }

  function handleServerEvent(eventName, payload) {
    switch (eventName) {
      case 'room:created':
        handleRoomCreated(payload);
        break;
      case 'room:joined':
        handleRoomJoined(payload);
        break;
      case 'peer:joined':
        handlePeerJoined(payload);
        break;
      case 'peer:left':
        handlePeerLeft(payload);
        break;
      case 'ice:credentials':
        handleIceCredentials(payload);
        break;
      case 'signal:receive':
        handleSignalReceive(payload);
        break;
      case 'room:error':
        handleRoomError(payload);
        break;
      case 'disconnect':
        resetAllRoomState();
        break;
      default:
        break;
    }
  }

  function applyStatusSnapshot(statusSnapshot) {
    if (disposed || !isPlainObject(statusSnapshot)) {
      return;
    }
    const nextConnectionStatus =
      typeof statusSnapshot.status === 'string'
        ? statusSnapshot.status
        : statusSnapshot.connected === true
          ? 'connected'
          : connectionStatus;
    connectionStatus = nextConnectionStatus;

    const hasDisconnectReason =
      typeof statusSnapshot.disconnectReason === 'string' &&
      statusSnapshot.disconnectReason.trim() !== '';
    if (nextConnectionStatus === 'disconnected' && hasDisconnectReason) {
      resetAllRoomState();
    }
  }

  if (typeof signalingClient.getStatus === 'function') {
    applyStatusSnapshot(signalingClient.getStatus());
  }

  const unsubscribers = [];

  if (typeof signalingClient.subscribeStatus === 'function') {
    unsubscribers.push(
      signalingClient.subscribeStatus((statusSnapshot) => {
        applyStatusSnapshot(statusSnapshot);
      }),
    );
  }

  if (typeof signalingClient.subscribeEvents === 'function') {
    unsubscribers.push(
      signalingClient.subscribeEvents((entry) => {
        if (disposed || !isPlainObject(entry)) {
          return;
        }
        if (entry.event === 'disconnect') {
          resetAllRoomState();
          return;
        }
        if (entry.direction === 'outbound' && entry.event === 'room:leave') {
          handleLocalLeave(entry.roomId);
          return;
        }
        if (
          entry.direction === 'outbound' &&
          entry.event === 'ice:get' &&
          entry.roomId === activeRoomId
        ) {
          iceRequestedForRoom = true;
        }
      }),
    );
  }

  if (typeof signalingClient.subscribeServerEvent === 'function') {
    const subscribedEvents = [
      'room:created',
      'room:joined',
      'peer:joined',
      'peer:left',
      'ice:credentials',
      'signal:receive',
      'room:error',
      'disconnect',
    ];
    for (const eventName of subscribedEvents) {
      unsubscribers.push(
        signalingClient.subscribeServerEvent(eventName, (payload) => {
          handleServerEvent(eventName, payload);
        }),
      );
    }
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

  function setIceServers(nextIceServers) {
    if (disposed) {
      return false;
    }
    if (!Array.isArray(nextIceServers) || nextIceServers.length === 0) {
      return false;
    }
    iceServers = nextIceServers;
    return true;
  }

  function startNegotiation(startOptions = {}) {
    const overrideServers = isPlainObject(startOptions)
      ? startOptions.iceServers
      : undefined;
    return beginOffererNegotiation(overrideServers);
  }

  function dispose() {
    if (disposed) {
      return;
    }
    disposed = true;
    closeActiveResources();
    for (const unsubscribe of unsubscribers) {
      unsubscribe();
    }
    unsubscribers.length = 0;
    stateSubscribers.clear();
  }

  return Object.freeze({
    getState: () => cloneStateSnapshot(currentState),
    subscribeState,
    startNegotiation,
    setIceServers,
    getPeerConnection: () => activePc,
    getDataChannel: () => activeDataChannel,
    handleServerEvent,
    handleLocalLeave,
    dispose,
  });
}
