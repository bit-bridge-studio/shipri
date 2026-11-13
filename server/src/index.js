import dotenv from 'dotenv';
import { loadConfig } from './config.js';
import { createSignalingServer } from './server.js';

dotenv.config();

const config = loadConfig();
const { httpServer } = createSignalingServer(config);

httpServer.listen(config.port, () => {
  console.log(`Signaling server listening on port ${config.port}`);
});
