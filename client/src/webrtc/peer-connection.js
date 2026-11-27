import { sanitizeTextValue } from '../signaling/socket-client.js';
import { validateProductionIceServers } from './ice-config.js';

export const PRODUCTION_CONTROL_CHANNEL_LABEL = 'shipri-control';
export const PRODUCTION_BINARY_CHANNEL_LABEL = 'shipri-binary';
export const DEFAULT_ICE_GATHERING_TIMEOUT_MS = 5000;

const ROOM_ID_PATTERN = /^ship-[a-f0-9]{4}$/;
const SAFE_PEER_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeRoomId(value) {
  return typeof value === 'string' && ROOM_ID_PATTERN.test(value) ? value : null;
}

function normalizePeerId(value) {
  return typeof value === 'string' && SAFE_PEER_ID_PATTERN.test(value)
    ? value
    : null;
}

function normalizePolicy(value) {
  return value === 'relay' ? 'relay' : 'all';
}

function createInitialSelectedPath() {
  return {
    mode: 'unknown',
    relayed: false,
  };
}

function inspectSelectedPath(statsReport) {
  if (!statsReport || typeof statsReport.forEach !== 'function') {
    return createInitialSelectedPath();
  }

  const candidates = new Map();
  let selectedPair = null;

  statsReport.forEach((stat) => {
    if (!isPlainObject(stat)) {
      return;
    }
    if (
      stat.type === 'local-candidate' ||
      stat.type === 'remote-candidate'
    ) {
      if (typeof stat.id === 'string') {
        candidates.set(stat.id, stat.candidateType ?? null);
      }
      return;
    }
    if (stat.type === 'candidate-pair') {
      if (stat.selected === true || (stat.nominated === true && stat.state === 'succeeded')) {
        selectedPair = stat;
      }
    }
  });

  // Also support Map entries keyed by candidate id when stat.id is omitted
  if (candidates.size === 0 && typeof statsReport.entries === 'function') {
    for (const [id, stat] of statsReport.entries()) {
      if (
        isPlainObject(stat) &&
        (stat.type === 'local-candidate' || stat.type === 'remote-candidate')
      ) {
        candidates.set(id, stat.candidateType ?? null);
      }
    }
  }

  if (!selectedPair) {
    return createInitialSelectedPath();
  }

  const localType = candidates.get(selectedPair.localCandidateId) ?? null;
  const remoteType = candidates.get(selectedPair.remoteCandidateId) ?? null;

  if (localType === 'relay' || remoteType === 'relay') {
    return {
      mode: 'relay',
      relayed: true,
    };
  }
  if (localType || remoteType) {
    return {
      mode: 'direct',
      relayed: false,
    };
  }
  return createInitialSelectedPath();
}

function createDefaultPeerConnectionFactory() {
  return (configuration) => new globalThis.RTCPeerConnection(configuration);
}

/**
 * Production-safe WebRTC peer connection manager consuming frozen Socket.IO
 * signaling, authorization, ICE/TURN, and dual data-channel contracts without
 * any prototype diagnostic UI or log dependencies.
 */
