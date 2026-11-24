import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, test } from 'vitest';
import {
  DEFAULT_ALLOWED_ORIGINS,
  DEFAULT_MAX_ROOMS,
  DEFAULT_NODE_ENV,
  DEFAULT_PORT,
  DEFAULT_ROOM_CLEANUP_INTERVAL_MS,
  DEFAULT_ROOM_CREATE_RATE_LIMIT_MAX,
  DEFAULT_ROOM_CREATE_RATE_LIMIT_WINDOW_MS,
  DEFAULT_ROOM_IDLE_TTL_MS,
  DEFAULT_ROOM_MAX_LIFETIME_MS,
  DEFAULT_STUN_URLS,
  DEFAULT_TRUST_PROXY,
  DEFAULT_TURN_CREDENTIAL_TTL_SECONDS,
  DEFAULT_TURN_URLS,
  loadConfig,
} from '../src/config.js';
import { createSignalingServer } from '../src/server.js';
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

function readRepoFile(relativePath) {
  return readFileSync(new URL(`../../${relativePath}`, import.meta.url), 'utf8');
}

function extractComposeDefaultEnv(composeText, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = composeText.match(
    new RegExp(`-\\s+${escaped}=\\$\\{${escaped}:-([^}]+)\\}`),
  );
  return match ? match[1] : undefined;
}

afterEach(async () => {
  closeSocketClients(...clients);
  clients.clear();

  await closeIsolatedServers(servers);
});

