import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, test } from 'vitest';
import { createSafeLogger } from '../src/logger.js';
import {
  createRoomCreateRateLimiter,
  resolveClientIp,
} from '../src/rate-limit.js';
import { deriveRoomAuthFromMasterSecret } from '../src/room-auth.js';
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

afterEach(async () => {
  closeSocketClients(...clients);
  clients.clear();

  await closeIsolatedServers(servers);
});

describe('resolveClientIp and TRUST_PROXY boundaries', () => {
  test('ignores spoofed X-Forwarded-For when trustProxy is false', () => {
    const fakeSocket = {
      handshake: {
        address: '::ffff:198.51.100.10',
        headers: { 'x-forwarded-for': '203.0.113.5, 198.51.100.99' },
      },
    };

    expect(resolveClientIp(fakeSocket, false)).toBe('198.51.100.10');
    expect(resolveClientIp(fakeSocket, 0)).toBe('198.51.100.10');
  });

  test('resolves rightmost untrusted client IP for numeric hop trustProxy preventing header spoofing', () => {
    const fakeSocket = {
      handshake: {
        address: '::ffff:127.0.0.1',
        headers: {
          'x-forwarded-for': '203.0.113.1, 198.51.100.42',
        },
      },
    };

    // With 1 trusted reverse proxy hop, the proxy appended 198.51.100.42; attacker cannot spoof 203.0.113.1
    expect(resolveClientIp(fakeSocket, 1)).toBe('198.51.100.42');
    expect(resolveClientIp(fakeSocket, 2)).toBe('203.0.113.1');
  });

  test('honors loopback trustProxy only when immediate peer is loopback', () => {
    const viaLoopback = {
      handshake: {
        address: '::ffff:127.0.0.1',
        headers: { 'x-forwarded-for': '203.0.113.77' },
      },
    };
    const directPublic = {
      handshake: {
        address: '198.51.100.25',
        headers: { 'x-forwarded-for': '203.0.113.77' },
      },
    };

    expect(resolveClientIp(viaLoopback, 'loopback')).toBe('203.0.113.77');
    expect(resolveClientIp(directPublic, 'loopback')).toBe('198.51.100.25');
  });

  test('tracks sliding window rate-limit buckets and purges expired entries cleanly', () => {
    let nowMs = 1_700_000_000_000;
    const limiter = createRoomCreateRateLimiter({
      maxAttempts: 2,
      windowMs: 10_000,
      now: () => nowMs,
    });

    expect(limiter.consume('198.51.100.1').allowed).toBe(true);
    expect(limiter.consume('198.51.100.1').allowed).toBe(true);
    expect(limiter.consume('198.51.100.1').allowed).toBe(false);
    expect(limiter.consume('198.51.100.2').allowed).toBe(true);

    nowMs += 10_500;
    expect(limiter.purgeExpired()).toBe(2);
    expect(limiter.size()).toBe(0);
    expect(limiter.consume('198.51.100.1').allowed).toBe(true);
  });
});

