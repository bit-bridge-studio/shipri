import { afterEach, describe, expect, test } from 'vitest';
import { PEER_ID_PATTERN } from '../src/room-id.js';
import { createSignalingServer } from '../src/server.js';
import {
  closeSocketClients,
  createSocketClient,
} from './helpers/socket-client.js';

const clients = new Set();
const servers = new Set();

async function startIsolatedServer() {
  const server = createSignalingServer();
  servers.add(server);

  await new Promise((resolve, reject) => {
    server.httpServer.once('error', reject);
    server.httpServer.listen(0, '127.0.0.1', () => {
      server.httpServer.off('error', reject);
      resolve();
    });
  });

  const address = server.httpServer.address();
  return {
    ...server,
    baseUrl: `http://127.0.0.1:${address.port}`,
  };
}

function waitForEvent(socket, eventName) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for ${eventName}`));
    }, 1_000);

    socket.once(eventName, (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

function emitAndWait(socket, emitEvent, payload, responseEvent) {
  const promise = waitForEvent(socket, responseEvent);
  socket.emit(emitEvent, payload);
  return promise;
}

async function fetchRoomsCount(baseUrl) {
  const response = await fetch(`${baseUrl}/health`);
  const body = await response.json();
  return body.roomsCount;
}

async function connectClient(baseUrl) {
  const client = await createSocketClient(baseUrl);
  clients.add(client);
  return client;
}

afterEach(async () => {
  closeSocketClients(...clients);
  clients.clear();

  await Promise.all([...servers].map((server) => server.close()));
  servers.clear();
});

describe('Socket.IO room:join and room capacity', () => {
  test('joins a second equal peer with answerer duty and notifies existing peer', async () => {
    const server = await startIsolatedServer();
    const peerA = await connectClient(server.baseUrl);
    const peerB = await connectClient(server.baseUrl);

    const created = await emitAndWait(peerA, 'room:create', {}, 'room:created');

    const peerJoinedPromise = waitForEvent(peerA, 'peer:joined');
    const joinedPromise = waitForEvent(peerB, 'room:joined');
    peerB.emit('room:join', { roomId: created.roomId });

    const [joined, peerJoined] = await Promise.all([
      joinedPromise,
      peerJoinedPromise,
    ]);

    expect(Object.keys(joined).sort()).toEqual([
      'negotiationDuty',
      'peerId',
      'roomId',
    ]);
    expect(joined.roomId).toBe(created.roomId);
    expect(joined.peerId).toMatch(PEER_ID_PATTERN);
    expect(joined.peerId).not.toBe(created.peerId);
    expect(joined.peerId).not.toBe(peerB.id);
    expect(joined.negotiationDuty).toBe('answerer');
    expect('role' in joined).toBe(false);

    expect(Object.keys(peerJoined).sort()).toEqual(['peerId', 'roomId']);
    expect(peerJoined).toEqual({
      roomId: created.roomId,
      peerId: joined.peerId,
    });
    expect('peerSocketId' in peerJoined).toBe(false);

    const adapterRoom = server.io.sockets.adapter.rooms.get(created.roomId);
    expect(adapterRoom?.has(peerA.id)).toBe(true);
    expect(adapterRoom?.has(peerB.id)).toBe(true);
    expect(adapterRoom?.size).toBe(2);
    expect(await fetchRoomsCount(server.baseUrl)).toBe(1);
  });

  test('allows replacement peer join when the joiner disconnects', async () => {
    const server = await startIsolatedServer();
    const peerA = await connectClient(server.baseUrl);
    const peerB = await connectClient(server.baseUrl);
    const peerC = await connectClient(server.baseUrl);

    const created = await emitAndWait(peerA, 'room:create', {}, 'room:created');

    const firstJoinedPromise = waitForEvent(peerB, 'room:joined');
    const firstPeerJoinedPromise = waitForEvent(peerA, 'peer:joined');
    peerB.emit('room:join', { roomId: created.roomId });
    const [firstJoined] = await Promise.all([
      firstJoinedPromise,
      firstPeerJoinedPromise,
    ]);

    const peerLeftPromise = waitForEvent(peerA, 'peer:left');
    peerB.disconnect();
    const peerLeft = await peerLeftPromise;
    expect(peerLeft).toEqual({
      roomId: created.roomId,
      peerId: firstJoined.peerId,
      reason: 'disconnect',
    });

    const replacementJoinedPromise = waitForEvent(peerC, 'room:joined');
    const replacementPeerJoinedPromise = waitForEvent(peerA, 'peer:joined');
    peerC.emit('room:join', { roomId: created.roomId });

    const [replacementJoined, replacementNotification] = await Promise.all([
      replacementJoinedPromise,
      replacementPeerJoinedPromise,
    ]);

    expect(replacementJoined.roomId).toBe(created.roomId);
    expect(replacementJoined.negotiationDuty).toBe('answerer');
    expect(replacementJoined.peerId).toMatch(PEER_ID_PATTERN);
    expect(replacementJoined.peerId).not.toBe(created.peerId);
    expect(replacementJoined.peerId).not.toBe(firstJoined.peerId);
    expect(replacementNotification).toEqual({
      roomId: created.roomId,
      peerId: replacementJoined.peerId,
    });

    const adapterRoom = server.io.sockets.adapter.rooms.get(created.roomId);
    expect(adapterRoom?.has(peerA.id)).toBe(true);
    expect(adapterRoom?.has(peerC.id)).toBe(true);
    expect(adapterRoom?.has(peerB.id)).toBe(false);
    expect(await fetchRoomsCount(server.baseUrl)).toBe(1);
  });

  test('allows replacement peer join when the original creator disconnects', async () => {
    const server = await startIsolatedServer();
    const peerA = await connectClient(server.baseUrl);
    const peerB = await connectClient(server.baseUrl);
    const peerC = await connectClient(server.baseUrl);

    const created = await emitAndWait(peerA, 'room:create', {}, 'room:created');

    const joinedPromise = waitForEvent(peerB, 'room:joined');
    const peerJoinedPromise = waitForEvent(peerA, 'peer:joined');
    peerB.emit('room:join', { roomId: created.roomId });
    const [joined] = await Promise.all([joinedPromise, peerJoinedPromise]);

    const peerLeftPromise = waitForEvent(peerB, 'peer:left');
    peerA.disconnect();
    const peerLeft = await peerLeftPromise;
    expect(peerLeft).toEqual({
      roomId: created.roomId,
      peerId: created.peerId,
      reason: 'disconnect',
    });

    const replacementJoinedPromise = waitForEvent(peerC, 'room:joined');
    const replacementPeerJoinedPromise = waitForEvent(peerB, 'peer:joined');
    peerC.emit('room:join', { roomId: created.roomId });

    const [replacementJoined, replacementNotification] = await Promise.all([
      replacementJoinedPromise,
      replacementPeerJoinedPromise,
    ]);

    expect(replacementJoined.roomId).toBe(created.roomId);
    expect(replacementJoined.negotiationDuty).toBe('answerer');
    expect(replacementJoined.peerId).toMatch(PEER_ID_PATTERN);
    expect(replacementJoined.peerId).not.toBe(joined.peerId);
    expect(replacementNotification).toEqual({
      roomId: created.roomId,
      peerId: replacementJoined.peerId,
    });

    const adapterRoom = server.io.sockets.adapter.rooms.get(created.roomId);
    expect(adapterRoom?.has(peerB.id)).toBe(true);
    expect(adapterRoom?.has(peerC.id)).toBe(true);
    expect(adapterRoom?.has(peerA.id)).toBe(false);
    expect(await fetchRoomsCount(server.baseUrl)).toBe(1);
  });

  test('returns ROOM_NOT_FOUND with canonical roomId for unknown rooms', async () => {
    const server = await startIsolatedServer();
    const peer = await connectClient(server.baseUrl);

    const error = await emitAndWait(
      peer,
      'room:join',
      { roomId: 'ship-9999' },
      'room:error',
    );

    expect(error).toEqual({
      roomId: 'ship-9999',
      code: 'ROOM_NOT_FOUND',
      message: expect.any(String),
    });
  });

  test.each(['ship-ZZZZ', '', 123])(
    'rejects malformed roomId %j with INVALID_ROOM_ID and no roomId field',
    async (roomId) => {
      const server = await startIsolatedServer();
      const peer = await connectClient(server.baseUrl);

      const error = await emitAndWait(
        peer,
        'room:join',
        { roomId },
        'room:error',
      );

      expect(error.code).toBe('INVALID_ROOM_ID');
      expect(typeof error.message).toBe('string');
      expect('roomId' in error).toBe(false);
    },
  );

  test.each([
    [null],
    [{ room_id: 'ship-83a1' }],
    [{ roomId: 'ship-83a1', extra: true }],
  ])(
    'rejects invalid payload %j with INVALID_PAYLOAD',
    async (payload) => {
      const server = await startIsolatedServer();
      const peer = await connectClient(server.baseUrl);

      const error = await emitAndWait(peer, 'room:join', payload, 'room:error');

      expect(error.code).toBe('INVALID_PAYLOAD');
      expect(typeof error.message).toBe('string');
    },
  );

  test('rejects creator attempting to join its own room with UNAUTHORIZED', async () => {
    const server = await startIsolatedServer();
    const peerA = await connectClient(server.baseUrl);
    const peerB = await connectClient(server.baseUrl);

    const roomA = await emitAndWait(peerA, 'room:create', {}, 'room:created');

    const error = await emitAndWait(
      peerA,
      'room:join',
      { roomId: roomA.roomId },
      'room:error',
    );

    expect(error).toEqual({
      roomId: roomA.roomId,
      code: 'UNAUTHORIZED',
      message: expect.any(String),
    });

    const joinedPromise = waitForEvent(peerB, 'room:joined');
    const peerJoinedPromise = waitForEvent(peerA, 'peer:joined');
    peerB.emit('room:join', { roomId: roomA.roomId });
    const [joined] = await Promise.all([joinedPromise, peerJoinedPromise]);
    expect(joined.negotiationDuty).toBe('answerer');
  });

  test('rejects creator of Room A joining Room B while keeping Room B available', async () => {
    const server = await startIsolatedServer();
    const peerA = await connectClient(server.baseUrl);
    const peerB = await connectClient(server.baseUrl);
    const peerC = await connectClient(server.baseUrl);

    await emitAndWait(peerA, 'room:create', {}, 'room:created');
    const roomB = await emitAndWait(peerB, 'room:create', {}, 'room:created');

    const error = await emitAndWait(
      peerA,
      'room:join',
      { roomId: roomB.roomId },
      'room:error',
    );

    expect(error).toEqual({
      roomId: roomB.roomId,
      code: 'UNAUTHORIZED',
      message: expect.any(String),
    });

    const joinedPromise = waitForEvent(peerC, 'room:joined');
    const peerJoinedPromise = waitForEvent(peerB, 'peer:joined');
    peerC.emit('room:join', { roomId: roomB.roomId });
    const [joined, peerJoined] = await Promise.all([
      joinedPromise,
      peerJoinedPromise,
    ]);
    expect(joined.roomId).toBe(roomB.roomId);
    expect(joined.negotiationDuty).toBe('answerer');
    expect(peerJoined.peerId).toBe(joined.peerId);
  });

  test('rejects joined second peer of Room A attempting to join Room B with UNAUTHORIZED', async () => {
    const server = await startIsolatedServer();
    const peerA = await connectClient(server.baseUrl);
    const peerA2 = await connectClient(server.baseUrl);
    const peerB = await connectClient(server.baseUrl);

    const roomA = await emitAndWait(peerA, 'room:create', {}, 'room:created');
    const roomB = await emitAndWait(peerB, 'room:create', {}, 'room:created');

    const joinedAPromise = waitForEvent(peerA2, 'room:joined');
    const peerJoinedAPromise = waitForEvent(peerA, 'peer:joined');
    peerA2.emit('room:join', { roomId: roomA.roomId });
    await Promise.all([joinedAPromise, peerJoinedAPromise]);

    const error = await emitAndWait(
      peerA2,
      'room:join',
      { roomId: roomB.roomId },
      'room:error',
    );

    expect(error).toEqual({
      roomId: roomB.roomId,
      code: 'UNAUTHORIZED',
      message: expect.any(String),
    });
  });

  test('rejects a third peer with ROOM_FULL without changing room membership or notifying active peers', async () => {
    const server = await startIsolatedServer();
    const peerA = await connectClient(server.baseUrl);
    const peerB = await connectClient(server.baseUrl);
    const peerC = await connectClient(server.baseUrl);

    const room = await emitAndWait(peerA, 'room:create', {}, 'room:created');

    const joinedPromise = waitForEvent(peerB, 'room:joined');
    const peerJoinedPromise = waitForEvent(peerA, 'peer:joined');
    peerB.emit('room:join', { roomId: room.roomId });
    await Promise.all([joinedPromise, peerJoinedPromise]);

    let extraNotifications = 0;
    peerA.on('peer:joined', () => {
      extraNotifications += 1;
    });
    peerB.on('peer:joined', () => {
      extraNotifications += 1;
    });

    const error = await emitAndWait(
      peerC,
      'room:join',
      { roomId: room.roomId },
      'room:error',
    );

    expect(error).toEqual({
      roomId: room.roomId,
      code: 'ROOM_FULL',
      message: expect.any(String),
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(extraNotifications).toBe(0);

    const adapterRoom = server.io.sockets.adapter.rooms.get(room.roomId);
    expect(adapterRoom?.has(peerA.id)).toBe(true);
    expect(adapterRoom?.has(peerB.id)).toBe(true);
    expect(adapterRoom?.has(peerC.id)).toBe(false);
    expect(adapterRoom?.size).toBe(2);
  });

  test('enforces documented error precedence on room:join', async () => {
    const server = await startIsolatedServer();
    const peerA = await connectClient(server.baseUrl);
    const peerB1 = await connectClient(server.baseUrl);
    const peerB2 = await connectClient(server.baseUrl);

    await emitAndWait(peerA, 'room:create', {}, 'room:created');
    const roomB = await emitAndWait(peerB1, 'room:create', {}, 'room:created');

    const joinedBPromise = waitForEvent(peerB2, 'room:joined');
    const peerJoinedBPromise = waitForEvent(peerB1, 'peer:joined');
    peerB2.emit('room:join', { roomId: roomB.roomId });
    await Promise.all([joinedBPromise, peerJoinedBPromise]);

    const notFoundFirst = await emitAndWait(
      peerA,
      'room:join',
      { roomId: 'ship-9999' },
      'room:error',
    );
    expect(notFoundFirst).toEqual({
      roomId: 'ship-9999',
      code: 'ROOM_NOT_FOUND',
      message: expect.any(String),
    });

    const unauthorizedBeforeFull = await emitAndWait(
      peerA,
      'room:join',
      { roomId: roomB.roomId },
      'room:error',
    );
    expect(unauthorizedBeforeFull).toEqual({
      roomId: roomB.roomId,
      code: 'UNAUTHORIZED',
      message: expect.any(String),
    });
  });
});
