import { afterEach, describe, expect, test } from 'vitest';
import { PEER_ID_PATTERN, validateRoomLeavePayload } from '../src/room-id.js';
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

afterEach(async () => {
  closeSocketClients(...clients);
  clients.clear();

  await Promise.all([...servers].map((server) => server.close()));
  servers.clear();
});

describe('validateRoomLeavePayload', () => {
  test('accepts valid canonical roomId payload', () => {
    expect(validateRoomLeavePayload({ roomId: 'ship-83a1' })).toEqual({
      ok: true,
      roomId: 'ship-83a1',
    });
  });

  test.each([[null], [undefined], ['ship-83a1'], [[]], [123]])(
    'rejects non-object payload %j with INVALID_PAYLOAD and no roomId',
    (payload) => {
      const result = validateRoomLeavePayload(payload);
      expect(result.ok).toBe(false);
      expect(result.error.code).toBe('INVALID_PAYLOAD');
      expect(typeof result.error.message).toBe('string');
      expect('roomId' in result.error).toBe(false);
    },
  );

  test('rejects unsupported top-level fields with INVALID_PAYLOAD and attaches valid roomId only', () => {
    const snakeCase = validateRoomLeavePayload({ room_id: 'ship-83a1' });
    expect(snakeCase.ok).toBe(false);
    expect(snakeCase.error.code).toBe('INVALID_PAYLOAD');
    expect('roomId' in snakeCase.error).toBe(false);

    const extraWithValidId = validateRoomLeavePayload({
      roomId: 'ship-83a1',
      extra: true,
    });
    expect(extraWithValidId.ok).toBe(false);
    expect(extraWithValidId.error).toEqual({
      roomId: 'ship-83a1',
      code: 'INVALID_PAYLOAD',
      message: expect.any(String),
    });

    const extraWithInvalidId = validateRoomLeavePayload({
      roomId: 'bad-id',
      extra: true,
    });
    expect(extraWithInvalidId.ok).toBe(false);
    expect(extraWithInvalidId.error.code).toBe('INVALID_PAYLOAD');
    expect('roomId' in extraWithInvalidId.error).toBe(false);
  });

  test.each([{}, { roomId: '' }, { roomId: 'ship-ZZZZ' }, { roomId: 123 }])(
    'rejects missing or malformed roomId %j with INVALID_ROOM_ID and no roomId',
    (payload) => {
      const result = validateRoomLeavePayload(payload);
      expect(result.ok).toBe(false);
      expect(result.error.code).toBe('INVALID_ROOM_ID');
      expect(typeof result.error.message).toBe('string');
      expect('roomId' in result.error).toBe(false);
    },
  );
});

