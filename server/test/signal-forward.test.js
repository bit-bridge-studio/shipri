import { afterEach, describe, expect, test, vi } from 'vitest';
import { validateSignalForwardPayload } from '../src/room-id.js';
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
  vi.restoreAllMocks();
  closeSocketClients(...clients);
  clients.clear();

  await Promise.all([...servers].map((server) => server.close()));
  servers.clear();
});

describe('validateSignalForwardPayload opaque signalData guarantee', () => {
  test('validates envelope without reading, enumerating, or mutating inner signalData properties', () => {
    const opaqueSignal = {
      type: 'offer',
      sdp: 'v=0\r\no=- 123456 2 IN IP4 127.0.0.1\r\n',
    };
    const strictProxy = new Proxy(opaqueSignal, {
      get() {
        throw new Error('Unexpected read of signalData property');
      },
      has() {
        throw new Error('Unexpected existence check on signalData property');
      },
      ownKeys() {
        throw new Error('Unexpected enumeration of signalData keys');
      },
      getOwnPropertyDescriptor() {
        throw new Error('Unexpected descriptor lookup on signalData');
      },
      set() {
        throw new Error('Unexpected mutation of signalData');
      },
      deleteProperty() {
        throw new Error('Unexpected deletion on signalData');
      },
    });

    const result = validateSignalForwardPayload({
      roomId: 'ship-83a1',
      signalData: strictProxy,
    });

    expect(result.ok).toBe(true);
    expect(result.roomId).toBe('ship-83a1');
    expect(result.signalData).toBe(strictProxy);
  });
});

