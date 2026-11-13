import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  ROOM_ID_PATTERN,
  allocateUniqueRoomId,
  generateRoomId,
  isValidRoomId,
  validateRoomJoinPayload,
  validateSignalForwardPayload,
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

afterEach(async () => {
  vi.restoreAllMocks();
  closeSocketClients(...clients);
  clients.clear();

  await Promise.all([...servers].map((server) => server.close()));
  servers.clear();
});

describe('room ID generation and validation', () => {
  test('generateRoomId produces canonical ship-[a-f0-9]{4} IDs without Math.random', () => {
    const mathRandomSpy = vi.spyOn(Math, 'random');

    for (let i = 0; i < 20; i += 1) {
      expect(generateRoomId()).toMatch(ROOM_ID_PATTERN);
    }

    expect(mathRandomSpy).not.toHaveBeenCalled();
  });

  test('generateRoomId requests 2 bytes from injected CSPRNG and formats hex', () => {
    const customRandomBytes = vi.fn(() => Buffer.from([0x0a, 0xbc]));

    expect(generateRoomId(customRandomBytes)).toBe('ship-0abc');
    expect(customRandomBytes).toHaveBeenCalledWith(2);
  });

  test('allocateUniqueRoomId retries colliding IDs and returns the first unused ID', () => {
    const activeRooms = new Map([['ship-aaaa', {}], ['ship-bbbb', {}]]);
    const createId = vi
      .fn()
      .mockReturnValueOnce('ship-aaaa')
      .mockReturnValueOnce('ship-bbbb')
      .mockReturnValueOnce('ship-83a1');

    expect(allocateUniqueRoomId(activeRooms, createId)).toBe('ship-83a1');
    expect(createId).toHaveBeenCalledTimes(3);
  });

  test.each(['ship-0000', 'ship-83a1', 'ship-ffff'])(
    'isValidRoomId returns true for canonical ID %j',
    (roomId) => {
      expect(isValidRoomId(roomId)).toBe(true);
    },
  );

  test.each([
    undefined,
    null,
    123,
    '',
    'ship-123',
    'ship-12345',
    'ship-ABCD',
    'ship-zzzz',
    'room-83a1',
    'ship-83a1/../../etc',
    'ship-83a1; DROP TABLE rooms;',
  ])('isValidRoomId returns false for malformed value %j', (roomId) => {
    expect(isValidRoomId(roomId)).toBe(false);
  });
});

