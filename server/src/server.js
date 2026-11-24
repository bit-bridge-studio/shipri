import { createServer } from 'node:http';
import cors from 'cors';
import express from 'express';
import { Server } from 'socket.io';
import { resolveDevelopmentIceServers, resolveServerConfig } from './config.js';
import { verifyAuthToken } from './room-auth.js';
import {
  SIGNAL_DATA_MAX_BYTES,
  allocateUniqueRoomId,
  createRoomError,
  generatePeerId,
  validateIceGetPayload,
  validateRoomCreatePayload,
  validateRoomJoinPayload,
  validateRoomLeavePayload,
  validateSignalForwardPayload,
} from './room-id.js';
import { createRoomStore } from './room-store.js';

function removePeerFromRoom(io, roomStore, room, peerIndex, socket, reason) {
  const { removedPeer, remainingPeer, roomDeleted } = roomStore.removePeer(
    room,
    peerIndex,
  );
  socket.leave(room.roomId);

  if (roomDeleted) {
    console.log(`Room closed after ${reason}: ${room.roomId}`);
    return;
  }

  io.to(remainingPeer.socketId).emit('peer:left', {
    roomId: room.roomId,
    peerId: removedPeer.peerId,
    reason,
  });
}

export function createSignalingServer(options = {}) {
  const config = resolveServerConfig(options);
  const now =
    typeof options?.now === 'function' ? options.now : () => Date.now();

  const app = express();
  app.set('trust proxy', config.trustProxy);
  app.use(
    cors({
      origin: config.allowedOrigins,
      methods: ['GET', 'POST'],
    }),
  );
  app.use(express.json());

  const httpServer = createServer(app);
  const io = new Server(httpServer, {
    maxHttpBufferSize: SIGNAL_DATA_MAX_BYTES,
    cors: {
      origin: config.allowedOrigins,
      methods: ['GET', 'POST'],
    },
  });

  const roomStore = createRoomStore({
    now,
    roomIdleTtlMs: config.roomIdleTtlMs,
    roomMaxLifetimeMs: config.roomMaxLifetimeMs,
  });
  const { activeRooms, socketRooms } = roomStore;

  function notifyExpiredRoom(expiredRoom) {
    if (!expiredRoom) {
      return;
    }

    const expiryError = createRoomError(
      'ROOM_NOT_FOUND',
      'Room does not exist or has expired.',
      expiredRoom.roomId,
    );

    for (const peer of expiredRoom.peers) {
      const peerSocket = io.sockets.sockets.get(peer.socketId);
      if (peerSocket) {
        peerSocket.leave(expiredRoom.roomId);
        peerSocket.emit('room:error', expiryError);
      }
    }

    console.log(`Room expired: ${expiredRoom.roomId}`);
  }

  function sweepExpiredRooms() {
    const expiredRooms = roomStore.purgeExpiredRooms();
    for (const expiredRoom of expiredRooms) {
      notifyExpiredRoom(expiredRoom);
    }
    return expiredRooms.length;
  }

  function resolveActiveRoom(roomId) {
    const { room, expiredRoom } = roomStore.getActiveRoom(roomId);
    if (expiredRoom) {
      notifyExpiredRoom(expiredRoom);
    }
    return room;
  }

  function hasLiveSocketMembership(socketId) {
    const membership = roomStore.findSocketMembership(socketId);
    if (!membership) {
      return false;
    }

    if (roomStore.isRoomExpired(membership.room)) {
      const expiredRoom = roomStore.expireRoom(membership.room.roomId);
      notifyExpiredRoom(expiredRoom);
      return false;
    }

    return true;
  }

  const cleanupTimer = setInterval(
    sweepExpiredRooms,
    config.roomCleanupIntervalMs,
  );
  if (typeof cleanupTimer.unref === 'function') {
    cleanupTimer.unref();
  }

  app.get('/health', (_req, res) => {
    sweepExpiredRooms();
    res.set('Cache-Control', 'no-store');
    res.status(200).json({
      status: 'ok',
      roomsCount: roomStore.size(),
    });
  });

  io.on('connection', (socket) => {
    console.log(`Socket connected: ${socket.id}`);

    // 1. First peer creates room
    socket.on('room:create', (payload) => {
      const validation = validateRoomCreatePayload(payload, {
        requireRoomAuth: config.requireRoomAuth,
      });
      if (!validation.ok) {
        socket.emit('room:error', validation.error);
        return;
      }

      if (hasLiveSocketMembership(socket.id)) {
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

      roomStore.createRoom({
        roomId,
        peerId,
        socketId: socket.id,
        authVerifierHash: validation.authVerifierHash ?? null,
      });
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
      const validation = validateRoomJoinPayload(payload, {
        requireRoomAuth: config.requireRoomAuth,
      });
      if (!validation.ok) {
        socket.emit('room:error', validation.error);
        return;
      }

      const { roomId, authToken } = validation;
      const room = resolveActiveRoom(roomId);

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

      if (hasLiveSocketMembership(socket.id)) {
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

      if (
        room.authVerifierHash !== null &&
        !verifyAuthToken(authToken, room.authVerifierHash)
      ) {
        socket.emit(
          'room:error',
          createRoomError(
            'UNAUTHORIZED',
            'Invalid room authorization token.',
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

      roomStore.addPeer(room, {
        peerId,
        socketId: socket.id,
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

    // 3. Either peer explicitly leaves room
    socket.on('room:leave', (payload) => {
      const validation = validateRoomLeavePayload(payload);
      if (!validation.ok) {
        socket.emit('room:error', validation.error);
        return;
      }

      const { roomId } = validation;
      const room = resolveActiveRoom(roomId);
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

      removePeerFromRoom(io, roomStore, room, peerIndex, socket, 'leave');
    });

    // 4. Forward WebRTC signaling candidates/SDP
    socket.on('signal:forward', (payload) => {
      const validation = validateSignalForwardPayload(payload);
      if (!validation.ok) {
        socket.emit('room:error', validation.error);
        return;
      }

      const { roomId, signalData } = validation;
      const room = resolveActiveRoom(roomId);
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

      roomStore.touchRoom(room);
      io.to(targetPeer.socketId).emit('signal:receive', {
        roomId,
        peerId: senderPeer.peerId,
        signalData,
      });
    });

    // 5. Return development-only STUN configuration for active members
    socket.on('ice:get', (payload) => {
      const validation = validateIceGetPayload(payload);
      if (!validation.ok) {
        socket.emit('room:error', validation.error);
        return;
      }

      const { roomId } = validation;
      const room = resolveActiveRoom(roomId);
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

      const isActiveMember =
        socketRooms.get(socket.id) === roomId &&
        room.peers.some((peer) => peer.socketId === socket.id);
      if (!isActiveMember) {
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

      // Development-only STUN response; dynamic TURN credentials are added in BE-4.
      const iceConfig = resolveDevelopmentIceServers(config.stunUrls);
      if (!iceConfig.ok) {
        socket.emit(
          'room:error',
          createRoomError(
            'SERVER_BUSY',
            'Development ICE configuration is unavailable.',
            roomId,
          ),
        );
        return;
      }

      roomStore.touchRoom(room);
      socket.emit('ice:credentials', {
        roomId,
        iceServers: iceConfig.iceServers,
      });
    });

    // 6. Handle disconnection
    socket.on('disconnect', () => {
      console.log(`Socket disconnected: ${socket.id}`);

      const membership = roomStore.findSocketMembership(socket.id);
      if (!membership) {
        return;
      }

      if (roomStore.isRoomExpired(membership.room)) {
        const expiredRoom = roomStore.expireRoom(membership.room.roomId);
        notifyExpiredRoom(expiredRoom);
        return;
      }

      removePeerFromRoom(
        io,
        roomStore,
        membership.room,
        membership.peerIndex,
        socket,
        'disconnect',
      );
    });
  });

  function close() {
    clearInterval(cleanupTimer);

    return new Promise((resolve, reject) => {
      if (!httpServer.listening) {
        io.disconnectSockets(true);
        roomStore.clear();
        resolve();
        return;
      }

      io.close((error) => {
        roomStore.clear();
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
    roomStore,
    activeRooms,
    socketRooms,
    sweepExpiredRooms,
    close,
  };
}