describe('loadConfig', () => {
  test('returns frozen local development defaults when env variables are omitted', () => {
    const config = loadConfig({});

    expect(config).toEqual({
      nodeEnv: DEFAULT_NODE_ENV,
      port: DEFAULT_PORT,
      allowedOrigins: DEFAULT_ALLOWED_ORIGINS,
      trustProxy: DEFAULT_TRUST_PROXY,
      requireRoomAuth: false,
      maxRooms: DEFAULT_MAX_ROOMS,
      roomIdleTtlMs: DEFAULT_ROOM_IDLE_TTL_MS,
      roomMaxLifetimeMs: DEFAULT_ROOM_MAX_LIFETIME_MS,
      roomCleanupIntervalMs: DEFAULT_ROOM_CLEANUP_INTERVAL_MS,
      roomCreateRateLimitMax: DEFAULT_ROOM_CREATE_RATE_LIMIT_MAX,
      roomCreateRateLimitWindowMs: DEFAULT_ROOM_CREATE_RATE_LIMIT_WINDOW_MS,
      stunUrls: DEFAULT_STUN_URLS,
      turnUrls: DEFAULT_TURN_URLS,
      turnCredentialTtlSeconds: DEFAULT_TURN_CREDENTIAL_TTL_SECONDS,
      requireTurn: false,
    });
    expect(config.port).toBe(5001);
    expect(config.maxRooms).toBe(5000);
    expect(config.roomIdleTtlMs).toBe(1_800_000);
    expect(config.roomMaxLifetimeMs).toBe(14_400_000);
    expect(config.roomCleanupIntervalMs).toBe(60_000);
    expect(config.roomCreateRateLimitMax).toBe(10);
    expect(config.roomCreateRateLimitWindowMs).toBe(60_000);
    expect(config.turnCredentialTtlSeconds).toBe(7_200);
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.allowedOrigins)).toBe(true);
    expect(Object.isFrozen(config.stunUrls)).toBe(true);
    expect(Object.isFrozen(config.turnUrls)).toBe(true);
  });

  test('parses, trims, and deduplicates valid custom full-backend environment values without exposing secrets', () => {
    const config = loadConfig({
      NODE_ENV: 'production',
      PORT: ' 6001 ',
      ALLOWED_ORIGINS:
        ' https://shipri.app , https://poc.shipri.app, https://shipri.app ',
      TRUST_PROXY: '1',
      REQUIRE_ROOM_AUTH: 'true',
      MAX_ROOMS: '2500',
      ROOM_IDLE_TTL_MS: '900000',
      ROOM_MAX_LIFETIME_MS: '7200000',
      ROOM_CLEANUP_INTERVAL_MS: '30000',
      ROOM_CREATE_RATE_LIMIT_MAX: '15',
      ROOM_CREATE_RATE_LIMIT_WINDOW_MS: '120000',
      STUN_URLS:
        ' stun:stun.l.google.com:19302 , stun:stun1.l.google.com:19302, stun:stun.l.google.com:19302 ',
      TURN_URLS:
        ' turn:turn.shipri.app:3478?transport=udp , turns:turn.shipri.app:443?transport=tcp, turn:turn.shipri.app:3478?transport=udp ',
      TURN_CREDENTIAL_TTL_SECONDS: '3600',
      REQUIRE_TURN: 'true',
      TURN_SHARED_SECRET: 'super_sensitive_hmac_secret',
    });

    expect(config).toEqual({
      nodeEnv: 'production',
      port: 6001,
      allowedOrigins: ['https://shipri.app', 'https://poc.shipri.app'],
      trustProxy: 1,
      requireRoomAuth: true,
      maxRooms: 2500,
      roomIdleTtlMs: 900_000,
      roomMaxLifetimeMs: 7_200_000,
      roomCleanupIntervalMs: 30_000,
      roomCreateRateLimitMax: 15,
      roomCreateRateLimitWindowMs: 120_000,
      stunUrls: [
        'stun:stun.l.google.com:19302',
        'stun:stun1.l.google.com:19302',
      ],
      turnUrls: [
        'turn:turn.shipri.app:3478?transport=udp',
        'turns:turn.shipri.app:443?transport=tcp',
      ],
      turnCredentialTtlSeconds: 3600,
      requireTurn: true,
    });
    expect(JSON.stringify(config)).not.toContain('super_sensitive_hmac_secret');
    expect(Object.keys(config)).not.toContain('turnSharedSecret');
  });

  test('defaults REQUIRE_ROOM_AUTH to true when NODE_ENV=production and rejects explicit false', () => {
    const prodConfig = loadConfig({ NODE_ENV: 'production' });
    expect(prodConfig.requireRoomAuth).toBe(true);

    expect(() =>
      loadConfig({ NODE_ENV: 'production', REQUIRE_ROOM_AUTH: 'false' }),
    ).toThrow(/Invalid REQUIRE_ROOM_AUTH configuration/i);
  });

  test.each(['staging', 'prod', '123'])(
    'throws a clear error for invalid NODE_ENV value %j',
    (invalidNodeEnv) => {
      expect(() => loadConfig({ NODE_ENV: invalidNodeEnv })).toThrow(
        /Invalid NODE_ENV configuration/i,
      );
    },
  );

  test.each(['', '-1', 'yes', 'abc'])(
    'throws a clear error for invalid REQUIRE_ROOM_AUTH value %j',
    (invalidBool) => {
      expect(() => loadConfig({ REQUIRE_ROOM_AUTH: invalidBool })).toThrow(
        /Invalid REQUIRE_ROOM_AUTH configuration/i,
      );
    },
  );

  test.each(['', '-1', '1.5'])(
    'throws a clear error for invalid TRUST_PROXY value %j',
    (invalidTrustProxy) => {
      expect(() => loadConfig({ TRUST_PROXY: invalidTrustProxy })).toThrow(
        /Invalid TRUST_PROXY configuration/i,
      );
    },
  );

  test('accepts valid TRUST_PROXY boolean, hop count, and proxy keyword values', () => {
    expect(loadConfig({ TRUST_PROXY: 'false' }).trustProxy).toBe(false);
    expect(loadConfig({ TRUST_PROXY: 'true' }).trustProxy).toBe(true);
    expect(loadConfig({ TRUST_PROXY: '2' }).trustProxy).toBe(2);
    expect(loadConfig({ TRUST_PROXY: 'loopback' }).trustProxy).toBe('loopback');
  });

  test('validates MAX_ROOMS, room TTL bounds, rate limits, and TURN config ranges', () => {
    expect(() => loadConfig({ MAX_ROOMS: '0' })).toThrow(
      /Invalid MAX_ROOMS configuration/i,
    );
    expect(() => loadConfig({ MAX_ROOMS: '70000' })).toThrow(
      /Invalid MAX_ROOMS configuration/i,
    );
    expect(() =>
      loadConfig({
        ROOM_IDLE_TTL_MS: '60000',
        ROOM_MAX_LIFETIME_MS: '30000',
      }),
    ).toThrow(/ROOM_IDLE_TTL_MS/i);
    expect(() => loadConfig({ ROOM_CLEANUP_INTERVAL_MS: '0' })).toThrow(
      /Invalid ROOM_CLEANUP_INTERVAL_MS configuration/i,
    );
    expect(() => loadConfig({ ROOM_CREATE_RATE_LIMIT_MAX: '0' })).toThrow(
      /Invalid ROOM_CREATE_RATE_LIMIT_MAX configuration/i,
    );
    expect(() =>
      loadConfig({ ROOM_CREATE_RATE_LIMIT_WINDOW_MS: '-5' }),
    ).toThrow(/Invalid ROOM_CREATE_RATE_LIMIT_WINDOW_MS configuration/i);
    expect(() => loadConfig({ TURN_CREDENTIAL_TTL_SECONDS: '30' })).toThrow(
      /Invalid TURN_CREDENTIAL_TTL_SECONDS configuration/i,
    );
    expect(() => loadConfig({ TURN_CREDENTIAL_TTL_SECONDS: '90000' })).toThrow(
      /Invalid TURN_CREDENTIAL_TTL_SECONDS configuration/i,
    );
    expect(() =>
      loadConfig({ TURN_URLS: 'stun:stun.l.google.com:19302' }),
    ).toThrow(/Invalid TURN_URLS configuration/i);
    expect(() =>
      loadConfig({ TURN_URLS: 'turn:turn.shipri.app:3478?transport=sctp' }),
    ).toThrow(/Invalid TURN_URLS configuration/i);
  });

  test.each(['', 'abc', '0', '-1', '65536', '5001.5'])(
    'throws a clear error for invalid PORT value %j',
    (invalidPort) => {
      expect(() => loadConfig({ PORT: invalidPort })).toThrow(
        /Invalid PORT configuration/i,
      );
    },
  );

  test.each([
    '',
    ' , ',
    '*',
    'not-a-url',
    'ftp://localhost:3000',
    'http://localhost:3000/path',
    'http://localhost:3000?query=1',
  ])(
    'throws a clear error for invalid ALLOWED_ORIGINS value %j',
    (invalidOrigins) => {
      expect(() => loadConfig({ ALLOWED_ORIGINS: invalidOrigins })).toThrow(
        /Invalid ALLOWED_ORIGINS configuration/i,
      );
    },
  );

  test.each([
    '',
    ' , ',
    'http://stun.l.google.com:19302',
    'turn:turn.shipri.app:3478',
    'turns:turn.shipri.app:443',
    'stun:stun.l.google.com',
    'stun:stun.l.google.com:0',
    'stun:stun.l.google.com:70000',
  ])(
    'throws a clear error for invalid STUN_URLS value %j',
    (invalidStunUrls) => {
      expect(() => loadConfig({ STUN_URLS: invalidStunUrls })).toThrow(
        /Invalid STUN_URLS configuration/i,
      );
    },
  );
});

