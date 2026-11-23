import { afterEach, describe, expect, test } from 'vitest';
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

afterEach(async () => {
  closeSocketClients(...clients);
  clients.clear();

  await closeIsolatedServers(servers);
});

describe('GET /health', () => {
  test('returns 200 JSON with no-store cache header and baseline service status', async () => {
    const server = await startIsolatedServer(undefined, servers);

    const response = await fetch(`${server.baseUrl}/health`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/application\/json/i);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(body).toEqual({
      status: 'ok',
      roomsCount: 0,
    });
  });

  test('reflects active room count without exposing room IDs, socket IDs, ICE config, or secrets', async () => {
    const server = await startIsolatedServer(
      {
        env: {
          NODE_ENV: 'test',
          ALLOWED_ORIGINS: 'http://localhost:3000',
          STUN_URLS: 'stun:stun.l.google.com:19302',
          TURN_URLS: 'turn:turn.shipri.app:3478?transport=udp',
          TURN_SHARED_SECRET: 'health_check_hidden_secret',
        },
      },
      servers,
    );
    const client = await createSocketClient(server.baseUrl);
    clients.add(client);

    const created = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('Timed out waiting for room:created'));
      }, 1_000);

      client.once('room:created', (payload) => {
        clearTimeout(timer);
        resolve(payload);
      });
      client.emit('room:create', {});
    });

    const response = await fetch(`${server.baseUrl}/health`);
    const rawText = await response.text();
    const body = JSON.parse(rawText);

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(Object.keys(body)).toEqual(['status', 'roomsCount']);
    expect(body).toEqual({
      status: 'ok',
      roomsCount: 1,
    });

    expect(rawText).not.toContain(created.roomId);
    expect(rawText).not.toContain(client.id);
    expect(rawText).not.toContain('turn.shipri.app');
    expect(rawText).not.toContain('health_check_hidden_secret');
    for (const stunUrl of server.config.stunUrls) {
      expect(rawText).not.toContain(stunUrl);
    }
    expect(rawText.toLowerCase()).not.toContain('secret');
    expect(rawText.toLowerCase()).not.toContain('token');
    expect(rawText.toLowerCase()).not.toContain('credential');
  });
});
