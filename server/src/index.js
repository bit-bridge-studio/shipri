import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 5001;

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: '*', // In production, restrict to allowed origins
    methods: ['GET', 'POST'],
  },
});

// Memory schema: Map<roomId, { roomId, hostSocketId, receiverSocketId, createdAt }>
const activeRooms = new Map();

// Generate a random ID with prefix ship-XXXX (4-character hex)
function generateRoomId() {
  const characters = '0123456789abcdef';
  let rand = '';
  for (let i = 0; i < 4; i++) {
    rand += characters.charAt(Math.floor(Math.random() * characters.length));
  }
  return `ship-${rand}`;
}

app.get('/health', (req, res) => {
  res.json({ status: 'ok', roomsCount: activeRooms.size });
});

io.on('connection', (socket) => {
  console.log(`Socket connected: ${socket.id}`);

  // 1. Host creates room
  socket.on('room:create', () => {
    let roomId = generateRoomId();
    // Ensure uniqueness
    while (activeRooms.has(roomId)) {
      roomId = generateRoomId();
    }

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
  socket.on('room:join', ({ roomId }) => {
    if (!roomId) {
      socket.emit('room:error', { code: 'INVALID_ROOM_ID', message: 'Room ID is required.' });
      return;
    }

    const room = activeRooms.get(roomId);

    if (!room) {
      socket.emit('room:error', { code: 'ROOM_NOT_FOUND', message: 'Room does not exist or has expired.' });
      return;
    }

    // Check if room is already full
    if (room.receiverSocketId && room.receiverSocketId !== socket.id) {
      socket.emit('room:error', { code: 'ROOM_FULL', message: 'This room is already occupied.' });
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
  socket.on('signal:forward', ({ roomId, signalData }) => {
    const room = activeRooms.get(roomId);
    if (!room) return;

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

httpServer.listen(PORT, () => {
  console.log(`Signaling server listening on port ${PORT}`);
});
