import React, { useEffect, useRef, useState } from 'react';
import {
  DIAGNOSTIC_CHANNEL_LABEL,
  MAX_DIAGNOSTIC_TEXT_LENGTH,
  createDiagnosticChannelController,
  createInitialDiagnosticChannelState,
} from './prototype/diagnostic-channel.js';
import {
  applyConnectionStatus,
  applyDiagnosticChannelState,
  applyWebRtcState,
  bindSignalingClient,
  clearEventLog,
  createInitialPrototypeState,
  createRoomLifecycleActions,
  recoverErrorState,
  shouldClearDraftRoomInput,
} from './prototype/diagnostic-state.js';
import { createInitialIceDiagnosticsState } from './prototype/ice-diagnostics.js';
import {
  MALFORMED_TEST_SCENARIOS,
  resolveRoomErrorDescriptor,
  runValidationScenario,
} from './prototype/room-errors.js';
import {
  createInitialWebRtcState,
  createWebRtcHarness,
} from './prototype/webrtc-harness.js';
import {
  createSignalingClient,
  sanitizeTextValue,
} from './signaling/socket-client.js';

function getConnectionStatusBanner(connectionStatus) {
  if (connectionStatus === 'connected') {
    return 'Signaling server connected';
  }
  if (connectionStatus === 'error') {
    return 'Signaling connection error';
  }
  return 'Connecting to signaling server...';
}

function formatLastError(lastError) {
  if (!lastError) {
    return 'None';
  }
  const prefix = lastError.code ? `${lastError.code}: ` : '';
  const roomSuffix = lastError.roomId ? ` (${lastError.roomId})` : '';
  return `${prefix}${lastError.message}${roomSuffix}`;
}

function resolveDisconnectNotice({
  connectionStatus,
  roomId,
  peerState,
  negotiationDuty,
  eventLog,
  signalingClient,
}) {
  if (connectionStatus === 'disconnected') {
    const clientStatus = signalingClient?.getStatus?.();
    let localReason =
      clientStatus?.status === 'disconnected' && clientStatus.disconnectReason
        ? clientStatus.disconnectReason
        : null;

    if (!localReason && Array.isArray(eventLog)) {
      for (let index = eventLog.length - 1; index >= 0; index -= 1) {
        const entry = eventLog[index];
        if (entry?.event === 'connect') {
          break;
        }
        if (entry?.event === 'disconnect') {
          localReason = entry.meta?.reason || 'unknown';
          break;
        }
      }
    }

    if (localReason) {
      const safeReason =
        sanitizeTextValue(localReason, { maxLength: 80 }) || 'unknown';
      return `Signaling disconnected (${safeReason}). Active room and peer state were reset; sanitized event log was preserved.`;
    }
  }

  if (roomId && peerState === 'waiting_for_peer' && Array.isArray(eventLog)) {
    for (let index = eventLog.length - 1; index >= 0; index -= 1) {
      const entry = eventLog[index];
      if (
        entry?.event === 'room:created' ||
        entry?.event === 'room:joined' ||
        entry?.event === 'peer:joined'
      ) {
        break;
      }
      if (entry?.event === 'peer:left') {
        if (entry.meta?.reason === 'disconnect') {
          return `Remote peer disconnected from ${roomId}. You remain in the room as ${negotiationDuty ?? 'offerer'} waiting for a replacement peer.`;
        }
        break;
      }
    }
  }

  return null;
}

