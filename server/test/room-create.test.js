import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  PEER_ID_PATTERN,
  ROOM_ID_PATTERN,
  generatePeerId,
  validateRoomCreatePayload,
} from '../src/room-id.js';
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

function emitAndWait(socket, emitEvent, payload, responseEvent) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for ${responseEvent}`));
    }, 1_000);

    socket.once(responseEvent, (responsePayload) => {
      clearTimeout(timer);
      resolve(responsePayload);
    });
    socket.emit(emitEvent, payload);
  });
}

async function fetchRoomsCount(baseUrl) {
  const response = await fetch(`${baseUrl}/health`);
  const body = await response.json();
  return body.roomsCount;
}

afterEach(async () => {
  vi.restoreAllMocks();
  closeSocketClients(...clients);
  clients.clear();

  await Promise.all([...servers].map((server) => server.close()));
  servers.clear();
});

describe('peer ID generation and room:create payload validation', () => {
  test('generatePeerId produces opaque peer-[a-f0-9]{16} IDs without Math.random', () => {
    const mathRandomSpy = vi.spyOn(Math, 'random');
    const seen = new Set();

    for (let i = 0; i < 20; i += 1) {
      const peerId = generatePeerId();
      expect(peerId).toMatch(PEER_ID_PATTERN);
      seen.add(peerId);
    }

    expect(seen.size).toBe(20);
    expect(mathRandomSpy).not.toHaveBeenCalled();
  });

  test('generatePeerId requests 8 bytes from injected CSPRNG and formats hex', () => {
    const customRandomBytes = vi.fn(() =>
      Buffer.from([0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef]),
    );

    expect(generatePeerId(customRandomBytes)).toBe('peer-0123456789abcdef');
    expect(customRandomBytes).toHaveBeenCalledWith(8);
  });

  test('validateRoomCreatePayload accepts empty plain object', () => {
    expect(validateRoomCreatePayload({})).toEqual({ ok: true });
  });

  test.each([[null], [undefined], ['ship-83a1'], [[]], [123]])(
    'validateRoomCreatePayload rejects non-object payload %j with INVALID_PAYLOAD',
    (payload) => {
      const result = validateRoomCreatePayload(payload);
      expect(result.ok).toBe(false);
      expect(result.error.code).toBe('INVALID_PAYLOAD');
      expect(typeof result.error.message).toBe('string');
      expect('roomId' in result.error).toBe(false);
    },
  );

  test.each([{ roomId: 'ship-83a1' }, { extra: true }])(
    'validateRoomCreatePayload rejects unsupported fields %j with INVALID_PAYLOAD',
    (payload) => {
      const result = validateRoomCreatePayload(payload);
      expect(result.ok).toBe(false);
      expect(result.error.code).toBe('INVALID_PAYLOAD');
      expect(typeof result.error.message).toBe('string');
      expect('roomId' in result.error).toBe(false);
    },
  );
});

describe('Socket.IO room:create lifecycle', () => {
  test('creates an in-memory room, joins the Socket.IO room, and emits canonical room:created payload', async () => {
    const server = await startIsolatedServer();
    const client = await createSocketClient(server.baseUrl);
    clients.add(client);

    const created = await emitAndWait(client, 'room:create', {}, 'room:created');

    expect(Object.keys(created).sort()).toEqual([
      'negotiationDuty',
      'peerId',
      'roomId',
    ]);
    expect(created.roomId).toMatch(ROOM_ID_PATTERN);
    expect(created.peerId).toMatch(PEER_ID_PATTERN);
    expect(created.peerId).not.toBe(client.id);
    expect(created.negotiationDuty).toBe('offerer');

    const adapterRoom = server.io.sockets.adapter.rooms.get(created.roomId);
    expect(adapterRoom?.has(client.id)).toBe(true);
    expect(await fetchRoomsCount(server.baseUrl)).toBe(1);
  });

  test('allocates unique roomId and peerId values across multiple active rooms', async () => {
    const server = await startIsolatedServer();
    const roomIds = new Set();
    const peerIds = new Set();

    for (let i = 0; i < 5; i += 1) {
      const client = await createSocketClient(server.baseUrl);
      clients.add(client);

      const created = await emitAndWait(client, 'room:create', {}, 'room:created');
      roomIds.add(created.roomId);
      peerIds.add(created.peerId);
    }

    expect(roomIds.size).toBe(5);
    expect(peerIds.size).toBe(5);
    expect(await fetchRoomsCount(server.baseUrl)).toBe(5);
  });

  test('rejects duplicate room creation from a socket with an active room membership', async () => {
    const server = await startIsolatedServer();
    const client = await createSocketClient(server.baseUrl);
    clients.add(client);

    const created = await emitAndWait(client, 'room:create', {}, 'room:created');
    let unexpectedCreated = false;
    client.once('room:created', () => {
      unexpectedCreated = true;
    });

    const error = await emitAndWait(client, 'room:create', {}, 'room:error');

    expect(error).toEqual({
      code: 'UNAUTHORIZED',
      message: expect.any(String),
    });
    expect('roomId' in error).toBe(false);
    expect(unexpectedCreated).toBe(false);
    expect(await fetchRoomsCount(server.baseUrl)).toBe(1);
    expect(server.io.sockets.adapter.rooms.get(created.roomId)?.has(client.id)).toBe(
      true,
    );
  });

  test.each([
    [null],
    ['bad'],
    [[]],
    [{ extra: true }],
    [{ roomId: 'ship-83a1' }],
  ])(
    'rejects malformed room:create payload %j with INVALID_PAYLOAD without creating a room',
    async (payload) => {
      const server = await startIsolatedServer();
      const client = await createSocketClient(server.baseUrl);
      clients.add(client);

      const error = await emitAndWait(client, 'room:create', payload, 'room:error');

      expect(error).toEqual({
        code: 'INVALID_PAYLOAD',
        message: expect.any(String),
      });
      expect('roomId' in error).toBe(false);
      expect(await fetchRoomsCount(server.baseUrl)).toBe(0);
    },
  );

  test('applies payload validation before membership check on room:create', async () => {
    const server = await startIsolatedServer();
    const client = await createSocketClient(server.baseUrl);
    clients.add(client);

    const created = await emitAndWait(client, 'room:create', {}, 'room:created');
    const error = await emitAndWait(
      client,
      'room:create',
      { extra: true },
      'room:error',
    );

    expect(error).toEqual({
      code: 'INVALID_PAYLOAD',
      message: expect.any(String),
    });
    expect('roomId' in error).toBe(false);
    expect(await fetchRoomsCount(server.baseUrl)).toBe(1);
    expect(server.io.sockets.adapter.rooms.get(created.roomId)?.has(client.id)).toBe(
      true,
    );
  });
});
