import { afterEach, describe, expect, test } from 'vitest';
import {
  DEFAULT_ALLOWED_ORIGINS,
  DEFAULT_PORT,
  DEFAULT_STUN_URLS,
  loadConfig,
} from '../src/config.js';
import { createSignalingServer } from '../src/server.js';

const servers = new Set();

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

  test('throws immediately when constructed with invalid config overrides', () => {
    expect(() => createSignalingServer({ port: -1 })).toThrow(
      /Invalid PORT configuration/i,
    );
    expect(() => createSignalingServer({ allowedOrigins: ['*'] })).toThrow(
      /Invalid ALLOWED_ORIGINS configuration/i,
    );
  });
});
