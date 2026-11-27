import { createLocalFileBoard } from '../board/local-board.js';
import { createRemoteFileBoard } from '../board/remote-board.js';
import { encodeBase64Url } from '../crypto/base64url.js';
import { isValidMemberId } from '../crypto/control-codec.js';
import {
  SESSION_STORAGE_PREFIX,
  decodeMasterKey,
  generateMemberId,
} from '../crypto/fragment-key.js';
import { buildRoomShareUrl } from '../crypto/room-auth.js';
import { evaluatePersistenceCapability } from '../persistence/file-persistence.js';
import {
  createSignalingClient,
  sanitizeTextValue,
} from '../signaling/socket-client.js';
import { createTransferCoordinator } from '../transfer/transfer-coordinator.js';
import { createProductionRoomConnection } from '../webrtc/room-connection.js';
import { createReconnectSupervisor } from '../webrtc/reconnect-supervisor.js';
import {
  PRODUCTION_BINARY_CHANNEL_LABEL,
  PRODUCTION_CONTROL_CHANNEL_LABEL,
} from '../webrtc/peer-connection.js';
import { buildQrSvgPath, encodeQrMatrix } from './qr-code.js';

const CANONICAL_ROOM_ID_PATTERN = /^ship-[a-f0-9]{4}$/;
const PATH_ROOM_PATTERN = /^\/room\/(ship-[a-f0-9]{4})\/?$/;

const ERROR_COPY = Object.freeze({
  ROOM_NOT_FOUND: {
    title: 'Room not found or expired',
    message: 'Ask the other peer for a fresh invite link or create a new room.',
  },
  ROOM_FULL: {
    title: 'Room is already full',
    message: 'This room already has two active peers.',
  },
  UNAUTHORIZED: {
    title: 'Invalid room key',
    message: 'Open the full invite link with the #key= fragment intact.',
  },
  MISSING_KEY: {
    title: 'Missing encryption key',
    message: 'Reopen the full share URL containing #key=... to join cleanly.',
  },
  INVALID_KEY: {
    title: 'Invalid encryption key',
    message: 'The room link key fragment is malformed or corrupted.',
  },
  INVALID_ROOM_ID: {
    title: 'Invalid room identifier',
    message: 'Enter a valid room ID (ship-xxxx) or paste the full invite URL.',
  },
  RATE_LIMITED: {
    title: 'Too many requests',
    message: 'Wait a few seconds before trying again.',
  },
  SERVER_BUSY: {
    title: 'Relay capacity unavailable',
    message: 'TURN relay credentials are temporarily busy; retry shortly.',
  },
  MISSING_FILE_SYSTEM_ACCESS_API: {
    title: 'Browser saving API unavailable',
    message:
      'This browser does not support window.showSaveFilePicker() for direct-to-disk streaming.',
  },
  INSECURE_CONTEXT: {
    title: 'Secure context required',
    message: 'Direct file saving requires HTTPS (or localhost).',
  },
  DIRECTION_BUSY: {
    title: 'Download already in progress',
    message:
      'Finish or cancel the current incoming download before starting another.',
  },
  UNAVAILABLE: {
    title: 'File currently unavailable',
    message: 'Wait for the peer to reconnect or select an available file.',
  },
  LIMIT_EXCEEDED: {
    title: 'Insufficient storage space',
    message: 'Free up local disk space or choose a smaller file.',
  },
  FILE_UNREADABLE: {
    title: 'Local file unreadable',
    message: 'Re-add the file from disk if it was moved, renamed, or modified.',
  },
  QUOTA_EXCEEDED: {
    title: 'Disk quota exceeded',
    message: 'Saving stopped because available local disk quota ran out.',
  },
  PERSISTENCE_FAILED: {
    title: 'Failed writing file to disk',
    message: 'Retry choosing a writable save location.',
  },
  AUTH_FAILED: {
    title: 'Encrypted chunk authentication failed',
    message: 'Transfer aborted because encrypted chunk verification failed.',
  },
  FLOW_CREDIT_EXCEEDED: {
    title: 'Flow-control limit exceeded',
    message: 'Transfer aborted because peer exceeded the granted receive credit.',
  },
});

