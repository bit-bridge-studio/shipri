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
  validateSignalForwardPayload,
} from './room-id.js';

function hasActiveRoomMembership(activeRooms, socketId) {
  for (const room of activeRooms.values()) {
    if (room.peers.some((peer) => peer.socketId === socketId)) {
      return true;
    }
  }

  return false;
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

      if (hasActiveRoomMembership(activeRooms, socket.id)) {
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

      if (hasActiveRoomMembership(activeRooms, socket.id)) {
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

    // 3. Forward WebRTC signaling candidates/SDP
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
          createRoomError('ROOM_NOT_FOUND', 'Room not found.', roomId),
        );
        return;
      }

      // Relays the message to the other socket in the room
      const targetPeer = room.peers.find((peer) => peer.socketId !== socket.id);
      if (targetPeer) {
        io.to(targetPeer.socketId).emit('signal:receive', { signalData });
      }
    });

    // 4. Handle disconnection
    socket.on('disconnect', () => {
      console.log(`Socket disconnected: ${socket.id}`);

      for (const [roomId, room] of activeRooms.entries()) {
        const peerIndex = room.peers.findIndex(
          (peer) => peer.socketId === socket.id,
        );
        if (peerIndex === -1) {
          continue;
        }

        const [removedPeer] = room.peers.splice(peerIndex, 1);
        socket.leave(roomId);

        if (room.peers.length === 0) {
          console.log(`Room closed after disconnect: ${roomId}`);
          activeRooms.delete(roomId);
          continue;
        }

        const remainingPeer = room.peers[0];
        io.to(remainingPeer.socketId).emit('peer:left', {
          roomId,
          peerId: removedPeer.peerId,
          reason: 'disconnect',
        });
      }
    });
  });

  function close() {
    return new Promise((resolve, reject) => {
      if (!httpServer.listening) {
        io.disconnectSockets(true);
        resolve();
        return;
      }

      io.close((error) => {
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
    close,
  };
}
