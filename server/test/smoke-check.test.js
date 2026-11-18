import { execFile, spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
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

const execFileAsync = promisify(execFile);
const SERVER_ROOT_DIR = fileURLToPath(new URL('..', import.meta.url));
const STAGING_PROXY_HEADERS = Object.freeze({
  'X-Shipri-Environment': 'poc-staging',
  'X-Robots-Tag': 'noindex, nofollow',
});
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailers',
  'transfer-encoding',
  'upgrade',
]);

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

async function listenLoopback(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  return server.address().port;
}

async function startIsolatedServer(options) {
  const server = createSignalingServer(options);
  cleanupCallbacks.add(() => server.close());

  const port = await listenLoopback(server.httpServer);
  return {
    ...server,
    port,
    baseUrl: `http://127.0.0.1:${port}`,
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

  const port = await listenLoopback(httpServer);
  return `http://127.0.0.1:${port}`;
}

async function createEphemeralTlsCertificate() {
  const tempDir = await mkdtemp(join(tmpdir(), 'shipri-smoke-tls-'));
  cleanupCallbacks.add(() => rm(tempDir, { recursive: true, force: true }));

  const keyPath = join(tempDir, 'tls-key.pem');
  const certPath = join(tempDir, 'tls-cert.pem');

  await execFileAsync('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    keyPath,
    '-out',
    certPath,
    '-days',
    '1',
    '-subj',
    '/CN=127.0.0.1',
    '-addext',
    'subjectAltName=DNS:poc.shipri.app,DNS:localhost,IP:127.0.0.1',
    '-addext',
    'basicConstraints=critical,CA:TRUE',
  ]);

  const [keyPem, certPem] = await Promise.all([
    readFile(keyPath, 'utf8'),
    readFile(certPath, 'utf8'),
  ]);

  return { certPath, certPem, keyPem };
}

function isProxiedStagingPath(rawUrl = '/') {
  const pathname = new URL(rawUrl, 'https://127.0.0.1').pathname;
  return (
    pathname === '/health' ||
    pathname === '/socket.io' ||
    pathname.startsWith('/socket.io/')
  );
}

function applyStagingHeaders(res) {
  for (const [name, value] of Object.entries(STAGING_PROXY_HEADERS)) {
    res.setHeader(name, value);
  }
}

function copyProxyHeaders(res, rawHeaders) {
  for (let i = 0; i < rawHeaders.length; i += 2) {
    const name = rawHeaders[i];
    const value = rawHeaders[i + 1];
    if (HOP_BY_HOP_HEADERS.has(name.toLowerCase())) {
      continue;
    }

    const existing = res.getHeader(name);
    if (existing === undefined) {
      res.setHeader(name, value);
    } else if (Array.isArray(existing)) {
      res.setHeader(name, [...existing, value]);
    } else {
      res.setHeader(name, [existing, value]);
    }
  }
}

function proxyHttpRequest(req, res, targetPort) {
  if (!isProxiedStagingPath(req.url)) {
    applyStagingHeaders(res);
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
    return;
  }

  const forwardHeaders = { ...req.headers };
  delete forwardHeaders.connection;
  forwardHeaders['x-forwarded-proto'] = 'https';

  const proxyReq = httpRequest(
    {
      hostname: '127.0.0.1',
      port: targetPort,
      path: req.url,
      method: req.method,
      headers: forwardHeaders,
      agent: false,
    },
    (proxyRes) => {
      copyProxyHeaders(res, proxyRes.rawHeaders);
      applyStagingHeaders(res);
      res.writeHead(proxyRes.statusCode || 502);
      proxyRes.pipe(res);
    },
  );

  proxyReq.on('error', (error) => {
    if (!res.headersSent) {
      applyStagingHeaders(res);
      res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`Bad Gateway: ${error.message}`);
      return;
    }
    res.destroy(error);
  });

  req.on('error', (error) => {
    proxyReq.destroy(error);
  });

  req.pipe(proxyReq);
}

function proxyUpgradeSocket(req, clientSocket, head, targetPort, activeSockets) {
  const pathname = new URL(req.url || '/', 'https://127.0.0.1').pathname;
  if (pathname !== '/socket.io' && !pathname.startsWith('/socket.io/')) {
    clientSocket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
    return;
  }

  const backendSocket = net.connect({ host: '127.0.0.1', port: targetPort });
  activeSockets.add(clientSocket);
  activeSockets.add(backendSocket);

  const destroyPair = () => {
    activeSockets.delete(clientSocket);
    activeSockets.delete(backendSocket);
    if (!clientSocket.destroyed) {
      clientSocket.destroy();
    }
    if (!backendSocket.destroyed) {
      backendSocket.destroy();
    }
  };

  clientSocket.on('error', destroyPair);
  backendSocket.on('error', destroyPair);
  clientSocket.on('close', destroyPair);
  backendSocket.on('close', destroyPair);

  backendSocket.on('connect', () => {
    const headerLines = [];
    let hasForwardedProto = false;
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const name = req.rawHeaders[i];
      const value = req.rawHeaders[i + 1];
      if (name.toLowerCase() === 'x-forwarded-proto') {
        hasForwardedProto = true;
      }
      headerLines.push(`${name}: ${value}`);
    }
    if (!hasForwardedProto) {
      headerLines.push('X-Forwarded-Proto: https');
    }

    backendSocket.write(
      `${req.method} ${req.url} HTTP/1.1\r\n${headerLines.join('\r\n')}\r\n\r\n`,
    );
    if (head && head.length > 0) {
      backendSocket.write(head);
    }

    clientSocket.pipe(backendSocket);
    backendSocket.pipe(clientSocket);
  });
}

