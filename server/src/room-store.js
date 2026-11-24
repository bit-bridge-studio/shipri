/**
 * Creates an in-memory room store with a synchronized O(1) reverse socket index.
 */
export function createRoomStore({ now = () => Date.now() } = {}) {
  const activeRooms = new Map();
  const socketRooms = new Map();

  function getRoom(roomId) {
    return activeRooms.get(roomId) ?? null;
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

    const room = {
      roomId,
      peers: [peer],
      authVerifierHash,
      createdAt: timestamp,
      lastActivityAt: timestamp,
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

    room.lastActivityAt = now();
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
    getRoom,
    findSocketMembership,
    hasActiveRoomMembership,
    createRoom,
    addPeer,
    removePeer,
    size,
    clear,
  };
}