describe('Socket.IO signal:forward relay authorization and error handling', () => {
  test('relays signals bidirectionally between active room members with canonical sender peerId', async () => {
    const server = await startIsolatedServer();
    const { peerA, peerB, created, joined } = await createTwoPeerRoom(server);

    const receivedByA = [];
    const receivedByB = [];
    const errors = [];

    peerA.on('signal:receive', (payload) => receivedByA.push(payload));
    peerB.on('signal:receive', (payload) => receivedByB.push(payload));
    peerA.on('room:error', (error) => errors.push(error));
    peerB.on('room:error', (error) => errors.push(error));

    const offerSignal = {
      type: 'offer',
      sdp: 'v=0\r\no=- 1001 2 IN IP4 127.0.0.1\r\n',
    };
    const offerReceivePromise = waitForEvent(peerB, 'signal:receive');
    peerA.emit('signal:forward', {
      roomId: created.roomId,
      signalData: offerSignal,
    });
    const offerReceived = await offerReceivePromise;

    expect(Object.keys(offerReceived).sort()).toEqual([
      'peerId',
      'roomId',
      'signalData',
    ]);
    expect(offerReceived).toEqual({
      roomId: created.roomId,
      peerId: created.peerId,
      signalData: offerSignal,
    });

    const answerSignal = {
      type: 'answer',
      sdp: 'v=0\r\no=- 1002 2 IN IP4 127.0.0.1\r\n',
    };
    const answerReceivePromise = waitForEvent(peerA, 'signal:receive');
    peerB.emit('signal:forward', {
      roomId: created.roomId,
      signalData: answerSignal,
    });
    const answerReceived = await answerReceivePromise;

    expect(Object.keys(answerReceived).sort()).toEqual([
      'peerId',
      'roomId',
      'signalData',
    ]);
    expect(answerReceived).toEqual({
      roomId: created.roomId,
      peerId: joined.peerId,
      signalData: answerSignal,
    });

    const iceFromA = {
      candidate: {
        candidate: 'candidate:1 1 udp 2122260223 192.0.2.1 5000 typ host',
        sdpMid: '0',
        sdpMLineIndex: 0,
      },
    };
    const iceBPromise = waitForEvent(peerB, 'signal:receive');
    peerA.emit('signal:forward', {
      roomId: created.roomId,
      signalData: iceFromA,
    });
    expect(await iceBPromise).toEqual({
      roomId: created.roomId,
      peerId: created.peerId,
      signalData: iceFromA,
    });

    const iceFromB = {
      candidate: {
        candidate: 'candidate:2 1 udp 2122260223 198.51.100.2 5001 typ host',
        sdpMid: '0',
        sdpMLineIndex: 0,
      },
    };
    const iceAPromise = waitForEvent(peerA, 'signal:receive');
    peerB.emit('signal:forward', {
      roomId: created.roomId,
      signalData: iceFromB,
    });
    expect(await iceAPromise).toEqual({
      roomId: created.roomId,
      peerId: joined.peerId,
      signalData: iceFromB,
    });

    await settle();
    expect(errors).toEqual([]);
    expect(receivedByB).toEqual([
      { roomId: created.roomId, peerId: created.peerId, signalData: offerSignal },
      { roomId: created.roomId, peerId: created.peerId, signalData: iceFromA },
    ]);
    expect(receivedByA).toEqual([
      {
        roomId: created.roomId,
        peerId: joined.peerId,
        signalData: answerSignal,
      },
      { roomId: created.roomId, peerId: joined.peerId, signalData: iceFromB },
    ]);
  });

  test('relays signals bidirectionally after replacement joins following leave and disconnect', async () => {
    const server = await startIsolatedServer();
    const { peerA, peerB, created } = await createTwoPeerRoom(server);
    const peerC = await connectClient(server.baseUrl);
    const peerD = await connectClient(server.baseUrl);

    let peerBReceivedSignals = 0;
    peerB.on('signal:receive', () => {
      peerBReceivedSignals += 1;
    });

    const peerLeftOnLeave = waitForEvent(peerA, 'peer:left');
    peerB.emit('room:leave', { roomId: created.roomId });
    await peerLeftOnLeave;

    const peerCJoinedPromise = waitForEvent(peerC, 'room:joined');
    const peerANotifiedC = waitForEvent(peerA, 'peer:joined');
    peerC.emit('room:join', { roomId: created.roomId });
    const [joinedC] = await Promise.all([peerCJoinedPromise, peerANotifiedC]);

    const signalAtoC = { type: 'offer', seq: 1 };
    const receiveC = waitForEvent(peerC, 'signal:receive');
    peerA.emit('signal:forward', {
      roomId: created.roomId,
      signalData: signalAtoC,
    });
    expect(await receiveC).toEqual({
      roomId: created.roomId,
      peerId: created.peerId,
      signalData: signalAtoC,
    });

    const signalCtoA = { type: 'answer', seq: 2 };
    const receiveA = waitForEvent(peerA, 'signal:receive');
    peerC.emit('signal:forward', {
      roomId: created.roomId,
      signalData: signalCtoA,
    });
    expect(await receiveA).toEqual({
      roomId: created.roomId,
      peerId: joinedC.peerId,
      signalData: signalCtoA,
    });

    const peerCNotifiedDisconnect = waitForEvent(peerC, 'peer:left');
    peerA.disconnect();
    await peerCNotifiedDisconnect;

    const peerDJoinedPromise = waitForEvent(peerD, 'room:joined');
    const peerCNotifiedD = waitForEvent(peerC, 'peer:joined');
    peerD.emit('room:join', { roomId: created.roomId });
    const [joinedD] = await Promise.all([peerDJoinedPromise, peerCNotifiedD]);

    const signalCtoD = { type: 'offer', seq: 3 };
    const receiveD = waitForEvent(peerD, 'signal:receive');
    peerC.emit('signal:forward', {
      roomId: created.roomId,
      signalData: signalCtoD,
    });
    expect(await receiveD).toEqual({
      roomId: created.roomId,
      peerId: joinedC.peerId,
      signalData: signalCtoD,
    });

    const signalDtoC = { type: 'answer', seq: 4 };
    const receiveC2 = waitForEvent(peerC, 'signal:receive');
    peerD.emit('signal:forward', {
      roomId: created.roomId,
      signalData: signalDtoC,
    });
    expect(await receiveC2).toEqual({
      roomId: created.roomId,
      peerId: joinedD.peerId,
      signalData: signalDtoC,
    });

    await settle();
    expect(peerBReceivedSignals).toBe(0);
  });

  test('isolates signaling relay across active rooms and unaffiliated sockets without logging signalData', async () => {
    const server = await startIsolatedServer();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const room1 = await createTwoPeerRoom(server);
    const room2 = await createTwoPeerRoom(server);
    const outsider = await connectClient(server.baseUrl);

    const leakedSignals = [];
    for (const nonTarget of [room1.peerA, room2.peerA, room2.peerB, outsider]) {
      nonTarget.on('signal:receive', (payload) => leakedSignals.push(payload));
    }

    const nestedSignalData = {
      type: 'offer',
      sdp: 'v=0\r\no=- 4611731400430051336 2 IN IP4 127.0.0.1\r\n',
      nested: {
        candidate: { sdpMid: '0', sdpMLineIndex: 0 },
        flags: [true, 42, 'relay-secret-marker'],
      },
    };

    const deliveredPromise = waitForEvent(room1.peerB, 'signal:receive');
    room1.peerA.emit('signal:forward', {
      roomId: room1.created.roomId,
      signalData: nestedSignalData,
    });
    const delivered = await deliveredPromise;

    await settle();

    expect(delivered).toEqual({
      roomId: room1.created.roomId,
      peerId: room1.created.peerId,
      signalData: nestedSignalData,
    });
    expect(leakedSignals).toEqual([]);

    const serializedLogs = [logSpy, infoSpy, warnSpy, errorSpy]
      .flatMap((spy) => spy.mock.calls)
      .map((args) => JSON.stringify(args))
      .join('\n');
    expect(serializedLogs).not.toContain('relay-secret-marker');
    expect(serializedLogs).not.toContain('4611731400430051336');
    expect(serializedLogs).not.toContain('signalData');
  });

  test('rejects unauthorized senders without relaying signals or mutating room state', async () => {
    const server = await startIsolatedServer();
    const roomA = await createTwoPeerRoom(server);
    const roomB = await createTwoPeerRoom(server);
    const outsider = await connectClient(server.baseUrl);

    const relayedInRoomA = [];
    roomA.peerA.on('signal:receive', (payload) => relayedInRoomA.push(payload));
    roomA.peerB.on('signal:receive', (payload) => relayedInRoomA.push(payload));

    const twoPeerSnapshot = snapshotServerState(server);

    const outsiderError = await emitAndWait(
      outsider,
      'signal:forward',
      { roomId: roomA.created.roomId, signalData: { type: 'offer' } },
      'room:error',
    );
    expect(outsiderError).toEqual({
      roomId: roomA.created.roomId,
      code: 'UNAUTHORIZED',
      message: expect.any(String),
    });

    const crossRoomError = await emitAndWait(
      roomB.peerA,
      'signal:forward',
      { roomId: roomA.created.roomId, signalData: { type: 'offer' } },
      'room:error',
    );
    expect(crossRoomError).toEqual({
      roomId: roomA.created.roomId,
      code: 'UNAUTHORIZED',
      message: expect.any(String),
    });

    await settle();
    expect(relayedInRoomA).toEqual([]);
    expect(snapshotServerState(server)).toEqual(twoPeerSnapshot);

    const peerLeftPromise = waitForEvent(roomA.peerA, 'peer:left');
    roomA.peerB.emit('room:leave', { roomId: roomA.created.roomId });
    await peerLeftPromise;

    const afterLeaveSnapshot = snapshotServerState(server);
    const formerPeerError = await emitAndWait(
      roomA.peerB,
      'signal:forward',
      { roomId: roomA.created.roomId, signalData: { type: 'offer' } },
      'room:error',
    );
    expect(formerPeerError).toEqual({
      roomId: roomA.created.roomId,
      code: 'UNAUTHORIZED',
      message: expect.any(String),
    });

    await settle();
    expect(relayedInRoomA).toEqual([]);
    expect(snapshotServerState(server)).toEqual(afterLeaveSnapshot);
  });

  test('returns PEER_UNAVAILABLE when an active member signals without a second peer', async () => {
    const server = await startIsolatedServer();
    const peerA = await connectClient(server.baseUrl);
    const peerB = await connectClient(server.baseUrl);
    const peerC = await connectClient(server.baseUrl);

    const created = await emitAndWait(peerA, 'room:create', {}, 'room:created');

    const initialWaitingError = await emitAndWait(
      peerA,
      'signal:forward',
      { roomId: created.roomId, signalData: { type: 'offer' } },
      'room:error',
    );
    expect(initialWaitingError).toEqual({
      roomId: created.roomId,
      code: 'PEER_UNAVAILABLE',
      message: expect.any(String),
    });

    const peerBJoined = waitForEvent(peerB, 'room:joined');
    const peerANotifiedB = waitForEvent(peerA, 'peer:joined');
    peerB.emit('room:join', { roomId: created.roomId });
    await Promise.all([peerBJoined, peerANotifiedB]);

    const peerLeftOnLeave = waitForEvent(peerA, 'peer:left');
    peerB.emit('room:leave', { roomId: created.roomId });
    await peerLeftOnLeave;

    const afterLeaveWaitingError = await emitAndWait(
      peerA,
      'signal:forward',
      { roomId: created.roomId, signalData: { type: 'offer' } },
      'room:error',
    );
    expect(afterLeaveWaitingError).toEqual({
      roomId: created.roomId,
      code: 'PEER_UNAVAILABLE',
      message: expect.any(String),
    });

    const peerCJoined = waitForEvent(peerC, 'room:joined');
    const peerANotifiedC = waitForEvent(peerA, 'peer:joined');
    peerC.emit('room:join', { roomId: created.roomId });
    await Promise.all([peerCJoined, peerANotifiedC]);

    const peerLeftOnDisconnect = waitForEvent(peerC, 'peer:left');
    peerA.disconnect();
    await peerLeftOnDisconnect;

    const afterDisconnectWaitingError = await emitAndWait(
      peerC,
      'signal:forward',
      { roomId: created.roomId, signalData: { type: 'offer' } },
      'room:error',
    );
    expect(afterDisconnectWaitingError).toEqual({
      roomId: created.roomId,
      code: 'PEER_UNAVAILABLE',
      message: expect.any(String),
    });
  });

  test('rejects unknown rooms, deleted rooms, and malformed payloads without mutating state', async () => {
    const server = await startIsolatedServer();
    const { peerA, created } = await createTwoPeerRoom(server);
    const outsider = await connectClient(server.baseUrl);
    const unusedRoomId =
      created.roomId === 'ship-0000' ? 'ship-0001' : 'ship-0000';

    const initialSnapshot = snapshotServerState(server);

    const unknownRoomError = await emitAndWait(
      outsider,
      'signal:forward',
      { roomId: unusedRoomId, signalData: { type: 'offer' } },
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
      { room_id: created.roomId, signalData: { type: 'offer' } },
      { roomId: created.roomId, signalData: { type: 'offer' }, extra: true },
    ]) {
      const error = await emitAndWait(
        peerA,
        'signal:forward',
        payload,
        'room:error',
      );
      expect(error.code).toBe('INVALID_PAYLOAD');
    }

    for (const signalData of [undefined, null, 'raw-sdp', [], 123]) {
      const error = await emitAndWait(
        peerA,
        'signal:forward',
        { roomId: created.roomId, signalData },
        'room:error',
      );
      expect(error).toEqual({
        roomId: created.roomId,
        code: 'INVALID_PAYLOAD',
        message: expect.any(String),
      });
    }

    for (const invalidRoomId of ['', 'bad-id', 123, 'ship-ZZZZ']) {
      const error = await emitAndWait(
        peerA,
        'signal:forward',
        { roomId: invalidRoomId, signalData: { type: 'offer' } },
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
      'signal:forward',
      { roomId: deletedRoom.roomId, signalData: { type: 'offer' } },
      'room:error',
    );
    expect(deletedRoomError).toEqual({
      roomId: deletedRoom.roomId,
      code: 'ROOM_NOT_FOUND',
      message: expect.any(String),
    });
  });

  test('enforces documented error precedence on signal:forward', async () => {
    const server = await startIsolatedServer();
    const creator = await connectClient(server.baseUrl);
    const outsider = await connectClient(server.baseUrl);

    const waitingRoom = await emitAndWait(
      creator,
      'room:create',
      {},
      'room:created',
    );
    const unusedRoomId =
      waitingRoom.roomId === 'ship-0000' ? 'ship-0001' : 'ship-0000';

    const payloadOverInvalidRoomId = await emitAndWait(
      outsider,
      'signal:forward',
      { roomId: 'bad-id', signalData: null },
      'room:error',
    );
    expect(payloadOverInvalidRoomId.code).toBe('INVALID_PAYLOAD');
    expect('roomId' in payloadOverInvalidRoomId).toBe(false);

    const extraFieldOverInvalidRoomId = await emitAndWait(
      outsider,
      'signal:forward',
      { roomId: 'bad-id', signalData: {}, extra: true },
      'room:error',
    );
    expect(extraFieldOverInvalidRoomId.code).toBe('INVALID_PAYLOAD');
    expect('roomId' in extraFieldOverInvalidRoomId).toBe(false);

    const payloadOverNotFoundAndUnauthorized = await emitAndWait(
      outsider,
      'signal:forward',
      { roomId: unusedRoomId, signalData: 'bad-signal' },
      'room:error',
    );
    expect(payloadOverNotFoundAndUnauthorized).toEqual({
      roomId: unusedRoomId,
      code: 'INVALID_PAYLOAD',
      message: expect.any(String),
    });

    const invalidRoomOverNotFoundAndUnauthorized = await emitAndWait(
      outsider,
      'signal:forward',
      { roomId: 'bad-id', signalData: {} },
      'room:error',
    );
    expect(invalidRoomOverNotFoundAndUnauthorized.code).toBe('INVALID_ROOM_ID');
    expect('roomId' in invalidRoomOverNotFoundAndUnauthorized).toBe(false);

    const notFoundOverUnauthorizedAndPeerUnavailable = await emitAndWait(
      outsider,
      'signal:forward',
      { roomId: unusedRoomId, signalData: {} },
      'room:error',
    );
    expect(notFoundOverUnauthorizedAndPeerUnavailable).toEqual({
      roomId: unusedRoomId,
      code: 'ROOM_NOT_FOUND',
      message: expect.any(String),
    });

    const unauthorizedOverPeerUnavailable = await emitAndWait(
      outsider,
      'signal:forward',
      { roomId: waitingRoom.roomId, signalData: {} },
      'room:error',
    );
    expect(unauthorizedOverPeerUnavailable).toEqual({
      roomId: waitingRoom.roomId,
      code: 'UNAUTHORIZED',
      message: expect.any(String),
    });
  });
});
