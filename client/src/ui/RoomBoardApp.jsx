import React, { useEffect, useMemo, useRef, useState } from 'react';
import { buildQrSvgPath, encodeQrMatrix } from './qr-code.js';
import {
  createInitialRoomBoardUiState,
  createRoomBoardController,
} from './room-board-controller.js';

function formatBytes(bytes) {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) {
    return '0 B';
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  if (bytes < 1024 ** 4) {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }
  return `${(bytes / 1024 ** 4).toFixed(2)} TB`;
}

function formatEta(etaSeconds) {
  if (typeof etaSeconds !== 'number' || !Number.isFinite(etaSeconds) || etaSeconds <= 0) {
    return null;
  }
  if (etaSeconds < 60) {
    return `${etaSeconds}s left`;
  }
  const mins = Math.floor(etaSeconds / 60);
  const secs = etaSeconds % 60;
  return `${mins}m ${secs}s left`;
}

function formatTransferStateLabel(transfer) {
  switch (transfer.state) {
    case 'requesting':
      return 'Requesting';
    case 'active':
      return transfer.directionLabel === 'sending' ? 'Sending' : 'Downloading';
    case 'paused_by_user':
      return 'Paused';
    case 'paused_reconnecting':
      return 'Paused (reconnecting)';
    case 'resuming':
      return 'Resuming';
    case 'completed':
      return 'Completed';
    case 'cancelled':
      return 'Cancelled';
    case 'rejected':
      return transfer.rejectReason ? `Rejected (${transfer.rejectReason})` : 'Rejected';
    case 'failed':
      return transfer.errorCode ? `Failed (${transfer.errorCode})` : 'Failed';
    default:
      return transfer.state;
  }
}

function formatPeerBanner(state) {
  if (state.peerState === 'waiting_for_peer') {
    return 'Waiting for another peer';
  }
  if (state.remoteSyncState === 'peer_disconnected_grace') {
    return 'Peer disconnected (60s reconnect window)';
  }
  if (state.peerReady) {
    return 'Encrypted peer session ready';
  }
  if (state.peerState === 'connected') {
    return 'Negotiating encrypted channels';
  }
  return 'Reconnecting to peer';
}