describe('Socket.IO room:leave lifecycle', () => {
  test('removes joining peer on room:leave, emits peer:left to remaining peer, and frees membership', async () => {
    const server = await startIsolatedServer();
    const { peerA, peerB, created, joined } = await createTwoPeerRoom(server);

    const peerLeftPromise = waitForEvent(peerA, 'peer:left');
    peerB.emit('room:leave', { roomId: created.roomId });
    const peerLeft = await peerLeftPromise;

    expect(Object.keys(peerLeft).sort()).toEqual(['peerId', 'reason', 'roomId']);
    expect(peerLeft).toEqual({
      roomId: created.roomId,
      peerId: joined.peerId,
      reason: 'leave',
    });

    const adapterRoom = server.io.sockets.adapter.rooms.get(created.roomId);
    expect(adapterRoom?.has(peerA.id)).toBe(true);
    expect(adapterRoom?.has(peerB.id)).toBe(false);
    expect(adapterRoom?.size).toBe(1);
    expect(await fetchRoomsCount(server.baseUrl)).toBe(1);

    const newRoom = await emitAndWait(peerB, 'room:create', {}, 'room:created');
    expect(newRoom.roomId).not.toBe(created.roomId);
    expect(newRoom.negotiationDuty).toBe('offerer');
    expect(await fetchRoomsCount(server.baseUrl)).toBe(2);
  });

  test('removes creator on room:leave and emits peer:left to remaining peer', async () => {
    const server = await startIsolatedServer();
    const { peerA, peerB, created } = await createTwoPeerRoom(server);

    const peerLeftPromise = waitForEvent(peerB, 'peer:left');
    peerA.emit('room:leave', { roomId: created.roomId });
    const peerLeft = await peerLeftPromise;

    expect(Object.keys(peerLeft).sort()).toEqual(['peerId', 'reason', 'roomId']);
    expect(peerLeft).toEqual({
      roomId: created.roomId,
      peerId: created.peerId,
      reason: 'leave',
    });

    const adapterRoom = server.io.sockets.adapter.rooms.get(created.roomId);
    expect(adapterRoom?.has(peerB.id)).toBe(true);
    expect(adapterRoom?.has(peerA.id)).toBe(false);
    expect(adapterRoom?.size).toBe(1);
    expect(await fetchRoomsCount(server.baseUrl)).toBe(1);
  });

  test('allows replacement peer join as answerer after joining peer explicitly leaves', async () => {
    const server = await startIsolatedServer();
    const { peerA, peerB, created, joined } = await createTwoPeerRoom(server);
    const peerC = await connectClient(server.baseUrl);

    const peerLeftPromise = waitForEvent(peerA, 'peer:left');
    peerB.emit('room:leave', { roomId: created.roomId });
    await peerLeftPromise;

    const replacementJoinedPromise = waitForEvent(peerC, 'room:joined');
    const peerJoinedPromise = waitForEvent(peerA, 'peer:joined');
    peerC.emit('room:join', { roomId: created.roomId });
    const [replacementJoined, notification] = await Promise.all([
      replacementJoinedPromise,
      peerJoinedPromise,
    ]);

    expect(replacementJoined.roomId).toBe(created.roomId);
    expect(replacementJoined.negotiationDuty).toBe('answerer');
    expect(replacementJoined.peerId).toMatch(PEER_ID_PATTERN);
    expect(replacementJoined.peerId).not.toBe(joined.peerId);
    expect(notification).toEqual({
      roomId: created.roomId,
      peerId: replacementJoined.peerId,
    });
  });

  test('allows replacement peer join as answerer after creator explicitly leaves', async () => {
    const server = await startIsolatedServer();
    const { peerA, peerB, created, joined } = await createTwoPeerRoom(server);
    const peerC = await connectClient(server.baseUrl);

    const peerLeftPromise = waitForEvent(peerB, 'peer:left');
    peerA.emit('room:leave', { roomId: created.roomId });
    await peerLeftPromise;

    const replacementJoinedPromise = waitForEvent(peerC, 'room:joined');
    const peerJoinedPromise = waitForEvent(peerB, 'peer:joined');
    peerC.emit('room:join', { roomId: created.roomId });
    const [replacementJoined, notification] = await Promise.all([
      replacementJoinedPromise,
      peerJoinedPromise,
    ]);

    expect(replacementJoined.roomId).toBe(created.roomId);
    expect(replacementJoined.negotiationDuty).toBe('answerer');
    expect(replacementJoined.peerId).toMatch(PEER_ID_PATTERN);
    expect(replacementJoined.peerId).not.toBe(created.peerId);
    expect(replacementJoined.peerId).not.toBe(joined.peerId);
    expect(notification).toEqual({
      roomId: created.roomId,
      peerId: replacementJoined.peerId,
    });
  });

  test('deletes a one-peer room immediately when its creator leaves', async () => {
    const server = await startIsolatedServer();
    const peerA = await connectClient(server.baseUrl);
    const peerB = await connectClient(server.baseUrl);

    const created = await emitAndWait(peerA, 'room:create', {}, 'room:created');

    let peerLeftCount = 0;
    peerA.on('peer:left', () => {
      peerLeftCount += 1;
    });

    peerA.emit('room:leave', { roomId: created.roomId });
    const joinError = await emitAndWait(
      peerA,
      'room:join',
      { roomId: created.roomId },
      'room:error',
    );

    expect(joinError).toEqual({
      roomId: created.roomId,
      code: 'ROOM_NOT_FOUND',
      message: expect.any(String),
    });

    const otherJoinError = await emitAndWait(
      peerB,
      'room:join',
      { roomId: created.roomId },
      'room:error',
    );
    expect(otherJoinError.code).toBe('ROOM_NOT_FOUND');

    expect(peerLeftCount).toBe(0);
    expect(server.io.sockets.adapter.rooms.has(created.roomId)).toBe(false);
    expect(await fetchRoomsCount(server.baseUrl)).toBe(0);
  });

  test('deletes room immediately when final remaining peer leaves after first peer already left', async () => {
    const server = await startIsolatedServer();
    const { peerA, peerB, created } = await createTwoPeerRoom(server);

    let peerBLeftEvents = 0;
    peerB.on('peer:left', () => {
      peerBLeftEvents += 1;
    });

    const firstLeavePromise = waitForEvent(peerB, 'peer:left');
    peerA.emit('room:leave', { roomId: created.roomId });
    await firstLeavePromise;
    expect(peerBLeftEvents).toBe(1);
    expect(await fetchRoomsCount(server.baseUrl)).toBe(1);

    peerB.emit('room:leave', { roomId: created.roomId });
    const repeatedError = await emitAndWait(
      peerB,
      'room:leave',
      { roomId: created.roomId },
      'room:error',
    );

    expect(repeatedError).toEqual({
      roomId: created.roomId,
      code: 'ROOM_NOT_FOUND',
      message: expect.any(String),
    });
    expect(peerBLeftEvents).toBe(1);
    expect(server.io.sockets.adapter.rooms.has(created.roomId)).toBe(false);
    expect(await fetchRoomsCount(server.baseUrl)).toBe(0);
  });

  test('returns UNAUTHORIZED on repeated leave while room remains active', async () => {
    const server = await startIsolatedServer();
    const { peerA, peerB, created } = await createTwoPeerRoom(server);

    let peerALeftEvents = 0;
    peerA.on('peer:left', () => {
      peerALeftEvents += 1;
    });

    const firstLeavePromise = waitForEvent(peerA, 'peer:left');
    peerB.emit('room:leave', { roomId: created.roomId });
    await firstLeavePromise;

    const repeatedError = await emitAndWait(
      peerB,
      'room:leave',
      { roomId: created.roomId },
      'room:error',
    );

    expect(repeatedError).toEqual({
      roomId: created.roomId,
      code: 'UNAUTHORIZED',
      message: expect.any(String),
    });
    expect(peerALeftEvents).toBe(1);
    expect(await fetchRoomsCount(server.baseUrl)).toBe(1);
  });

  test('rejects leave requests from non-members without mutating active room', async () => {
    const server = await startIsolatedServer();
    const peerA = await connectClient(server.baseUrl);
    const outsider = await connectClient(server.baseUrl);
    const otherMember = await connectClient(server.baseUrl);

    const roomA = await emitAndWait(peerA, 'room:create', {}, 'room:created');
    const roomB = await emitAndWait(
      otherMember,
      'room:create',
      {},
      'room:created',
    );

    const outsiderError = await emitAndWait(
      outsider,
      'room:leave',
      { roomId: roomA.roomId },
      'room:error',
    );
    expect(outsiderError).toEqual({
      roomId: roomA.roomId,
      code: 'UNAUTHORIZED',
      message: expect.any(String),
    });

    const otherMemberError = await emitAndWait(
      otherMember,
      'room:leave',
      { roomId: roomA.roomId },
      'room:error',
    );
    expect(otherMemberError).toEqual({
      roomId: roomA.roomId,
      code: 'UNAUTHORIZED',
      message: expect.any(String),
    });

    expect(
      server.io.sockets.adapter.rooms.get(roomA.roomId)?.has(peerA.id),
    ).toBe(true);
    expect(
      server.io.sockets.adapter.rooms.get(roomB.roomId)?.has(otherMember.id),
    ).toBe(true);
    expect(await fetchRoomsCount(server.baseUrl)).toBe(2);
  });

  test('enforces documented error precedence on room:leave', async () => {
    const server = await startIsolatedServer();
    const peer = await connectClient(server.baseUrl);

    const invalidPayload = await emitAndWait(
      peer,
      'room:leave',
      { roomId: 'ship-83a1', extra: true },
      'room:error',
    );
    expect(invalidPayload).toEqual({
      roomId: 'ship-83a1',
      code: 'INVALID_PAYLOAD',
      message: expect.any(String),
    });

    const invalidRoomId = await emitAndWait(
      peer,
      'room:leave',
      { roomId: 'bad-id' },
      'room:error',
    );
    expect(invalidRoomId.code).toBe('INVALID_ROOM_ID');
    expect('roomId' in invalidRoomId).toBe(false);

    const roomNotFound = await emitAndWait(
      peer,
      'room:leave',
      { roomId: 'ship-9999' },
      'room:error',
    );
    expect(roomNotFound).toEqual({
      roomId: 'ship-9999',
      code: 'ROOM_NOT_FOUND',
      message: expect.any(String),
    });
  });
});
