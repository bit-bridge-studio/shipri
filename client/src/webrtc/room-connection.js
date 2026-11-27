import {
  decryptControlMessage,
  encryptControlMessage,
} from '../crypto/control-codec.js';
import { createFragmentKeyLifecycle } from '../crypto/fragment-key.js';
import {
  buildRoomShareUrl,
  createRoomAuthorizationSession,
} from '../crypto/room-auth.js';
import { sanitizeTextValue } from '../signaling/socket-client.js';
import {
  PRODUCTION_BINARY_CHANNEL_LABEL,
  PRODUCTION_CONTROL_CHANNEL_LABEL,
  createPeerConnectionManager,
} from './peer-connection.js';

function resolveOrigin(locationObj, explicitOrigin) {
  if (typeof explicitOrigin === 'string' && explicitOrigin.trim() !== '') {
    return explicitOrigin.trim();
  }
  if (typeof locationObj?.origin === 'string' && locationObj.origin !== 'null') {
    return locationObj.origin;
  }
  return 'http://localhost:5173';
}

/**
 * High-level equal-peer production room connection composing URL-fragment keys,
 * HKDF room authorization, generation-scoped WebRTC channels, and encrypted
 * shipri-control-v1 messaging with zero prototype UI/log dependencies.
 */
export function createProductionRoomConnection(options = {}) {
  if (!options || !options.signalingClient) {
    throw new TypeError(
      'Expected options.signalingClient to create production room connection.',
    );
  }

  const {
    signalingClient,
    peerConnectionFactory,
    storage = globalThis.window?.sessionStorage,
    locationObj = globalThis.window?.location,
    historyObj = globalThis.window?.history,
    iceTransportPolicy = 'all',
    iceGatheringTimeoutMs,
    onStateChange,
    onControlMessage,
    onBinaryFrame,
    onPeerReady,
    onPeerLeft,
    onError,
  } = options;

  let disposed = false;
  let shareUrl = null;
  let shareOrigin = resolveOrigin(locationObj, options.origin);
  let remoteMemberId = null;
  let helloSentForGeneration = -1;
  let peerReadyNotified = false;
  let lastError = null;
  let controlSendChain = Promise.resolve();

  const keyLifecycle = createFragmentKeyLifecycle({
    storage,
    locationObj,
    historyObj,
  });

  function buildSanitizedState() {
    const peerStateSnapshot = peerManager.getState();
    const authSnapshot = authSession.getState();
    const activeSession = keyLifecycle.getActiveSession();
    const controlState =
      peerStateSnapshot.channelStates[PRODUCTION_CONTROL_CHANNEL_LABEL] ??
      'closed';
    const binaryState =
      peerStateSnapshot.channelStates[PRODUCTION_BINARY_CHANNEL_LABEL] ??
      'closed';
    const peerReady = Boolean(
      !disposed &&
        activeSession &&
        remoteMemberId &&
        controlState === 'open' &&
        binaryState === 'open',
    );

    return {
      disposed,
      connectionStatus: peerStateSnapshot.connectionStatus,
      authStatus: authSnapshot.status,
      roomId: peerStateSnapshot.roomId ?? authSnapshot.roomId,
      peerState: peerStateSnapshot.peerState,
      negotiationDuty: peerStateSnapshot.negotiationDuty,
      generation: peerStateSnapshot.generation,
      iceTransportPolicy: peerStateSnapshot.iceTransportPolicy,
      selectedPath: peerStateSnapshot.selectedPath,
      controlChannelState: controlState,
      binaryChannelState: binaryState,
      memberId: activeSession?.memberId ?? null,
      remoteMemberId,
      peerReady,
      hasShareUrl: Boolean(shareUrl),
      lastError: lastError ? { ...lastError } : null,
    };
  }

  function emitState() {
    const snapshot = buildSanitizedState();
    if (
      snapshot.peerReady &&
      !peerReadyNotified &&
      typeof onPeerReady === 'function'
    ) {
      peerReadyNotified = true;
      onPeerReady({
        roomId: snapshot.roomId,
        memberId: snapshot.memberId,
        remoteMemberId: snapshot.remoteMemberId,
      });
    } else if (!snapshot.peerReady) {
      peerReadyNotified = false;
    }

    if (typeof onStateChange === 'function') {
      onStateChange(snapshot);
    }
  }

  function forwardError(err) {
    const safeError = {
      code:
        typeof err?.code === 'string'
          ? sanitizeTextValue(err.code, { maxLength: 64 })
          : 'UNKNOWN_ERROR',
      message:
        sanitizeTextValue(err?.message, { maxLength: 160 }) ||
        'Connection error.',
    };
    lastError = safeError;
    keyLifecycle.handleTerminalRoomError(safeError.code);
    if (typeof onError === 'function') {
      onError({ ...safeError });
    }
    emitState();
  }

  const authSession = createRoomAuthorizationSession({
    signalingClient,
    onStateChange: () => emitState(),
    onAuthError: (err) => forwardError(err),
  });

  function sendEncryptedControlInternal(message) {
    const session = keyLifecycle.getActiveSession();
    const channel = peerManager.getChannel(PRODUCTION_CONTROL_CHANNEL_LABEL);
    if (
      disposed ||
      !session ||
      !channel ||
      channel.readyState !== 'open'
    ) {
      return Promise.reject(
        new Error('Control channel or active room key is unavailable.'),
      );
    }
    const genAtSend = peerManager.getState().generation;
    controlSendChain = controlSendChain.then(async () => {
      const currentChannel = peerManager.getChannel(
        PRODUCTION_CONTROL_CHANNEL_LABEL,
      );
      if (
        disposed ||
        peerManager.getState().generation !== genAtSend ||
        !currentChannel ||
        currentChannel.readyState !== 'open'
      ) {
        throw new Error('Control channel closed before send completed.');
      }
      const envelope = await encryptControlMessage({
        masterKeyBytes: session.masterKeyBytes,
        roomId: session.roomId,
        senderMemberId: session.memberId,
        message,
      });
      currentChannel.send(JSON.stringify(envelope));
    });
    return controlSendChain;
  }

  async function handleInboundControlData(rawData) {
    const session = keyLifecycle.getActiveSession();
    if (disposed || !session || typeof rawData !== 'string') {
      return;
    }

    let envelope;
    try {
      envelope = JSON.parse(rawData);
    } catch {
      forwardError({
        code: 'INVALID_CONTROL_MESSAGE',
        message: 'Received malformed control payload.',
      });
      return;
    }

    const result = await decryptControlMessage({
      masterKeyBytes: session.masterKeyBytes,
      roomId: session.roomId,
      expectedSenderMemberId: remoteMemberId ?? undefined,
      envelope,
    });

    if (!result.ok) {
      forwardError({
        code: result.code,
        message: 'Control message verification failed.',
      });
      return;
    }

    if (result.senderMemberId === session.memberId) {
      forwardError({
        code: 'SENDER_MISMATCH',
        message: 'Control message sender matches local member identity.',
      });
      return;
    }

    if (result.message.type === 'PEER_HELLO') {
      const peerMember = result.message.payload.memberId;
      if (peerMember !== result.senderMemberId) {
        forwardError({
          code: 'SENDER_MISMATCH',
          message: 'PEER_HELLO memberId does not match authenticated sender.',
        });
        return;
      }
      remoteMemberId = peerMember;
      emitState();
    }

    if (typeof onControlMessage === 'function') {
      onControlMessage(result.message, result.senderMemberId);
    }
  }

  const peerManager = createPeerConnectionManager({
    signalingClient,
    peerConnectionFactory,
    iceTransportPolicy,
    iceGatheringTimeoutMs,
    onStateChange: () => emitState(),
    onChannelOpen: (label) => {
      if (disposed) {
        return;
      }
      if (label === PRODUCTION_CONTROL_CHANNEL_LABEL) {
        const session = keyLifecycle.getActiveSession();
        const gen = peerManager.getState().generation;
        if (session && helloSentForGeneration !== gen) {
          helloSentForGeneration = gen;
          void sendEncryptedControlInternal({
            type: 'PEER_HELLO',
            payload: {
              memberId: session.memberId,
              protocolVersion: 1,
            },
          }).catch(() => {});
        }
      }
      emitState();
    },
    onChannelClose: () => emitState(),
    onChannelMessage: (label, data) => {
      if (disposed) {
        return;
      }
      if (label === PRODUCTION_CONTROL_CHANNEL_LABEL) {
        void handleInboundControlData(data);
        return;
      }
      if (label === PRODUCTION_BINARY_CHANNEL_LABEL) {
        if (typeof onBinaryFrame === 'function') {
          onBinaryFrame(data);
        }
      }
    },
    onError: (err) => forwardError(err),
  });

  const unsubscribers = [
    signalingClient.subscribeServerEvent('room:created', (payload) => {
      if (disposed || typeof payload?.roomId !== 'string') {
        return;
      }
      const bound = keyLifecycle.bindCreatedRoom(payload.roomId);
      if (!bound.ok) {
        forwardError(bound);
        return;
      }
      shareUrl = buildRoomShareUrl({
        origin: shareOrigin,
        roomId: bound.roomId,
        masterKeyBase64Url: bound.masterKeyBase64Url,
      });
      remoteMemberId = null;
      peerReadyNotified = false;
      emitState();
    }),

    signalingClient.subscribeServerEvent('peer:left', (payload) => {
      if (disposed) {
        return;
      }
      remoteMemberId = null;
      peerReadyNotified = false;
      emitState();
      if (typeof onPeerLeft === 'function') {
        onPeerLeft({
          roomId: payload?.roomId ?? null,
          reason: payload?.reason === 'disconnect' ? 'disconnect' : 'leave',
        });
      }
    }),
  ];

  async function createRoom({ origin } = {}) {
    if (disposed) {
      throw new Error('Room connection has been disposed.');
    }
    shareOrigin = resolveOrigin(locationObj, origin ?? options.origin);
    shareUrl = null;
    remoteMemberId = null;
    lastError = null;
    const prepared = keyLifecycle.prepareCreation();
    await authSession.createAuthorizedRoom(prepared.masterKeyBytes);
    // Zero temporary returned copy after auth verifier derivation
    prepared.masterKeyBytes.fill(0);
    emitState();
    return { status: 'creating' };
  }

  async function joinRoom(targetRoomId) {
    if (disposed) {
      throw new Error('Room connection has been disposed.');
    }
    shareUrl = null;
    remoteMemberId = null;
    lastError = null;
    const resolved = keyLifecycle.resolveForRoom(targetRoomId);
    if (!resolved.ok) {
      forwardError(resolved);
      return resolved;
    }
    await authSession.joinAuthorizedRoom(targetRoomId, resolved.masterKeyBytes);
    emitState();
    return { ok: true, roomId: targetRoomId };
  }

  function sendControlMessage(message) {
    return sendEncryptedControlInternal(message);
  }

  function sendBinaryFrame(frameBuffer) {
    const channel = peerManager.getChannel(PRODUCTION_BINARY_CHANNEL_LABEL);
    if (
      disposed ||
      !channel ||
      channel.readyState !== 'open' ||
      (!(frameBuffer instanceof ArrayBuffer) && !ArrayBuffer.isView(frameBuffer))
    ) {
      return false;
    }
    channel.send(frameBuffer);
    return true;
  }

  function leaveRoom() {
    shareUrl = null;
    remoteMemberId = null;
    peerReadyNotified = false;
    keyLifecycle.wipeForLeave();
    authSession.leaveAuthorizedRoom();
    peerManager.leaveRoom();
    emitState();
  }

  function dispose() {
    if (disposed) {
      return;
    }
    disposed = true;
    shareUrl = null;
    remoteMemberId = null;
    peerReadyNotified = false;
    while (unsubscribers.length > 0) {
      const unsub = unsubscribers.pop();
      unsub();
    }
    peerManager.dispose();
    authSession.dispose();
    keyLifecycle.wipeForLeave();
  }

  return Object.freeze({
    createRoom,
    joinRoom,
    leaveRoom,
    reconnect: () => peerManager.reconnect(),
    setIceTransportPolicy: (policy) => peerManager.setIceTransportPolicy(policy),
    sendControlMessage,
    sendBinaryFrame,
    getState: buildSanitizedState,
    getShareUrl: () => shareUrl,
    getMasterKeyBytes: () =>
      keyLifecycle.getActiveSession()?.masterKeyBytes ?? null,
    getPeerManager: () => peerManager,
    dispose,
  });
}