export function formatErrorCopy(errorObj) {
  const code =
    typeof errorObj?.code === 'string' ? errorObj.code : 'UNKNOWN_ERROR';
  const known = ERROR_COPY[code];
  if (known) {
    return Object.freeze({
      code,
      title: known.title,
      message: known.message,
    });
  }
  return Object.freeze({
    code,
    title: 'Transfer or room error',
    message:
      sanitizeTextValue(errorObj?.message, { maxLength: 160 }) ||
      'An unexpected error occurred.',
  });
}

/**
 * Parses either a canonical room ID (ship-xxxx) or a full share link
 * containing /room/ship-xxxx#key=... without leaking key material to logs.
 */
export function parseRoomEntryInput(rawInput, locationObj) {
  const trimmed = typeof rawInput === 'string' ? rawInput.trim() : '';
  if (!trimmed) {
    return {
      ok: false,
      code: 'INVALID_ROOM_ID',
      message: ERROR_COPY.INVALID_ROOM_ID.message,
    };
  }

  if (CANONICAL_ROOM_ID_PATTERN.test(trimmed)) {
    return { ok: true, roomId: trimmed, masterKeyBase64Url: null };
  }

  try {
    const base =
      typeof locationObj?.origin === 'string' && locationObj.origin !== 'null'
        ? locationObj.origin
        : 'https://shipri.app';
    const parsed = new URL(trimmed, base);
    const match = PATH_ROOM_PATTERN.exec(parsed.pathname);
    if (!match) {
      return {
        ok: false,
        code: 'INVALID_ROOM_ID',
        message: ERROR_COPY.INVALID_ROOM_ID.message,
      };
    }

    let masterKeyBase64Url = null;
    if (parsed.hash && parsed.hash.startsWith('#key=')) {
      const candidateKey = parsed.hash.slice('#key='.length);
      decodeMasterKey(candidateKey);
      masterKeyBase64Url = candidateKey;
    }

    return {
      ok: true,
      roomId: match[1],
      masterKeyBase64Url,
    };
  } catch {
    return {
      ok: false,
      code: trimmed.includes('#key=') ? 'INVALID_KEY' : 'INVALID_ROOM_ID',
      message: trimmed.includes('#key=')
        ? ERROR_COPY.INVALID_KEY.message
        : ERROR_COPY.INVALID_ROOM_ID.message,
    };
  }
}

export function createInitialRoomBoardUiState(overrides = {}) {
  return {
    connectionStatus: 'disconnected',
    peerState: 'unaffiliated',
    roomId: null,
    peerReady: false,
    remoteSyncState: 'empty',
    hasShareUrl: Boolean(overrides.hasShareUrl ?? overrides.shareUrl),
    qrVisible: false,
    qrPayload: null,
    copyFeedback: null,
    selectedPath: null,
    capability: Object.freeze({
      supported: true,
      mode: 'file-system-access',
      reason: null,
      guidance: null,
    }),
    localFiles: [],
    remoteFiles: [],
    transfers: [],
    hasActiveIncomingDownload: false,
    errorBanner: null,
    statusAnnouncement: 'Connecting to signaling server.',
    ...overrides,
  };
}

const INCOMING_BUSY_STATES = new Set([
  'preparing_persistence',
  'requesting',
  'active',
  'paused_by_user',
  'paused_reconnecting',
  'resuming',
]);

/**
 * Production equal-peer controller orchestrating room entry, fragment-key
 * lifecycle, local/remote encrypted file boards, and simultaneous transfers.
 */