export default function RoomBoardApp({ controller, initialState } = {}) {
  const internalControllerRef = useRef(null);
  const fileInputRef = useRef(null);
  const qrToggleRef = useRef(null);
  const [joinInput, setJoinInput] = useState('');
  const [dragOver, setDragOver] = useState(false);

  const [uiState, setUiState] = useState(() => {
    if (controller) {
      return controller.getState();
    }
    return createInitialRoomBoardUiState(initialState);
  });

  useEffect(() => {
    if (initialState && !controller) {
      return undefined;
    }
    const active = controller ?? createRoomBoardController();
    const ownsController = !controller;
    internalControllerRef.current = active;
    setUiState(active.getState());
    const unsubscribe = active.subscribe((nextState) => {
      setUiState(nextState);
    });

    return () => {
      unsubscribe();
      if (ownsController) {
        active.dispose();
        internalControllerRef.current = null;
      }
    };
  }, [controller, initialState]);

  const activeController = controller ?? internalControllerRef.current;
  const isConnected = uiState.connectionStatus === 'connected';
  const showShareControls = Boolean(uiState.hasShareUrl || uiState.shareUrl);
  const qrPayload = useMemo(() => {
    if (!uiState.qrVisible) {
      return null;
    }
    if (uiState.qrPayload) {
      return uiState.qrPayload;
    }
    if (!uiState.shareUrl) {
      return null;
    }
    try {
      const encoded = encodeQrMatrix(uiState.shareUrl);
      const quietZone = 4;
      const totalSize = encoded.size + quietZone * 2;
      return {
        viewBox: `0 0 ${totalSize} ${totalSize}`,
        path: buildQrSvgPath(encoded.matrix, quietZone),
      };
    } catch {
      return null;
    }
  }, [uiState.qrVisible, uiState.qrPayload, uiState.shareUrl]);

  const handleJoinSubmit = (event) => {
    event.preventDefault();
    if (!activeController || !isConnected || uiState.roomId || joinInput.trim() === '') {
      return;
    }
    const submitted = joinInput;
    setJoinInput('');
    void activeController.joinRoom(submitted);
  };

  const handleFileSelection = (fileList) => {
    if (!activeController || !fileList || fileList.length === 0) {
      return;
    }
    void activeController.addLocalFiles(fileList);
  };

  const handleDropzoneKeyDown = (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      fileInputRef.current?.click();
    }
  };

  return (
    <main className="glass-card board-shell">
      <header className="board-header">
        <div>
          <h1 className="board-title">
            <span className="gradient-text">Shipri</span>
          </h1>
          <p className="board-subtitle">
            End-to-End Encrypted Peer File Board
          </p>
        </div>

        <div className="board-header-badges">
          <div className="connection-banner" role="status" aria-live="polite">
            <span
              className="pulse-dot"
              style={{
                backgroundColor: isConnected ? '#00F5D4' : '#ff0055',
              }}
            />
            <span>{uiState.statusAnnouncement}</span>
          </div>

          {uiState.roomId && (uiState.selectedPath?.relayed || uiState.selectedPath?.isRelay) ? (
            <div className="relay-pill" aria-label="TURN relay active">
              TURN Relay (throughput may be capped)
            </div>
          ) : uiState.roomId && uiState.peerReady ? (
            <div className="direct-pill" aria-label="Direct peer connection">
              Direct P2P
            </div>
          ) : null}
        </div>
      </header>

      {uiState.errorBanner ? (
        <section className="board-alert" role="alert" aria-live="assertive">
          <div className="board-alert-copy">
            <strong>{uiState.errorBanner.title}:</strong>{' '}
            <span>{uiState.errorBanner.message}</span>
          </div>
          <button
            type="button"
            className="btn-secondary"
            onClick={() => activeController?.dismissError()}
          >
            Dismiss
          </button>
        </section>
      ) : null}

      {!uiState.roomId ? (
        <section className="board-entry" aria-label="Enter an encrypted room">
          <h2 className="board-section-title">Start or Join a Room</h2>
          <p className="board-section-note">
            Encryption keys stay strictly inside the room invite fragment and
            your browser memory. Neither peer holds a permanent sender or
            receiver role.
          </p>
          <div className="board-entry-actions">
            <button
              type="button"
              className="btn-primary"
              disabled={!isConnected}
              onClick={() => void activeController?.createRoom()}
            >
              Create Room
            </button>

            <form className="board-join-form" onSubmit={handleJoinSubmit}>
              <label className="sr-only" htmlFor="board-join-input">
                Room ID or invite link
              </label>
              <input
                id="board-join-input"
                type="text"
                className="room-id-input"
                placeholder="ship-xxxx or https://.../room/ship-xxxx#key=..."
                value={joinInput}
                onChange={(event) => setJoinInput(event.target.value)}
                disabled={!isConnected}
                autoComplete="off"
                spellCheck={false}
              />
              <button
                type="submit"
                className="btn-secondary"
                disabled={!isConnected || joinInput.trim() === ''}
              >
                Join Room
              </button>
            </form>
          </div>
        </section>
      ) : (
        <>
          <section className="board-room-bar" aria-label="Active room controls">
            <div className="board-room-meta">
              <span className="status-label">Room</span>
              <strong className="board-room-id">{uiState.roomId}</strong>
              <span className="board-peer-pill">{formatPeerBanner(uiState)}</span>
            </div>

            <div className="board-room-actions">
              {showShareControls ? (
                <>
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={() => void activeController?.copyShareLink()}
                  >
                    {uiState.copyFeedback ?? 'Copy Share Link'}
                  </button>
                  <button
                    ref={qrToggleRef}
                    type="button"
                    className="btn-secondary"
                    aria-expanded={uiState.qrVisible}
                    aria-controls="room-qr-panel"
                    onClick={() => activeController?.toggleQrCode()}
                  >
                    {uiState.qrVisible ? 'Hide QR Code' : 'Show QR Code'}
                  </button>
                </>
              ) : null}
              <button
                type="button"
                className="btn-secondary btn-danger"
                onClick={() => activeController?.leaveRoom()}
              >
                Leave Room
              </button>
            </div>
          </section>

          {uiState.qrVisible && qrPayload ? (
            <section
              id="room-qr-panel"
              className="qr-panel"
              aria-label="Room invite QR code"
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  activeController?.toggleQrCode(false);
                  qrToggleRef.current?.focus();
                }
              }}
            >
              <svg
                viewBox={qrPayload.viewBox}
                role="img"
                aria-label="Room invite QR code"
                className="qr-svg"
              >
                <rect width="100%" height="100%" fill="#ffffff" />
                <path d={qrPayload.path} fill="#0d0f12" />
              </svg>
              <div className="qr-panel-copy">
                <strong>Offline Room Invite QR</strong>
                <p>
                  Generated locally in your browser so the room key fragment is
                  never sent to external QR services.
                </p>
              </div>
            </section>
          ) : null}

          {!uiState.capability.supported ? (
            <section className="board-notice" role="status">
              <strong>Direct file saving unavailable:</strong>{' '}
              <span>{uiState.capability.guidance}</span>
            </section>
          ) : null}

          <section className="board-columns" aria-label="Shared file board">
            <div className="board-panel">
              <div className="board-panel-header">
                <h2 className="board-section-title">Shared by you</h2>
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => fileInputRef.current?.click()}
                >
                  Choose Files
                </button>
              </div>

              <div
                role="button"
                tabIndex={0}
                className={`board-dropzone${dragOver ? ' board-dropzone--active' : ''}`}
                aria-label="Drop local files here or press Enter to add files"
                onClick={() => fileInputRef.current?.click()}
                onKeyDown={handleDropzoneKeyDown}
                onDragOver={(event) => {
                  event.preventDefault();
                  setDragOver(true);
                }}
                onDragLeave={() => setDragOver(false)}
                onDrop={(event) => {
                  event.preventDefault();
                  setDragOver(false);
                  handleFileSelection(event.dataTransfer?.files);
                }}
              >
                <span>
                  Drop files here or press Enter to share local references (files
                  stay in your browser until requested)
                </span>
              </div>

              <input
                ref={fileInputRef}
                type="file"
                multiple
                className="sr-only"
                aria-label="Select local files to share"
                onChange={(event) => {
                  handleFileSelection(event.target.files);
                  event.target.value = '';
                }}
              />

              {uiState.localFiles.length === 0 ? (
                <p className="board-empty">No local files shared yet.</p>
              ) : (
                <ul className="file-list">
                  {uiState.localFiles.map((file) => (
                    <li key={file.fileId} className="file-card">
                      <div className="file-card-meta">
                        <strong className="file-card-name">{file.fileName}</strong>
                        <span className="file-card-details">
                          {formatBytes(file.fileSize)}
                          {file.fileType ? ` - ${file.fileType}` : ''}
                        </span>
                      </div>
                      <button
                        type="button"
                        className="btn-secondary btn-danger"
                        aria-label={`Remove ${file.fileName}`}
                        onClick={() =>
                          void activeController?.removeLocalFile(file.fileId)
                        }
                      >
                        Remove
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="board-panel">
              <div className="board-panel-header">
                <h2 className="board-section-title">Available from peer</h2>
                <span className="status-label">{uiState.remoteSyncState}</span>
              </div>

              {uiState.capability?.supported ? (
                <p className="board-inline-hint">
                  Direct-to-disk saving active.{' '}
                  {typeof uiState.storageEstimate?.availableBytes === 'number'
                    ? `Estimated available storage: ${formatBytes(
                        uiState.storageEstimate.availableBytes,
                      )}.`
                    : uiState.capability.maxProtocolFileSizeBytes
                      ? `Protocol file size limit: ${formatBytes(
                          uiState.capability.maxProtocolFileSizeBytes,
                        )}.`
                      : null}
                </p>
              ) : null}

              {uiState.hasActiveIncomingDownload ? (
                <p className="board-inline-hint">
                  Finish or cancel the current download before starting another.
                </p>
              ) : null}

              {uiState.remoteFiles.length === 0 ? (
                <p className="board-empty">
                  {uiState.peerState === 'waiting_for_peer'
                    ? 'Waiting for peer to connect and share files.'
                    : 'No files advertised by remote peer yet.'}
                </p>
              ) : (
                <ul className="file-list">
                  {uiState.remoteFiles.map((file) => {
                    const isAvailable =
                      file.availability === 'available' && uiState.peerReady;
                    const limitBlocked = Boolean(
                      file.insufficientStorage || file.exceedsProtocolLimit,
                    );
                    const disabled =
                      !isAvailable ||
                      !uiState.capability.supported ||
                      limitBlocked ||
                      uiState.hasActiveIncomingDownload;
                    return (
                      <li key={file.fileId} className="file-card">
                        <div className="file-card-meta">
                          <strong className="file-card-name">
                            {file.fileName}
                          </strong>
                          <span className="file-card-details">
                            {formatBytes(file.fileSize)}
                            {file.availability === 'unavailable_reconnecting'
                              ? ' - Unavailable (peer reconnecting)'
                              : ' - Available'}
                          </span>
                          {file.limitGuidance ? (
                            <span className="file-card-warning">
                              {file.limitGuidance}
                            </span>
                          ) : null}
                        </div>
                        <button
                          type="button"
                          className="btn-primary board-download-btn"
                          aria-label={`Download ${file.fileName}`}
                          disabled={disabled}
                          onClick={() => {
                            void activeController?.downloadRemoteFile(
                              file.fileId,
                            );
                          }}
                        >
                          Download
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </section>

          <section
            className="board-transfers"
            aria-label="Active and recent transfers"
          >
            <h2 className="board-section-title">Transfers</h2>
            {uiState.transfers.length === 0 ? (
              <p className="board-empty">No transfers started yet.</p>
            ) : (
              <ul className="transfer-list">
                {uiState.transfers.map((transfer) => {
                  const isActive = transfer.state === 'active';
                  const isPaused = transfer.state === 'paused_by_user';
                  const isTerminal =
                    transfer.state === 'completed' ||
                    transfer.state === 'cancelled' ||
                    transfer.state === 'failed' ||
                    transfer.state === 'rejected';
                  const etaLabel = formatEta(transfer.etaSeconds);
                  return (
                    <li key={transfer.transferId} className="transfer-row">
                      <div className="transfer-row-top">
                        <div className="transfer-title-group">
                          <span className="transfer-dir-badge">
                            {transfer.directionLabel === 'sending'
                              ? 'Sending'
                              : 'Downloading'}
                          </span>
                          <strong className="file-card-name">
                            {transfer.fileName}
                          </strong>
                        </div>
                        <span className="transfer-state-label">
                          {formatTransferStateLabel(transfer)}
                        </span>
                      </div>

                      <div
                        className="transfer-progress-track"
                        role="progressbar"
                        aria-label={`Transfer progress for ${transfer.fileName}`}
                        aria-valuenow={Math.round(transfer.progressPercent)}
                        aria-valuemin={0}
                        aria-valuemax={100}
                      >
                        <div
                          className="transfer-progress-fill"
                          style={{
                            width: `${Math.min(100, Math.max(0, transfer.progressPercent))}%`,
                          }}
                        />
                      </div>

                      <div className="transfer-row-bottom">
                        <span className="file-card-details">
                          {formatBytes(transfer.bytesTransferred)} /{' '}
                          {formatBytes(transfer.totalBytes)} (
                          {Math.round(transfer.progressPercent)}%)
                          {transfer.bytesPerSecond > 0
                            ? ` - ${formatBytes(transfer.bytesPerSecond)}/s`
                            : ''}
                          {etaLabel ? ` - ${etaLabel}` : ''}
                        </span>

                        <div className="transfer-controls">
                          {isActive ? (
                            <button
                              type="button"
                              className="btn-secondary"
                              onClick={() =>
                                activeController?.pauseTransfer(
                                  transfer.transferId,
                                )
                              }
                            >
                              Pause
                            </button>
                          ) : null}
                          {isPaused ? (
                            <button
                              type="button"
                              className="btn-secondary"
                              onClick={() =>
                                void activeController?.resumeTransfer(
                                  transfer.transferId,
                                )
                              }
                            >
                              Resume
                            </button>
                          ) : null}
                          {!isTerminal ? (
                            <button
                              type="button"
                              className="btn-secondary btn-danger"
                              onClick={() =>
                                void activeController?.cancelTransfer(
                                  transfer.transferId,
                                )
                              }
                            >
                              Cancel
                            </button>
                          ) : null}
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </>
      )}
    </main>
  );
}