async function startTlsReverseProxy({ targetPort, certPem, keyPem }) {
  const activeSockets = new Set();
  const httpsServer = https.createServer({ key: keyPem, cert: certPem }, (req, res) => {
    proxyHttpRequest(req, res, targetPort);
  });

  httpsServer.on('upgrade', (req, clientSocket, head) => {
    proxyUpgradeSocket(req, clientSocket, head, targetPort, activeSockets);
  });

  cleanupCallbacks.add(
    () =>
      new Promise((resolve) => {
        for (const socket of activeSockets) {
          socket.destroy();
        }
        activeSockets.clear();
        if (typeof httpsServer.closeAllConnections === 'function') {
          httpsServer.closeAllConnections();
        }
        if (!httpsServer.listening) {
          resolve();
          return;
        }
        httpsServer.close(() => resolve());
      }),
  );

  const port = await listenLoopback(httpsServer);
  return {
    port,
    baseUrl: `https://127.0.0.1:${port}`,
  };
}

function runSmokeCliProcess(envOverrides) {
  const childEnv = { ...process.env, ...envOverrides };
  if (envOverrides.SMOKE_ALLOW_HTTP === undefined) {
    delete childEnv.SMOKE_ALLOW_HTTP;
  }

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['src/smoke-check.js'], {
      cwd: SERVER_ROOT_DIR,
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

function requestHttpsJson({ port, path, ca, headers }) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method: 'GET',
        ca,
        rejectUnauthorized: true,
        headers,
      },
      (res) => {
        let bodyText = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          bodyText += chunk;
        });
        res.on('end', () => {
          try {
            resolve({
              statusCode: res.statusCode,
              headers: res.headers,
              body: JSON.parse(bodyText),
            });
          } catch (error) {
            reject(error);
          }
        });
      },
    );

    req.on('error', reject);
    req.end();
  });
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

  test('executes smoke-check CLI end-to-end over HTTPS and WSS TLS reverse proxy with immediate room cleanup', async () => {
    const tls = await createEphemeralTlsCertificate();
    const server = await startIsolatedServer({
      allowedOrigins: [
        'https://poc.shipri.app',
        'http://localhost:3000',
        'http://127.0.0.1:3000',
        'http://localhost:5173',
        'http://127.0.0.1:5173',
      ],
    });
    const proxy = await startTlsReverseProxy({
      targetPort: server.port,
      certPem: tls.certPem,
      keyPem: tls.keyPem,
    });

    const cliResult = await runSmokeCliProcess({
      NODE_EXTRA_CA_CERTS: tls.certPath,
      SMOKE_BASE_URL: proxy.baseUrl,
      SMOKE_ORIGIN: 'https://poc.shipri.app',
    });

    expect(cliResult.code).toBe(0);
    expect(cliResult.stderr).toBe('');
    expect(cliResult.stdout).toContain('[PASS]');
    expect(cliResult.stdout).toContain('health=ok');
    expect(cliResult.stdout).toContain('roomsCount=0');
    expect(cliResult.stdout).toContain('transport=websocket');

    const postSmokeHealth = await requestHttpsJson({
      port: proxy.port,
      path: '/health',
      ca: tls.certPem,
      headers: { Origin: 'https://poc.shipri.app' },
    });

    expect(postSmokeHealth.statusCode).toBe(200);
    expect(postSmokeHealth.body).toEqual({
      status: 'ok',
      roomsCount: 0,
    });
    expect(postSmokeHealth.headers['x-shipri-environment']).toBe('poc-staging');
    expect(postSmokeHealth.headers['x-robots-tag']).toBe('noindex, nofollow');
    expect(postSmokeHealth.headers['access-control-allow-origin']).toBe(
      'https://poc.shipri.app',
    );

    const disallowedOriginHealth = await requestHttpsJson({
      port: proxy.port,
      path: '/health',
      ca: tls.certPem,
      headers: { Origin: 'https://shipri.app' },
    });

    expect(disallowedOriginHealth.statusCode).toBe(200);
    expect(disallowedOriginHealth.body).toEqual({
      status: 'ok',
      roomsCount: 0,
    });
    expect(
      disallowedOriginHealth.headers['access-control-allow-origin'],
    ).toBeUndefined();
  });
});
