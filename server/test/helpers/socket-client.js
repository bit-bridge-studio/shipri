import { io } from 'socket.io-client';

export function createSocketClient(url, options = {}) {
  const socket = io(url, {
    forceNew: true,
    reconnection: false,
    timeout: 1_000,
    ...options,
    autoConnect: false,
  });

  return new Promise((resolve, reject) => {
    const removeConnectionListeners = () => {
      socket.off('connect', handleConnect);
      socket.off('connect_error', handleConnectError);
    };
    const handleConnect = () => {
      removeConnectionListeners();
      resolve(socket);
    };
    const handleConnectError = (error) => {
      removeConnectionListeners();
      socket.close();
      reject(error);
    };

    socket.once('connect', handleConnect);
    socket.once('connect_error', handleConnectError);
    socket.connect();
  });
}

export function closeSocketClients(...sockets) {
  for (const socket of sockets) {
    if (!socket) {
      continue;
    }

    socket.removeAllListeners();
    socket.disconnect();
  }
}
