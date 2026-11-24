import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { verifyTurnCredential } from '../src/ice-service.js';
import { createSafeLogger } from '../src/logger.js';
import {
  closeSocketClients,
  createSocketClient,
} from './helpers/socket-client.js';
import {
  closeIsolatedServers,
  startIsolatedServer,
} from './helpers/test-server.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../..');

function sha256Base64Url(value) {
  return createHash('sha256').update(value, 'utf8').digest('base64url');
}

function waitForEvent(socket, event, timeoutMs = 2_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, onEvent);
      reject(new Error(`Timed out waiting for event "${event}".`));
    }, timeoutMs);
    function onEvent(payload) {
      clearTimeout(timer);
      resolve(payload);
    }
    socket.once(event, onEvent);
  });
}

describe('BE-7 full backend acceptance gate', () => {
  const activeServers = new Set();
  const activeClients = [];

  afterEach(async () => {
    closeSocketClients(...activeClients.splice(0));
    await closeIsolatedServers(activeServers);
  });

  it('exposes /health, /ready, and privacy-safe aggregate /metrics without user tracking across full authorized lifecycle', async () => {
    let currentTimeMs = 1_785_000_000_000;
    const logs = [];
    const logger = createSafeLogger({ sink: (msg) => logs.push(msg) });
    const turnSecret = 'be7-turn-shared-secret-32-bytes-minimum-value';

    const server = await startIsolatedServer(
      {
        env: {
          NODE_ENV: 'test',
          PORT: '5001',
          ALLOWED_ORIGINS: 'https://shipri.app',
          TRUST_PROXY: '1',
          REQUIRE_ROOM_AUTH: 'true',
          MAX_ROOMS: '1',
          ROOM_IDLE_TTL_MS: '5000',
          ROOM_MAX_LIFETIME_MS: '20000',
          ROOM_CLEANUP_INTERVAL_MS: '60000',
          ROOM_CREATE_RATE_LIMIT_MAX: '2',
          ROOM_CREATE_RATE_LIMIT_WINDOW_MS: '60000',
          STUN_URLS: 'stun:stun.l.google.com:19302',
          TURN_URLS:
            'turn:turn.shipri.app:3478?transport=udp,turns:turn.shipri.app:443?transport=tcp',
          TURN_SHARED_SECRET: turnSecret,
          TURN_CREDENTIAL_TTL_SECONDS: '7200',
          REQUIRE_TURN: 'true',
        },
        now: () => currentTimeMs,
        logger,
      },
      activeServers,
    );
    const { baseUrl } = server;

    // 1. Health and readiness baseline
    const healthRes = await fetch(`${baseUrl}/health`);
    expect(healthRes.status).toBe(200);
    expect(healthRes.headers.get('cache-control')).toBe('no-store');
    const healthBody = await healthRes.json();
    expect(Object.keys(healthBody)).toEqual(['status', 'roomsCount']);
    expect(healthBody).toEqual({ status: 'ok', roomsCount: 0 });

    const readyRes = await fetch(`${baseUrl}/ready`);
    expect(readyRes.status).toBe(200);
    expect(readyRes.headers.get('cache-control')).toBe('no-store');
    expect(await readyRes.json()).toEqual({
      status: 'ready',
      roomsCount: 0,
      maxRooms: 1,
    });

    // 2. Authorized equal-peer lifecycle + HMAC-SHA1 TURN verification
    const peerA = await createSocketClient(baseUrl, {
      extraHeaders: {
        Origin: 'https://shipri.app',
        'X-Forwarded-For': '198.51.100.10',
      },
    });
    const peerB = await createSocketClient(baseUrl, {
      extraHeaders: {
        Origin: 'https://shipri.app',
        'X-Forwarded-For': '198.51.100.11',
      },
    });
    const peerC = await createSocketClient(baseUrl, {
      extraHeaders: {
        Origin: 'https://shipri.app',
        'X-Forwarded-For': '198.51.100.12',
      },
    });
    activeClients.push(peerA, peerB, peerC);

    const authToken = 'be7-derived-room-auth-token-secret-value';
    const authVerifier = sha256Base64Url(authToken);

    const createdP = waitForEvent(peerA, 'room:created');
    peerA.emit('room:create', { authVerifier });
    const created = await createdP;
    expect(created.roomId).toMatch(/^ship-[a-f0-9]{4}$/);
    expect(created.negotiationDuty).toBe('offerer');

    // Wrong token -> UNAUTHORIZED
    const unauthJoinP = waitForEvent(peerB, 'room:error');
    peerB.emit('room:join', {
      roomId: created.roomId,
      authToken: 'wrong-token',
    });
    expect((await unauthJoinP).code).toBe('UNAUTHORIZED');

    // Valid join -> room:joined + peer:joined
    const joinedP = waitForEvent(peerB, 'room:joined');
    const peerJoinedP = waitForEvent(peerA, 'peer:joined');
    peerB.emit('room:join', { roomId: created.roomId, authToken });
    const [joined, peerJoined] = await Promise.all([joinedP, peerJoinedP]);
    expect(joined.negotiationDuty).toBe('answerer');
    expect(peerJoined.peerId).toBe(joined.peerId);

    // Third peer -> ROOM_FULL; non-member signal -> UNAUTHORIZED
    const fullP = waitForEvent(peerC, 'room:error');
    peerC.emit('room:join', { roomId: created.roomId, authToken });
    expect((await fullP).code).toBe('ROOM_FULL');

    const spoofP = waitForEvent(peerC, 'room:error');
    peerC.emit('signal:forward', {
      roomId: created.roomId,
      signalData: { type: 'offer' },
    });
    expect((await spoofP).code).toBe('UNAUTHORIZED');

    // Authorized ICE/TURN credentials verification
    const iceP = waitForEvent(peerA, 'ice:credentials');
    peerA.emit('ice:get', { roomId: created.roomId });
    const ice = await iceP;
    const turnEntry = ice.iceServers.find((entry) => entry.credential);
    expect(turnEntry).toBeDefined();
    expect(
      verifyTurnCredential({
        username: turnEntry.username,
        credential: turnEntry.credential,
        turnSharedSecret: turnSecret,
        now: () => currentTimeMs,
      }),
    ).toBe(true);
    expect(
      verifyTurnCredential({
        username: turnEntry.username,
        credential: turnEntry.credential,
        turnSharedSecret: turnSecret,
        now: () => currentTimeMs + 8_000_000,
      }),
    ).toBe(false);

    // Capacity saturation (MAX_ROOMS=1) -> SERVER_BUSY, then rate-limit -> RATE_LIMITED
    const busy1P = waitForEvent(peerC, 'room:error');
    peerC.emit('room:create', { authVerifier });
    expect((await busy1P).code).toBe('SERVER_BUSY');

    const busy2P = waitForEvent(peerC, 'room:error');
    peerC.emit('room:create', { authVerifier });
    expect((await busy2P).code).toBe('SERVER_BUSY');

    const rateLimitedP = waitForEvent(peerC, 'room:error');
    peerC.emit('room:create', { authVerifier });
    expect((await rateLimitedP).code).toBe('RATE_LIMITED');

    // Advance time past idle TTL and sweep -> ROOM_NOT_FOUND + roomsExpiredTotal === 1
    currentTimeMs += 6_000;
    const expiredNoticeP = waitForEvent(peerA, 'room:error');
    expect(server.sweepExpiredRooms()).toBe(1);
    expect((await expiredNoticeP).code).toBe('ROOM_NOT_FOUND');

    // 3. Verify aggregate metrics contain zero user/room/IP/secret identifiers
    const metricsRes = await fetch(`${baseUrl}/metrics`);
    expect(metricsRes.status).toBe(200);
    expect(metricsRes.headers.get('cache-control')).toBe('no-store');
    const metrics = await metricsRes.json();

    expect(metrics).toMatchObject({
      status: 'ok',
      activeRoomsCount: 0,
      maxRooms: 1,
      roomsCreatedTotal: 1,
      roomsExpiredTotal: 1,
    });
    expect(metrics.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(metrics.errorsByCode).toMatchObject({
      UNAUTHORIZED: 2,
      ROOM_FULL: 1,
      SERVER_BUSY: 2,
      RATE_LIMITED: 1,
      ROOM_NOT_FOUND: 1,
    });

    const serializedMetrics = JSON.stringify(metrics);
    expect(serializedMetrics).not.toContain(created.roomId);
    expect(serializedMetrics).not.toContain(peerA.id);
    expect(serializedMetrics).not.toContain(peerB.id);
    expect(serializedMetrics).not.toContain('198.51.100.');
    expect(serializedMetrics).not.toContain(authToken);
    expect(serializedMetrics).not.toContain(authVerifier);
    expect(serializedMetrics).not.toContain(turnSecret);

    // Logs must remain strictly privacy-safe
    const combinedLogs = logs.join('\n');
    expect(combinedLogs).not.toContain(peerA.id);
    expect(combinedLogs).not.toContain('198.51.100.');
    expect(combinedLogs).not.toContain(authToken);
    expect(combinedLogs).not.toContain(authVerifier);
    expect(combinedLogs).not.toContain(turnSecret);
    expect(combinedLogs).not.toContain(turnEntry.credential);
  });

  it('reports /ready as 503 when required TURN configuration is unavailable', async () => {
    const server = await startIsolatedServer(
      {
        env: {
          NODE_ENV: 'test',
          PORT: '5001',
          ALLOWED_ORIGINS: 'https://shipri.app',
          STUN_URLS: 'stun:stun.l.google.com:19302',
          TURN_URLS: '',
          TURN_SHARED_SECRET: '',
          REQUIRE_TURN: 'true',
        },
      },
      activeServers,
    );

    const readyRes = await fetch(`${server.baseUrl}/ready`);
    expect(readyRes.status).toBe(503);
    expect(readyRes.headers.get('cache-control')).toBe('no-store');
    expect(await readyRes.json()).toEqual({ status: 'not_ready' });
  });

  it('validates graceful shutdown, room cleanup, and idempotent close()', async () => {
    const server = await startIsolatedServer(
      {
        env: {
          NODE_ENV: 'test',
          PORT: '5001',
          ALLOWED_ORIGINS: 'http://localhost:5173',
          REQUIRE_ROOM_AUTH: 'false',
          STUN_URLS: 'stun:stun.l.google.com:19302',
        },
      },
      activeServers,
    );

    const peer = await createSocketClient(server.baseUrl);
    const createdP = waitForEvent(peer, 'room:created');
    peer.emit('room:create', {});
    await createdP;

    expect(server.activeRooms.size).toBe(1);
    expect(server.socketRooms.size).toBe(1);
    expect(server.getReadinessStatus().ready).toBe(true);

    await server.close();

    expect(server.getReadinessStatus()).toEqual({
      ready: false,
      status: 'not_ready',
    });
    expect(server.getOperationalMetrics().status).toBe('shutting_down');
    expect(server.activeRooms.size).toBe(0);
    expect(server.socketRooms.size).toBe(0);
    expect(server.rateLimiter.size()).toBe(0);
    expect(server.httpServer.listening).toBe(false);

    // Calling close() a second time is safely idempotent
    await expect(server.close()).resolves.toBeUndefined();
    peer.close();
  });

  it('wires SIGTERM/SIGINT graceful shutdown in server/src/index.js and matches released deployment contracts', () => {
    const indexSrc = readFileSync(
      path.join(REPO_ROOT, 'server/src/index.js'),
      'utf8',
    );
    expect(indexSrc).toContain('SIGTERM');
    expect(indexSrc).toContain('SIGINT');
    expect(indexSrc).toContain('close');

    const caddyfile = readFileSync(path.join(REPO_ROOT, 'Caddyfile'), 'utf8');
    expect(caddyfile).toContain('/health');
    expect(caddyfile).toContain('/socket.io/*');

    const prodCompose = readFileSync(
      path.join(REPO_ROOT, 'docker-compose.prod.yml'),
      'utf8',
    );
    expect(prodCompose).not.toContain('super_secret_turn_key_change_me');
    expect(prodCompose).toContain('healthcheck:');
  });
});