describe('createSignalingServer configuration', () => {
  test('exposes validated config and enforces allowedOrigins on HTTP CORS', async () => {
    const server = await startIsolatedServer(undefined, servers);

    expect(server.config).toMatchObject({
      port: DEFAULT_PORT,
      allowedOrigins: DEFAULT_ALLOWED_ORIGINS,
      stunUrls: DEFAULT_STUN_URLS,
      trustProxy: DEFAULT_TRUST_PROXY,
      maxRooms: DEFAULT_MAX_ROOMS,
      roomIdleTtlMs: DEFAULT_ROOM_IDLE_TTL_MS,
      roomMaxLifetimeMs: DEFAULT_ROOM_MAX_LIFETIME_MS,
      roomCleanupIntervalMs: DEFAULT_ROOM_CLEANUP_INTERVAL_MS,
      roomCreateRateLimitMax: DEFAULT_ROOM_CREATE_RATE_LIMIT_MAX,
      roomCreateRateLimitWindowMs: DEFAULT_ROOM_CREATE_RATE_LIMIT_WINDOW_MS,
      turnUrls: DEFAULT_TURN_URLS,
      turnCredentialTtlSeconds: DEFAULT_TURN_CREDENTIAL_TTL_SECONDS,
      requireTurn: false,
    });

    const allowedResponse = await fetch(`${server.baseUrl}/health`, {
      headers: { Origin: 'http://localhost:3000' },
    });
    expect(allowedResponse.status).toBe(200);
    expect(allowedResponse.headers.get('access-control-allow-origin')).toBe(
      'http://localhost:3000',
    );

    const blockedResponse = await fetch(`${server.baseUrl}/health`, {
      headers: { Origin: 'https://unapproved.example' },
    });
    expect(blockedResponse.status).toBe(200);
    expect(
      blockedResponse.headers.get('access-control-allow-origin'),
    ).toBeNull();
  });

  test('supports restricted POC staging origins without exposing secrets or permitting production origins', async () => {
    const stagingConfig = loadConfig({
      PORT: '5001',
      ALLOWED_ORIGINS:
        'https://poc.shipri.app,http://localhost:3000,http://127.0.0.1:3000,http://localhost:5173,http://127.0.0.1:5173',
      STUN_URLS: 'stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302',
      TURN_SHARED_SECRET: 'ignored_in_poc',
    });
    const server = await startIsolatedServer(stagingConfig, servers);

    expect(Object.keys(server.config)).not.toContain('turnSharedSecret');
    expect(JSON.stringify(server.config)).not.toContain('ignored_in_poc');

    const stagingOriginResponse = await fetch(`${server.baseUrl}/health`, {
      headers: { Origin: 'https://poc.shipri.app' },
    });
    expect(stagingOriginResponse.status).toBe(200);
    expect(
      stagingOriginResponse.headers.get('access-control-allow-origin'),
    ).toBe('https://poc.shipri.app');

    const localViteOriginResponse = await fetch(`${server.baseUrl}/health`, {
      headers: { Origin: 'http://localhost:5173' },
    });
    expect(localViteOriginResponse.status).toBe(200);
    expect(
      localViteOriginResponse.headers.get('access-control-allow-origin'),
    ).toBe('http://localhost:5173');

    const productionOriginResponse = await fetch(`${server.baseUrl}/health`, {
      headers: { Origin: 'https://shipri.app' },
    });
    expect(productionOriginResponse.status).toBe(200);
    expect(
      productionOriginResponse.headers.get('access-control-allow-origin'),
    ).toBeNull();
  });

  test('throws immediately when constructed with invalid config overrides', () => {
    expect(() => createSignalingServer({ port: -1 })).toThrow(
      /Invalid PORT configuration/i,
    );
    expect(() => createSignalingServer({ allowedOrigins: ['*'] })).toThrow(
      /Invalid ALLOWED_ORIGINS configuration/i,
    );
    expect(() =>
      createSignalingServer({ nodeEnv: 'production', requireRoomAuth: false }),
    ).toThrow(/Invalid REQUIRE_ROOM_AUTH configuration/i);
  });
});

