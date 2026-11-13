import { afterEach, describe, expect, test, vi } from 'vitest';
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

function waitForEvent(emitter, eventName) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for ${eventName}`));
    }, 1_000);

    emitter.once(eventName, (payload) => {
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

async function createTwoPeerRoom(server) {
  const peerA = await connectClient(server.baseUrl);
  const peerB = await connectClient(server.baseUrl);

  const created = await emitAndWait(peerA, 'room:create', {}, 'room:created');

  const joinedPromise = waitForEvent(peerB, 'room:joined');
  const peerJoinedPromise = waitForEvent(peerA, 'peer:joined');
  peerB.emit('room:join', { roomId: created.roomId });
  const [joined] = await Promise.all([joinedPromise, peerJoinedPromise]);

  return { peerA, peerB, created, joined };
}

function snapshotServerState(server) {
  const rooms = [...server.activeRooms.entries()].map(([roomId, room]) => [
    roomId,
    {
      roomId: room.roomId,
      createdAt: room.createdAt,
      peers: room.peers.map((peer) => ({ ...peer })),
    },
  ]);

  return {
    rooms,
    socketRooms: [...server.socketRooms.entries()],
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  closeSocketClients(...clients);
  clients.clear();

  await Promise.all([...servers].map((server) => server.close()));
  servers.clear();
});

describe('Socket.IO disconnect room cleanup and peer notifications', () => {
  test('removes only disconnecting joiner, removes socket from Socket.IO room, preserves room, and emits peer:left', async () => {
    const server = await startIsolatedServer();
    const { peerA, peerB, created, joined } = await createTwoPeerRoom(server);
    const peerASocketId = peerA.id;
    const peerBSocketId = peerB.id;

    let unexpectedRoomError = null;
    peerA.on('room:error', (error) => {
      unexpectedRoomError = error;
    });

    const peerLeftPromise = waitForEvent(peerA, 'peer:left');
    peerB.disconnect();
    const peerLeft = await peerLeftPromise;

    expect(Object.keys(peerLeft).sort()).toEqual(['peerId', 'reason', 'roomId']);
    expect(peerLeft).toEqual({
      roomId: created.roomId,
      peerId: joined.peerId,
      reason: 'disconnect',
    });
    expect(unexpectedRoomError).toBeNull();

    const adapterRoom = server.io.sockets.adapter.rooms.get(created.roomId);
    expect(adapterRoom?.has(peerASocketId)).toBe(true);
    expect(adapterRoom?.has(peerBSocketId)).toBe(false);
    expect(adapterRoom?.size).toBe(1);
    expect(await fetchRoomsCount(server.baseUrl)).toBe(1);
  });

  test('removes only disconnecting creator, removes socket from Socket.IO room, preserves room, and emits peer:left', async () => {
    const server = await startIsolatedServer();
    const { peerA, peerB, created } = await createTwoPeerRoom(server);
    const peerASocketId = peerA.id;
    const peerBSocketId = peerB.id;

    let unexpectedRoomError = null;
    peerB.on('room:error', (error) => {
      unexpectedRoomError = error;
    });

    const peerLeftPromise = waitForEvent(peerB, 'peer:left');
    peerA.disconnect();
    const peerLeft = await peerLeftPromise;

    expect(Object.keys(peerLeft).sort()).toEqual(['peerId', 'reason', 'roomId']);
    expect(peerLeft).toEqual({
      roomId: created.roomId,
      peerId: created.peerId,
      reason: 'disconnect',
    });
    expect(unexpectedRoomError).toBeNull();

    const adapterRoom = server.io.sockets.adapter.rooms.get(created.roomId);
    expect(adapterRoom?.has(peerASocketId)).toBe(false);
    expect(adapterRoom?.has(peerBSocketId)).toBe(true);
    expect(adapterRoom?.size).toBe(1);
    expect(await fetchRoomsCount(server.baseUrl)).toBe(1);
  });

  test('treats remaining peer as next offerer across chained disconnects and replacement joins', async () => {
    const server = await startIsolatedServer();
    const { peerA, peerB, created, joined } = await createTwoPeerRoom(server);
    const peerC = await connectClient(server.baseUrl);
    const peerD = await connectClient(server.baseUrl);

    const firstDisconnectPromise = waitForEvent(peerA, 'peer:left');
    peerB.disconnect();
    const firstLeft = await firstDisconnectPromise;
    expect(firstLeft).toEqual({
      roomId: created.roomId,
      peerId: joined.peerId,
      reason: 'disconnect',
    });

    const peerCJoinedPromise = waitForEvent(peerC, 'room:joined');
    const peerANotifiedPromise = waitForEvent(peerA, 'peer:joined');
    peerC.emit('room:join', { roomId: created.roomId });
    const [peerCJoined, peerANotified] = await Promise.all([
      peerCJoinedPromise,
      peerANotifiedPromise,
    ]);

    expect(peerCJoined.roomId).toBe(created.roomId);
    expect(peerCJoined.negotiationDuty).toBe('answerer');
    expect(peerCJoined.peerId).toMatch(PEER_ID_PATTERN);
    expect(peerANotified).toEqual({
      roomId: created.roomId,
      peerId: peerCJoined.peerId,
    });

    const secondDisconnectPromise = waitForEvent(peerC, 'peer:left');
    peerA.disconnect();
    const secondLeft = await secondDisconnectPromise;
    expect(secondLeft).toEqual({
      roomId: created.roomId,
      peerId: created.peerId,
      reason: 'disconnect',
    });

    const peerDJoinedPromise = waitForEvent(peerD, 'room:joined');
    const peerCNotifiedPromise = waitForEvent(peerC, 'peer:joined');
    peerD.emit('room:join', { roomId: created.roomId });
    const [peerDJoined, peerCNotified] = await Promise.all([
      peerDJoinedPromise,
      peerCNotifiedPromise,
    ]);

    expect(peerDJoined.roomId).toBe(created.roomId);
    expect(peerDJoined.negotiationDuty).toBe('answerer');
    expect(peerDJoined.peerId).toMatch(PEER_ID_PATTERN);
    expect(peerDJoined.peerId).not.toBe(peerCJoined.peerId);
    expect(peerCNotified).toEqual({
      roomId: created.roomId,
      peerId: peerDJoined.peerId,
    });

    const adapterRoom = server.io.sockets.adapter.rooms.get(created.roomId);
    expect(adapterRoom?.has(peerC.id)).toBe(true);
    expect(adapterRoom?.has(peerD.id)).toBe(true);
    expect(adapterRoom?.size).toBe(2);
    expect(await fetchRoomsCount(server.baseUrl)).toBe(1);
  });

  test('deletes a one-peer room immediately when the only peer disconnects', async () => {
    const server = await startIsolatedServer();
    const peerA = await connectClient(server.baseUrl);
    const peerB = await connectClient(server.baseUrl);

    const created = await emitAndWait(peerA, 'room:create', {}, 'room:created');
    const serverSocketA = server.io.sockets.sockets.get(peerA.id);
    const disconnectProcessed = waitForEvent(serverSocketA, 'disconnect');

    peerA.disconnect();
    await disconnectProcessed;

    expect(server.io.sockets.adapter.rooms.has(created.roomId)).toBe(false);
    expect(await fetchRoomsCount(server.baseUrl)).toBe(0);

    const joinError = await emitAndWait(
      peerB,
      'room:join',
      { roomId: created.roomId },
      'room:error',
    );
    expect(joinError).toEqual({
      roomId: created.roomId,
      code: 'ROOM_NOT_FOUND',
      message: expect.any(String),
    });
  });

  test('deletes room immediately when final remaining peer disconnects after first peer disconnected', async () => {
    const server = await startIsolatedServer();
    const { peerA, peerB, created } = await createTwoPeerRoom(server);
    const peerC = await connectClient(server.baseUrl);

    const firstLeftPromise = waitForEvent(peerB, 'peer:left');
    peerA.disconnect();
    await firstLeftPromise;
    expect(await fetchRoomsCount(server.baseUrl)).toBe(1);

    const serverSocketB = server.io.sockets.sockets.get(peerB.id);
    const secondDisconnectProcessed = waitForEvent(serverSocketB, 'disconnect');

    peerB.disconnect();
    await secondDisconnectProcessed;

    expect(server.io.sockets.adapter.rooms.has(created.roomId)).toBe(false);
    expect(await fetchRoomsCount(server.baseUrl)).toBe(0);

    const joinError = await emitAndWait(
      peerC,
      'room:join',
      { roomId: created.roomId },
      'room:error',
    );
    expect(joinError).toEqual({
      roomId: created.roomId,
      code: 'ROOM_NOT_FOUND',
      message: expect.any(String),
    });
  });

  test('does not emit peer:left or alter active rooms when an unaffiliated socket disconnects', async () => {
    const server = await startIsolatedServer();
    const { peerA, peerB, created } = await createTwoPeerRoom(server);
    const outsider = await connectClient(server.baseUrl);

    let peerLeftNotifications = 0;
    peerA.on('peer:left', () => {
      peerLeftNotifications += 1;
    });
    peerB.on('peer:left', () => {
      peerLeftNotifications += 1;
    });

    const outsiderServerSocket = server.io.sockets.sockets.get(outsider.id);
    const outsiderDisconnected = waitForEvent(outsiderServerSocket, 'disconnect');
    outsider.disconnect();
    await outsiderDisconnected;

    expect(peerLeftNotifications).toBe(0);
    expect(await fetchRoomsCount(server.baseUrl)).toBe(1);
    const adapterRoom = server.io.sockets.adapter.rooms.get(created.roomId);
    expect(adapterRoom?.has(peerA.id)).toBe(true);
    expect(adapterRoom?.has(peerB.id)).toBe(true);
  });

  test('resolves disconnect cleanup via reverse socket-to-room index without scanning activeRooms or affecting unrelated rooms', async () => {
    const server = await startIsolatedServer();
    const {
      peerA: targetA,
      peerB: targetB,
      created: targetCreated,
      joined: targetJoined,
    } = await createTwoPeerRoom(server);
    const {
      peerA: unrelatedA,
      peerB: unrelatedB,
      created: unrelatedTwoPeerRoom,
    } = await createTwoPeerRoom(server);
    const unrelatedSingle = await connectClient(server.baseUrl);
    const unrelatedSingleRoom = await emitAndWait(
      unrelatedSingle,
      'room:create',
      {},
      'room:created',
    );
    const outsider = await connectClient(server.baseUrl);

    const targetASocketId = targetA.id;
    const targetBSocketId = targetB.id;
    const outsiderSocketId = outsider.id;

    expect(server.activeRooms.size).toBe(3);
    expect(server.socketRooms.size).toBe(5);
    expect(server.socketRooms.get(targetASocketId)).toBe(targetCreated.roomId);
    expect(server.socketRooms.get(targetBSocketId)).toBe(targetCreated.roomId);
    expect(server.socketRooms.get(unrelatedA.id)).toBe(
      unrelatedTwoPeerRoom.roomId,
    );
    expect(server.socketRooms.get(unrelatedB.id)).toBe(
      unrelatedTwoPeerRoom.roomId,
    );
    expect(server.socketRooms.get(unrelatedSingle.id)).toBe(
      unrelatedSingleRoom.roomId,
    );
    expect(server.socketRooms.has(outsiderSocketId)).toBe(false);

    let unrelatedNotifications = 0;
    for (const unrelatedPeer of [unrelatedA, unrelatedB, unrelatedSingle]) {
      unrelatedPeer.on('peer:left', () => {
        unrelatedNotifications += 1;
      });
    }

    const valuesSpy = vi.spyOn(server.activeRooms, 'values');
    const entriesSpy = vi.spyOn(server.activeRooms, 'entries');
    const forEachSpy = vi.spyOn(server.activeRooms, 'forEach');
    const iteratorSpy = vi.spyOn(server.activeRooms, Symbol.iterator);

    const peerLeftPromise = waitForEvent(targetA, 'peer:left');
    targetB.disconnect();
    const peerLeft = await peerLeftPromise;

    expect(peerLeft).toEqual({
      roomId: targetCreated.roomId,
      peerId: targetJoined.peerId,
      reason: 'disconnect',
    });

    const outsiderServerSocket = server.io.sockets.sockets.get(outsiderSocketId);
    const outsiderDisconnected = waitForEvent(outsiderServerSocket, 'disconnect');
    outsider.disconnect();
    await outsiderDisconnected;

    expect(valuesSpy).toHaveBeenCalledTimes(0);
    expect(entriesSpy).toHaveBeenCalledTimes(0);
    expect(forEachSpy).toHaveBeenCalledTimes(0);
    expect(iteratorSpy).toHaveBeenCalledTimes(0);

    expect(server.socketRooms.has(targetBSocketId)).toBe(false);
    expect(server.socketRooms.has(outsiderSocketId)).toBe(false);
    expect(server.socketRooms.get(targetASocketId)).toBe(targetCreated.roomId);
    expect(server.activeRooms.size).toBe(3);
    expect(server.socketRooms.size).toBe(4);
    expect(server.activeRooms.get(targetCreated.roomId)?.peers).toHaveLength(1);
    expect(
      server.activeRooms.get(unrelatedTwoPeerRoom.roomId)?.peers,
    ).toHaveLength(2);
    expect(
      server.activeRooms.get(unrelatedSingleRoom.roomId)?.peers,
    ).toHaveLength(1);
    expect(unrelatedNotifications).toBe(0);

    const targetAServerSocket = server.io.sockets.sockets.get(targetASocketId);
    const targetADisconnected = waitForEvent(targetAServerSocket, 'disconnect');
    targetA.disconnect();
    await targetADisconnected;

    expect(valuesSpy).toHaveBeenCalledTimes(0);
    expect(entriesSpy).toHaveBeenCalledTimes(0);
    expect(forEachSpy).toHaveBeenCalledTimes(0);
    expect(iteratorSpy).toHaveBeenCalledTimes(0);

    expect(server.activeRooms.has(targetCreated.roomId)).toBe(false);
    expect(server.socketRooms.has(targetASocketId)).toBe(false);
    expect(server.activeRooms.size).toBe(2);
    expect(server.socketRooms.size).toBe(3);
    expect(server.socketRooms.get(unrelatedA.id)).toBe(
      unrelatedTwoPeerRoom.roomId,
    );
    expect(server.socketRooms.get(unrelatedB.id)).toBe(
      unrelatedTwoPeerRoom.roomId,
    );
    expect(server.socketRooms.get(unrelatedSingle.id)).toBe(
      unrelatedSingleRoom.roomId,
    );
    expect(unrelatedNotifications).toBe(0);
  });

  test('keeps reverse socket-to-room index consistent across valid transitions and unchanged on rejected operations', async () => {
    const server = await startIsolatedServer();
    const peerA = await connectClient(server.baseUrl);
    const peerB = await connectClient(server.baseUrl);
    const peerC = await connectClient(server.baseUrl);
    const otherCreator = await connectClient(server.baseUrl);
    const outsider = await connectClient(server.baseUrl);

    expect(server.activeRooms.size).toBe(0);
    expect(server.socketRooms.size).toBe(0);

    const invalidCreateError = await emitAndWait(
      peerA,
      'room:create',
      { unexpected: true },
      'room:error',
    );
    expect(invalidCreateError.code).toBe('INVALID_PAYLOAD');
    expect(server.activeRooms.size).toBe(0);
    expect(server.socketRooms.size).toBe(0);

    const created = await emitAndWait(peerA, 'room:create', {}, 'room:created');
    const unusedRoomId =
      created.roomId === 'ship-0000' ? 'ship-0001' : 'ship-0000';
    expect(server.activeRooms.size).toBe(1);
    expect(server.socketRooms.size).toBe(1);
    expect(server.socketRooms.get(peerA.id)).toBe(created.roomId);

    const onePeerSnapshot = snapshotServerState(server);

    expect(
      (await emitAndWait(peerA, 'room:create', {}, 'room:error')).code,
    ).toBe('UNAUTHORIZED');
    expect(
      (
        await emitAndWait(
          peerA,
          'room:join',
          { roomId: created.roomId },
          'room:error',
        )
      ).code,
    ).toBe('UNAUTHORIZED');
    expect(
      (await emitAndWait(peerB, 'room:join', null, 'room:error')).code,
    ).toBe('INVALID_PAYLOAD');
    expect(
      (await emitAndWait(peerB, 'room:join', { roomId: 'bad' }, 'room:error'))
        .code,
    ).toBe('INVALID_ROOM_ID');
    expect(
      (
        await emitAndWait(
          peerB,
          'room:join',
          { roomId: unusedRoomId },
          'room:error',
        )
      ).code,
    ).toBe('ROOM_NOT_FOUND');
    expect(
      (await emitAndWait(outsider, 'room:leave', null, 'room:error')).code,
    ).toBe('INVALID_PAYLOAD');
    expect(
      (
        await emitAndWait(
          outsider,
          'room:leave',
          { roomId: 'bad' },
          'room:error',
        )
      ).code,
    ).toBe('INVALID_ROOM_ID');
    expect(
      (
        await emitAndWait(
          outsider,
          'room:leave',
          { roomId: unusedRoomId },
          'room:error',
        )
      ).code,
    ).toBe('ROOM_NOT_FOUND');
    expect(
      (
        await emitAndWait(
          outsider,
          'room:leave',
          { roomId: created.roomId },
          'room:error',
        )
      ).code,
    ).toBe('UNAUTHORIZED');
    expect(snapshotServerState(server)).toEqual(onePeerSnapshot);

    const peerBJoinedPromise = waitForEvent(peerB, 'room:joined');
    const peerANotifiedJoinPromise = waitForEvent(peerA, 'peer:joined');
    peerB.emit('room:join', { roomId: created.roomId });
    await Promise.all([peerBJoinedPromise, peerANotifiedJoinPromise]);

    expect(server.activeRooms.size).toBe(1);
    expect(server.socketRooms.size).toBe(2);
    expect(server.socketRooms.get(peerA.id)).toBe(created.roomId);
    expect(server.socketRooms.get(peerB.id)).toBe(created.roomId);

    const otherRoom = await emitAndWait(
      otherCreator,
      'room:create',
      {},
      'room:created',
    );
    expect(server.activeRooms.size).toBe(2);
    expect(server.socketRooms.size).toBe(3);
    expect(server.socketRooms.get(otherCreator.id)).toBe(otherRoom.roomId);

    const fullSnapshot = snapshotServerState(server);
    expect(
      (
        await emitAndWait(
          peerC,
          'room:join',
          { roomId: created.roomId },
          'room:error',
        )
      ).code,
    ).toBe('ROOM_FULL');
    expect(
      (
        await emitAndWait(
          otherCreator,
          'room:join',
          { roomId: created.roomId },
          'room:error',
        )
      ).code,
    ).toBe('UNAUTHORIZED');
    expect(
      (
        await emitAndWait(
          otherCreator,
          'room:leave',
          { roomId: created.roomId },
          'room:error',
        )
      ).code,
    ).toBe('UNAUTHORIZED');
    expect(snapshotServerState(server)).toEqual(fullSnapshot);

    const otherCreatorSocketId = otherCreator.id;
    const otherCreatorServerSocket = server.io.sockets.sockets.get(
      otherCreatorSocketId,
    );
    const otherCreatorDisconnected = waitForEvent(
      otherCreatorServerSocket,
      'disconnect',
    );
    otherCreator.disconnect();
    await otherCreatorDisconnected;

    expect(server.activeRooms.has(otherRoom.roomId)).toBe(false);
    expect(server.socketRooms.has(otherCreatorSocketId)).toBe(false);
    expect(server.activeRooms.size).toBe(1);
    expect(server.socketRooms.size).toBe(2);

    const peerLeftOnLeavePromise = waitForEvent(peerA, 'peer:left');
    peerB.emit('room:leave', { roomId: created.roomId });
    const peerLeftOnLeave = await peerLeftOnLeavePromise;
    expect(peerLeftOnLeave.reason).toBe('leave');

    expect(server.activeRooms.size).toBe(1);
    expect(server.socketRooms.size).toBe(1);
    expect(server.socketRooms.has(peerB.id)).toBe(false);
    expect(server.socketRooms.get(peerA.id)).toBe(created.roomId);

    const afterLeaveSnapshot = snapshotServerState(server);
    expect(
      (
        await emitAndWait(
          peerB,
          'room:leave',
          { roomId: created.roomId },
          'room:error',
        )
      ).code,
    ).toBe('UNAUTHORIZED');
    expect(snapshotServerState(server)).toEqual(afterLeaveSnapshot);

    const peerCJoinedPromise = waitForEvent(peerC, 'room:joined');
    const peerANotifiedReplacementPromise = waitForEvent(peerA, 'peer:joined');
    peerC.emit('room:join', { roomId: created.roomId });
    await Promise.all([peerCJoinedPromise, peerANotifiedReplacementPromise]);

    expect(server.activeRooms.size).toBe(1);
    expect(server.socketRooms.size).toBe(2);
    expect(server.socketRooms.get(peerA.id)).toBe(created.roomId);
    expect(server.socketRooms.get(peerC.id)).toBe(created.roomId);

    const peerASocketId = peerA.id;
    const peerCSocketId = peerC.id;

    const peerCNotifiedDisconnectPromise = waitForEvent(peerC, 'peer:left');
    peerA.disconnect();
    const peerCNotifiedDisconnect = await peerCNotifiedDisconnectPromise;
    expect(peerCNotifiedDisconnect.reason).toBe('disconnect');

    expect(server.activeRooms.size).toBe(1);
    expect(server.socketRooms.size).toBe(1);
    expect(server.socketRooms.has(peerASocketId)).toBe(false);
    expect(server.socketRooms.get(peerCSocketId)).toBe(created.roomId);

    const peerCServerSocket = server.io.sockets.sockets.get(peerCSocketId);
    const peerCDisconnected = waitForEvent(peerCServerSocket, 'disconnect');
    peerC.disconnect();
    await peerCDisconnected;

    expect(server.activeRooms.size).toBe(0);
    expect(server.socketRooms.size).toBe(0);

    expect(
      (
        await emitAndWait(
          outsider,
          'room:leave',
          { roomId: created.roomId },
          'room:error',
        )
      ).code,
    ).toBe('ROOM_NOT_FOUND');
    expect(server.activeRooms.size).toBe(0);
    expect(server.socketRooms.size).toBe(0);
  });
});
