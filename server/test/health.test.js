import { afterEach, describe, expect, test } from 'vitest';
import { createSignalingServer } from '../src/server.js';
import {
  closeSocketClients,
  createSocketClient,
} from './helpers/socket-client.js';

const clients = new Set();
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
  closeSocketClients(...clients);
  clients.clear();

  await Promise.all([...servers].map((server) => server.close()));
  servers.clear();
});

describe('GET /health', () => {
  test('returns 200 JSON with no-store cache header and baseline service status', async () => {
    const server = await startIsolatedServer();

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
    const server = await startIsolatedServer();
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
    for (const stunUrl of server.config.stunUrls) {
      expect(rawText).not.toContain(stunUrl);
    }
    expect(rawText.toLowerCase()).not.toContain('secret');
    expect(rawText.toLowerCase()).not.toContain('token');
    expect(rawText.toLowerCase()).not.toContain('credential');
  });
});
