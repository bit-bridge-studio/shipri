import { createServer } from 'node:http';
import { Server as SocketIOServer } from 'socket.io';
import { afterEach, describe, expect, test } from 'vitest';
import { createSignalingServer } from '../src/server.js';
import {
  DEFAULT_SMOKE_TIMEOUT_MS,
  DEFAULT_STAGING_BASE_URL,
  resolveSmokeCheckConfig,
  runStagingSmokeChecks,
  runStagingSmokeCli,
} from '../src/smoke-check.js';

const cleanupCallbacks = new Set();

function createBufferWriter() {
  let content = '';
  return {
    write(chunk) {
      content += String(chunk);
    },
    read() {
      return content;
    },
  };
}

async function startIsolatedServer(options) {
  const server = createSignalingServer(options);
  cleanupCallbacks.add(() => server.close());

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

async function startCustomHttpServer(handler, attachSocketIO) {
  const httpServer = createServer(handler);
  const io = attachSocketIO
    ? attachSocketIO(new SocketIOServer(httpServer, { cors: { origin: '*' } }))
    : null;

  cleanupCallbacks.add(
    () =>
      new Promise((resolve) => {
        if (io) {
          io.close(() => resolve());
          return;
        }
        httpServer.close(() => resolve());
      }),
  );

  await new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(0, '127.0.0.1', () => {
      httpServer.off('error', reject);
      resolve();
    });
  });

  const address = httpServer.address();
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  await Promise.all([...cleanupCallbacks].map((fn) => fn()));
  cleanupCallbacks.clear();
});

describe('resolveSmokeCheckConfig', () => {
  test('returns frozen POC staging defaults requiring HTTPS and zero secrets', () => {
    const config = resolveSmokeCheckConfig({});

    expect(config).toEqual({
      baseUrl: DEFAULT_STAGING_BASE_URL,
      origin: DEFAULT_STAGING_BASE_URL,
      timeoutMs: DEFAULT_SMOKE_TIMEOUT_MS,
      requireHttps: true,
    });
    expect(config.baseUrl).toBe('https://poc.shipri.app');
    expect(config.timeoutMs).toBe(5_000);
    expect(Object.isFrozen(config)).toBe(true);
  });

  test('normalizes trailing slash on SMOKE_BASE_URL and honors overrides', () => {
    const config = resolveSmokeCheckConfig({
      SMOKE_BASE_URL: ' https://poc.shipri.app/ ',
      SMOKE_ORIGIN: ' https://poc.shipri.app ',
      SMOKE_TIMEOUT_MS: ' 2500 ',
      SMOKE_ALLOW_HTTP: 'true',
    });

    expect(config).toEqual({
      baseUrl: 'https://poc.shipri.app',
      origin: 'https://poc.shipri.app',
      timeoutMs: 2_500,
      requireHttps: false,
    });
  });

  test.each([
    '',
    'not-a-url',
    'wss://poc.shipri.app',
    'ftp://poc.shipri.app',
    'https://user:pass@poc.shipri.app',
    'https://poc.shipri.app?debug=1',
    'https://poc.shipri.app#section',
  ])('throws clear error for invalid SMOKE_BASE_URL %j', (invalidBaseUrl) => {
    expect(() =>
      resolveSmokeCheckConfig({ SMOKE_BASE_URL: invalidBaseUrl }),
    ).toThrow(/Invalid SMOKE_BASE_URL/i);
  });

  test.each(['', '*', 'not-an-origin', 'https://poc.shipri.app/path'])(
    'throws clear error for invalid SMOKE_ORIGIN %j',
    (invalidOrigin) => {
      expect(() =>
        resolveSmokeCheckConfig({ SMOKE_ORIGIN: invalidOrigin }),
      ).toThrow(/Invalid SMOKE_ORIGIN/i);
    },
  );

  test.each(['', '0', '-100', 'abc', '12.5'])(
    'throws clear error for invalid SMOKE_TIMEOUT_MS %j',
    (invalidTimeout) => {
      expect(() =>
        resolveSmokeCheckConfig({ SMOKE_TIMEOUT_MS: invalidTimeout }),
      ).toThrow(/Invalid SMOKE_TIMEOUT_MS/i);
    },
  );
});

