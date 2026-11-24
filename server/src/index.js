import dotenv from 'dotenv';
import { loadConfig } from './config.js';
import { createSafeLogger } from './logger.js';
import { createSignalingServer } from './server.js';

dotenv.config();

const config = loadConfig();
const logger = createSafeLogger();
const { httpServer, close } = createSignalingServer({ ...config, logger });

let shutdownStarted = false;

async function handleShutdown(signal) {
  if (shutdownStarted) {
    return;
  }
  shutdownStarted = true;
  logger.serverShutdown(signal);
  try {
    await close();
    process.exit(0);
  } catch {
    process.exit(1);
  }
}

process.once('SIGTERM', () => {
  void handleShutdown('SIGTERM');
});
process.once('SIGINT', () => {
  void handleShutdown('SIGINT');
});

httpServer.listen(config.port, () => {
  logger.serverListening(config.port);
});
