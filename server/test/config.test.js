import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, test } from 'vitest';
import {
  DEFAULT_ALLOWED_ORIGINS,
  DEFAULT_PORT,
  DEFAULT_STUN_URLS,
  loadConfig,
} from '../src/config.js';
import { createSignalingServer } from '../src/server.js';
import {
  closeSocketClients,
  createSocketClient,
} from './helpers/socket-client.js';

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

afterEach(async () => {
  closeSocketClients(...clients);
  clients.clear();

  await Promise.all([...servers].map((server) => server.close()));
  servers.clear();
});

describe('loadConfig', () => {
  test('returns frozen local development defaults when env variables are omitted', () => {
    const config = loadConfig({});

    expect(config).toEqual({
      port: DEFAULT_PORT,
      allowedOrigins: DEFAULT_ALLOWED_ORIGINS,
      stunUrls: DEFAULT_STUN_URLS,
    });
    expect(config.port).toBe(5001);
    expect(config.allowedOrigins).toEqual([
      'http://localhost:3000',
      'http://127.0.0.1:3000',
      'http://localhost:5173',
      'http://127.0.0.1:5173',
    ]);
    expect(config.stunUrls).toEqual([
      'stun:stun.l.google.com:19302',
      'stun:stun1.l.google.com:19302',
    ]);
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.allowedOrigins)).toBe(true);
    expect(Object.isFrozen(config.stunUrls)).toBe(true);
  });

  test('parses, trims, and deduplicates valid custom environment values', () => {
    const config = loadConfig({
      PORT: ' 6001 ',
      ALLOWED_ORIGINS:
        ' https://poc.shipri.app , http://localhost:3000, https://poc.shipri.app ',
      STUN_URLS:
        ' stun:stun.l.google.com:19302 , stun:stun1.l.google.com:19302, stun:stun.l.google.com:19302 ',
    });

    expect(config).toEqual({
      port: 6001,
      allowedOrigins: ['https://poc.shipri.app', 'http://localhost:3000'],
      stunUrls: [
        'stun:stun.l.google.com:19302',
        'stun:stun1.l.google.com:19302',
      ],
    });
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
    const server = await startIsolatedServer();

    expect(server.config).toEqual({
      port: DEFAULT_PORT,
      allowedOrigins: DEFAULT_ALLOWED_ORIGINS,
      stunUrls: DEFAULT_STUN_URLS,
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
    const server = await startIsolatedServer(stagingConfig);

    expect(Object.keys(server.config)).toEqual([
      'port',
      'allowedOrigins',
      'stunUrls',
    ]);

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

    expect(prodCompose).not.toContain('TURN_SHARED_SECRET');
    expect(prodCompose).not.toContain('coturn');
    expect(prodCompose).not.toContain('shipri-turn');
    expect(prodCompose).not.toContain('your_super_secret_here');
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
    const server = await startIsolatedServer(stagingConfig);

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
    expect(standaloneCompose).not.toContain('TURN_SHARED_SECRET');
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
