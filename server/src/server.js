import { createServer } from 'node:http';
import cors from 'cors';
import express from 'express';
import { Server } from 'socket.io';
import { resolveServerConfig } from './config.js';
import {
  allocateUniqueRoomId,
  createRoomError,
  generatePeerId,
  validateRoomCreatePayload,
  validateRoomJoinPayload,
  validateRoomLeavePayload,
  validateSignalForwardPayload,
} from './room-id.js';

function findSocketMembership(activeRooms, socketRooms, socketId) {
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

function hasActiveRoomMembership(activeRooms, socketRooms, socketId) {
  return findSocketMembership(activeRooms, socketRooms, socketId) !== null;
}

function removePeerFromRoom(
  io,
  activeRooms,
  socketRooms,
  room,
  peerIndex,
  socket,
  reason,
) {
  const [removedPeer] = room.peers.splice(peerIndex, 1);
  socketRooms.delete(removedPeer.socketId);
  socket.leave(room.roomId);

  if (room.peers.length === 0) {
    console.log(`Room closed after ${reason}: ${room.roomId}`);
    activeRooms.delete(room.roomId);
    return;
  }

  const remainingPeer = room.peers[0];
  io.to(remainingPeer.socketId).emit('peer:left', {
    roomId: room.roomId,
    peerId: removedPeer.peerId,
    reason,
  });
}

export function createSignalingServer(options = {}) {
  const config = resolveServerConfig(options);

  const app = express();
  app.use(
    cors({
      origin: config.allowedOrigins,
      methods: ['GET', 'POST'],
    }),
  );
  app.use(express.json());

  const httpServer = createServer(app);
  const io = new Server(httpServer, {
    cors: {
      origin: config.allowedOrigins,
      methods: ['GET', 'POST'],
    },
  });

  // Memory schema: Map<roomId, { roomId, peers, createdAt }>
  const activeRooms = new Map();
  // Reverse index: Map<socketId, roomId> for O(1) membership and disconnect lookup
  const socketRooms = new Map();

  app.get('/health', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.status(200).json({
      status: 'ok',
      roomsCount: activeRooms.size,
    });
  });

  io.on('connection', (socket) => {
    console.log(`Socket connected: ${socket.id}`);

    // 1. First peer creates room
    socket.on('room:create', (payload) => {
      const validation = validateRoomCreatePayload(payload);
      if (!validation.ok) {
        socket.emit('room:error', validation.error);
        return;
      }

      if (hasActiveRoomMembership(activeRooms, socketRooms, socket.id)) {
        socket.emit(
          'room:error',
          createRoomError(
            'UNAUTHORIZED',
            'Socket already belongs to an active room.',
          ),
        );
        return;
      }

      const roomId = allocateUniqueRoomId(activeRooms);
      const peerId = generatePeerId();
      const now = Date.now();

      const room = {
        roomId,
        peers: [
          {
            peerId,
            socketId: socket.id,
            joinedAt: now,
          },
        ],
        createdAt: now,
      };

      activeRooms.set(roomId, room);
      socketRooms.set(socket.id, roomId);
      socket.join(roomId);

      console.log(`Room created: ${roomId}`);
      socket.emit('room:created', {
        roomId,
        peerId,
        negotiationDuty: 'offerer',
      });
    });

    // 2. Second peer joins room
    socket.on('room:join', (payload) => {
      const validation = validateRoomJoinPayload(payload);
      if (!validation.ok) {
        socket.emit('room:error', validation.error);
        return;
      }

      const { roomId } = validation;
      const room = activeRooms.get(roomId);

      if (!room) {
        socket.emit(
          'room:error',
          createRoomError(
            'ROOM_NOT_FOUND',
            'Room does not exist or has expired.',
            roomId,
          ),
        );
        return;
      }

      if (hasActiveRoomMembership(activeRooms, socketRooms, socket.id)) {
        socket.emit(
          'room:error',
          createRoomError(
            'UNAUTHORIZED',
            'Socket already belongs to an active room.',
            roomId,
          ),
        );
        return;
      }

      if (room.peers.length >= 2) {
        socket.emit(
          'room:error',
          createRoomError(
            'ROOM_FULL',
            'This room is already occupied.',
            roomId,
          ),
        );
        return;
      }

      const existingPeer = room.peers[0];
      const peerId = generatePeerId();
      const now = Date.now();

      room.peers.push({
        peerId,
        socketId: socket.id,
        joinedAt: now,
      });
      socketRooms.set(socket.id, roomId);
      socket.join(roomId);

      console.log(`Peer joined room: ${roomId}`);
      socket.emit('room:joined', {
        roomId,
        peerId,
        negotiationDuty: 'answerer',
      });

      io.to(existingPeer.socketId).emit('peer:joined', {
        roomId,
        peerId,
      });
    });

    // 3. Either peer explicitly leaves room
    socket.on('room:leave', (payload) => {
      const validation = validateRoomLeavePayload(payload);
      if (!validation.ok) {
        socket.emit('room:error', validation.error);
        return;
      }

      const { roomId } = validation;
      const room = activeRooms.get(roomId);
      if (!room) {
        socket.emit(
          'room:error',
          createRoomError(
            'ROOM_NOT_FOUND',
            'Room does not exist or has expired.',
            roomId,
          ),
        );
        return;
      }

      const indexedRoomId = socketRooms.get(socket.id);
      const peerIndex =
        indexedRoomId === roomId
          ? room.peers.findIndex((peer) => peer.socketId === socket.id)
          : -1;
      if (peerIndex === -1) {
        socket.emit(
          'room:error',
          createRoomError(
            'UNAUTHORIZED',
            'Socket is not a member of this room.',
            roomId,
          ),
        );
        return;
      }

      removePeerFromRoom(
        io,
        activeRooms,
        socketRooms,
        room,
        peerIndex,
        socket,
        'leave',
      );
    });

    // 4. Forward WebRTC signaling candidates/SDP
    socket.on('signal:forward', (payload) => {
      const validation = validateSignalForwardPayload(payload);
      if (!validation.ok) {
        socket.emit('room:error', validation.error);
        return;
      }

      const { roomId, signalData } = validation;
      const room = activeRooms.get(roomId);
      if (!room) {
        socket.emit(
          'room:error',
          createRoomError(
            'ROOM_NOT_FOUND',
            'Room does not exist or has expired.',
            roomId,
          ),
        );
        return;
      }

      const senderPeer =
        socketRooms.get(socket.id) === roomId
          ? room.peers.find((peer) => peer.socketId === socket.id)
          : null;
      if (!senderPeer) {
        socket.emit(
          'room:error',
          createRoomError(
            'UNAUTHORIZED',
            'Socket is not a member of this room.',
            roomId,
          ),
        );
        return;
      }

      const targetPeer = room.peers.find((peer) => peer.socketId !== socket.id);
      if (!targetPeer) {
        socket.emit(
          'room:error',
          createRoomError(
            'PEER_UNAVAILABLE',
            'No second peer is connected to this room.',
            roomId,
          ),
        );
        return;
      }

      io.to(targetPeer.socketId).emit('signal:receive', {
        roomId,
        peerId: senderPeer.peerId,
        signalData,
      });
    });

    // 5. Handle disconnection
    socket.on('disconnect', () => {
      console.log(`Socket disconnected: ${socket.id}`);

      const membership = findSocketMembership(
        activeRooms,
        socketRooms,
        socket.id,
      );
      if (!membership) {
        return;
      }

      removePeerFromRoom(
        io,
        activeRooms,
        socketRooms,
        membership.room,
        membership.peerIndex,
        socket,
        'disconnect',
      );
    });
  });

  function close() {
    return new Promise((resolve, reject) => {
      if (!httpServer.listening) {
        io.disconnectSockets(true);
        activeRooms.clear();
        socketRooms.clear();
        resolve();
        return;
      }

      io.close((error) => {
        activeRooms.clear();
        socketRooms.clear();
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  return {
    app,
    httpServer,
    io,
    config,
    activeRooms,
    socketRooms,
    close,
  };
}