describe('Backend POC staging smoke checks', () => {
  test('rejects http:// target URLs by default when HTTPS/WSS is required', async () => {
    const server = await startIsolatedServer({
      allowedOrigins: ['https://poc.shipri.app'],
    });
    const stdout = createBufferWriter();
    const stderr = createBufferWriter();

    await expect(
      runStagingSmokeChecks({
        env: {
          SMOKE_BASE_URL: server.baseUrl,
          SMOKE_ORIGIN: 'https://poc.shipri.app',
        },
      }),
    ).rejects.toThrow(/https:\/\//i);

    const exitCode = await runStagingSmokeCli({
      env: {
        SMOKE_BASE_URL: server.baseUrl,
        SMOKE_ORIGIN: 'https://poc.shipri.app',
      },
      stdout,
      stderr,
    });

    expect(exitCode).toBe(1);
    expect(stdout.read()).toBe('');
    expect(stderr.read()).toContain('[FAIL]');
    expect(stderr.read()).toMatch(/https:\/\//i);
  });

  test('verifies /health, CORS, and WebSocket room round-trip with cleanup and returns CLI exit code 0', async () => {
    const server = await startIsolatedServer({
      allowedOrigins: ['https://poc.shipri.app'],
    });
    const stdout = createBufferWriter();
    const stderr = createBufferWriter();

    const result = await runStagingSmokeChecks({
      env: {
        SMOKE_BASE_URL: server.baseUrl,
        SMOKE_ORIGIN: 'https://poc.shipri.app',
        SMOKE_ALLOW_HTTP: 'true',
      },
    });

    expect(result.ok).toBe(true);
    expect(result.health).toEqual({
      status: 'ok',
      roomsCount: 0,
      allowOrigin: 'https://poc.shipri.app',
    });
    expect(result.socket.transport).toBe('websocket');
    expect(result.socket.roomId).toMatch(/^ship-[a-f0-9]{4}$/);

    const postSmokeHealth = await fetch(`${server.baseUrl}/health`);
    expect(await postSmokeHealth.json()).toEqual({
      status: 'ok',
      roomsCount: 0,
    });

    const exitCode = await runStagingSmokeCli({
      env: {
        SMOKE_BASE_URL: server.baseUrl,
        SMOKE_ORIGIN: 'https://poc.shipri.app',
        SMOKE_ALLOW_HTTP: 'true',
      },
      stdout,
      stderr,
    });

    expect(exitCode).toBe(0);
    expect(stderr.read()).toBe('');
    expect(stdout.read()).toContain('[PASS]');
    expect(stdout.read()).toContain('transport=websocket');
  });

  test('fails with non-zero CLI exit code when SMOKE_ORIGIN is rejected by CORS', async () => {
    const server = await startIsolatedServer({
      allowedOrigins: ['https://poc.shipri.app'],
    });
    const stdout = createBufferWriter();
    const stderr = createBufferWriter();

    const exitCode = await runStagingSmokeCli({
      env: {
        SMOKE_BASE_URL: server.baseUrl,
        SMOKE_ORIGIN: 'https://shipri.app',
        SMOKE_ALLOW_HTTP: 'true',
      },
      stdout,
      stderr,
    });

    expect(exitCode).toBe(1);
    expect(stdout.read()).toBe('');
    expect(stderr.read()).toContain('[FAIL]');
    expect(stderr.read()).toMatch(/CORS/i);
  });

  test('fails with non-zero CLI exit code when /health returns non-200 status or invalid JSON schema', async () => {
    const unhealthyUrl = await startCustomHttpServer((req, res) => {
      if (req.url === '/health') {
        res.writeHead(503, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
          'Access-Control-Allow-Origin': 'https://poc.shipri.app',
        });
        res.end(JSON.stringify({ status: 'unavailable' }));
        return;
      }
      res.writeHead(404).end();
    });

    const stdout1 = createBufferWriter();
    const stderr1 = createBufferWriter();
    const statusExitCode = await runStagingSmokeCli({
      env: {
        SMOKE_BASE_URL: unhealthyUrl,
        SMOKE_ORIGIN: 'https://poc.shipri.app',
        SMOKE_ALLOW_HTTP: 'true',
      },
      stdout: stdout1,
      stderr: stderr1,
    });
    expect(statusExitCode).toBe(1);
    expect(stderr1.read()).toContain('[FAIL]');
    expect(stderr1.read()).toContain('503');

    const badPayloadUrl = await startCustomHttpServer((req, res) => {
      if (req.url === '/health') {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
          'Access-Control-Allow-Origin': 'https://poc.shipri.app',
        });
        res.end(JSON.stringify({ status: 'degraded', roomsCount: 'invalid' }));
        return;
      }
      res.writeHead(404).end();
    });

    const stdout2 = createBufferWriter();
    const stderr2 = createBufferWriter();
    const schemaExitCode = await runStagingSmokeCli({
      env: {
        SMOKE_BASE_URL: badPayloadUrl,
        SMOKE_ORIGIN: 'https://poc.shipri.app',
        SMOKE_ALLOW_HTTP: 'true',
      },
      stdout: stdout2,
      stderr: stderr2,
    });
    expect(schemaExitCode).toBe(1);
    expect(stderr2.read()).toContain('[FAIL]');
    expect(stderr2.read()).toMatch(/health payload/i);
  });

  test('fails with non-zero CLI exit code when WebSocket connection is unreachable or room:create fails', async () => {
    const roomErrorUrl = await startCustomHttpServer(
      (req, res) => {
        if (req.url === '/health') {
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
            'Access-Control-Allow-Origin': 'https://poc.shipri.app',
          });
          res.end(JSON.stringify({ status: 'ok', roomsCount: 0 }));
          return;
        }
        res.writeHead(404).end();
      },
      (io) => {
        io.on('connection', (socket) => {
          socket.on('room:create', () => {
            socket.emit('room:error', {
              code: 'SERVER_BUSY',
              message: 'Simulated failure',
            });
          });
        });
        return io;
      },
    );

    const stdout1 = createBufferWriter();
    const stderr1 = createBufferWriter();
    const errorExitCode = await runStagingSmokeCli({
      env: {
        SMOKE_BASE_URL: roomErrorUrl,
        SMOKE_ORIGIN: 'https://poc.shipri.app',
        SMOKE_ALLOW_HTTP: 'true',
      },
      stdout: stdout1,
      stderr: stderr1,
    });
    expect(errorExitCode).toBe(1);
    expect(stderr1.read()).toContain('[FAIL]');
    expect(stderr1.read()).toContain('SERVER_BUSY');

    const noSocketUrl = await startCustomHttpServer((req, res) => {
      if (req.url === '/health') {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
          'Access-Control-Allow-Origin': 'https://poc.shipri.app',
        });
        res.end(JSON.stringify({ status: 'ok', roomsCount: 0 }));
        return;
      }
      res.writeHead(404).end();
    });

    const stdout2 = createBufferWriter();
    const stderr2 = createBufferWriter();
    const wsExitCode = await runStagingSmokeCli({
      env: {
        SMOKE_BASE_URL: noSocketUrl,
        SMOKE_ORIGIN: 'https://poc.shipri.app',
        SMOKE_ALLOW_HTTP: 'true',
        SMOKE_TIMEOUT_MS: '500',
      },
      stdout: stdout2,
      stderr: stderr2,
    });
    expect(wsExitCode).toBe(1);
    expect(stderr2.read()).toContain('[FAIL]');
  });
});
