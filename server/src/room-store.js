import {
  DEFAULT_ROOM_IDLE_TTL_MS,
  DEFAULT_ROOM_MAX_LIFETIME_MS,
} from './config.js';

/**
 * Creates an in-memory room store with synchronized O(1) reverse socket index and TTL tracking.
 */
export function createRoomStore({
  now = () => Date.now(),
  roomIdleTtlMs = DEFAULT_ROOM_IDLE_TTL_MS,
  roomMaxLifetimeMs = DEFAULT_ROOM_MAX_LIFETIME_MS,
} = {}) {
  const activeRooms = new Map();
  const socketRooms = new Map();

  function isRoomExpired(room, timestamp = now()) {
    return timestamp >= room.expiresAt || timestamp >= room.maxExpiresAt;
  }

  function expireRoom(roomId) {
    const room = activeRooms.get(roomId);
    if (!room) {
      return null;
    }

    for (const peer of room.peers) {
      if (socketRooms.get(peer.socketId) === roomId) {
        socketRooms.delete(peer.socketId);
      }
    }

    activeRooms.delete(roomId);
    return room;
  }

  function getRoom(roomId) {
    return activeRooms.get(roomId) ?? null;
  }

  function getActiveRoom(roomId) {
    const room = activeRooms.get(roomId);
    if (!room) {
      return { room: null, expiredRoom: null };
    }

    if (isRoomExpired(room)) {
      const expiredRoom = expireRoom(roomId);
      return { room: null, expiredRoom };
    }

    return { room, expiredRoom: null };
  }

  function purgeExpiredRooms() {
    const timestamp = now();
    const expiredRooms = [];

    for (const [roomId, room] of activeRooms.entries()) {
      if (isRoomExpired(room, timestamp)) {
        const expiredRoom = expireRoom(roomId);
        if (expiredRoom) {
          expiredRooms.push(expiredRoom);
        }
      }
    }

    return expiredRooms;
  }

  function touchRoom(room) {
    const timestamp = now();
    room.lastActivityAt = timestamp;
    room.expiresAt = Math.min(timestamp + roomIdleTtlMs, room.maxExpiresAt);
  }

  function findSocketMembership(socketId) {
    const roomId = socketRooms.get(socketId);
    if (!roomId) {
      return null;
    }

    const room = activeRooms.get(roomId);
    if (!room) {
      socketRooms.delete(socketId);
      return null;
    }

    const peerIndex = room.peers.findIndex(
      (peer) => peer.socketId === socketId,
    );
    if (peerIndex === -1) {
      socketRooms.delete(socketId);
      return null;
    }

    return { room, peerIndex };
  }

  function hasActiveRoomMembership(socketId) {
    return findSocketMembership(socketId) !== null;
  }

  function createRoom({ roomId, peerId, socketId, authVerifierHash = null }) {
    const timestamp = now();
    const peer = {
      peerId,
      socketId,
      joinedAt: timestamp,
    };

    const maxExpiresAt = timestamp + roomMaxLifetimeMs;
    const expiresAt = Math.min(timestamp + roomIdleTtlMs, maxExpiresAt);

    const room = {
      roomId,
      peers: [peer],
      authVerifierHash,
      createdAt: timestamp,
      lastActivityAt: timestamp,
      expiresAt,
      maxExpiresAt,
    };

    activeRooms.set(roomId, room);
    socketRooms.set(socketId, roomId);

    return { room, peer };
  }

  function addPeer(room, { peerId, socketId }) {
    const timestamp = now();
    const peer = {
      peerId,
      socketId,
      joinedAt: timestamp,
    };

    room.peers.push(peer);
    room.lastActivityAt = timestamp;
    room.expiresAt = Math.min(timestamp + roomIdleTtlMs, room.maxExpiresAt);
    socketRooms.set(socketId, room.roomId);

    return peer;
  }

  function removePeer(room, peerIndex) {
    const [removedPeer] = room.peers.splice(peerIndex, 1);
    socketRooms.delete(removedPeer.socketId);

    if (room.peers.length === 0) {
      activeRooms.delete(room.roomId);
      return {
        removedPeer,
        remainingPeer: null,
        roomDeleted: true,
      };
    }

    touchRoom(room);
    return {
      removedPeer,
      remainingPeer: room.peers[0],
      roomDeleted: false,
    };
  }

  function size() {
    return activeRooms.size;
  }

  function clear() {
    activeRooms.clear();
    socketRooms.clear();
  }

  return {
    activeRooms,
    socketRooms,
    isRoomExpired,
    expireRoom,
    getRoom,
    getActiveRoom,
    purgeExpiredRooms,
    touchRoom,
    findSocketMembership,
    hasActiveRoomMembership,
    createRoom,
    addPeer,
    removePeer,
    size,
    clear,
  };
}
