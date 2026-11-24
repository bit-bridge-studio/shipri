import { afterEach, describe, expect, test } from 'vitest';
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

afterEach(async () => {
  closeSocketClients(...clients);
  clients.clear();

  await closeIsolatedServers(servers);
});

describe('createSignalingServer', () => {
  test('constructs a server without listening on import or construction and configures trust proxy', () => {
    const server = createSignalingServer({ trustProxy: 1 });
    servers.add(server);

    expect(server.app).toBeDefined();
    expect(server.app.get('trust proxy')).toBe(1);
    expect(server.httpServer).toBeDefined();
    expect(server.io).toBeDefined();
    expect(server.roomStore).toBeDefined();
    expect(typeof server.close).toBe('function');
    expect(server.httpServer.listening).toBe(false);
  });

  test('starts on an isolated port, serves GET /health, and closes cleanly and idempotently', async () => {
    const server = await startIsolatedServer(undefined, servers);

    expect(server.httpServer.listening).toBe(true);

    const response = await fetch(`${server.baseUrl}/health`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      status: 'ok',
      roomsCount: 0,
    });

    await server.close();
    await server.close();
    servers.delete(server);

    expect(server.httpServer.listening).toBe(false);
    expect(server.activeRooms.size).toBe(0);
    expect(server.socketRooms.size).toBe(0);
  });

  test('accepts Socket.IO client connections on multiple isolated in-process servers concurrently', async () => {
    const serverA = await startIsolatedServer(undefined, servers);
    const serverB = await startIsolatedServer(undefined, servers);
    const clientA = await createSocketClient(serverA.baseUrl);
    const clientB = await createSocketClient(serverB.baseUrl);
    clients.add(clientA);
    clients.add(clientB);

    expect(clientA.connected).toBe(true);
    expect(clientB.connected).toBe(true);
    expect(serverA.baseUrl).not.toBe(serverB.baseUrl);

    closeSocketClients(clientA, clientB);
    clients.delete(clientA);
    clients.delete(clientB);

    expect(clientA.connected).toBe(false);
    expect(clientB.connected).toBe(false);
  });
});
