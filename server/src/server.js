import { createServer } from 'node:http';
import cors from 'cors';
import express from 'express';
import { Server } from 'socket.io';
import { resolveServerConfig } from './config.js';
import {
  allocateUniqueRoomId,
  createRoomError,
  validateRoomJoinPayload,
  validateSignalForwardPayload,
} from './room-id.js';

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

  // Memory schema: Map<roomId, { roomId, hostSocketId, receiverSocketId, createdAt }>
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

    // 1. Host creates room
    socket.on('room:create', () => {
      const roomId = allocateUniqueRoomId(activeRooms);

      const room = {
        roomId,
        hostSocketId: socket.id,
        receiverSocketId: null,
        createdAt: Date.now(),
      };

      activeRooms.set(roomId, room);
      socket.join(roomId);

      console.log(`Room created: ${roomId} by host ${socket.id}`);
      socket.emit('room:created', { roomId, socketId: socket.id });
    });

    // 2. Receiver joins room
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

      // Check if room is already full
      if (room.receiverSocketId && room.receiverSocketId !== socket.id) {
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

      // Set receiver socket
      room.receiverSocketId = socket.id;
      socket.join(roomId);

      console.log(`Receiver ${socket.id} joined room: ${roomId}`);
      socket.emit('room:joined', { roomId, role: 'receiver' });

      // Notify Host
      io.to(room.hostSocketId).emit('peer:joined', { peerSocketId: socket.id });
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
      const targetSocketId = socket.id === room.hostSocketId ? room.receiverSocketId : room.hostSocketId;
      if (targetSocketId) {
        io.to(targetSocketId).emit('signal:receive', { signalData });
      }
    });

    // 4. Handle disconnection
    socket.on('disconnect', () => {
      console.log(`Socket disconnected: ${socket.id}`);

      // Find rooms where this socket was host or receiver
      for (const [roomId, room] of activeRooms.entries()) {
        if (room.hostSocketId === socket.id) {
          console.log(`Host disconnected. Closing room: ${roomId}`);
          if (room.receiverSocketId) {
            io.to(room.receiverSocketId).emit('room:error', {
              code: 'HOST_DISCONNECTED',
              message: 'The host has disconnected. Room is closed.',
            });
          }
          activeRooms.delete(roomId);
        } else if (room.receiverSocketId === socket.id) {
          console.log(`Receiver disconnected from room: ${roomId}`);
          room.receiverSocketId = null;
          io.to(room.hostSocketId).emit('room:error', {
            code: 'RECEIVER_DISCONNECTED',
            message: 'The receiver has disconnected. Room is waiting for reconnect.',
          });
        }
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
