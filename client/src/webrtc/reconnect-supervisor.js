export const MAX_RECONNECT_ATTEMPTS = 3;
export const INITIAL_RECONNECT_BACKOFF_MS = 1_000;
export const MAX_RECONNECT_BACKOFF_MS = 8_000;
export const RECONNECT_GRACE_WINDOW_MS = 60_000;

/**
 * Supervises bounded WebRTC reconnection retries with exponential backoff and a
 * 60-second grace window across transient transport failures and peer drops.
 */
export function createReconnectSupervisor({
  roomConnection,
  signalingClient,
  maxAttempts = MAX_RECONNECT_ATTEMPTS,
  initialBackoffMs = INITIAL_RECONNECT_BACKOFF_MS,
  maxBackoffMs = MAX_RECONNECT_BACKOFF_MS,
  graceWindowMs = RECONNECT_GRACE_WINDOW_MS,
  setTimeoutFn = globalThis.setTimeout,
  clearTimeoutFn = globalThis.clearTimeout,
  onStateChange,
  onExhausted,
} = {}) {
  if (
    !roomConnection ||
    typeof roomConnection.getState !== 'function' ||
    typeof roomConnection.reconnect !== 'function'
  ) {
    throw new TypeError('Expected a valid roomConnection instance.');
  }

  let disposed = false;
  let state = 'idle';
  let attempts = 0;
  let lastReason = null;
  let lastAffiliatedRoomId = roomConnection.getState()?.roomId ?? null;
  let retryTimer = null;
  let graceTimer = null;

  function getState() {
    return Object.freeze({
      state,
      attempts,
      maxAttempts,
      lastReason,
    });
  }

  function emitState() {
    if (!disposed && typeof onStateChange === 'function') {
      onStateChange(getState());
    }
  }

  function clearRetryTimer() {
    if (retryTimer !== null) {
      clearTimeoutFn(retryTimer);
      retryTimer = null;
    }
  }

  function clearGraceTimer() {
    if (graceTimer !== null) {
      clearTimeoutFn(graceTimer);
      graceTimer = null;
    }
  }

  function clearAllTimers() {
    clearRetryTimer();
    clearGraceTimer();
  }

  function exhaust(reason) {
    if (disposed || state === 'exhausted') {
      return;
    }
    clearAllTimers();
    state = 'exhausted';
    lastReason = reason;
    lastAffiliatedRoomId = null;
    emitState();
    if (typeof onExhausted === 'function') {
      onExhausted({ reason, attempts });
    }
  }

  function ensureGraceTimer() {
    if (graceTimer !== null || disposed) {
      return;
    }
    graceTimer = setTimeoutFn(() => {
      graceTimer = null;
      if (disposed || state !== 'reconnecting') {
        return;
      }
      exhaust('GRACE_WINDOW_EXPIRED');
    }, graceWindowMs);
  }

  function computeDelay(attemptNumber) {
    return Math.min(
      maxBackoffMs,
      initialBackoffMs * Math.pow(2, Math.max(0, attemptNumber - 1)),
    );
  }

  function scheduleNextAttempt() {
    if (disposed || state !== 'reconnecting' || retryTimer !== null) {
      return;
    }

    if (attempts >= maxAttempts) {
      const settleDelay = computeDelay(attempts + 1);
      retryTimer = setTimeoutFn(() => {
        retryTimer = null;
        if (disposed || state !== 'reconnecting') {
          return;
        }
        if (roomConnection.getState()?.peerReady) {
          notifyPeerReady();
          return;
        }
        exhaust('MAX_ATTEMPTS_EXCEEDED');
      }, settleDelay);
      return;
    }

    const delayMs = computeDelay(attempts + 1);
    retryTimer = setTimeoutFn(() => {
      retryTimer = null;
      void executeReconnectStep();
    }, delayMs);
  }

  async function executeReconnectStep() {
    if (disposed || state !== 'reconnecting') {
      return false;
    }

    const connState = roomConnection.getState();
    if (connState?.peerReady) {
      notifyPeerReady();
      return true;
    }

    if (attempts >= maxAttempts) {
      exhaust('MAX_ATTEMPTS_EXCEEDED');
      return false;
    }

    const signalingConnected =
      (signalingClient?.getStatus?.().status ?? connState?.connectionStatus) ===
      'connected';

    attempts += 1;
    emitState();

    if (connState?.roomId && connState.peerState === 'connected') {
      roomConnection.reconnect();
    } else if (
      !connState?.roomId &&
      lastAffiliatedRoomId &&
      signalingConnected &&
      typeof roomConnection.joinRoom === 'function'
    ) {
      try {
        await roomConnection.joinRoom(lastAffiliatedRoomId);
      } catch {
        // Retry timer still governs remaining attempts within grace window
      }
    }

    if (!disposed && state === 'reconnecting') {
      scheduleNextAttempt();
    }
    return true;
  }

  function beginRecovery(reason, shouldRetryTransport) {
    if (disposed) {
      return;
    }
    const currentRoomId = roomConnection.getState()?.roomId;
    if (currentRoomId) {
      lastAffiliatedRoomId = currentRoomId;
    }
    if (!lastAffiliatedRoomId) {
      return;
    }

    const enteringRecovery = state !== 'reconnecting';
    if (enteringRecovery) {
      attempts = 0;
    }
    state = 'reconnecting';
    lastReason = reason;
    ensureGraceTimer();
    if (shouldRetryTransport) {
      scheduleNextAttempt();
    }
    emitState();
  }

  function notifyPeerReady() {
    if (disposed) {
      return;
    }
    const currentRoomId = roomConnection.getState()?.roomId;
    if (currentRoomId) {
      lastAffiliatedRoomId = currentRoomId;
    }
    clearAllTimers();
    attempts = 0;
    lastReason = null;
    state = 'connected';
    emitState();
  }

  function notifyPeerLeft() {
    beginRecovery('PEER_LEFT', false);
  }

  function notifyTransportFailure(code = 'TRANSPORT_LOST') {
    const connState = roomConnection.getState();
    const shouldRetry =
      connState?.peerState === 'connected' || Boolean(lastAffiliatedRoomId);
    beginRecovery(code, shouldRetry);
  }

  function notifyIntentionalLeave() {
    if (disposed) {
      return;
    }
    clearAllTimers();
    attempts = 0;
    lastReason = null;
    lastAffiliatedRoomId = null;
    state = 'idle';
    emitState();
  }

  function triggerReconnectAttempt() {
    if (disposed || state === 'exhausted') {
      return false;
    }
    const connState = roomConnection.getState();
    if (connState?.roomId) {
      lastAffiliatedRoomId = connState.roomId;
    }
    if (!lastAffiliatedRoomId) {
      return false;
    }
    state = 'reconnecting';
    ensureGraceTimer();
    clearRetryTimer();
    void executeReconnectStep();
    return true;
  }

  function dispose() {
    if (disposed) {
      return;
    }
    disposed = true;
    clearAllTimers();
    lastAffiliatedRoomId = null;
  }

  return Object.freeze({
    notifyPeerReady,
    notifyPeerLeft,
    notifyTransportFailure,
    notifyIntentionalLeave,
    triggerReconnectAttempt,
    getState,
    dispose,
  });
}
