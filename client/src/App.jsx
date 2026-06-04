import React, { useState, useEffect } from 'react';
import { io } from 'socket.io-client';

function App() {
  const [socketConnected, setSocketConnected] = useState(false);
  const [socket, setSocket] = useState(null);

  useEffect(() => {
    // Connect to signaling server (default development port 5001)
    const newSocket = io(import.meta.env.VITE_SIGNALING_URL || 'http://localhost:5001');
    setSocket(newSocket);

    newSocket.on('connect', () => {
      setSocketConnected(true);
    });

    newSocket.on('disconnect', () => {
      setSocketConnected(false);
    });

    return () => {
      newSocket.disconnect();
    };
  }, []);

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
            {socketConnected ? 'Signaling server connected' : 'Connecting to signaling server...'}
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
