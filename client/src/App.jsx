import React, { useEffect, useState } from 'react';
import { createSignalingClient } from './signaling/socket-client.js';

const DEFAULT_CONNECTION_STATE = Object.freeze({
  status: 'disconnected',
  connected: false,
  lastError: null,
});

function App({ signalingClient } = {}) {
  const [connectionState, setConnectionState] = useState(() =>
    signalingClient ? signalingClient.getStatus() : DEFAULT_CONNECTION_STATE,
  );

  useEffect(() => {
    const client = signalingClient ?? createSignalingClient();
    const ownsClient = !signalingClient;

    setConnectionState(client.getStatus());
    const unsubscribeStatus = client.subscribeStatus((nextState) => {
      setConnectionState(nextState);
    });

    if (ownsClient) {
      client.connect();
    }

    return () => {
      unsubscribeStatus();
      if (ownsClient) {
        client.dispose();
      }
    };
  }, [signalingClient]);

  const socketConnected = Boolean(connectionState?.connected);
  const statusText = socketConnected
    ? 'Signaling server connected'
    : connectionState?.status === 'error'
      ? 'Signaling connection error'
      : 'Connecting to signaling server...';

  return (
    <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '80vh' }}>
      <div className="glass-card" style={{ padding: '3rem', maxWidth: '500px', width: '100%' }}>
        <h1 style={{ fontSize: '3rem', margin: '0 0 10px 0' }}>
          <span className="gradient-text">Shipri</span>
        </h1>
        <p style={{ fontSize: '1.2rem', color: '#a0aab8', margin: '0 0 30px 0' }}>
          Secure, zero-knowledge P2P file sharing directly between devices.
        </p>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '10px', marginBottom: '30px' }}>
          <span className="pulse-dot" style={{ backgroundColor: socketConnected ? '#00F5D4' : '#ff0055' }}></span>
          <span style={{ fontSize: '0.9rem', color: '#8e9aa8' }}>
            {statusText}
          </span>
        </div>

        <button className="btn-primary" style={{ width: '100%' }}>
          Share a File
        </button>
      </div>
    </div>
  );
}

export default App;