function App({ signalingClient, initialState } = {}) {
  const clientRef = useRef(signalingClient ?? null);
  const webrtcHarnessRef = useRef(null);
  const diagnosticChannelRef = useRef(null);
  const [joinRoomId, setJoinRoomId] = useState('');
  const [diagnosticText, setDiagnosticText] = useState('');
  const [prototypeState, setPrototypeState] = useState(() => {
    const baseState = createInitialPrototypeState(initialState);
    return signalingClient
      ? applyConnectionStatus(baseState, signalingClient.getStatus())
      : baseState;
  });

  useEffect(() => {
    const client = signalingClient ?? createSignalingClient();
    const ownsClient = !signalingClient;
    clientRef.current = client;
    const unbind = bindSignalingClient(client, setPrototypeState);
    const channelController = createDiagnosticChannelController({
      signalingClient: client,
      onStateChange: (nextChannelState) => {
        setPrototypeState((prev) =>
          applyDiagnosticChannelState(prev, nextChannelState),
        );
      },
    });
    diagnosticChannelRef.current = channelController;

    const harness = createWebRtcHarness({
      signalingClient: client,
      onStateChange: (nextWebRtcState) => {
        setPrototypeState((prev) => applyWebRtcState(prev, nextWebRtcState));
      },
      onDataChannel: (channel, meta) =>
        channelController.attachChannel(channel, meta),
    });
    webrtcHarnessRef.current = harness;

    if (ownsClient) {
      client.connect();
    }

    return () => {
      harness.dispose();
      webrtcHarnessRef.current = null;
      channelController.dispose();
      diagnosticChannelRef.current = null;
      unbind();
      if (ownsClient) {
        client.dispose();
        clientRef.current = null;
      }
    };
  }, [signalingClient]);

  const {
    connectionStatus,
    roomId,
    peerState,
    entryRole = null,
    negotiationDuty,
    selfPeerId = null,
    remotePeerId = null,
    lastError,
    iceDiagnostics: rawIceDiagnostics = null,
    webrtc: rawWebRtc = null,
    diagnosticChannel: rawDiagnosticChannel = null,
    eventLog,
  } = prototypeState;
  const iceDiagnostics =
    rawIceDiagnostics ?? createInitialIceDiagnosticsState();
  const webrtc = rawWebRtc ?? createInitialWebRtcState();
  const diagnosticChannel =
    rawDiagnosticChannel ?? createInitialDiagnosticChannelState();

  useEffect(() => {
    if (roomId) {
      setJoinRoomId('');
    } else {
      setDiagnosticText('');
    }
  }, [roomId]);

  const socketConnected = connectionStatus === 'connected';
  const channelOpen =
    socketConnected &&
    Boolean(roomId) &&
    peerState === 'connected' &&
    diagnosticChannel.channelState === 'open';
  const statusBannerText = getConnectionStatusBanner(connectionStatus);
  const errorDescriptor = lastError
    ? resolveRoomErrorDescriptor(lastError)
    : null;
  const disconnectNotice = resolveDisconnectNotice({
    connectionStatus,
    roomId,
    peerState,
    negotiationDuty,
    eventLog,
    signalingClient: signalingClient ?? clientRef.current,
  });

  const getLifecycleActions = () => {
    const client = signalingClient ?? clientRef.current;
    if (!client) {
      return null;
    }
    return createRoomLifecycleActions(client, setPrototypeState);
  };

  const handleCreateRoom = () => {
    const actions = getLifecycleActions();
    if (!actions || !socketConnected || roomId) {
      return;
    }
    actions.createRoom();
  };

  const handleJoinRoom = (event) => {
    event.preventDefault();
    const actions = getLifecycleActions();
    if (!actions || !socketConnected || roomId) {
      return;
    }
    actions.joinRoom(joinRoomId);
  };

  const handleLeaveRoom = () => {
    const actions = getLifecycleActions();
    if (!actions || !socketConnected || !roomId) {
      return;
    }
    actions.leaveRoom(roomId);
  };

  const handleRequestIce = () => {
    const actions = getLifecycleActions();
    if (!actions || !socketConnected || !roomId) {
      return;
    }
    actions.requestIce(roomId);
  };

  const handleStartWebRtcNegotiation = () => {
    const harness = webrtcHarnessRef.current;
    if (
      !harness ||
      !socketConnected ||
      !roomId ||
      peerState !== 'connected' ||
      negotiationDuty !== 'offerer' ||
      webrtc.status === 'negotiating'
    ) {
      return;
    }
    void harness.startNegotiation();
  };

  const handleSendPing = () => {
    const controller = diagnosticChannelRef.current;
    if (!controller || !channelOpen) {
      return;
    }
    controller.sendPing();
  };

  const handleSendText = (event) => {
    event.preventDefault();
    const controller = diagnosticChannelRef.current;
    if (!controller || !channelOpen) {
      return;
    }
    const result = controller.sendText(diagnosticText);
    if (result?.ok) {
      setDiagnosticText('');
    }
  };

  const handleClearError = () => {
    if (!lastError && !diagnosticChannel.lastError) {
      return;
    }
    if (shouldClearDraftRoomInput(prototypeState)) {
      setJoinRoomId('');
    }
    diagnosticChannelRef.current?.clearError();
    setPrototypeState((prev) => recoverErrorState(prev));
  };

  const handleRunValidationScenario = (scenarioId) => {
    const client = signalingClient ?? clientRef.current;
    if (!client || !socketConnected) {
      return;
    }
    runValidationScenario(client, scenarioId, {
      roomId,
      targetRoomId: joinRoomId.trim() || undefined,
    });
  };

  const handleClearLog = () => {
    setPrototypeState((prev) => clearEventLog(prev));
  };

  return (
    <main className="glass-card diagnostic-shell">
      <header className="diagnostic-header">
        <div>
          <h1 className="diagnostic-title">
            <span className="gradient-text">Shipri</span>
          </h1>
          <p className="diagnostic-subtitle">Diagnostic Prototype Shell</p>
        </div>

        <div className="connection-banner" role="status" aria-live="polite">
          <span
            className="pulse-dot"
            style={{ backgroundColor: socketConnected ? '#00F5D4' : '#ff0055' }}
          />
          <span>{statusBannerText}</span>
        </div>
      </header>

      <section className="room-controls" aria-label="Room controls">
        <div className="room-controls-header">
          <h2 className="room-controls-title">Room Controls</h2>
          <p className="room-controls-note">
            Both room members are equal peers. Entry role reflects entry history
            only and negotiation duty is signaling-only; neither restricts
            messages or implies file-transfer direction.
          </p>
        </div>

        <div className="room-controls-actions">
          <button
            type="button"
            className="btn-primary"
            onClick={handleCreateRoom}
            disabled={!socketConnected || Boolean(roomId)}
          >
            Create Room
          </button>

          <form className="room-join-form" onSubmit={handleJoinRoom}>
            <label className="sr-only" htmlFor="join-room-id">
              Room ID to join
            </label>
            <input
              id="join-room-id"
              name="roomId"
              type="text"
              className="room-id-input"
              value={joinRoomId}
              onChange={(event) => setJoinRoomId(event.target.value)}
              placeholder="ship-xxxx"
              aria-label="Room ID to join"
              autoComplete="off"
              spellCheck={false}
              disabled={!socketConnected || Boolean(roomId)}
            />
            <button
              type="submit"
              className="btn-secondary"
              disabled={
                !socketConnected || Boolean(roomId) || joinRoomId.trim() === ''
              }
            >
              Join Room
            </button>
          </form>

          <button
            type="button"
            className="btn-secondary btn-danger"
            onClick={handleLeaveRoom}
            disabled={!socketConnected || !roomId}
          >
            Leave Room
          </button>
        </div>
      </section>

      {disconnectNotice ? (
        <div className="disconnect-notice" role="status" aria-live="polite">
          {disconnectNotice}
        </div>
      ) : null}

      <section className="status-grid" aria-label="Diagnostic status">
        <div className="status-card">
          <span className="status-label">Connection State</span>
          <span className="status-value">{connectionStatus}</span>
        </div>

        <div className="status-card">
          <span className="status-label">Room ID</span>
          <span
            className={`status-value${roomId ? '' : ' status-value--muted'}`}
          >
            {roomId ?? 'None'}
          </span>
        </div>

        <div className="status-card">
          <span className="status-label">Peer State</span>
          <span className="status-value">{peerState}</span>
          {selfPeerId ? (
            <span className="status-hint">Self ID: {selfPeerId}</span>
          ) : null}
          {remotePeerId ? (
            <span className="status-hint">Peer ID: {remotePeerId}</span>
          ) : null}
        </div>

        <div className="status-card">
          <span className="status-label">Entry Role</span>
          <span
            className={`status-value${entryRole ? '' : ' status-value--muted'}`}
          >
            {entryRole ?? 'None'}
          </span>
          <span className="status-hint">Entry history only</span>
        </div>

        <div className="status-card">
          <span className="status-label">Negotiation Duty</span>
          <span
            className={`status-value${negotiationDuty ? '' : ' status-value--muted'}`}
          >
            {negotiationDuty ?? 'None'}
          </span>
          <span className="status-hint">Signaling-only</span>
        </div>

        <div
          className={`status-card status-card--wide${lastError ? ' status-card--error' : ''}`}
        >
          <div className="status-card-header">
            <span className="status-label">Last Error</span>
            <button
              type="button"
              className="btn-secondary"
              onClick={handleClearError}
              disabled={!lastError}
            >
              Clear Error
            </button>
          </div>

          {lastError && errorDescriptor ? (
            <div className="error-diagnostics">
              <div className="error-diagnostics-meta">
                <span className="event-log-badge event-log-badge--error">
                  {lastError.code}
                </span>
                <span className="event-log-badge">
                  Category: {errorDescriptor.category}
                </span>
                {!errorDescriptor.known &&
                lastError.code !== 'UNKNOWN_ERROR' ? (
                  <span className="event-log-badge">
                    Fallback: {errorDescriptor.code}
                  </span>
                ) : null}
                {lastError.roomId ? (
                  <span className="event-log-badge">{lastError.roomId}</span>
                ) : null}
                {lastError.source ? (
                  <span className="event-log-badge">{lastError.source}</span>
                ) : null}
              </div>
              <span className="status-value status-value--error">
                {errorDescriptor.title}: {formatLastError(lastError)}
              </span>
              <p className="error-recovery-guidance">
                Recovery: {errorDescriptor.recoveryGuidance}
              </p>
            </div>
          ) : (
            <span className="status-value status-value--muted">
              {formatLastError(lastError)}
            </span>
          )}
        </div>
      </section>

      <section
        className="ice-diagnostics"
        aria-label="ICE configuration diagnostics"
      >
        <div className="ice-diagnostics-header">
          <div className="ice-diagnostics-title-group">
            <h2 className="ice-diagnostics-title">
              ICE Configuration Diagnostics
            </h2>
            <p className="ice-diagnostics-note">
              Request and validate development STUN-only ICE server
              configuration for the active room without exposing server
              endpoints or secrets.
            </p>
          </div>

          <button
            type="button"
            className="btn-secondary"
            onClick={handleRequestIce}
            disabled={
              !socketConnected ||
              !roomId ||
              iceDiagnostics.status === 'loading'
            }
          >
            Request ICE Config
          </button>
        </div>

        <div className="ice-summary-grid">
          <div className="status-card">
            <span className="status-label">ICE Status</span>
            <span
              className={`status-value${
                iceDiagnostics.status === 'invalid' ||
                iceDiagnostics.status === 'error'
                  ? ' status-value--error'
                  : iceDiagnostics.status === 'idle'
                    ? ' status-value--muted'
                    : ''
              }`}
            >
              {iceDiagnostics.status}
            </span>
            <span className="status-hint">
              {iceDiagnostics.isStunOnly
                ? 'Development STUN-only'
                : 'Endpoints redacted'}
            </span>
          </div>

          <div className="status-card">
            <span className="status-label">Server Entries</span>
            <span className="status-value">
              {iceDiagnostics.serverEntryCount}
            </span>
          </div>

          <div className="status-card">
            <span className="status-label">Endpoint URLs</span>
            <span className="status-value">{iceDiagnostics.endpointCount}</span>
          </div>

          <div className="status-card">
            <span className="status-label">Schemes</span>
            <span
              className={`status-value${
                iceDiagnostics.schemes.length === 0
                  ? ' status-value--muted'
                  : ''
              }`}
            >
              {iceDiagnostics.schemes.length > 0
                ? iceDiagnostics.schemes.join(', ')
                : 'None'}
            </span>
          </div>

          <div className="status-card">
            <span className="status-label">STUN / TURN Counts</span>
            <span className="status-value">
              {`STUN: ${iceDiagnostics.stunCount} / TURN: ${iceDiagnostics.turnCount}`}
            </span>
          </div>
        </div>

        {iceDiagnostics.lastError ? (
          <div
            className="ice-diagnostics-error"
            role="status"
            aria-live="polite"
          >
            <span className="event-log-badge event-log-badge--error">
              {iceDiagnostics.lastError.code}
            </span>
            <span className="ice-diagnostics-error-text">
              {iceDiagnostics.lastError.message}
            </span>
          </div>
        ) : null}
      </section>

      <section
        className="webrtc-harness"
        aria-label="WebRTC signaling harness"
      >
        <div className="webrtc-harness-header">
          <div className="webrtc-harness-title-group">
            <h2 className="webrtc-harness-title">WebRTC Signaling Harness</h2>
            <p className="webrtc-harness-note">
              Trickle ICE and SDP offer/answer negotiation run on the active
              room peer connection. Negotiation duty controls initial signaling
              setup only and never restricts application messages.
            </p>
          </div>

          <button
            type="button"
            className="btn-primary"
            onClick={handleStartWebRtcNegotiation}
            disabled={
              !socketConnected ||
              !roomId ||
              peerState !== 'connected' ||
              negotiationDuty !== 'offerer' ||
              webrtc.status === 'negotiating'
            }
          >
            Start WebRTC Negotiation
          </button>
        </div>

        <div className="webrtc-summary-grid">
          <div className="status-card">
            <span className="status-label">Harness Status</span>
            <span
              className={`status-value${
                webrtc.status === 'failed'
                  ? ' status-value--error'
                  : webrtc.status === 'idle'
                    ? ' status-value--muted'
                    : ''
              }`}
            >
              {webrtc.status}
            </span>
            <span className="status-hint">
              {webrtc.localDescriptionForwarded
                ? 'SDP forwarded immediately'
                : 'Awaiting local SDP'}
            </span>
          </div>

          <div className="status-card">
            <span className="status-label">Signaling State</span>
            <span
              className={`status-value${
                webrtc.signalingState === 'idle' ? ' status-value--muted' : ''
              }`}
            >
              {webrtc.signalingState}
            </span>
            <span className="status-hint">
              {webrtc.activePeerId
                ? `Active peer: ${webrtc.activePeerId}`
                : 'No active peer session'}
            </span>
          </div>

          <div className="status-card">
            <span className="status-label">ICE Gathering State</span>
            <span className="status-value">{webrtc.iceGatheringState}</span>
            <span className="status-hint">
              {webrtc.stalledGathering
                ? '5000ms bound exceeded'
                : 'Trickle ICE active'}
            </span>
          </div>

          <div className="status-card">
            <span className="status-label">ICE Connection State</span>
            <span
              className={`status-value${
                webrtc.iceConnectionState === 'failed'
                  ? ' status-value--error'
                  : ''
              }`}
            >
              {webrtc.iceConnectionState}
            </span>
          </div>

          <div className="status-card">
            <span className="status-label">Peer Connection State</span>
            <span
              className={`status-value${
                webrtc.connectionState === 'failed'
                  ? ' status-value--error'
                  : ''
              }`}
            >
              {webrtc.connectionState}
            </span>
          </div>

          <div className="status-card">
            <span className="status-label">Negotiation Generation</span>
            <span className="status-value">{webrtc.generation}</span>
            <span className="status-hint">
              {webrtc.remoteGeneration !== null
                ? `Session gen: ${webrtc.remoteGeneration}`
                : 'No active generation'}
            </span>
          </div>

          <div className="status-card">
            <span className="status-label">Trickle ICE Counters</span>
            <span className="status-value">
              {`Out: ${webrtc.localCandidatesSent} / In: ${webrtc.remoteCandidatesReceived} / Applied: ${webrtc.remoteCandidatesApplied}`}
            </span>
            <span className="status-hint">
              {`Queued: ${webrtc.queuedCandidateCount} (Total queued: ${webrtc.remoteCandidatesQueued}) | Stale ignored: ${webrtc.staleEventsIgnored}`}
            </span>
          </div>

          <div className="status-card">
            <span className="status-label">Data Channel</span>
            <span
              className={`status-value${
                webrtc.dataChannelState === 'none' ? ' status-value--muted' : ''
              }`}
            >
              {webrtc.dataChannelState}
            </span>
            <span className="status-hint">shipri-diagnostic</span>
          </div>
        </div>

        {webrtc.stalledGathering ? (
          <div className="webrtc-stall-notice" role="status" aria-live="polite">
            <span className="event-log-badge event-log-badge--warning">
              ICE Gathering Stalled (&gt;5000ms)
            </span>
            <span className="webrtc-stall-text">
              {webrtc.stalledDiagnostic ??
                'ICE candidate gathering exceeded 5000ms; initial SDP was not delayed and late candidates continue trickling.'}
            </span>
          </div>
        ) : null}

        {webrtc.lastError ? (
          <div
            className="ice-diagnostics-error"
            role="status"
            aria-live="polite"
          >
            <span className="event-log-badge event-log-badge--error">
              {webrtc.lastError.code}
            </span>
            <span className="ice-diagnostics-error-text">
              {webrtc.lastError.message}
            </span>
          </div>
        ) : null}
      </section>

      <section
        className="diagnostic-channel"
        aria-label="Diagnostic data channel"
      >
        <div className="diagnostic-channel-header">
          <h2 className="diagnostic-channel-title">Diagnostic Data Channel</h2>
          <p className="diagnostic-channel-note">
            Once the shipri-diagnostic channel is open, either equal peer can
            initiate ping/pong and short text messages regardless of room-entry
            role or signaling negotiation duty.
          </p>
        </div>

        <div className="diagnostic-channel-actions">
          <button
            type="button"
            className="btn-primary"
            onClick={handleSendPing}
            disabled={!channelOpen}
          >
            Send Ping
          </button>

          <form className="diagnostic-channel-form" onSubmit={handleSendText}>
            <label className="sr-only" htmlFor="diagnostic-channel-text">
              Short diagnostic message
            </label>
            <input
              id="diagnostic-channel-text"
              name="diagnosticText"
              type="text"
              className="diagnostic-channel-input"
              value={diagnosticText}
              onChange={(event) => setDiagnosticText(event.target.value)}
              placeholder={`Short message (max ${MAX_DIAGNOSTIC_TEXT_LENGTH} chars)`}
              aria-label="Short diagnostic message"
              maxLength={MAX_DIAGNOSTIC_TEXT_LENGTH}
              autoComplete="off"
              spellCheck={false}
              disabled={!channelOpen}
            />
            <button
              type="submit"
              className="btn-secondary"
              disabled={!channelOpen || diagnosticText.trim() === ''}
            >
              Send Text
            </button>
          </form>
        </div>

        <div className="diagnostic-channel-summary-grid">
          <div className="status-card">
            <span className="status-label">Channel State</span>
            <span
              className={`status-value${
                diagnosticChannel.channelState === 'none'
                  ? ' status-value--muted'
                  : ''
              }`}
            >
              {diagnosticChannel.channelState}
            </span>
            <span className="status-hint">
              {diagnosticChannel.label ?? DIAGNOSTIC_CHANNEL_LABEL}
            </span>
          </div>

          <div className="status-card">
            <span className="status-label">Last RTT</span>
            <span
              className={`status-value${
                diagnosticChannel.lastRttMs === null
                  ? ' status-value--muted'
                  : ''
              }`}
            >
              {diagnosticChannel.lastRttMs !== null
                ? `${diagnosticChannel.lastRttMs} ms`
                : 'None'}
            </span>
            <span className="status-hint">
              {`Pings: ${diagnosticChannel.pingsSent} / Pongs: ${diagnosticChannel.pongsReceived} / Pending: ${diagnosticChannel.pendingPingCount}`}
            </span>
          </div>

          <div className="status-card">
            <span className="status-label">Message Counters</span>
            <span className="status-value">
              {`Out: ${diagnosticChannel.messagesSent} / In: ${diagnosticChannel.messagesReceived}`}
            </span>
            <span className="status-hint">
              {diagnosticChannel.messages.length === 1
                ? '1 recorded message'
                : `${diagnosticChannel.messages.length} recorded messages`}
            </span>
          </div>
        </div>

        {diagnosticChannel.lastError ? (
          <div
            className="ice-diagnostics-error"
            role="status"
            aria-live="polite"
          >
            <span className="event-log-badge event-log-badge--error">
              {diagnosticChannel.lastError.code}
            </span>
            <span className="ice-diagnostics-error-text">
              {diagnosticChannel.lastError.message}
            </span>
          </div>
        ) : null}

        {diagnosticChannel.messages.length === 0 ? (
          <p className="event-log-empty">
            No diagnostic data-channel messages exchanged yet.
          </p>
        ) : (
          <ol className="diagnostic-channel-messages">
            {diagnosticChannel.messages.map((message, index) => (
              <li
                key={`${message.id}-${message.direction}-${message.type}-${index}`}
                className="event-log-item"
              >
                <div className="event-log-row">
                  <time
                    className="event-log-timestamp"
                    dateTime={message.timestamp}
                  >
                    {message.timestamp}
                  </time>
                  <span
                    className={`event-log-badge event-log-badge--${message.direction}`}
                  >
                    {message.direction}
                  </span>
                  <span className="event-log-name">{message.type}</span>
                  <span className="event-log-badge">{message.id}</span>
                  {message.rttMs !== undefined ? (
                    <span className="event-log-badge">
                      {`${message.rttMs} ms`}
                    </span>
                  ) : null}
                </div>
                {message.body !== undefined ? (
                  <p className="event-log-summary">{message.body}</p>
                ) : null}
              </li>
            ))}
          </ol>
        )}
      </section>

      <section
        className="validation-panel"
        aria-label="Validation and error scenarios"
      >
        <div className="validation-panel-header">
          <h2 className="validation-panel-title">
            Validation &amp; Error Scenarios
          </h2>
          <p className="validation-panel-note">
            Emit malformed payloads or invalid room requests via raw socket
            events to exercise server room:error responses without modifying
            active room membership.
          </p>
        </div>

        <div className="scenario-grid">
          {MALFORMED_TEST_SCENARIOS.map((scenario) => (
            <button
              key={scenario.id}
              type="button"
              className="btn-secondary scenario-btn"
              onClick={() => handleRunValidationScenario(scenario.id)}
              disabled={!socketConnected}
            >
              <span className="scenario-btn-header">
                <span className="scenario-btn-label">{scenario.label}</span>
                <span className="event-log-badge event-log-badge--error">
                  {scenario.expectedCode}
                </span>
              </span>
              <span className="scenario-btn-desc">{scenario.description}</span>
            </button>
          ))}
        </div>
      </section>

      <section className="event-log" aria-label="Event Log">
        <div className="event-log-header">
          <div className="event-log-title-group">
            <h2 className="event-log-title">Event Log</h2>
            <span className="event-log-meta">
              {eventLog.length === 1 ? '1 entry' : `${eventLog.length} entries`}
              {' - '}
              oldest to newest
            </span>
          </div>

          <button
            type="button"
            className="btn-secondary"
            onClick={handleClearLog}
            disabled={eventLog.length === 0}
          >
            Clear Log
          </button>
        </div>

        {eventLog.length === 0 ? (
          <p className="event-log-empty">No signaling events recorded yet.</p>
        ) : (
          <ol className="event-log-list">
            {eventLog.map((entry, index) => (
              <li
                key={`${entry.timestamp}-${entry.direction}-${entry.event}-${index}`}
                className="event-log-item"
              >
                <div className="event-log-row">
                  <time
                    className="event-log-timestamp"
                    dateTime={entry.timestamp}
                  >
                    {entry.timestamp}
                  </time>
                  <span
                    className={`event-log-badge event-log-badge--${entry.direction}`}
                  >
                    {entry.direction}
                  </span>
                  <span className="event-log-name">{entry.event}</span>
                  {entry.roomId ? (
                    <span className="event-log-badge">{entry.roomId}</span>
                  ) : null}
                  {entry.code ? (
                    <span className="event-log-badge event-log-badge--error">
                      {entry.code}
                    </span>
                  ) : null}
                </div>
                <p className="event-log-summary">{entry.summary}</p>
              </li>
            ))}
          </ol>
        )}
      </section>
    </main>
  );
}

export default App;