export function createRoomBoardController({
  signalingClient: providedSignalingClient,
  peerConnectionFactory,
  storage = globalThis.window?.sessionStorage,
  locationObj = globalThis.window?.location,
  historyObj = globalThis.window?.history,
  windowObj = globalThis.window,
  navigatorObj = globalThis.navigator,
  cryptoProcessor,
  nowFn = Date.now,
  origin,
  iceTransportPolicy = 'all',
  autoConnect = !providedSignalingClient,
} = {}) {
  let disposed = false;
  const signalingClient = providedSignalingClient ?? createSignalingClient();
  const ownsSignalingClient = !providedSignalingClient;

  let localBoard = null;
  let remoteBoard = null;
  let transferCoordinator = null;
  let boundRoomId = null;
  let autoJoinAttempted = false;
  let qrVisible = false;
  let copyFeedback = null;
  let copyTimer = null;
  let errorBanner = null;
  let statusAnnouncement = 'Connecting to signaling server.';

  const listeners = new Set();

  function evaluateBrowserCapability() {
    if (transferCoordinator) {
      return transferCoordinator.getCapabilities().capability;
    }
    return evaluatePersistenceCapability({ windowObj });
  }

  function resolveInitialRoomIdFromLocation() {
    if (typeof locationObj?.pathname !== 'string') {
      return null;
    }
    const match = PATH_ROOM_PATTERN.exec(locationObj.pathname);
    return match ? match[1] : null;
  }

  function computeStatusAnnouncement(connState) {
    if (connState.connectionStatus === 'error') {
      return 'Signaling connection error. Attempting recovery.';
    }
    if (!connState.roomId) {
      return connState.connectionStatus === 'connected'
        ? 'Connected to signaling. Create or join a room to share files.'
        : 'Connecting to signaling server.';
    }
    if (connState.peerState === 'waiting_for_peer') {
      return 'Waiting for another peer to join the room.';
    }
    if (connState.selectedPath?.relayed || connState.selectedPath?.isRelay) {
      return connState.peerReady
        ? 'Connected via TURN relay. Throughput may be capped by relay limits.'
        : 'TURN relay active. Waiting for encrypted channels.';
    }
    if (connState.peerReady) {
      return 'Encrypted peer connection ready.';
    }
    return `Peer connection state: ${connState.peerState}.`;
  }

  function resolveShareUrl() {
    const connUrl = roomConnection.getShareUrl();
    if (connUrl) {
      return connUrl;
    }
    const connState = roomConnection.getState();
    const masterKeyBytes = roomConnection.getMasterKeyBytes();
    const resolvedOrigin =
      typeof origin === 'string' && origin.trim() !== ''
        ? origin.trim()
        : typeof locationObj?.origin === 'string' && locationObj.origin !== 'null'
          ? locationObj.origin
          : 'http://localhost:5173';
    if (!connState.roomId || !(masterKeyBytes instanceof Uint8Array)) {
      return null;
    }
    try {
      return buildRoomShareUrl({
        origin: resolvedOrigin,
        roomId: connState.roomId,
        masterKeyBase64Url: encodeBase64Url(masterKeyBytes),
      });
    } catch {
      return null;
    }
  }

  function buildUiState() {
    const connState = roomConnection.getState();
    const localFiles = localBoard ? localBoard.getPublicEntries() : [];
    const remoteFiles = remoteBoard ? remoteBoard.getEntries() : [];
    const transfers = transferCoordinator ? transferCoordinator.getTransfers() : [];
    const hasActiveIncomingDownload = transfers.some(
      (t) => t.role === 'downloader' && INCOMING_BUSY_STATES.has(t.state),
    );
    const activeShareUrl = connState.roomId ? resolveShareUrl() : null;
    let qrPayload = null;
    if (connState.roomId && qrVisible && activeShareUrl) {
      try {
        const encoded = encodeQrMatrix(activeShareUrl);
        const quietZone = 4;
        const totalSize = encoded.size + quietZone * 2;
        qrPayload = Object.freeze({
          viewBox: `0 0 ${totalSize} ${totalSize}`,
          path: buildQrSvgPath(encoded.matrix, quietZone),
        });
      } catch {
        qrPayload = null;
      }
    }

    return {
      connectionStatus: connState.connectionStatus,
      peerState: connState.peerState,
      roomId: connState.roomId,
      peerReady: connState.peerReady,
      remoteSyncState: remoteBoard ? remoteBoard.getSyncState() : 'empty',
      hasShareUrl: Boolean(activeShareUrl),
      qrVisible: Boolean(connState.roomId && qrVisible),
      qrPayload,
      copyFeedback,
      selectedPath: connState.selectedPath,
      capability: evaluateBrowserCapability(),
      localFiles,
      remoteFiles,
      transfers,
      hasActiveIncomingDownload,
      errorBanner,
      statusAnnouncement,
    };
  }

  function notifyListeners() {
    if (disposed) {
      return;
    }
    const snapshot = buildUiState();
    for (const listener of [...listeners]) {
      listener(snapshot);
    }
  }

  function teardownBoards() {
    boundRoomId = null;
    if (transferCoordinator) {
      transferCoordinator.dispose();
      transferCoordinator = null;
    }
    if (remoteBoard) {
      remoteBoard.dispose();
      remoteBoard = null;
    }
    if (localBoard) {
      localBoard.dispose();
      localBoard = null;
    }
  }

  function ensureBoardsInitialized(connState) {
    const masterKeyBytes = roomConnection.getMasterKeyBytes();
    const roomId = connState.roomId;
    const localMemberId = connState.memberId;

    if (
      disposed ||
      !roomId ||
      !(masterKeyBytes instanceof Uint8Array) ||
      !isValidMemberId(localMemberId)
    ) {
      if (!roomId && (localBoard || remoteBoard || transferCoordinator)) {
        teardownBoards();
      }
      return;
    }

    if (boundRoomId === roomId && localBoard && remoteBoard && transferCoordinator) {
      return;
    }

    teardownBoards();
    boundRoomId = roomId;

    localBoard = createLocalFileBoard({
      roomId,
      masterKeyBytes,
      publishControlMessage: async (msg) => {
        if (roomConnection.getState().peerReady) {
          await roomConnection.sendControlMessage(msg);
        }
      },
      onChange: () => {
        notifyListeners();
      },
    });

    remoteBoard = createRemoteFileBoard({
      roomId,
      masterKeyBytes,
      onChange: (entries) => {
        if (transferCoordinator) {
          void transferCoordinator.refreshRemoteCapabilities(entries);
        }
        notifyListeners();
      },
      onError: (err) => {
        errorBanner = formatErrorCopy(err);
        notifyListeners();
      },
    });

    transferCoordinator = createTransferCoordinator({
      roomId,
      masterKeyBytes,
      localMemberId,
      getRemoteMemberId: () => roomConnection.getState().remoteMemberId,
      localBoard,
      remoteBoard,
      getBinaryChannel: () =>
        roomConnection.getPeerManager().getChannel(PRODUCTION_BINARY_CHANNEL_LABEL),
      sendControlMessage: async (msg) => {
        await roomConnection.sendControlMessage(msg);
      },
      cryptoProcessor,
      windowObj,
      navigatorObj,
      nowFn,
      onChange: () => {
        notifyListeners();
      },
      onError: (err) => {
        errorBanner = formatErrorCopy(err);
        notifyListeners();
      },
    });
  }

  const roomConnection = createProductionRoomConnection({
    signalingClient,
    peerConnectionFactory,
    storage,
    locationObj,
    historyObj,
    origin,
    iceTransportPolicy,
    onStateChange: (connState) => {
      ensureBoardsInitialized(connState);
      statusAnnouncement = computeStatusAnnouncement(connState);

      if (
        !autoJoinAttempted &&
        !connState.roomId &&
        connState.connectionStatus === 'connected'
      ) {
        const pathRoomId = resolveInitialRoomIdFromLocation();
        if (pathRoomId) {
          autoJoinAttempted = true;
          void joinRoom(pathRoomId);
        }
      }
      notifyListeners();
    },
    onPeerReady: async () => {
      reconnectSupervisor.notifyPeerReady();
      if (disposed || !localBoard) {
        return;
      }
      try {
        const syncMsg = await localBoard.getBoardSyncMessage();
        if (!disposed && roomConnection.getState().peerReady) {
          await roomConnection.sendControlMessage(syncMsg);
        }
        if (!disposed && transferCoordinator && roomConnection.getState().peerReady) {
          await transferCoordinator.handlePeerReconnected();
        }
      } catch {
        // Ignore transient send errors while channel settles
      }
    },
    onPeerLeft: () => {
      if (remoteBoard) {
        remoteBoard.handlePeerDisconnected();
      }
      if (transferCoordinator) {
        transferCoordinator.handlePeerDisconnected();
      }
      reconnectSupervisor.notifyPeerLeft();
      statusAnnouncement =
        'Peer disconnected. Shared files preserved for 60s reconnect window.';
      notifyListeners();
    },
    onControlMessage: (message, senderMemberId) => {
      if (disposed) {
        return;
      }
      if (
        message.type === 'PEER_HELLO' ||
        message.type === 'BOARD_SYNC' ||
        message.type === 'FILE_ADVERTISE' ||
        message.type === 'FILE_REMOVE'
      ) {
        void remoteBoard?.handleControlMessage(message);
        return;
      }
      void transferCoordinator?.handleControlMessage(message, senderMemberId);
    },
    onBinaryFrame: (frameBuffer) => {
      if (disposed || !transferCoordinator) {
        return;
      }
      transferCoordinator.handleBinaryFrame(frameBuffer);
    },
    onError: (err) => {
      errorBanner = formatErrorCopy(err);
      if (err?.code === 'ROOM_NOT_FOUND' || err?.code === 'UNAUTHORIZED' || err?.code === 'ROOM_FULL') {
        reconnectSupervisor.notifyIntentionalLeave();
        teardownBoards();
      } else if (
        err?.code === 'ICE_CONNECTION_FAILED' ||
        err?.code === 'PEER_CONNECTION_FAILED'
      ) {
        reconnectSupervisor.notifyTransportFailure(err.code);
      }
      notifyListeners();
    },
  });

  const reconnectSupervisor = createReconnectSupervisor({
    roomConnection,
    signalingClient,
    onStateChange: () => notifyListeners(),
    onExhausted: ({ reason }) => {
      statusAnnouncement =
        reason === 'GRACE_WINDOW_EXPIRED'
          ? 'Reconnect grace window expired.'
          : 'Reconnection attempts exhausted.';
      notifyListeners();
    },
  });

  if (autoConnect) {
    signalingClient.connect();
  }

  const initialConn = roomConnection.getState();
  statusAnnouncement = computeStatusAnnouncement(initialConn);
  if (initialConn.connectionStatus === 'connected') {
    const pathRoomId = resolveInitialRoomIdFromLocation();
    if (pathRoomId) {
      autoJoinAttempted = true;
      void joinRoom(pathRoomId);
    }
  }

  async function createRoom() {
    if (disposed) {
      return { ok: false, code: 'DISPOSED' };
    }
    errorBanner = null;
    qrVisible = false;
    await roomConnection.createRoom({ origin });
    notifyListeners();
    return { ok: true };
  }

  async function joinRoom(rawInput) {
    if (disposed) {
      return { ok: false, code: 'DISPOSED' };
    }
    errorBanner = null;
    qrVisible = false;

    const parsed = parseRoomEntryInput(rawInput, locationObj);
    if (!parsed.ok) {
      errorBanner = formatErrorCopy(parsed);
      notifyListeners();
      return parsed;
    }

    if (
      parsed.masterKeyBase64Url &&
      storage &&
      typeof storage.setItem === 'function'
    ) {
      storage.setItem(
        `${SESSION_STORAGE_PREFIX}${parsed.roomId}`,
        JSON.stringify({
          masterKeyBase64Url: parsed.masterKeyBase64Url,
          memberId: generateMemberId(),
        }),
      );
    }

    const result = await roomConnection.joinRoom(parsed.roomId);
    if (result?.ok === false) {
      errorBanner = formatErrorCopy(result);
    }
    notifyListeners();
    return result;
  }

  function leaveRoom() {
    if (disposed) {
      return;
    }
    qrVisible = false;
    copyFeedback = null;
    errorBanner = null;
    reconnectSupervisor.notifyIntentionalLeave();
    teardownBoards();
    roomConnection.leaveRoom();
    statusAnnouncement = 'Left room and wiped encryption keys from session.';
    notifyListeners();
  }

  async function copyShareLink(clipboardObj = navigatorObj?.clipboard) {
    const shareUrl = resolveShareUrl();
    if (!shareUrl || typeof clipboardObj?.writeText !== 'function') {
      return false;
    }
    try {
      await clipboardObj.writeText(shareUrl);
      copyFeedback = 'Share link copied';
      statusAnnouncement = 'Room share link copied to clipboard.';
      if (copyTimer) {
        clearTimeout(copyTimer);
      }
      copyTimer = setTimeout(() => {
        copyFeedback = null;
        notifyListeners();
      }, 2500);
      notifyListeners();
      return true;
    } catch {
      return false;
    }
  }

  function toggleQrCode(nextValue) {
    qrVisible =
      typeof nextValue === 'boolean' ? nextValue : !qrVisible;
    notifyListeners();
    return qrVisible;
  }

  async function addLocalFiles(fileList) {
    if (disposed || !localBoard) {
      return { advertised: [], duplicates: [], rejected: [], messages: [] };
    }
    const result = await localBoard.addFiles(fileList);
    if (result.rejected.length > 0) {
      errorBanner = formatErrorCopy({
        code: 'FILE_UNREADABLE',
        message: `Skipped ${result.rejected.length} unreadable or invalid file(s).`,
      });
    } else if (result.advertised.length > 0) {
      statusAnnouncement = `Shared ${result.advertised.length} file(s) with peer.`;
    }
    notifyListeners();
    return result;
  }

  async function removeLocalFile(fileId) {
    if (disposed || !localBoard) {
      return false;
    }
    const removed = await localBoard.removeFile(fileId);
    if (removed) {
      statusAnnouncement = 'Removed file advertisement from board.';
      notifyListeners();
    }
    return removed;
  }

  /**
   * Preserves transient user gesture by calling coordinator.requestDownload(fileId)
   * synchronously before awaiting any async continuation.
   */
  function downloadRemoteFile(fileId) {
    if (disposed || !transferCoordinator) {
      return Promise.resolve({ ok: false, code: 'UNAVAILABLE' });
    }
    const reqPromise = transferCoordinator.requestDownload(fileId);
    return reqPromise.then((res) => {
      if (!res?.ok && !res?.cancelled) {
        errorBanner = formatErrorCopy(res);
      } else if (res?.ok) {
        statusAnnouncement = 'Download requested.';
      }
      notifyListeners();
      return res;
    });
  }

  function pauseTransfer(transferId) {
    return transferCoordinator?.pauseTransfer(transferId) ?? false;
  }

  function resumeTransfer(transferId) {
    return transferCoordinator?.resumeTransfer(transferId) ?? Promise.resolve(false);
  }

  function cancelTransfer(transferId) {
    return transferCoordinator?.cancelTransfer(transferId) ?? Promise.resolve(false);
  }

  function dismissError() {
    errorBanner = null;
    notifyListeners();
  }

  function subscribe(listener) {
    if (typeof listener !== 'function') {
      return () => {};
    }
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  function dispose() {
    if (disposed) {
      return;
    }
    disposed = true;
    if (copyTimer) {
      clearTimeout(copyTimer);
      copyTimer = null;
    }
    listeners.clear();
    reconnectSupervisor.dispose();
    teardownBoards();
    roomConnection.dispose();
    if (ownsSignalingClient) {
      signalingClient.dispose();
    }
  }

  return Object.freeze({
    createRoom,
    joinRoom,
    leaveRoom,
    copyShareLink,
    toggleQrCode,
    addLocalFiles,
    removeLocalFile,
    downloadRemoteFile,
    pauseTransfer,
    resumeTransfer,
    cancelTransfer,
    dismissError,
    getState: buildUiState,
    getConnection: () => roomConnection,
    getControlChannel: () =>
      roomConnection.getPeerManager().getChannel(PRODUCTION_CONTROL_CHANNEL_LABEL),
    subscribe,
    dispose,
  });
}
