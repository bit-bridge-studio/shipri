import { isValidRoomId } from './room-id.js';

/**
 * Creates a privacy-safe operational logger that records only high-level room lifecycle
 * and error codes without socket IDs, client IPs, secrets, tokens, SDP, ICE, or file data.
 */
export function createSafeLogger({ sink = console.log } = {}) {
  function emit(message) {
    if (typeof sink === 'function') {
      sink(message);
    }
  }

  return Object.freeze({
    serverListening(port) {
      emit(`Signaling server listening on port ${port}`);
    },
    serverShutdown(signal) {
      const safeSignal =
        typeof signal === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(signal)
          ? signal
          : 'UNKNOWN';
      emit(`Signaling server shutting down (${safeSignal})`);
    },
    roomCreated(roomId) {
      if (isValidRoomId(roomId)) {
        emit(`Room created: ${roomId}`);
      }
    },
    peerJoined(roomId) {
      if (isValidRoomId(roomId)) {
        emit(`Peer joined room: ${roomId}`);
      }
    },
    roomClosed(roomId, reason) {
      if (isValidRoomId(roomId)) {
        const safeReason = reason === 'disconnect' ? 'disconnect' : 'leave';
        emit(`Room closed after ${safeReason}: ${roomId}`);
      }
    },
    roomExpired(roomId) {
      if (isValidRoomId(roomId)) {
        emit(`Room expired: ${roomId}`);
      }
    },
    roomError(code, roomId) {
      const safeCode = typeof code === 'string' ? code : 'UNKNOWN_ERROR';
      if (isValidRoomId(roomId)) {
        emit(`Room error: ${safeCode} (${roomId})`);
        return;
      }
      emit(`Room error: ${safeCode}`);
    },
  });
}
