import { createSignalingServer } from '../../src/server.js';

export async function startIsolatedServer(options, registry) {
  const server = createSignalingServer(options);
  if (registry) {
    registry.add(server);
  }

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

export async function closeIsolatedServers(registry) {
  await Promise.all([...registry].map((server) => server.close()));
  registry.clear();
}
