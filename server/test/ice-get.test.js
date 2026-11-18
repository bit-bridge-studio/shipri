import { afterEach, describe, expect, test } from 'vitest';
import {
  DEFAULT_STUN_URLS,
  resolveDevelopmentIceServers,
} from '../src/config.js';
import { validateIceGetPayload } from '../src/room-id.js';
import { createSignalingServer } from '../src/server.js';
import {
  closeSocketClients,
  createSocketClient,
} from './helpers/socket-client.js';

const clients = new Set();
const servers = new Set();

async function startIsolatedServer(options) {
  const server = createSignalingServer(options);
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

function settle(ms = 40) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

afterEach(async () => {
  closeSocketClients(...clients);
  clients.clear();

  await Promise.all([...servers].map((server) => server.close()));
  servers.clear();
});

describe('ICE payload validation and development STUN resolver', () => {
  test('validateIceGetPayload accepts canonical roomId object', () => {
    expect(validateIceGetPayload({ roomId: 'ship-83a1' })).toEqual({
      ok: true,
      roomId: 'ship-83a1',
    });
  });

  test.each([[null], [undefined], ['ship-83a1'], [[]], [123]])(
    'validateIceGetPayload rejects non-object payload %j with INVALID_PAYLOAD and no roomId',
    (payload) => {
      const result = validateIceGetPayload(payload);
      expect(result.ok).toBe(false);
      expect(result.error.code).toBe('INVALID_PAYLOAD');
      expect('roomId' in result.error).toBe(false);
    },
  );

  test('validateIceGetPayload rejects unsupported fields with INVALID_PAYLOAD and preserves valid roomId only', () => {
    const legacyFieldResult = validateIceGetPayload({ room_id: 'ship-83a1' });
    expect(legacyFieldResult.ok).toBe(false);
    expect(legacyFieldResult.error.code).toBe('INVALID_PAYLOAD');
    expect('roomId' in legacyFieldResult.error).toBe(false);

    const extraFieldResult = validateIceGetPayload({
      roomId: 'ship-83a1',
      extra: true,
    });
    expect(extraFieldResult.ok).toBe(false);
    expect(extraFieldResult.error).toEqual({
      roomId: 'ship-83a1',
      code: 'INVALID_PAYLOAD',
      message: expect.any(String),
    });
  });

  test.each([
    {},
    { roomId: '' },
    { roomId: 'bad-id' },
    { roomId: 123 },
    { roomId: 'ship-ZZZZ' },
  ])(
    'validateIceGetPayload rejects invalid roomId %j with INVALID_ROOM_ID and no roomId',
    (payload) => {
      const result = validateIceGetPayload(payload);
      expect(result.ok).toBe(false);
      expect(result.error.code).toBe('INVALID_ROOM_ID');
      expect('roomId' in result.error).toBe(false);
    },
  );

  test('resolveDevelopmentIceServers builds STUN-only iceServers for valid endpoints', () => {
    expect(resolveDevelopmentIceServers(DEFAULT_STUN_URLS)).toEqual({
      ok: true,
      iceServers: [
        {
          urls: [
            'stun:stun.l.google.com:19302',
            'stun:stun1.l.google.com:19302',
          ],
        },
      ],
    });
  });

  test.each([
    [undefined],
    [null],
    [[]],
    [['']],
    [[123]],
    [['turn:turn.shipri.app:3478']],
    [['turns:turn.shipri.app:443']],
    [['stun:stun.l.google.com:19302', 'turn:turn.shipri.app:3478']],
    [['http://stun.l.google.com:19302']],
  ])(
    'resolveDevelopmentIceServers rejects invalid or non-STUN entries %j',
    (stunUrls) => {
      expect(resolveDevelopmentIceServers(stunUrls)).toEqual({ ok: false });
    },
  );
});

describe('Socket.IO ice:get development ICE response', () => {
  test('returns STUN-only ice:credentials for waiting creator, both connected peers, and replacement peers', async () => {
    const server = await startIsolatedServer();
    const peerA = await connectClient(server.baseUrl);
    const peerB = await connectClient(server.baseUrl);
    const peerC = await connectClient(server.baseUrl);

    const created = await emitAndWait(peerA, 'room:create', {}, 'room:created');

    const waitingIce = await emitAndWait(
      peerA,
      'ice:get',
      { roomId: created.roomId },
      'ice:credentials',
    );
    expect(Object.keys(waitingIce).sort()).toEqual(['iceServers', 'roomId']);
    expect(waitingIce).toEqual({
      roomId: created.roomId,
      iceServers: [{ urls: [...DEFAULT_STUN_URLS] }],
    });

    const peerBJoined = waitForEvent(peerB, 'room:joined');
    const peerANotifiedJoin = waitForEvent(peerA, 'peer:joined');
    peerB.emit('room:join', { roomId: created.roomId });
    await Promise.all([peerBJoined, peerANotifiedJoin]);

    let peerAReceivedDuringB = 0;
    peerA.on('ice:credentials', () => {
      peerAReceivedDuringB += 1;
    });

    const peerBIce = await emitAndWait(
      peerB,
      'ice:get',
      { roomId: created.roomId },
      'ice:credentials',
    );
    expect(peerBIce).toEqual({
      roomId: created.roomId,
      iceServers: [{ urls: [...DEFAULT_STUN_URLS] }],
    });
    await settle();
    expect(peerAReceivedDuringB).toBe(0);

    peerA.removeAllListeners('ice:credentials');
    let peerBReceivedDuringA = 0;
    peerB.on('ice:credentials', () => {
      peerBReceivedDuringA += 1;
    });

    const peerAIce = await emitAndWait(
      peerA,
      'ice:get',
      { roomId: created.roomId },
      'ice:credentials',
    );
    expect(peerAIce).toEqual({
      roomId: created.roomId,
      iceServers: [{ urls: [...DEFAULT_STUN_URLS] }],
    });
    await settle();
    expect(peerBReceivedDuringA).toBe(0);

    const serialized = JSON.stringify(peerAIce);
    expect(serialized).not.toContain('turn:');
    expect(serialized).not.toContain('turns:');
    expect(serialized).not.toContain('username');
    expect(serialized).not.toContain('credential');
    expect(serialized).not.toContain('credentialType');
    expect(serialized).not.toContain('TURN_SHARED_SECRET');

    const peerLeft = waitForEvent(peerA, 'peer:left');
    peerB.emit('room:leave', { roomId: created.roomId });
    await peerLeft;

    const peerCJoined = waitForEvent(peerC, 'room:joined');
    const peerANotifiedC = waitForEvent(peerA, 'peer:joined');
    peerC.emit('room:join', { roomId: created.roomId });
    await Promise.all([peerCJoined, peerANotifiedC]);

    const peerCIce = await emitAndWait(
      peerC,
      'ice:get',
      { roomId: created.roomId },
      'ice:credentials',
    );
    expect(peerCIce).toEqual({
      roomId: created.roomId,
      iceServers: [{ urls: [...DEFAULT_STUN_URLS] }],
    });

    const departedIceError = await emitAndWait(
      peerB,
      'ice:get',
      { roomId: created.roomId },
      'room:error',
    );
    expect(departedIceError).toEqual({
      roomId: created.roomId,
      code: 'UNAUTHORIZED',
      message: expect.any(String),
    });
  });

  test('returns configured custom STUN endpoints with no TURN credentials', async () => {
    const server = await startIsolatedServer({
      stunUrls: ['stun:stun.example.org:3478', 'stuns:stun.example.org:5349'],
    });
    const peerA = await connectClient(server.baseUrl);
    const created = await emitAndWait(peerA, 'room:create', {}, 'room:created');

    const credentials = await emitAndWait(
      peerA,
      'ice:get',
      { roomId: created.roomId },
      'ice:credentials',
    );

    expect(credentials).toEqual({
      roomId: created.roomId,
      iceServers: [
        {
          urls: ['stun:stun.example.org:3478', 'stuns:stun.example.org:5349'],
        },
      ],
    });
    for (const entry of credentials.iceServers) {
      expect(Object.keys(entry)).toEqual(['urls']);
    }
  });

  test('rejects unauthorized sockets, unknown rooms, and malformed payloads without mutating state', async () => {
    const server = await startIsolatedServer();
    const roomA = await createTwoPeerRoom(server);
    const roomB = await createTwoPeerRoom(server);
    const outsider = await connectClient(server.baseUrl);
    const unusedRoomId =
      roomA.created.roomId === 'ship-0000' ? 'ship-0001' : 'ship-0000';

    const initialSnapshot = snapshotServerState(server);

    const outsiderError = await emitAndWait(
      outsider,
      'ice:get',
      { roomId: roomA.created.roomId },
      'room:error',
    );
    expect(outsiderError).toEqual({
      roomId: roomA.created.roomId,
      code: 'UNAUTHORIZED',
      message: expect.any(String),
    });

    const crossRoomError = await emitAndWait(
      roomB.peerA,
      'ice:get',
      { roomId: roomA.created.roomId },
      'room:error',
    );
    expect(crossRoomError).toEqual({
      roomId: roomA.created.roomId,
      code: 'UNAUTHORIZED',
      message: expect.any(String),
    });

    const unknownRoomError = await emitAndWait(
      roomA.peerA,
      'ice:get',
      { roomId: unusedRoomId },
      'room:error',
    );
    expect(unknownRoomError).toEqual({
      roomId: unusedRoomId,
      code: 'ROOM_NOT_FOUND',
      message: expect.any(String),
    });

    for (const payload of [
      null,
      undefined,
      'ship-83a1',
      [],
      123,
      { room_id: roomA.created.roomId },
      { roomId: roomA.created.roomId, extra: true },
    ]) {
      const error = await emitAndWait(
        roomA.peerA,
        'ice:get',
        payload,
        'room:error',
      );
      expect(error.code).toBe('INVALID_PAYLOAD');
    }

    for (const payload of [
      {},
      { roomId: '' },
      { roomId: 'bad-id' },
      { roomId: 123 },
      { roomId: 'ship-ZZZZ' },
    ]) {
      const error = await emitAndWait(
        roomA.peerA,
        'ice:get',
        payload,
        'room:error',
      );
      expect(error.code).toBe('INVALID_ROOM_ID');
      expect('roomId' in error).toBe(false);
    }

    expect(snapshotServerState(server)).toEqual(initialSnapshot);

    const tempCreator = await connectClient(server.baseUrl);
    const deletedRoom = await emitAndWait(
      tempCreator,
      'room:create',
      {},
      'room:created',
    );
    tempCreator.emit('room:leave', { roomId: deletedRoom.roomId });
    await settle();

    const deletedRoomError = await emitAndWait(
      outsider,
      'ice:get',
      { roomId: deletedRoom.roomId },
      'room:error',
    );
    expect(deletedRoomError).toEqual({
      roomId: deletedRoom.roomId,
      code: 'ROOM_NOT_FOUND',
      message: expect.any(String),
    });
  });

  test.each([
    { label: 'empty stunUrls array', options: { stunUrls: [] } },
    {
      label: 'TURN URL instead of STUN',
      options: { stunUrls: ['turn:turn.shipri.app:3478'] },
    },
    { label: 'blank STUN_URLS env string', options: { env: { STUN_URLS: '' } } },
  ])(
    'returns SERVER_BUSY when ICE configuration is invalid ($label)',
    async ({ options }) => {
      const server = await startIsolatedServer(options);
      const creator = await connectClient(server.baseUrl);
      const created = await emitAndWait(
        creator,
        'room:create',
        {},
        'room:created',
      );

      let receivedCredentials = 0;
      creator.on('ice:credentials', () => {
        receivedCredentials += 1;
      });

      const error = await emitAndWait(
        creator,
        'ice:get',
        { roomId: created.roomId },
        'room:error',
      );
      await settle();

      expect(receivedCredentials).toBe(0);
      expect(error).toEqual({
        roomId: created.roomId,
        code: 'SERVER_BUSY',
        message: expect.any(String),
      });
    },
  );

  test('enforces documented error precedence on ice:get even when ICE config is invalid', async () => {
    const server = await startIsolatedServer({ stunUrls: [] });
    const creator = await connectClient(server.baseUrl);
    const outsider = await connectClient(server.baseUrl);

    const created = await emitAndWait(
      creator,
      'room:create',
      {},
      'room:created',
    );
    const unusedRoomId =
      created.roomId === 'ship-0000' ? 'ship-0001' : 'ship-0000';

    const extraOverInvalidRoomId = await emitAndWait(
      outsider,
      'ice:get',
      { roomId: 'bad-id', extra: true },
      'room:error',
    );
    expect(extraOverInvalidRoomId.code).toBe('INVALID_PAYLOAD');
    expect('roomId' in extraOverInvalidRoomId).toBe(false);

    const payloadOverNotFoundAndBusy = await emitAndWait(
      creator,
      'ice:get',
      { roomId: unusedRoomId, extra: true },
      'room:error',
    );
    expect(payloadOverNotFoundAndBusy).toEqual({
      roomId: unusedRoomId,
      code: 'INVALID_PAYLOAD',
      message: expect.any(String),
    });

    const invalidRoomOverNotFoundAndBusy = await emitAndWait(
      outsider,
      'ice:get',
      { roomId: 'bad-id' },
      'room:error',
    );
    expect(invalidRoomOverNotFoundAndBusy.code).toBe('INVALID_ROOM_ID');
    expect('roomId' in invalidRoomOverNotFoundAndBusy).toBe(false);

    const notFoundOverUnauthorizedAndBusy = await emitAndWait(
      outsider,
      'ice:get',
      { roomId: unusedRoomId },
      'room:error',
    );
    expect(notFoundOverUnauthorizedAndBusy).toEqual({
      roomId: unusedRoomId,
      code: 'ROOM_NOT_FOUND',
      message: expect.any(String),
    });

    const unauthorizedOverBusy = await emitAndWait(
      outsider,
      'ice:get',
      { roomId: created.roomId },
      'room:error',
    );
    expect(unauthorizedOverBusy).toEqual({
      roomId: created.roomId,
      code: 'UNAUTHORIZED',
      message: expect.any(String),
    });

    const busyError = await emitAndWait(
      creator,
      'ice:get',
      { roomId: created.roomId },
      'room:error',
    );
    expect(busyError).toEqual({
      roomId: created.roomId,
      code: 'SERVER_BUSY',
      message: expect.any(String),
    });
  });
});
