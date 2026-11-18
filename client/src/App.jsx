import React, { useEffect, useRef, useState } from 'react';
import {
  applyConnectionStatus,
  bindSignalingClient,
  clearEventLog,
  createInitialPrototypeState,
  createRoomLifecycleActions,
} from './prototype/diagnostic-state.js';
import { createSignalingClient } from './signaling/socket-client.js';

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

function App({ signalingClient, initialState } = {}) {
  const clientRef = useRef(signalingClient ?? null);
  const [joinRoomId, setJoinRoomId] = useState('');
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

    if (ownsClient) {
      client.connect();
    }

    return () => {
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
    eventLog,
  } = prototypeState;

  useEffect(() => {
    if (roomId) {
      setJoinRoomId('');
    }
  }, [roomId]);

  const socketConnected = connectionStatus === 'connected';
  const statusBannerText = getConnectionStatusBanner(connectionStatus);

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
          <span className="status-label">Last Error</span>
          <span
            className={`status-value${lastError ? ' status-value--error' : ' status-value--muted'}`}
          >
            {formatLastError(lastError)}
          </span>
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
