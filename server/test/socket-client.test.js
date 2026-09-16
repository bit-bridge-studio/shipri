import { createServer } from 'node:http';
import { afterEach, describe, expect, test } from 'vitest';
import { Server } from 'socket.io';
import {
  closeSocketClients,
  createSocketClient,
} from './helpers/socket-client.js';

const clients = new Set();
const servers = new Set();

afterEach(async () => {
  closeSocketClients(...clients);
  clients.clear();

  await Promise.all(
    [...servers].map(
      (server) => new Promise((resolve) => server.close(resolve)),
    ),
  );
  servers.clear();
});

describe('Socket.IO test client helpers', () => {
  test('create a connected client and close it cleanly', async () => {
    const httpServer = createServer();
    const io = new Server(httpServer);

    await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    servers.add(io);

    const address = httpServer.address();
    const client = await createSocketClient(`http://127.0.0.1:${address.port}`);
    clients.add(client);

    expect(client.connected).toBe(true);

    closeSocketClients(client);
    clients.delete(client);

    expect(client.connected).toBe(false);
  });
});
