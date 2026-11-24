import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, test } from 'vitest';
import {
  createAuthVerifierFromToken,
  decodeAuthVerifier,
  deriveRoomAuthFromMasterSecret,
  isValidAuthToken,
  isValidAuthVerifier,
  verifyAuthToken,
} from '../src/room-auth.js';
import {
  closeSocketClients,
  createSocketClient,
} from './helpers/socket-client.js';
import {
  closeIsolatedServers,
  startIsolatedServer,
} from './helpers/test-server.js';

const clients = new Set();
const servers = new Set();

function waitForEvent(socket, eventName, timeoutMs = 1_500) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for ${eventName}`));
    }, timeoutMs);

    socket.once(eventName, (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

function expectNoEvent(socket, eventName, durationMs = 120) {
  return new Promise((resolve, reject) => {
    const onEvent = (payload) => {
      clearTimeout(timer);
      reject(
        new Error(
          `Unexpected ${eventName} event received: ${JSON.stringify(payload)}`,
        ),
      );
    };

    const timer = setTimeout(() => {
      socket.off(eventName, onEvent);
      resolve();
    }, durationMs);

    socket.once(eventName, onEvent);
  });
}

afterEach(async () => {
  closeSocketClients(...clients);
  clients.clear();

  await closeIsolatedServers(servers);
});

describe('room-auth HKDF separation and constant-time verification', () => {
  test('derives deterministic 43-char base64url authToken and SHA-256 authVerifier independently from roomId', () => {
    const masterSecret = randomBytes(32);
    const derivedA = deriveRoomAuthFromMasterSecret(masterSecret);
    const derivedB = deriveRoomAuthFromMasterSecret(masterSecret);

    expect(derivedA).toEqual(derivedB);
    expect(derivedA.authToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(derivedA.authVerifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(derivedA.authToken).not.toBe(derivedA.authVerifier);
    expect(derivedA.authToken).not.toBe(masterSecret.toString('base64url'));

    expect(isValidAuthVerifier(derivedA.authVerifier)).toBe(true);
    expect(isValidAuthToken(derivedA.authToken)).toBe(true);
    expect(createAuthVerifierFromToken(derivedA.authToken)).toBe(
      derivedA.authVerifier,
    );

    const hashBuffer = decodeAuthVerifier(derivedA.authVerifier);
    expect(Buffer.isBuffer(hashBuffer)).toBe(true);
    expect(hashBuffer).toHaveLength(32);
    expect(verifyAuthToken(derivedA.authToken, hashBuffer)).toBe(true);
    expect(verifyAuthToken('wrong-token-value', hashBuffer)).toBe(false);
  });

  test('rejects malformed authVerifier and empty or oversized authToken values', () => {
    expect(isValidAuthVerifier('')).toBe(false);
    expect(isValidAuthVerifier('short')).toBe(false);
    expect(isValidAuthVerifier('a'.repeat(44))).toBe(false);
    expect(isValidAuthVerifier(`${'a'.repeat(42)}=`)).toBe(false);
    expect(decodeAuthVerifier('not-valid')).toBeNull();

    expect(isValidAuthToken('')).toBe(false);
    expect(isValidAuthToken('a'.repeat(257))).toBe(false);
    expect(isValidAuthToken(12345)).toBe(false);
    expect(isValidAuthToken('diagnostic-wrong-token')).toBe(true);
  });
});

describe('secure full backend room lifecycle (REQUIRE_ROOM_AUTH=true)', () => {
  test('enforces authVerifier on room:create, authToken on room:join, UNAUTHORIZED before ROOM_FULL, and third-peer ROOM_FULL', async () => {
    const server = await startIsolatedServer(
      { requireRoomAuth: true },
      servers,
    );
    const creator = await createSocketClient(server.baseUrl);
    const joiner = await createSocketClient(server.baseUrl);
    const attacker = await createSocketClient(server.baseUrl);
    const thirdAuthorizedPeer = await createSocketClient(server.baseUrl);
    clients.add(creator);
    clients.add(joiner);
    clients.add(attacker);
    clients.add(thirdAuthorizedPeer);

    // Missing authVerifier is rejected with INVALID_PAYLOAD
    const missingVerifierPromise = waitForEvent(creator, 'room:error');
    creator.emit('room:create', {});
    expect(await missingVerifierPromise).toMatchObject({
      code: 'INVALID_PAYLOAD',
    });

    // Valid HKDF-derived authVerifier creates room
    const { authToken, authVerifier } = deriveRoomAuthFromMasterSecret(
      randomBytes(32),
    );
    const createdPromise = waitForEvent(creator, 'room:created');
    creator.emit('room:create', { authVerifier });
    const created = await createdPromise;

    expect(created.roomId).toMatch(/^ship-[a-f0-9]{4}$/);
    expect(created.negotiationDuty).toBe('offerer');
    expect(server.activeRooms.get(created.roomId).authVerifierHash).toHaveLength(
      32,
    );

    // Missing authToken on room:join returns INVALID_PAYLOAD
    const missingTokenPromise = waitForEvent(attacker, 'room:error');
    attacker.emit('room:join', { roomId: created.roomId });
    expect(await missingTokenPromise).toMatchObject({
      roomId: created.roomId,
      code: 'INVALID_PAYLOAD',
    });

    // Wrong authToken on WaitingForPeer room returns UNAUTHORIZED
    const wrongTokenWaitingPromise = waitForEvent(attacker, 'room:error');
    attacker.emit('room:join', {
      roomId: created.roomId,
      authToken: 'wrong-diagnostic-token',
    });
    expect(await wrongTokenWaitingPromise).toMatchObject({
      roomId: created.roomId,
      code: 'UNAUTHORIZED',
    });

    // Valid authToken joins second equal peer
    const joinedPromise = waitForEvent(joiner, 'room:joined');
    const peerJoinedPromise = waitForEvent(creator, 'peer:joined');
    joiner.emit('room:join', { roomId: created.roomId, authToken });
    const joined = await joinedPromise;
    const peerJoined = await peerJoinedPromise;

    expect(joined.roomId).toBe(created.roomId);
    expect(joined.negotiationDuty).toBe('answerer');
    expect(peerJoined).toEqual({
      roomId: created.roomId,
      peerId: joined.peerId,
    });

    // Wrong authToken on FULL room still returns UNAUTHORIZED (not ROOM_FULL) to prevent occupancy oracle
    const wrongTokenFullPromise = waitForEvent(attacker, 'room:error');
    attacker.emit('room:join', {
      roomId: created.roomId,
      authToken: 'wrong-token-on-full-room',
    });
    expect(await wrongTokenFullPromise).toMatchObject({
      roomId: created.roomId,
      code: 'UNAUTHORIZED',
    });

    // Third peer WITH valid authToken receives ROOM_FULL
    const roomFullPromise = waitForEvent(thirdAuthorizedPeer, 'room:error');
    thirdAuthorizedPeer.emit('room:join', {
      roomId: created.roomId,
      authToken,
    });
    expect(await roomFullPromise).toMatchObject({
      roomId: created.roomId,
      code: 'ROOM_FULL',
    });

    // Unauthorized attacker cannot inject signaling or fetch ICE config
    const unauthorizedSignalPromise = waitForEvent(attacker, 'room:error');
    const noCreatorSignal = expectNoEvent(creator, 'signal:receive');
    const noJoinerSignal = expectNoEvent(joiner, 'signal:receive');
    attacker.emit('signal:forward', {
      roomId: created.roomId,
      signalData: { type: 'offer', sdp: 'v=0 spoofed' },
    });
    expect(await unauthorizedSignalPromise).toMatchObject({
      roomId: created.roomId,
      code: 'UNAUTHORIZED',
    });
    await Promise.all([noCreatorSignal, noJoinerSignal]);

    // Valid signal relay works between both authorized equal peers
    const signalToJoiner = waitForEvent(joiner, 'signal:receive');
    creator.emit('signal:forward', {
      roomId: created.roomId,
      signalData: { type: 'offer', sdp: 'v=0 valid', generation: 1 },
    });
    expect(await signalToJoiner).toEqual({
      roomId: created.roomId,
      peerId: created.peerId,
      signalData: { type: 'offer', sdp: 'v=0 valid', generation: 1 },
    });

    // Malformed roomId and unsupported top-level fields on room:join are rejected cleanly
    const badRoomIdPromise = waitForEvent(attacker, 'room:error');
    attacker.emit('room:join', {
      roomId: 'BAD-ID',
      authToken: 'valid-format-token',
    });
    expect(await badRoomIdPromise).toMatchObject({
      code: 'INVALID_ROOM_ID',
    });

    const extraFieldPromise = waitForEvent(attacker, 'room:error');
    attacker.emit('room:join', {
      roomId: created.roomId,
      authToken,
      extra: true,
    });
    expect(await extraFieldPromise).toMatchObject({
      roomId: created.roomId,
      code: 'INVALID_PAYLOAD',
    });
  });

  test('supports either-peer leave, disconnect, replacement authorized join, and empty-room teardown', async () => {
    const server = await startIsolatedServer(
      { requireRoomAuth: true },
      servers,
    );
    const peerA = await createSocketClient(server.baseUrl);
    const peerB = await createSocketClient(server.baseUrl);
    const peerC = await createSocketClient(server.baseUrl);
    clients.add(peerA);
    clients.add(peerB);
    clients.add(peerC);

    const { authToken, authVerifier } = deriveRoomAuthFromMasterSecret(
      randomBytes(32),
    );
    const createdPromise = waitForEvent(peerA, 'room:created');
    peerA.emit('room:create', { authVerifier });
    const { roomId, peerId: peerAId } = await createdPromise;

    const joinedBPromise = waitForEvent(peerB, 'room:joined');
    peerB.emit('room:join', { roomId, authToken });
    await joinedBPromise;

    // Creator leaves explicitly -> joiner B remains and receives peer:left (leave)
    const peerLeftLeavePromise = waitForEvent(peerB, 'peer:left');
    peerA.emit('room:leave', { roomId });
    expect(await peerLeftLeavePromise).toEqual({
      roomId,
      peerId: peerAId,
      reason: 'leave',
    });

    // Replacement peer C joins with same authToken
    const joinedCPromise = waitForEvent(peerC, 'room:joined');
    const peerJoinedForB = waitForEvent(peerB, 'peer:joined');
    peerC.emit('room:join', { roomId, authToken });
    const joinedC = await joinedCPromise;
    expect(await peerJoinedForB).toEqual({ roomId, peerId: joinedC.peerId });

    // Peer C disconnects unexpectedly -> peer B receives peer:left (disconnect)
    const peerLeftDisconnectPromise = waitForEvent(peerB, 'peer:left');
    peerC.disconnect();
    expect(await peerLeftDisconnectPromise).toEqual({
      roomId,
      peerId: joinedC.peerId,
      reason: 'disconnect',
    });

    // Remaining peer B leaves -> room deleted immediately
    peerB.emit('room:leave', { roomId });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(server.activeRooms.size).toBe(0);
    expect(server.socketRooms.size).toBe(0);
  });

  test('enforces idle TTL refresh, lazy expiry, periodic sweep cleanup, and hard ROOM_MAX_LIFETIME_MS', async () => {
    let currentTime = 1_700_000_000_000;
    const server = await startIsolatedServer(
      {
        requireRoomAuth: true,
        roomIdleTtlMs: 5_000,
        roomMaxLifetimeMs: 12_000,
        roomCleanupIntervalMs: 60_000,
        now: () => currentTime,
      },
      servers,
    );

    const creator = await createSocketClient(server.baseUrl);
    const joiner = await createSocketClient(server.baseUrl);
    clients.add(creator);
    clients.add(joiner);

    const { authToken, authVerifier } = deriveRoomAuthFromMasterSecret(
      randomBytes(32),
    );
    const createdPromise = waitForEvent(creator, 'room:created');
    creator.emit('room:create', { authVerifier });
    const { roomId } = await createdPromise;

    // Activity at +4s refreshes idle TTL (expiresAt advances to +9s)
    currentTime += 4_000;
    const joinedPromise = waitForEvent(joiner, 'room:joined');
    joiner.emit('room:join', { roomId, authToken });
    await joinedPromise;

    // Activity at +8s refreshes idle TTL again, clamped to maxExpiresAt (+12s)
    currentTime += 4_000;
    const signalPromise = waitForEvent(joiner, 'signal:receive');
    creator.emit('signal:forward', {
      roomId,
      signalData: { type: 'offer', sdp: 'v=0 active' },
    });
    await signalPromise;
    expect(server.activeRooms.get(roomId).expiresAt).toBe(
      1_700_000_000_000 + 12_000,
    );

    // Advance past hard ROOM_MAX_LIFETIME_MS (+12.5s) and run cleanup sweep
    currentTime += 4_500;
    const creatorExpiredNotice = waitForEvent(creator, 'room:error');
    const joinerExpiredNotice = waitForEvent(joiner, 'room:error');
    const expiredCount = server.sweepExpiredRooms();

    expect(expiredCount).toBe(1);
    expect(await creatorExpiredNotice).toMatchObject({
      roomId,
      code: 'ROOM_NOT_FOUND',
    });
    expect(await joinerExpiredNotice).toMatchObject({
      roomId,
      code: 'ROOM_NOT_FOUND',
    });
    expect(server.activeRooms.size).toBe(0);
    expect(server.socketRooms.size).toBe(0);

    // Subsequent signal or join on expired room returns ROOM_NOT_FOUND
    const lateErrorPromise = waitForEvent(creator, 'room:error');
    creator.emit('ice:get', { roomId });
    expect(await lateErrorPromise).toMatchObject({
      roomId,
      code: 'ROOM_NOT_FOUND',
    });

    // Lazy expiry test: create new room, advance past idle TTL without sweep, join fails with ROOM_NOT_FOUND
    const room2Created = waitForEvent(creator, 'room:created');
    creator.emit('room:create', { authVerifier });
    const { roomId: room2Id } = await room2Created;

    currentTime += 5_500;
    const lazyExpiredForJoiner = waitForEvent(joiner, 'room:error');
    const lazyExpiredForCreator = waitForEvent(creator, 'room:error');
    joiner.emit('room:join', { roomId: room2Id, authToken });
    expect(await lazyExpiredForJoiner).toMatchObject({
      roomId: room2Id,
      code: 'ROOM_NOT_FOUND',
    });
    expect(await lazyExpiredForCreator).toMatchObject({
      roomId: room2Id,
      code: 'ROOM_NOT_FOUND',
    });
    expect(server.activeRooms.size).toBe(0);
    expect(server.socketRooms.size).toBe(0);
  });
});