export function createPeerConnectionManager(options = {}) {
  if (!isPlainObject(options) || !options.signalingClient) {
    throw new TypeError(
      'Expected options.signalingClient to create peer connection manager.',
    );
  }

  const {
    signalingClient,
    peerConnectionFactory = createDefaultPeerConnectionFactory(),
    iceGatheringTimeoutMs = DEFAULT_ICE_GATHERING_TIMEOUT_MS,
    onStateChange,
    onChannelOpen,
    onChannelClose,
    onChannelMessage,
    onError,
  } = options;

  let iceTransportPolicy = normalizePolicy(options.iceTransportPolicy);
  let disposed = false;

  let roomId = null;
  let selfPeerId = null;
  let remotePeerId = null;
  let peerState = 'unaffiliated';
  let negotiationDuty = null;
  let connectionStatus = signalingClient.getStatus?.().status ?? 'disconnected';

  let generation = 0;
  let activeConnection = null;
  let activePeerId = null;
  let remoteDescriptionSet = false;
  let iceGatheringStalled = false;
  let gatheringTimer = null;
  let pendingIceWaiter = null;
  let staleEventsIgnored = 0;
  let lastError = null;
  let selectedPath = createInitialSelectedPath();

  const channels = new Map();
  const channelCleanupFns = [];
  const queuedRemoteCandidates = [];
  const pendingInboundSignals = [];

  function buildStateSnapshot() {
    const channelStates = {};
    for (const [label, ch] of channels.entries()) {
      channelStates[label] = ch.readyState ?? 'connecting';
    }

    return {
      disposed,
      connectionStatus,
      roomId,
      selfPeerId,
      remotePeerId,
      peerState,
      negotiationDuty,
      generation,
      iceTransportPolicy,
      signalingState: activeConnection?.signalingState ?? 'idle',
      iceGatheringState: activeConnection?.iceGatheringState ?? 'new',
      iceConnectionState: activeConnection?.iceConnectionState ?? 'new',
      connectionState: activeConnection?.connectionState ?? 'new',
      iceGatheringStalled,
      selectedPath: { ...selectedPath },
      channelStates,
      staleEventsIgnored,
      lastError: lastError ? { ...lastError } : null,
    };
  }

  function notifyState() {
    if (typeof onStateChange === 'function') {
      onStateChange(buildStateSnapshot());
    }
  }

  function reportError(code, message, targetRoomId) {
    const safeCode =
      typeof code === 'string' && code.trim() !== ''
        ? sanitizeTextValue(code, { maxLength: 64 })
        : 'UNKNOWN_ERROR';
    const safeMessage =
      sanitizeTextValue(message, { maxLength: 160 }) ||
      'Peer connection error.';
    const errorRecord = {
      code: safeCode,
      ...(targetRoomId ? { roomId: targetRoomId } : {}),
      message: safeMessage,
    };
    lastError = errorRecord;
    if (typeof onError === 'function') {
      onError({ ...errorRecord });
    }
    notifyState();
  }

  function clearGatheringTimer() {
    if (gatheringTimer !== null) {
      clearTimeout(gatheringTimer);
      gatheringTimer = null;
    }
  }

  function rejectPendingIceWaiter(reasonCode, reasonMessage) {
    if (!pendingIceWaiter) {
      return;
    }
    const waiter = pendingIceWaiter;
    pendingIceWaiter = null;
    waiter.reject({ code: reasonCode, message: reasonMessage });
  }

  function teardownConnection() {
    clearGatheringTimer();
    rejectPendingIceWaiter('NEGOTIATION_CANCELLED', 'Connection torn down.');
    iceGatheringStalled = false;
    remoteDescriptionSet = false;
    activePeerId = null;
    selectedPath = createInitialSelectedPath();
    queuedRemoteCandidates.length = 0;
    pendingInboundSignals.length = 0;

    while (channelCleanupFns.length > 0) {
      const cleanup = channelCleanupFns.pop();
      try {
        cleanup();
      } catch {
        // Ignore cleanup listener errors during teardown.
      }
    }

    for (const channel of channels.values()) {
      try {
        channel.close();
      } catch {
        // Ignore already-closed channels.
      }
    }
    channels.clear();

    if (activeConnection) {
      const pc = activeConnection;
      activeConnection = null;
      pc.onicecandidate = null;
      pc.onicegatheringstatechange = null;
      pc.oniceconnectionstatechange = null;
      pc.onconnectionstatechange = null;
      pc.onsignalingstatechange = null;
      pc.ondatachannel = null;
      try {
        pc.close();
      } catch {
        // Ignore already-closed peer connections.
      }
    }
  }

  function attachDataChannel(channel, expectedGen) {
    if (!channel || typeof channel.label !== 'string') {
      return;
    }
    if (disposed || expectedGen !== generation) {
      try {
        channel.close();
      } catch {
        // Ignore stale channel close failure.
      }
      return;
    }

    const label = channel.label;
    if (label === PRODUCTION_BINARY_CHANNEL_LABEL) {
      try {
        channel.binaryType = 'arraybuffer';
      } catch {
        // Some test mocks may define read-only binaryType.
      }
    }

    channels.set(label, channel);

    const handleOpen = () => {
      if (disposed || expectedGen !== generation) {
        staleEventsIgnored += 1;
        return;
      }
      if (typeof onChannelOpen === 'function') {
        onChannelOpen(label, channel);
      }
      notifyState();
    };

    const handleClose = () => {
      if (disposed || expectedGen !== generation) {
        return;
      }
      if (typeof onChannelClose === 'function') {
        onChannelClose(label);
      }
      notifyState();
    };

    const handleMessage = (event) => {
      if (disposed || expectedGen !== generation) {
        staleEventsIgnored += 1;
        return;
      }
      if (typeof onChannelMessage === 'function') {
        onChannelMessage(label, event.data);
      }
    };

    const handleError = () => {
      if (disposed || expectedGen !== generation) {
        return;
      }
      reportError(
        'DATA_CHANNEL_ERROR',
        `Data channel ${label} encountered an error.`,
        roomId,
      );
    };

    channel.onopen = handleOpen;
    channel.onclose = handleClose;
    channel.onmessage = handleMessage;
    channel.onerror = handleError;

    channelCleanupFns.push(() => {
      channel.onopen = null;
      channel.onclose = null;
      channel.onmessage = null;
      channel.onerror = null;
    });
  }

  async function refreshSelectedPath(pc, expectedGen) {
    if (
      disposed ||
      expectedGen !== generation ||
      !pc ||
      typeof pc.getStats !== 'function'
    ) {
      return;
    }
    try {
      const stats = await pc.getStats();
      if (disposed || expectedGen !== generation) {
        return;
      }
      selectedPath = inspectSelectedPath(stats);
      notifyState();
    } catch {
      // Stats inspection is best-effort.
    }
  }

  function requestIceForGeneration(expectedGen, targetRoomId) {
    return new Promise((resolve, reject) => {
      pendingIceWaiter = {
        generation: expectedGen,
        roomId: targetRoomId,
        resolve,
        reject,
      };
      try {
        signalingClient.requestIce(targetRoomId);
      } catch (error) {
        pendingIceWaiter = null;
        reject({
          code: 'CONNECT_ERROR',
          message: sanitizeTextValue(error, { maxLength: 160 }),
        });
      }
    });
  }

  function initializePeerConnection(iceServers, expectedGen, targetPeerId) {
    const pc = peerConnectionFactory({
      iceServers,
      iceTransportPolicy,
    });
    activeConnection = pc;
    activePeerId = targetPeerId;
    remoteDescriptionSet = false;
    iceGatheringStalled = false;

    clearGatheringTimer();
    gatheringTimer = setTimeout(() => {
      if (disposed || expectedGen !== generation || activeConnection !== pc) {
        return;
      }
      if (pc.iceGatheringState !== 'complete') {
        iceGatheringStalled = true;
        notifyState();
      }
    }, iceGatheringTimeoutMs);
    if (typeof gatheringTimer.unref === 'function') {
      gatheringTimer.unref();
    }

    pc.onicecandidate = (event) => {
      if (disposed || expectedGen !== generation || activeConnection !== pc) {
        staleEventsIgnored += 1;
        return;
      }
      if (!event?.candidate || !roomId) {
        return;
      }
      const candidateInit =
        typeof event.candidate.toJSON === 'function'
          ? event.candidate.toJSON()
          : event.candidate;
      try {
        signalingClient.forwardSignal(roomId, {
          kind: 'ice',
          generation: expectedGen,
          candidate: candidateInit,
        });
      } catch {
        // Ignore transient disconnect while trickling.
      }
    };

    pc.onicegatheringstatechange = () => {
      if (disposed || expectedGen !== generation || activeConnection !== pc) {
        staleEventsIgnored += 1;
        return;
      }
      if (pc.iceGatheringState === 'complete') {
        clearGatheringTimer();
        iceGatheringStalled = false;
      }
      notifyState();
    };

    pc.oniceconnectionstatechange = () => {
      if (disposed || expectedGen !== generation || activeConnection !== pc) {
        staleEventsIgnored += 1;
        return;
      }
      if (
        pc.iceConnectionState === 'connected' ||
        pc.iceConnectionState === 'completed'
      ) {
        void refreshSelectedPath(pc, expectedGen);
      }
      if (pc.iceConnectionState === 'failed') {
        reportError(
          'ICE_CONNECTION_FAILED',
          'ICE connectivity failed between peers.',
          roomId,
        );
      } else {
        notifyState();
      }
    };

    pc.onconnectionstatechange = () => {
      if (disposed || expectedGen !== generation || activeConnection !== pc) {
        staleEventsIgnored += 1;
        return;
      }
      if (pc.connectionState === 'connected') {
        void refreshSelectedPath(pc, expectedGen);
      }
      if (pc.connectionState === 'failed') {
        reportError(
          'PEER_CONNECTION_FAILED',
          'WebRTC peer connection failed.',
          roomId,
        );
      } else {
        notifyState();
      }
    };

    pc.onsignalingstatechange = () => {
      if (disposed || expectedGen !== generation || activeConnection !== pc) {
        staleEventsIgnored += 1;
        return;
      }
      notifyState();
    };

    pc.ondatachannel = (event) => {
      if (disposed || expectedGen !== generation || activeConnection !== pc) {
        staleEventsIgnored += 1;
        return;
      }
      attachDataChannel(event?.channel, expectedGen);
      notifyState();
    };

    return pc;
  }

  async function flushQueuedCandidates(pc, expectedGen) {
    while (queuedRemoteCandidates.length > 0) {
      if (disposed || expectedGen !== generation || activeConnection !== pc) {
        return;
      }
      const candidate = queuedRemoteCandidates.shift();
      try {
        await pc.addIceCandidate(candidate);
      } catch (error) {
        if (disposed || expectedGen !== generation) {
          return;
        }
        reportError(
          'ICE_CANDIDATE_ERROR',
          sanitizeTextValue(error, { maxLength: 160 }) ||
            'Failed to apply remote ICE candidate.',
          roomId,
        );
      }
    }
  }

  async function applyInboundSignal(payload, expectedGen) {
    if (disposed || expectedGen !== generation) {
      staleEventsIgnored += 1;
      return;
    }

    const signalRoomId = normalizeRoomId(payload?.roomId);
    const senderPeerId = normalizePeerId(payload?.peerId);
    const signalData = payload?.signalData;

    if (
      !signalRoomId ||
      signalRoomId !== roomId ||
      !isPlainObject(signalData)
    ) {
      staleEventsIgnored += 1;
      return;
    }

    if (activePeerId && senderPeerId && senderPeerId !== activePeerId) {
      staleEventsIgnored += 1;
      return;
    }

    if (
      typeof signalData.generation === 'number' &&
      signalData.generation !== expectedGen
    ) {
      // Allow initial offer from offerer to establish generation on answerer if not yet active
      if (!(negotiationDuty === 'answerer' && signalData.kind === 'sdp' && signalData.description?.type === 'offer')) {
        staleEventsIgnored += 1;
        return;
      }
    }

    if (!activeConnection) {
      if (
        negotiationDuty === 'answerer' &&
        signalData.kind === 'sdp' &&
        signalData.description?.type === 'offer'
      ) {
        await handleAnswererOffer(payload, expectedGen);
        return;
      }
      pendingInboundSignals.push(payload);
      return;
    }

    const pc = activeConnection;
    if (signalData.kind === 'sdp' && isPlainObject(signalData.description)) {
      try {
        await pc.setRemoteDescription(signalData.description);
        if (disposed || expectedGen !== generation || activeConnection !== pc) {
          return;
        }
        remoteDescriptionSet = true;
        await flushQueuedCandidates(pc, expectedGen);
        notifyState();
      } catch (error) {
        if (!disposed && expectedGen === generation) {
          reportError(
            'SDP_NEGOTIATION_ERROR',
            sanitizeTextValue(error, { maxLength: 160 }) ||
              'Failed to apply remote SDP description.',
            roomId,
          );
        }
      }
      return;
    }

    if (signalData.kind === 'ice' && signalData.candidate !== undefined) {
      if (!remoteDescriptionSet) {
        queuedRemoteCandidates.push(signalData.candidate);
        return;
      }
      try {
        await pc.addIceCandidate(signalData.candidate);
      } catch (error) {
        if (!disposed && expectedGen === generation) {
          reportError(
            'ICE_CANDIDATE_ERROR',
            sanitizeTextValue(error, { maxLength: 160 }) ||
              'Failed to apply remote ICE candidate.',
            roomId,
          );
        }
      }
    }
  }

  async function startOffererNegotiation(expectedGen, targetRoomId, targetPeerId) {
    try {
      const iceResult = await requestIceForGeneration(expectedGen, targetRoomId);
      if (disposed || expectedGen !== generation) {
        return;
      }
      const pc = initializePeerConnection(
        iceResult.iceServers,
        expectedGen,
        targetPeerId,
      );

      const controlChannel = pc.createDataChannel(
        PRODUCTION_CONTROL_CHANNEL_LABEL,
        { ordered: true },
      );
      const binaryChannel = pc.createDataChannel(
        PRODUCTION_BINARY_CHANNEL_LABEL,
        { ordered: true },
      );
      attachDataChannel(controlChannel, expectedGen);
      attachDataChannel(binaryChannel, expectedGen);

      const offer = await pc.createOffer();
      if (disposed || expectedGen !== generation || activeConnection !== pc) {
        return;
      }
      await pc.setLocalDescription(offer);
      if (disposed || expectedGen !== generation || activeConnection !== pc) {
        return;
      }

      // Forward SDP offer immediately after setLocalDescription() without waiting for ICE gathering
      signalingClient.forwardSignal(targetRoomId, {
        kind: 'sdp',
        generation: expectedGen,
        description: pc.localDescription ?? offer,
      });
      notifyState();
    } catch (error) {
      if (disposed || expectedGen !== generation) {
        return;
      }
      if (error?.code && error.code !== 'NEGOTIATION_CANCELLED') {
        reportError(error.code, error.message, targetRoomId);
      }
    }
  }

  async function handleAnswererOffer(payload, expectedGen) {
    const targetRoomId = roomId;
    const offerPeerId = normalizePeerId(payload?.peerId);
    const offerGen =
      typeof payload?.signalData?.generation === 'number'
        ? payload.signalData.generation
        : expectedGen;

    try {
      const iceResult = await requestIceForGeneration(expectedGen, targetRoomId);
      if (disposed || expectedGen !== generation) {
        return;
      }
      const pc = initializePeerConnection(
        iceResult.iceServers,
        expectedGen,
        offerPeerId,
      );
      remotePeerId = offerPeerId ?? remotePeerId;

      await pc.setRemoteDescription(payload.signalData.description);
      if (disposed || expectedGen !== generation || activeConnection !== pc) {
        return;
      }
      remoteDescriptionSet = true;
      await flushQueuedCandidates(pc, expectedGen);

      const answer = await pc.createAnswer();
      if (disposed || expectedGen !== generation || activeConnection !== pc) {
        return;
      }
      await pc.setLocalDescription(answer);
      if (disposed || expectedGen !== generation || activeConnection !== pc) {
        return;
      }

      signalingClient.forwardSignal(targetRoomId, {
        kind: 'sdp',
        generation: offerGen,
        description: pc.localDescription ?? answer,
      });

      const buffered = pendingInboundSignals.splice(0);
      for (const item of buffered) {
        await applyInboundSignal(item, expectedGen);
      }
      notifyState();
    } catch (error) {
      if (disposed || expectedGen !== generation) {
        return;
      }
      if (error?.code && error.code !== 'NEGOTIATION_CANCELLED') {
        reportError(error.code, error.message, targetRoomId);
      }
    }
  }

  const unsubscribers = [
    signalingClient.subscribeStatus((snapshot) => {
      if (disposed) {
        return;
      }
      connectionStatus = snapshot.status;
      if (snapshot.status === 'disconnected' && snapshot.disconnectReason) {
        generation += 1;
        teardownConnection();
        roomId = null;
        selfPeerId = null;
        remotePeerId = null;
        peerState = 'unaffiliated';
        negotiationDuty = null;
      }
      notifyState();
    }),

    signalingClient.subscribeServerEvent('room:created', (payload) => {
      if (disposed) {
        return;
      }
      const nextRoomId = normalizeRoomId(payload?.roomId);
      if (!nextRoomId) {
        return;
      }
      generation += 1;
      teardownConnection();
      roomId = nextRoomId;
      selfPeerId = normalizePeerId(payload?.peerId);
      remotePeerId = null;
      peerState = 'waiting_for_peer';
      negotiationDuty = 'offerer';
      lastError = null;
      notifyState();
    }),

    signalingClient.subscribeServerEvent('room:joined', (payload) => {
      if (disposed) {
        return;
      }
      const nextRoomId = normalizeRoomId(payload?.roomId);
      if (!nextRoomId) {
        return;
      }
      generation += 1;
      teardownConnection();
      roomId = nextRoomId;
      selfPeerId = normalizePeerId(payload?.peerId);
      remotePeerId = null;
      peerState = 'connected';
      negotiationDuty = 'answerer';
      lastError = null;
      notifyState();
    }),

    signalingClient.subscribeServerEvent('peer:joined', (payload) => {
      if (disposed) {
        return;
      }
      const targetRoomId = normalizeRoomId(payload?.roomId);
      if (!targetRoomId || targetRoomId !== roomId) {
        staleEventsIgnored += 1;
        return;
      }
      const joinedPeerId = normalizePeerId(payload?.peerId);
      teardownConnection();
      generation += 1;
      remotePeerId = joinedPeerId;
      peerState = 'connected';
      negotiationDuty = 'offerer';
      lastError = null;
      notifyState();
      void startOffererNegotiation(generation, targetRoomId, joinedPeerId);
    }),

    signalingClient.subscribeServerEvent('peer:left', (payload) => {
      if (disposed) {
        return;
      }
      const targetRoomId = normalizeRoomId(payload?.roomId);
      if (!targetRoomId || targetRoomId !== roomId) {
        staleEventsIgnored += 1;
        return;
      }
      generation += 1;
      teardownConnection();
      remotePeerId = null;
      peerState = 'waiting_for_peer';
      negotiationDuty = 'offerer';
      notifyState();
    }),

    signalingClient.subscribeServerEvent('ice:credentials', (payload) => {
      if (disposed) {
        return;
      }
      const waiter = pendingIceWaiter;
      if (!waiter || waiter.generation !== generation) {
        staleEventsIgnored += 1;
        return;
      }
      pendingIceWaiter = null;

      const validation = validateProductionIceServers(payload, {
        expectedRoomId: waiter.roomId,
        requireTurn: iceTransportPolicy === 'relay',
      });
      if (!validation.ok) {
        waiter.reject(validation.error);
        return;
      }
      waiter.resolve(validation);
    }),

    signalingClient.subscribeServerEvent('signal:receive', (payload) => {
      if (disposed) {
        return;
      }
      void applyInboundSignal(payload, generation);
    }),

    signalingClient.subscribeServerEvent('room:error', (payload) => {
      if (disposed) {
        return;
      }
      const code =
        typeof payload?.code === 'string' ? payload.code : 'UNKNOWN_ERROR';
      const message =
        typeof payload?.message === 'string'
          ? payload.message
          : 'Room signaling error.';
      const errorRoomId = normalizeRoomId(payload?.roomId);

      if (pendingIceWaiter && (code === 'SERVER_BUSY' || code === 'UNAUTHORIZED' || code === 'ROOM_NOT_FOUND')) {
        rejectPendingIceWaiter(code, message);
      }

      reportError(code, message, errorRoomId);
    }),
  ];

  function setIceTransportPolicy(nextPolicy) {
    iceTransportPolicy = normalizePolicy(nextPolicy);
    notifyState();
  }

  /**
   * Reconnect hook: disposes the current connection generation and initiates a
   * fresh generation when connected to a peer in an active room.
   */
  function reconnect() {
    if (disposed || !roomId || peerState !== 'connected') {
      return false;
    }
    const targetPeerId = remotePeerId;
    const targetRoomId = roomId;
    teardownConnection();
    generation += 1;
    lastError = null;
    notifyState();

    if (negotiationDuty === 'offerer') {
      void startOffererNegotiation(generation, targetRoomId, targetPeerId);
    }
    return true;
  }

  function dispose() {
    if (disposed) {
      return;
    }
    disposed = true;
    generation += 1;
    teardownConnection();

    while (unsubscribers.length > 0) {
      const unsubscribe = unsubscribers.pop();
      try {
        unsubscribe();
      } catch {
        // Ignore unsubscribe error during disposal.
      }
    }

    roomId = null;
    selfPeerId = null;
    remotePeerId = null;
    peerState = 'unaffiliated';
    negotiationDuty = null;
    notifyState();
  }

  return Object.freeze({
    getState: buildStateSnapshot,
    getPeerConnection: () => activeConnection,
    getChannel: (label) => channels.get(label) ?? null,
    setIceTransportPolicy,
    reconnect,
    dispose,
  });
}