describe('Backend POC staging deployment configuration', () => {
  test('docker-compose.prod.yml defines shipri-server and shipri-client on nginx-proxy without host ports or TURN secrets', () => {
    const prodCompose = readRepoFile('docker-compose.prod.yml');

    expect(prodCompose).toContain('container_name: shipri-server');
    expect(prodCompose).toContain('container_name: shipri-client');
    expect(prodCompose).toContain('- "5001"');
    expect(prodCompose).toContain('- "80"');
    expect(prodCompose).toContain('shipri-network');
    expect(prodCompose).toContain('nginx-proxy');
    expect(prodCompose).toMatch(/nginx-proxy:\s*\n\s*external:\s*true/);
    expect(prodCompose).not.toMatch(/^\s*ports:/m);

    expect(prodCompose).not.toContain('coturn');
    expect(prodCompose).not.toContain('shipri-turn');
    expect(prodCompose).not.toContain('your_super_secret_here');
    expect(prodCompose).not.toMatch(/TURN_SHARED_SECRET=[A-Za-z0-9+/=_-]{8,}/);
  });

  test('validates default staging compose environment and enforces Socket.IO CORS origins', async () => {
    const prodCompose = readRepoFile('docker-compose.prod.yml');
    const port = extractComposeDefaultEnv(prodCompose, 'PORT');
    const allowedOrigins = extractComposeDefaultEnv(
      prodCompose,
      'ALLOWED_ORIGINS',
    );
    const stunUrls = extractComposeDefaultEnv(prodCompose, 'STUN_URLS');

    expect(port).toBe('5001');
    expect(allowedOrigins).toBe(
      'https://poc.shipri.app,http://localhost:3000,http://127.0.0.1:3000,http://localhost:5173,http://127.0.0.1:5173',
    );
    expect(stunUrls).toBe(
      'stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302',
    );

    const stagingConfig = loadConfig({
      PORT: port,
      ALLOWED_ORIGINS: allowedOrigins,
      STUN_URLS: stunUrls,
    });
    const server = await startIsolatedServer(stagingConfig, servers);

    const stagingSocketCors = await fetch(
      `${server.baseUrl}/socket.io/?EIO=4&transport=polling`,
      {
        headers: { Origin: 'https://poc.shipri.app' },
      },
    );
    expect(stagingSocketCors.status).toBe(200);
    expect(stagingSocketCors.headers.get('access-control-allow-origin')).toBe(
      'https://poc.shipri.app',
    );

    const localViteSocketCors = await fetch(
      `${server.baseUrl}/socket.io/?EIO=4&transport=polling`,
      {
        headers: { Origin: 'http://localhost:5173' },
      },
    );
    expect(localViteSocketCors.status).toBe(200);
    expect(
      localViteSocketCors.headers.get('access-control-allow-origin'),
    ).toBe('http://localhost:5173');

    const productionSocketCors = await fetch(
      `${server.baseUrl}/socket.io/?EIO=4&transport=polling`,
      {
        headers: { Origin: 'https://shipri.app' },
      },
    );
    expect(productionSocketCors.status).toBe(200);
    expect(
      productionSocketCors.headers.get('access-control-allow-origin'),
    ).toBeNull();

    const client = await createSocketClient(server.baseUrl, {
      extraHeaders: { Origin: 'https://poc.shipri.app' },
    });
    clients.add(client);

    const createdRoom = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('Timed out waiting for room:created'));
      }, 1_000);

      client.once('room:created', (payload) => {
        clearTimeout(timer);
        resolve(payload);
      });
      client.emit('room:create', {});
    });

    expect(createdRoom.roomId).toMatch(/^ship-[a-f0-9]{4}$/);
    expect(createdRoom.negotiationDuty).toBe('offerer');
  });

  test('docker-compose.yml removes obsolete version and TURN secrets and profiles coturn out of POC staging', () => {
    const standaloneCompose = readRepoFile('docker-compose.yml');

    expect(standaloneCompose).not.toMatch(/^\s*version:/m);
    expect(standaloneCompose).not.toMatch(
      /TURN_SHARED_SECRET=[A-Za-z0-9+/=_-]{8,}/,
    );
    expect(standaloneCompose).not.toContain('your_super_secret_here');

    expect(extractComposeDefaultEnv(standaloneCompose, 'PORT')).toBe('5001');
    expect(
      extractComposeDefaultEnv(standaloneCompose, 'ALLOWED_ORIGINS'),
    ).toBe(
      'https://poc.shipri.app,http://localhost:3000,http://127.0.0.1:3000,http://localhost:5173,http://127.0.0.1:5173',
    );
    expect(extractComposeDefaultEnv(standaloneCompose, 'STUN_URLS')).toBe(
      'stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302',
    );
    expect(standaloneCompose).toMatch(
      /coturn:[\s\S]*profiles:\s*\n\s*-\s*turn|coturn:[\s\S]*profiles:\s*\[\s*["']?turn["']?\s*\]/,
    );
  });

  test('Caddyfile and client/nginx.conf route /health and /socket.io/ to server:5001 with POC staging headers', () => {
    const caddyfile = readRepoFile('Caddyfile');
    const nginxConf = readRepoFile('client/nginx.conf');

    expect(caddyfile).toContain('poc.shipri.app');
    expect(caddyfile).toContain('reverse_proxy /socket.io/* server:5001');
    expect(caddyfile).toContain('reverse_proxy /health server:5001');
    expect(caddyfile).toContain('reverse_proxy * client:80');
    expect(caddyfile).toContain('X-Shipri-Environment');
    expect(caddyfile).toContain('poc-staging');
    expect(caddyfile).toContain('X-Robots-Tag');
    expect(caddyfile).toContain('noindex, nofollow');

    expect(nginxConf).toContain('location = /health');
    expect(nginxConf).toContain('proxy_pass http://server:5001/health;');
    expect(nginxConf).toContain('location /socket.io/');
    expect(nginxConf).toContain('proxy_pass http://server:5001/socket.io/;');
    expect(nginxConf).toContain('proxy_http_version 1.1;');
    expect(nginxConf).toContain('proxy_set_header Upgrade $http_upgrade;');
    expect(nginxConf).toContain('proxy_set_header Connection "upgrade";');
    expect(nginxConf).toContain('X-Shipri-Environment');
    expect(nginxConf).toContain('poc-staging');
    expect(nginxConf).toContain('X-Robots-Tag');
    expect(nginxConf).toContain('noindex, nofollow');
  });
});
