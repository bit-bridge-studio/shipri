import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { build as viteBuild, createServer as createViteServer, preview as vitePreview } from 'vite';
import { createSafeLogger } from '../../../server/src/logger.js';
import { createSignalingServer } from '../../../server/src/server.js';
import { startLocalTurnServer } from './local-turn-server.js';
import { getSavedFiles, installPersistenceStub } from './persistence-stub.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CLIENT_ROOT = path.resolve(__dirname, '../..');

const ALLOWED_SIGNALING_INBOUND = new Set([
  'room:create',
  'room:join',
  'room:leave',
  'ice:get',
  'signal:forward',
]);

async function allocateEphemeralPort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close((err) => {
        if (err) {
          reject(err);
        } else {
          resolve(port);
        }
      });
    });
  });
}

function safeJsonSerialize(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Attaches non-intrusive audit listeners to HTTP and Socket.IO layers to prove
 * the signaling backend never observes board state, file metadata, or E2EE keys.
 */
function attachBackendAudit(signalingServer) {
  const httpRequests = [];
  const socketInboundEvents = [];
  const socketOutboundEvents = [];

  const handleHttpRequest = (req) => {
    httpRequests.push({
      method: req.method,
      url: req.url,
      headerNames: Object.keys(req.headers ?? {}),
      headersJson: safeJsonSerialize(req.headers ?? {}),
    });
  };
  signalingServer.httpServer.on('request', handleHttpRequest);

  const handleSocketConnection = (socket) => {
    const onAnyInbound = (event, ...args) => {
      socketInboundEvents.push({
        socketId: socket.id,
        event,
        payloadJson: safeJsonSerialize(args),
      });
    };
    socket.onAny(onAnyInbound);

    if (typeof socket.onAnyOutgoing === 'function') {
      socket.onAnyOutgoing((event, ...args) => {
        socketOutboundEvents.push({
          socketId: socket.id,
          event,
          payloadJson: safeJsonSerialize(args),
        });
      });
    }
  };
  signalingServer.io.on('connection', handleSocketConnection);

  function getSnapshot() {
    return {
      httpRequests: [...httpRequests],
      socketInboundEvents: [...socketInboundEvents],
      socketOutboundEvents: [...socketOutboundEvents],
      metrics: signalingServer.getOperationalMetrics(),
    };
  }

  function assertZeroLeakage({
    forbiddenStrings = [],
    forbiddenEventNames = [
      'PEER_HELLO',
      'BOARD_SYNC',
      'FILE_ADVERTISE',
      'FILE_REMOVE',
      'DOWNLOAD_REQUEST',
      'DOWNLOAD_ACCEPTED',
      'DOWNLOAD_REJECTED',
      'FLOW_CREDIT',
      'TRANSFER_PAUSE',
      'TRANSFER_RESUME',
      'TRANSFER_CANCEL',
      'TRANSFER_COMPLETE',
      'TRANSFER_ERROR',
      'RESUME_REQUEST',
      'RESUME_ACCEPTED',
      'RESUME_REJECTED',
    ],
  } = {}) {
    for (const entry of socketInboundEvents) {
      if (!ALLOWED_SIGNALING_INBOUND.has(entry.event)) {
        throw new Error(`Unexpected inbound Socket.IO event on backend: ${entry.event}`);
      }
    }

    const combinedText = JSON.stringify({
      httpRequests,
      socketInboundEvents,
      socketOutboundEvents,
      metrics: signalingServer.getOperationalMetrics(),
    });

    for (const ev of forbiddenEventNames) {
      if (ev && combinedText.includes(ev)) {
        throw new Error(`Forbidden protocol event leaked to backend audit: ${ev}`);
      }
    }

    for (const secret of forbiddenStrings) {
      if (typeof secret === 'string' && secret.length >= 3 && combinedText.includes(secret)) {
        throw new Error(`Forbidden plaintext/secret string leaked to backend audit: ${secret}`);
      }
    }
  }

  return Object.freeze({
    getSnapshot,
    assertZeroLeakage,
    detach() {
      signalingServer.httpServer.removeListener('request', handleHttpRequest);
      signalingServer.io.removeListener('connection', handleSocketConnection);
    },
  });
}

async function applyForcedTurnInitScript(context) {
  await context.addInitScript(() => {
    const OriginalRTCPeerConnection = window.RTCPeerConnection;
    if (typeof OriginalRTCPeerConnection !== 'function') {
      return;
    }
    function RelayForcedRTCPeerConnection(config = {}, ...rest) {
      const nextConfig =
        config && typeof config === 'object'
          ? { ...config, iceTransportPolicy: 'relay' }
          : { iceTransportPolicy: 'relay' };
      return new OriginalRTCPeerConnection(nextConfig, ...rest);
    }
    RelayForcedRTCPeerConnection.prototype = OriginalRTCPeerConnection.prototype;
    if (typeof OriginalRTCPeerConnection.generateCertificate === 'function') {
      RelayForcedRTCPeerConnection.generateCertificate =
        OriginalRTCPeerConnection.generateCertificate.bind(OriginalRTCPeerConnection);
    }
    window.RTCPeerConnection = RelayForcedRTCPeerConnection;
  });
}

/**
 * Starts an isolated local E2E peer-room environment comprising:
 * - ephemeral RFC 5389/5766 local STUN + HMAC-SHA1 TURN server
 * - production-configured Node signaling server with backend audit hooks
 * - Vite dev server or compiled bundle preview server pointing to signaling
 * - isolated Chromium peer contexts with deterministic stubs
 */
export async function startPeerRoomHarness({
  browser,
  serveBuiltBundle = false,
  requireTurn = false,
  peerAOptions = {},
  peerBOptions = {},
  createDefaultPeers = true,
  roomCreateRateLimitMax = 50,
} = {}) {
  const turnSharedSecret = randomBytes(24).toString('hex');
  const turnServer = await startLocalTurnServer({ turnSharedSecret });

  const clientPort = await allocateEphemeralPort();
  const clientUrl = `http://127.0.0.1:${clientPort}`;
  const clientLocalhostUrl = `http://localhost:${clientPort}`;

  const signalingServer = createSignalingServer({
    env: {},
    nodeEnv: 'production',
    allowedOrigins: [clientUrl, clientLocalhostUrl],
    requireRoomAuth: true,
    stunUrls: [turnServer.stunUrl],
    turnUrls: [turnServer.turnUrl],
    turnSharedSecret,
    requireTurn,
    roomCreateRateLimitMax,
    roomCreateRateLimitWindowMs: 60_000,
    logger: createSafeLogger({ sink: () => {} }),
  });

  await new Promise((resolve, reject) => {
    signalingServer.httpServer.once('error', reject);
    signalingServer.httpServer.listen(0, '127.0.0.1', () => {
      signalingServer.httpServer.removeListener('error', reject);
      resolve();
    });
  });

  const sigAddr = signalingServer.httpServer.address();
  const signalingPort = typeof sigAddr === 'object' && sigAddr ? sigAddr.port : 0;
  const signalingUrl = `http://127.0.0.1:${signalingPort}`;
  const backendAudit = attachBackendAudit(signalingServer);

  let viteServer = null;
  let previewServer = null;
  let builtOutDir = null;

  if (serveBuiltBundle) {
    builtOutDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shipri-e2e-dist-'));
    await viteBuild({
      configFile: false,
      root: CLIENT_ROOT,
      plugins: [react()],
      define: {
        'import.meta.env.VITE_SIGNALING_URL': JSON.stringify(signalingUrl),
      },
      build: {
        outDir: builtOutDir,
        emptyOutDir: true,
      },
      logLevel: 'silent',
    });
    previewServer = await vitePreview({
      configFile: false,
      root: CLIENT_ROOT,
      build: {
        outDir: builtOutDir,
      },
      preview: {
        host: '127.0.0.1',
        port: clientPort,
        strictPort: true,
      },
      logLevel: 'silent',
    });
  } else {
    viteServer = await createViteServer({
      configFile: false,
      root: CLIENT_ROOT,
      plugins: [react()],
      define: {
        'import.meta.env.VITE_SIGNALING_URL': JSON.stringify(signalingUrl),
      },
      server: {
        host: '127.0.0.1',
        port: clientPort,
        strictPort: true,
      },
      clearScreen: false,
      logLevel: 'silent',
    });
    await viteServer.listen();
  }

  const createdPeers = [];

  async function createPeerContext(targetBrowser = browser, opts = {}) {
    if (!targetBrowser) {
      throw new TypeError('Expected Playwright Browser instance.');
    }
    const context = await targetBrowser.newContext({
      viewport: opts.viewport ?? { width: 1280, height: 800 },
    });
    await installPersistenceStub(context, opts);
    if (opts.forceTurnRelay) {
      await applyForcedTurnInitScript(context);
    }
    const page = await context.newPage();
    const consoleErrors = [];
    const pageErrors = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text());
      }
    });
    page.on('pageerror', (err) => {
      pageErrors.push(String(err));
    });

    const handle = {
      context,
      page,
      consoleErrors,
      pageErrors,
      getSavedFiles: () => getSavedFiles(page),
      async close() {
        await context.close().catch(() => {});
      },
    };
    createdPeers.push(handle);
    return handle;
  }

  let peerA = null;
  let peerB = null;
  if (createDefaultPeers && browser) {
    peerA = await createPeerContext(browser, peerAOptions);
    peerB = await createPeerContext(browser, peerBOptions);
  }

  async function close() {
    for (const p of createdPeers) {
      await p.close();
    }
    createdPeers.length = 0;

    if (viteServer) {
      await viteServer.close().catch(() => {});
      viteServer = null;
    }
    if (previewServer) {
      await new Promise((resolve) => previewServer.httpServer.close(() => resolve()));
      previewServer = null;
    }
    if (builtOutDir) {
      fs.rmSync(builtOutDir, { recursive: true, force: true });
      builtOutDir = null;
    }

    backendAudit.detach();
    await signalingServer.close().catch(() => {});
    await turnServer.close().catch(() => {});
  }

  return Object.freeze({
    clientUrl,
    signalingUrl,
    builtOutDir,
    turnServer,
    signalingServer,
    backendAudit,
    peerA,
    peerB,
    createPeerContext,
    close,
  });
}
