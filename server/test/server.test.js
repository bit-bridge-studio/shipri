import { afterEach, describe, expect, test } from 'vitest';
import { createSignalingServer } from '../src/server.js';
import {
  closeSocketClients,
  createSocketClient,
} from './helpers/socket-client.js';

const clients = new Set();
const servers = new Set();

async function startIsolatedServer() {
  const server = createSignalingServer();
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

  await Promise.all(
    [...servers].map((server) => server.close()),
  );
  servers.clear();
});

describe('createSignalingServer', () => {
  test('constructs a server without listening on import or construction', () => {
    const server = createSignalingServer();
    servers.add(server);

    expect(server.app).toBeDefined();
    expect(server.httpServer).toBeDefined();
    expect(server.io).toBeDefined();
    expect(typeof server.close).toBe('function');
    expect(server.httpServer.listening).toBe(false);
  });

  test('starts on an isolated port, serves GET /health, and closes cleanly', async () => {
    const server = await startIsolatedServer();

    expect(server.httpServer.listening).toBe(true);

    const response = await fetch(`${server.baseUrl}/health`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      status: 'ok',
      roomsCount: 0,
    });

    await server.close();
    servers.delete(server);

    expect(server.httpServer.listening).toBe(false);
  });

  test('accepts Socket.IO client connections on an isolated server instance', async () => {
    const server = await startIsolatedServer();
    const client = await createSocketClient(server.baseUrl);
    clients.add(client);

    expect(client.connected).toBe(true);

    closeSocketClients(client);
    clients.delete(client);

    expect(client.connected).toBe(false);
  });
});
