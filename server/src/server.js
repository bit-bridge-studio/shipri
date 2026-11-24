import { createServer } from 'node:http';
import cors from 'cors';
import express from 'express';
import { Server } from 'socket.io';
import { getTurnSharedSecret, resolveServerConfig } from './config.js';
import { resolveIceServers } from './ice-service.js';
import { createSafeLogger } from './logger.js';
import { createRoomCreateRateLimiter, resolveClientIp } from './rate-limit.js';
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

function removePeerFromRoom(
  io,
  roomStore,
  logger,
  room,
  peerIndex,
  socket,
  reason,
) {
  const { removedPeer, remainingPeer, roomDeleted } = roomStore.removePeer(
    room,
    peerIndex,
  );
  socket.leave(room.roomId);

  if (roomDeleted) {
    logger.roomClosed(room.roomId, reason);
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
  const logger = options?.logger ?? createSafeLogger();

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
  const rateLimiter = createRoomCreateRateLimiter({
    maxAttempts: config.roomCreateRateLimitMax,
    windowMs: config.roomCreateRateLimitWindowMs,
    now,
  });
  const { activeRooms, socketRooms } = roomStore;
  const startedAt = now();
  let isShuttingDown = false;
  let closePromise = null;
  let roomsCreatedTotal = 0;
  let roomsExpiredTotal = 0;
  const errorsByCode = Object.create(null);

  function recordErrorMetric(code) {
    const safeCode =
      typeof code === 'string' && /^[A-Z0-9_]{1,64}$/.test(code)
        ? code
        : 'UNKNOWN_ERROR';
    errorsByCode[safeCode] = (errorsByCode[safeCode] ?? 0) + 1;
  }

  function emitRoomError(socket, error) {
    recordErrorMetric(error.code);
    logger.roomError(error.code, error.roomId);
    socket.emit('room:error', error);
  }

  function notifyExpiredRoom(expiredRoom) {
    if (!expiredRoom) {
      return;
    }

    roomsExpiredTotal += 1;
    recordErrorMetric('ROOM_NOT_FOUND');

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

    logger.roomExpired(expiredRoom.roomId);
  }

  function sweepExpiredRooms() {
    const expiredRooms = roomStore.purgeExpiredRooms();
    for (const expiredRoom of expiredRooms) {
      notifyExpiredRoom(expiredRoom);
    }
    rateLimiter.purgeExpired();
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

  function getReadinessStatus() {
    if (isShuttingDown) {
      return {
        ready: false,
        status: 'not_ready',
      };
    }

    const iceCheck = resolveIceServers({
      stunUrls: config.stunUrls,
      turnUrls: config.turnUrls,
      turnSharedSecret: getTurnSharedSecret(config),
      turnCredentialTtlSeconds: config.turnCredentialTtlSeconds,
      requireTurn: config.requireTurn,
      now,
    });
    if (!iceCheck.ok) {
      return {
        ready: false,
        status: 'not_ready',
      };
    }

    return {
      ready: true,
      status: 'ready',
      roomsCount: roomStore.size(),
      maxRooms: config.maxRooms,
    };
  }

  function getOperationalMetrics() {
    const elapsedMs = Math.max(0, now() - startedAt);
    return {
      status: isShuttingDown ? 'shutting_down' : 'ok',
      uptimeSeconds: Math.floor(elapsedMs / 1000),
      activeRoomsCount: roomStore.size(),
      maxRooms: config.maxRooms,
      roomsCreatedTotal,
      roomsExpiredTotal,
      errorsByCode: { ...errorsByCode },
    };
  }

  app.get('/health', (_req, res) => {
    sweepExpiredRooms();
    res.set('Cache-Control', 'no-store');
    res.status(200).json({
      status: 'ok',
      roomsCount: roomStore.size(),
    });
  });

  app.get('/ready', (_req, res) => {
    sweepExpiredRooms();
    res.set('Cache-Control', 'no-store');
    const readiness = getReadinessStatus();
    if (!readiness.ready) {
      res.status(503).json({ status: 'not_ready' });
      return;
    }
    res.status(200).json({
      status: readiness.status,
      roomsCount: readiness.roomsCount,
      maxRooms: readiness.maxRooms,
    });
  });

  app.get('/metrics', (_req, res) => {
    sweepExpiredRooms();
    res.set('Cache-Control', 'no-store');
    res.status(200).json(getOperationalMetrics());
  });

  io.on('connection', (socket) => {
    // 1. First peer creates room
    socket.on('room:create', (payload) => {
      const clientIp = resolveClientIp(socket, config.trustProxy);
      const rateLimit = rateLimiter.consume(clientIp);
      if (!rateLimit.allowed) {
        emitRoomError(
          socket,
          createRoomError(
            'RATE_LIMITED',
            'Too many room creation attempts. Try again later.',
          ),
        );
        return;
      }

      const validation = validateRoomCreatePayload(payload, {
        requireRoomAuth: config.requireRoomAuth,
      });
      if (!validation.ok) {
        emitRoomError(socket, validation.error);
        return;
      }

      if (hasLiveSocketMembership(socket.id)) {
        emitRoomError(
          socket,
          createRoomError(
            'UNAUTHORIZED',
            'Socket already belongs to an active room.',
          ),
        );
        return;
      }

      sweepExpiredRooms();
      if (roomStore.size() >= config.maxRooms) {
        emitRoomError(
          socket,
          createRoomError(
            'SERVER_BUSY',
            'Server capacity reached. Try again later.',
          ),
        );
        return;
      }

      let roomId;
      try {
        roomId = allocateUniqueRoomId(activeRooms);
      } catch {
        emitRoomError(
          socket,
          createRoomError(
            'SERVER_BUSY',
            'Server capacity reached. Try again later.',
          ),
        );
        return;
      }

      const peerId = generatePeerId();

      roomStore.createRoom({
        roomId,
        peerId,
        socketId: socket.id,
        authVerifierHash: validation.authVerifierHash ?? null,
      });
      roomsCreatedTotal += 1;
      socket.join(roomId);

      logger.roomCreated(roomId);
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
        emitRoomError(socket, validation.error);
        return;
      }

      const { roomId, authToken } = validation;
      const room = resolveActiveRoom(roomId);

      if (!room) {
        emitRoomError(
          socket,
          createRoomError(
            'ROOM_NOT_FOUND',
            'Room does not exist or has expired.',
            roomId,
          ),
        );
        return;
      }

      if (hasLiveSocketMembership(socket.id)) {
        emitRoomError(
          socket,
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
        emitRoomError(
          socket,
          createRoomError(
            'UNAUTHORIZED',
            'Invalid room authorization token.',
            roomId,
          ),
        );
        return;
      }

      if (room.peers.length >= 2) {
        emitRoomError(
          socket,
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

      logger.peerJoined(roomId);
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
        emitRoomError(socket, validation.error);
        return;
      }

      const { roomId } = validation;
      const room = resolveActiveRoom(roomId);
      if (!room) {
        emitRoomError(
          socket,
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
        emitRoomError(
          socket,
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
        roomStore,
        logger,
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
        emitRoomError(socket, validation.error);
        return;
      }

      const { roomId, signalData } = validation;
      const room = resolveActiveRoom(roomId);
      if (!room) {
        emitRoomError(
          socket,
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
        emitRoomError(
          socket,
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
        emitRoomError(
          socket,
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
        emitRoomError(socket, validation.error);
        return;
      }

      const { roomId } = validation;
      const room = resolveActiveRoom(roomId);
      if (!room) {
        emitRoomError(
          socket,
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
        emitRoomError(
          socket,
          createRoomError(
            'UNAUTHORIZED',
            'Socket is not a member of this room.',
            roomId,
          ),
        );
        return;
      }

      const iceConfig = resolveIceServers({
        stunUrls: config.stunUrls,
        turnUrls: config.turnUrls,
        turnSharedSecret: getTurnSharedSecret(config),
        turnCredentialTtlSeconds: config.turnCredentialTtlSeconds,
        requireTurn: config.requireTurn,
        now,
      });
      if (!iceConfig.ok) {
        emitRoomError(
          socket,
          createRoomError(
            'SERVER_BUSY',
            'ICE configuration is unavailable.',
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
        logger,
        membership.room,
        membership.peerIndex,
        socket,
        'disconnect',
      );
    });
  });

  function close() {
    if (closePromise) {
      return closePromise;
    }

    isShuttingDown = true;
    clearInterval(cleanupTimer);

    closePromise = new Promise((resolve, reject) => {
      if (!httpServer.listening) {
        io.disconnectSockets(true);
        roomStore.clear();
        rateLimiter.clear();
        resolve();
        return;
      }

      io.disconnectSockets(true);
      io.close((error) => {
        roomStore.clear();
        rateLimiter.clear();
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });

    return closePromise;
  }

  return {
    app,
    httpServer,
    io,
    config,
    roomStore,
    rateLimiter,
    activeRooms,
    socketRooms,
    sweepExpiredRooms,
    getReadinessStatus,
    getOperationalMetrics,
    close,
  };
}
