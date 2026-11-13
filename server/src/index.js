import dotenv from 'dotenv';
import { createSignalingServer } from './server.js';

dotenv.config();

const PORT = process.env.PORT || 5001;
const { httpServer } = createSignalingServer();

httpServer.listen(PORT, () => {
  console.log(`Signaling server listening on port ${PORT}`);
});
