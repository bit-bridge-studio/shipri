import { createHmac, randomBytes } from 'node:crypto';
import { afterEach, describe, expect, test } from 'vitest';
import { loadConfig } from '../src/config.js';
import {
  generateTurnCredentials,
  resolveIceServers,
} from '../src/ice-service.js';
import { createSafeLogger } from '../src/logger.js';
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

describe('ice-service TURN REST HMAC-SHA1 credential generation', () => {
  test('generates time-limited Coturn REST username and valid HMAC-SHA1 base64 credential', () => {
    const fixedNow = 1_785_232_000_000;
    const sharedSecret = 'coturn_hmac_shared_secret_value';
    const creds = generateTurnCredentials({
      turnSharedSecret: sharedSecret,
      ttlSeconds: 7_200,
      now: () => fixedNow,
      randomBytesFn: () => Buffer.from('0123456789abcdef', 'hex'),
    });

    expect(creds.username).toBe('1785239200:0123456789abcdef');
    const expectedHmac = createHmac('sha1', sharedSecret)
      .update('1785239200:0123456789abcdef')
      .digest('base64');
    expect(creds.credential).toBe(expectedHmac);
    expect(creds.expiresAt).toBe(1_785_239_200);
    expect(JSON.stringify(creds)).not.toContain(sharedSecret);
  });

  test('fails closed when requireTurn is true and TURN URLs or secret are missing', () => {
    const missingSecret = resolveIceServers({
      stunUrls: ['stun:stun.l.google.com:19302'],
      turnUrls: ['turn:turn.shipri.app:3478?transport=udp'],
      turnSharedSecret: null,
      requireTurn: true,
    });
    expect(missingSecret).toEqual({ ok: false });

    const missingUrls = resolveIceServers({
      stunUrls: ['stun:stun.l.google.com:19302'],
      turnUrls: [],
      turnSharedSecret: 'valid_secret',
      requireTurn: true,
    });
    expect(missingUrls).toEqual({ ok: false });

    const partialConfig = resolveIceServers({
      stunUrls: ['stun:stun.l.google.com:19302'],
      turnUrls: ['turn:turn.shipri.app:3478?transport=udp'],
      turnSharedSecret: '',
      requireTurn: false,
    });
    expect(partialConfig).toEqual({ ok: false });
  });
});

describe('Socket.IO ice:get authorized STUN + TURN credential service', () => {
  test('returns STUN and ephemeral HMAC-SHA1 TURN credentials for authorized room members without leaking TURN_SHARED_SECRET', async () => {
    const fixedNow = 1_785_232_000_000;
    const sharedSecret = 'very_private_turn_shared_secret_be4';
    const logLines = [];
    const logger = createSafeLogger({
      sink: (line) => logLines.push(line),
    });

    const loaded = loadConfig({
      NODE_ENV: 'test',
      REQUIRE_ROOM_AUTH: 'true',
      STUN_URLS: 'stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302',
      TURN_URLS:
        'turn:turn.shipri.app:3478?transport=udp,turn:turn.shipri.app:3478?transport=tcp,turns:turn.shipri.app:443?transport=tcp',
      TURN_SHARED_SECRET: sharedSecret,
      TURN_CREDENTIAL_TTL_SECONDS: '3600',
      REQUIRE_TURN: 'true',
    });

    const server = await startIsolatedServer(
      {
        ...loaded,
        env: {
          NODE_ENV: 'test',
          REQUIRE_ROOM_AUTH: 'true',
          STUN_URLS:
            'stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302',
          TURN_URLS:
            'turn:turn.shipri.app:3478?transport=udp,turn:turn.shipri.app:3478?transport=tcp,turns:turn.shipri.app:443?transport=tcp',
          TURN_SHARED_SECRET: sharedSecret,
          TURN_CREDENTIAL_TTL_SECONDS: '3600',
          REQUIRE_TURN: 'true',
        },
        now: () => fixedNow,
        logger,
      },
      servers,
    );

    const creator = await createSocketClient(server.baseUrl);
    const joiner = await createSocketClient(server.baseUrl);
    const outsider = await createSocketClient(server.baseUrl);
    clients.add(creator);
    clients.add(joiner);
    clients.add(outsider);

    const { authToken, authVerifier } = deriveRoomAuthFromMasterSecret(
      randomBytes(32),
    );
    const createdPromise = waitForEvent(creator, 'room:created');
    creator.emit('room:create', { authVerifier });
    const { roomId } = await createdPromise;

    const joinedPromise = waitForEvent(joiner, 'room:joined');
    joiner.emit('room:join', { roomId, authToken });
    await joinedPromise;

    // Non-member cannot fetch TURN credentials
    const outsiderError = waitForEvent(outsider, 'room:error');
    outsider.emit('ice:get', { roomId });
    expect(await outsiderError).toMatchObject({
      roomId,
      code: 'UNAUTHORIZED',
    });

    // Authorized member receives STUN + valid HMAC-SHA1 TURN credentials
    const credsPromise = waitForEvent(joiner, 'ice:credentials');
    joiner.emit('ice:get', { roomId });
    const response = await credsPromise;

    expect(response.roomId).toBe(roomId);
    expect(response.iceServers).toHaveLength(2);
    expect(response.iceServers[0]).toEqual({
      urls: [
        'stun:stun.l.google.com:19302',
        'stun:stun1.l.google.com:19302',
      ],
    });

    const turnEntry = response.iceServers[1];
    expect(turnEntry.urls).toEqual([
      'turn:turn.shipri.app:3478?transport=udp',
      'turn:turn.shipri.app:3478?transport=tcp',
      'turns:turn.shipri.app:443?transport=tcp',
    ]);
    expect(turnEntry.username).toMatch(/^1785235600:[a-f0-9]{16}$/);
    const expectedHmac = createHmac('sha1', sharedSecret)
      .update(turnEntry.username)
      .digest('base64');
    expect(turnEntry.credential).toBe(expectedHmac);

    const serializedResponse = JSON.stringify(response);
    expect(serializedResponse).not.toContain(sharedSecret);
    expect(JSON.stringify(server.config)).not.toContain(sharedSecret);

    const combinedLogs = logLines.join('\n');
    expect(combinedLogs).not.toContain(sharedSecret);
    expect(combinedLogs).not.toContain(turnEntry.username);
    expect(combinedLogs).not.toContain(turnEntry.credential);
  });

  test('fails safely with SERVER_BUSY when REQUIRE_TURN=true and TURN_SHARED_SECRET is missing', async () => {
    const server = await startIsolatedServer(
      {
        env: {
          NODE_ENV: 'test',
          STUN_URLS: 'stun:stun.l.google.com:19302',
          TURN_URLS: 'turn:turn.shipri.app:3478?transport=udp',
          REQUIRE_TURN: 'true',
        },
      },
      servers,
    );

    const creator = await createSocketClient(server.baseUrl);
    clients.add(creator);

    const createdPromise = waitForEvent(creator, 'room:created');
    creator.emit('room:create', {});
    const { roomId } = await createdPromise;

    const busyError = waitForEvent(creator, 'room:error');
    creator.emit('ice:get', { roomId });
    const error = await busyError;

    expect(error).toMatchObject({
      roomId,
      code: 'SERVER_BUSY',
    });
    expect(error.message.toLowerCase()).not.toContain('secret');
  });
});