describe('abuse controls, capacity limits, CORS, and safe operational logging', () => {
  test('enforces per-IP room:create rate limiting, TRUST_PROXY behavior, and RATE_LIMITED precedence', async () => {
    let currentTime = 1_700_000_000_000;
    const server = await startIsolatedServer(
      {
        requireRoomAuth: true,
        trustProxy: false,
        roomCreateRateLimitMax: 2,
        roomCreateRateLimitWindowMs: 10_000,
        now: () => currentTime,
      },
      servers,
    );

    const client1 = await createSocketClient(server.baseUrl, {
      extraHeaders: { 'x-forwarded-for': '203.0.113.10' },
    });
    const client2 = await createSocketClient(server.baseUrl, {
      extraHeaders: { 'x-forwarded-for': '203.0.113.11' },
    });
    const client3 = await createSocketClient(server.baseUrl, {
      extraHeaders: { 'x-forwarded-for': '203.0.113.12' },
    });
    clients.add(client1);
    clients.add(client2);
    clients.add(client3);

    const auth1 = deriveRoomAuthFromMasterSecret(randomBytes(32));
    const auth2 = deriveRoomAuthFromMasterSecret(randomBytes(32));

    // Attempts 1 and 2 succeed (same direct 127.0.0.1 IP because trustProxy=false ignores X-Forwarded-For)
    const created1 = waitForEvent(client1, 'room:created');
    client1.emit('room:create', { authVerifier: auth1.authVerifier });
    await created1;

    const created2 = waitForEvent(client2, 'room:created');
    client2.emit('room:create', { authVerifier: auth2.authVerifier });
    await created2;

    // Attempt 3 fails with RATE_LIMITED even when payload is malformed (precedence #1)
    const rateLimited = waitForEvent(client3, 'room:error');
    client3.emit('room:create', { invalidExtra: true });
    expect(await rateLimited).toMatchObject({
      code: 'RATE_LIMITED',
    });

    // Advancing past window restores quota
    currentTime += 10_500;
    const auth3 = deriveRoomAuthFromMasterSecret(randomBytes(32));
    const created3 = waitForEvent(client3, 'room:created');
    client3.emit('room:create', { authVerifier: auth3.authVerifier });
    const room3 = await created3;
    expect(room3.roomId).toMatch(/^ship-[a-f0-9]{4}$/);
  });

  test('isolates per-IP room:create budgets when trustProxy is configured', async () => {
    const server = await startIsolatedServer(
      {
        trustProxy: 1,
        roomCreateRateLimitMax: 1,
        roomCreateRateLimitWindowMs: 60_000,
      },
      servers,
    );

    const peerFromIpA1 = await createSocketClient(server.baseUrl, {
      extraHeaders: { 'x-forwarded-for': '198.51.100.20' },
    });
    const peerFromIpA2 = await createSocketClient(server.baseUrl, {
      extraHeaders: { 'x-forwarded-for': '198.51.100.20' },
    });
    const peerFromIpB = await createSocketClient(server.baseUrl, {
      extraHeaders: { 'x-forwarded-for': '198.51.100.21' },
    });
    clients.add(peerFromIpA1);
    clients.add(peerFromIpA2);
    clients.add(peerFromIpB);

    const createdA = waitForEvent(peerFromIpA1, 'room:created');
    peerFromIpA1.emit('room:create', {});
    await createdA;

    const blockedA = waitForEvent(peerFromIpA2, 'room:error');
    peerFromIpA2.emit('room:create', {});
    expect(await blockedA).toMatchObject({ code: 'RATE_LIMITED' });

    const createdB = waitForEvent(peerFromIpB, 'room:created');
    peerFromIpB.emit('room:create', {});
    expect((await createdB).roomId).toMatch(/^ship-[a-f0-9]{4}$/);
  });

  test('enforces MAX_ROOMS capacity cap with SERVER_BUSY and recovers after expiry purge', async () => {
    let currentTime = 1_700_000_000_000;
    const server = await startIsolatedServer(
      {
        maxRooms: 2,
        roomIdleTtlMs: 5_000,
        roomMaxLifetimeMs: 10_000,
        roomCreateRateLimitMax: 20,
        now: () => currentTime,
      },
      servers,
    );

    const c1 = await createSocketClient(server.baseUrl);
    const c2 = await createSocketClient(server.baseUrl);
    const c3 = await createSocketClient(server.baseUrl);
    clients.add(c1);
    clients.add(c2);
    clients.add(c3);

    const r1 = waitForEvent(c1, 'room:created');
    c1.emit('room:create', {});
    await r1;

    const r2 = waitForEvent(c2, 'room:created');
    c2.emit('room:create', {});
    await r2;

    const busyError = waitForEvent(c3, 'room:error');
    c3.emit('room:create', {});
    expect(await busyError).toMatchObject({
      code: 'SERVER_BUSY',
    });

    // Advance clock past idle TTL: next room:create purges expired rooms and succeeds
    currentTime += 6_000;
    const r3 = waitForEvent(c3, 'room:created');
    c3.emit('room:create', {});
    expect((await r3).roomId).toMatch(/^ship-[a-f0-9]{4}$/);
    expect(server.activeRooms.size).toBe(1);
  });

  test('emits operational logs without socket IDs, IPs, auth tokens, TURN secrets, SDP, or file metadata', async () => {
    const logLines = [];
    const logger = createSafeLogger({
      sink: (line) => logLines.push(line),
    });

    const server = await startIsolatedServer(
      {
        requireRoomAuth: true,
        allowedOrigins: ['https://shipri.app'],
        turnSharedSecret: 'top_secret_turn_hmac_key_do_not_log',
        logger,
      },
      servers,
    );

    const creator = await createSocketClient(server.baseUrl, {
      extraHeaders: { Origin: 'https://shipri.app' },
    });
    const joiner = await createSocketClient(server.baseUrl, {
      extraHeaders: { Origin: 'https://shipri.app' },
    });
    const intruder = await createSocketClient(server.baseUrl, {
      extraHeaders: { Origin: 'https://shipri.app' },
    });
    clients.add(creator);
    clients.add(joiner);
    clients.add(intruder);

    const { authToken, authVerifier } = deriveRoomAuthFromMasterSecret(
      randomBytes(32),
    );
    const createdPromise = waitForEvent(creator, 'room:created');
    creator.emit('room:create', { authVerifier });
    const created = await createdPromise;

    const badJoinError = waitForEvent(intruder, 'room:error');
    intruder.emit('room:join', {
      roomId: created.roomId,
      authToken: 'secret_wrong_token_9999',
    });
    await badJoinError;

    const joinedPromise = waitForEvent(joiner, 'room:joined');
    joiner.emit('room:join', { roomId: created.roomId, authToken });
    await joinedPromise;

    const signalReceived = waitForEvent(joiner, 'signal:receive');
    creator.emit('signal:forward', {
      roomId: created.roomId,
      signalData: {
        type: 'offer',
        sdp: 'v=0\r\na=fingerprint:sha-256 SECRET_SDP_FINGERPRINT',
      },
    });
    await signalReceived;

    const peerLeftPromise = waitForEvent(creator, 'peer:left');
    joiner.emit('room:leave', { roomId: created.roomId });
    await peerLeftPromise;

    creator.emit('room:leave', { roomId: created.roomId });
    await new Promise((resolve) => setTimeout(resolve, 60));

    const combinedLogs = logLines.join('\n');
    expect(combinedLogs).toContain(`Room created: ${created.roomId}`);
    expect(combinedLogs).toContain(`Peer joined room: ${created.roomId}`);
    expect(combinedLogs).toContain(`Room closed after leave: ${created.roomId}`);

    expect(combinedLogs).not.toContain(creator.id);
    expect(combinedLogs).not.toContain(joiner.id);
    expect(combinedLogs).not.toContain(intruder.id);
    expect(combinedLogs).not.toContain('127.0.0.1');
    expect(combinedLogs).not.toContain(authToken);
    expect(combinedLogs).not.toContain(authVerifier);
    expect(combinedLogs).not.toContain('secret_wrong_token_9999');
    expect(combinedLogs).not.toContain('top_secret_turn_hmac_key_do_not_log');
    expect(combinedLogs).not.toContain('SECRET_SDP_FINGERPRINT');
    expect(combinedLogs).not.toContain('#key=');
  });
});
