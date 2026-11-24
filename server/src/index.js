import dotenv from 'dotenv';
import { loadConfig } from './config.js';
import { createSafeLogger } from './logger.js';
import { createSignalingServer } from './server.js';

dotenv.config();

const config = loadConfig();
const logger = createSafeLogger();
const { httpServer } = createSignalingServer({ ...config, logger });

httpServer.listen(config.port, () => {
  logger.serverListening(config.port);
});