describe('payload validation', () => {
  test.each([null, undefined, 'ship-83a1', []])(
    'validateRoomJoinPayload rejects non-object payload %j with INVALID_PAYLOAD',
    (payload) => {
      const result = validateRoomJoinPayload(payload);
      expect(result.ok).toBe(false);
      expect(result.error.code).toBe('INVALID_PAYLOAD');
      expect(result.error.roomId).toBeUndefined();
    },
  );

  test.each([
    { room_id: 'ship-83a1' },
    { roomId: 'ship-83a1', extra: true },
  ])(
    'validateRoomJoinPayload rejects unsupported top-level fields %j with INVALID_PAYLOAD',
    (payload) => {
      const result = validateRoomJoinPayload(payload);
      expect(result.ok).toBe(false);
      expect(result.error.code).toBe('INVALID_PAYLOAD');
    },
  );

  test.each([
    {},
    { roomId: '' },
    { roomId: 123 },
    { roomId: 'ship-XYZ' },
    { roomId: 'ship-12345' },
  ])(
    'validateRoomJoinPayload rejects invalid roomId %j with INVALID_ROOM_ID and no roomId',
    (payload) => {
      const result = validateRoomJoinPayload(payload);
      expect(result.ok).toBe(false);
      expect(result.error.code).toBe('INVALID_ROOM_ID');
      expect('roomId' in result.error).toBe(false);
    },
  );

  test.each([
    null,
    undefined,
    'ship-83a1',
    [],
    { room_id: 'ship-83a1', signalData: { type: 'offer' } },
    { roomId: 'ship-83a1', signalData: { type: 'offer' }, extra: true },
  ])(
    'validateSignalForwardPayload rejects malformed envelope %j with INVALID_PAYLOAD',
    (payload) => {
      const result = validateSignalForwardPayload(payload);
      expect(result.ok).toBe(false);
      expect(result.error.code).toBe('INVALID_PAYLOAD');
    },
  );

  test('validateSignalForwardPayload rejects missing or non-object signalData with INVALID_PAYLOAD', () => {
    for (const payload of [
      { roomId: 'ship-83a1' },
      { roomId: 'ship-83a1', signalData: null },
      { roomId: 'ship-83a1', signalData: 'sdp' },
    ]) {
      const result = validateSignalForwardPayload(payload);
      expect(result.ok).toBe(false);
      expect(result.error.code).toBe('INVALID_PAYLOAD');
      expect(result.error.roomId).toBe('ship-83a1');
    }

    const invalidRoomAndSignal = validateSignalForwardPayload({
      roomId: 'bad-id',
      signalData: 'sdp',
    });
    expect(invalidRoomAndSignal.ok).toBe(false);
    expect(invalidRoomAndSignal.error.code).toBe('INVALID_PAYLOAD');
    expect('roomId' in invalidRoomAndSignal.error).toBe(false);
  });

  test('validateSignalForwardPayload rejects invalid roomId with INVALID_ROOM_ID', () => {
    const result = validateSignalForwardPayload({
      roomId: 'ship-ZZZZ',
      signalData: { type: 'offer' },
    });
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('INVALID_ROOM_ID');
    expect('roomId' in result.error).toBe(false);
  });
});

describe('Socket.IO room ID and payload validation integration', () => {
  test('room:create emits a canonical ship-[a-f0-9]{4} roomId', async () => {
    const server = await startIsolatedServer();
    const client = await createSocketClient(server.baseUrl);
    clients.add(client);

    const created = await emitAndWait(client, 'room:create', {}, 'room:created');
    expect(created.roomId).toMatch(ROOM_ID_PATTERN);
  });

  test.each([
    '',
    'ship-XYZ',
    'ship-12345',
    123,
    'ship-83a1/../../etc',
    'ship-83a1; DROP TABLE rooms;',
  ])(
    'room:join rejects malformed roomId %j with INVALID_ROOM_ID',
    async (roomId) => {
      const server = await startIsolatedServer();
      const client = await createSocketClient(server.baseUrl);
      clients.add(client);

      const error = await emitAndWait(
        client,
        'room:join',
        { roomId },
        'room:error',
      );
      expect(error.code).toBe('INVALID_ROOM_ID');
      expect('roomId' in error).toBe(false);
    },
  );

  test.each([null, 'ship-83a1', { room_id: 'ship-83a1' }])(
    'room:join rejects invalid payload %j with INVALID_PAYLOAD',
    async (payload) => {
      const server = await startIsolatedServer();
      const client = await createSocketClient(server.baseUrl);
      clients.add(client);

      const error = await emitAndWait(client, 'room:join', payload, 'room:error');
      expect(error.code).toBe('INVALID_PAYLOAD');
    },
  );

  test('signal:forward rejects malformed roomId and missing/non-object signalData', async () => {
    const server = await startIsolatedServer();
    const client = await createSocketClient(server.baseUrl);
    clients.add(client);

    const invalidRoomError = await emitAndWait(
      client,
      'signal:forward',
      { roomId: 'ship-ZZZZ', signalData: { type: 'offer' } },
      'room:error',
    );
    expect(invalidRoomError.code).toBe('INVALID_ROOM_ID');
    expect('roomId' in invalidRoomError).toBe(false);

    const invalidSignalError = await emitAndWait(
      client,
      'signal:forward',
      { roomId: 'ship-83a1', signalData: 'raw-sdp' },
      'room:error',
    );
    expect(invalidSignalError.code).toBe('INVALID_PAYLOAD');
    expect(invalidSignalError.roomId).toBe('ship-83a1');
  });
});
