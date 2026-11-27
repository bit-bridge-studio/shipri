import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { generateMasterKey } from '../src/crypto/fragment-key.js';
import { createSignalingClient } from '../src/signaling/socket-client.js';
import {
  PRODUCTION_BINARY_CHANNEL_LABEL,
  PRODUCTION_CONTROL_CHANNEL_LABEL,
} from '../src/webrtc/peer-connection.js';
import { buildQrSvgPath, encodeQrMatrix } from '../src/ui/qr-code.js';
import RoomBoardApp from '../src/ui/RoomBoardApp.jsx';
import {
  createInitialRoomBoardUiState,
  createRoomBoardController,
  parseRoomEntryInput,
} from '../src/ui/room-board-controller.js';
import { createMockSocketFactory } from './helpers/mock-socket.js';
import { createMockPeerConnectionFactory } from './helpers/mock-webrtc.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CLIENT_SRC_DIR = path.resolve(__dirname, '../src');

function sha256Base64Url(value) {
  return createHash('sha256').update(value, 'utf8').digest('base64url');
}

function createMemoryStorage() {
  const store = new Map();
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    size: () => store.size,
  };
}

function collectModuleDependencies(entryPath, visited = new Set()) {
  const absPath = path.resolve(entryPath);
  if (visited.has(absPath)) {
    return visited;
  }
  visited.add(absPath);
  const source = fs.readFileSync(absPath, 'utf8');
  const importRegex = /(?:import|export)\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g;
  let match;
  while ((match = importRegex.exec(source)) !== null) {
    const spec = match[1];
    if (!spec.startsWith('.')) {
      continue;
    }
    const candidate = path.resolve(path.dirname(absPath), spec);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      collectModuleDependencies(candidate, visited);
    }
  }
  return visited;
}

function linkReliableChannels(chA, chB) {
  const pendingToB = [];
  const pendingToA = [];
  const origSendA = chA.send.bind(chA);
  const origSendB = chB.send.bind(chB);

  chA.send = (data) => {
    origSendA(data);
    if (chB.readyState === 'open') {
      chB.simulateMessage(data);
    } else {
      pendingToB.push(data);
    }
  };
  chB.send = (data) => {
    origSendB(data);
    if (chA.readyState === 'open') {
      chA.simulateMessage(data);
    } else {
      pendingToA.push(data);
    }
  };

  return {
    openBoth() {
      chA.simulateOpen();
      chB.simulateOpen();
      while (pendingToB.length > 0) {
        chB.simulateMessage(pendingToB.shift());
      }
      while (pendingToA.length > 0) {
        chA.simulateMessage(pendingToA.shift());
      }
    },
  };
}

function createAuthRelaySocketFactory() {
  const baseFactory = createMockSocketFactory({ idPrefix: 'ux-peer' });
  const rooms = new Map();
  const recordedEmits = [];
  let roomSeq = 0x6100;
  let peerSeq = 1;

  function ioFactory(url, options) {
    const socket = baseFactory(url, options);
    const origEmit = socket.emit.bind(socket);

    socket.emit = (event, ...args) => {
      recordedEmits.push({ event, args });
      origEmit(event, ...args);
      const payload = args[0];

      if (event === 'room:create') {
        const roomId = `ship-${(roomSeq++).toString(16).padStart(4, '0')}`;
        const peerId = `peer-${peerSeq++}`;
        rooms.set(roomId, {
          authVerifier: payload.authVerifier,
          peers: [{ socket, peerId }],
        });
        queueMicrotask(() => {
          socket.simulateServerEvent('room:created', {
            roomId,
            peerId,
            negotiationDuty: 'offerer',
          });
        });
      }

      if (event === 'room:join') {
        const room = rooms.get(payload?.roomId);
        if (!room || sha256Base64Url(payload.authToken) !== room.authVerifier) {
          queueMicrotask(() => {
            socket.simulateServerEvent('room:error', {
              roomId: payload?.roomId,
              code: 'UNAUTHORIZED',
              message: 'Invalid room token.',
            });
          });
          return socket;
        }
        const peerId = `peer-${peerSeq++}`;
        const existing = room.peers[0];
        room.peers.push({ socket, peerId });
        queueMicrotask(() => {
          socket.simulateServerEvent('room:joined', {
            roomId: payload.roomId,
            peerId,
            negotiationDuty: 'answerer',
          });
          existing?.socket.simulateServerEvent('peer:joined', {
            roomId: payload.roomId,
            peerId,
          });
        });
      }

      if (event === 'ice:get') {
        queueMicrotask(() => {
          socket.simulateServerEvent('ice:credentials', {
            roomId: payload.roomId,
            iceServers: [{ urls: ['stun:stun.shipri.test:3478'] }],
          });
        });
      }

      if (event === 'signal:forward') {
        const room = rooms.get(payload?.roomId);
        const sender = room?.peers.find((p) => p.socket === socket);
        const target = room?.peers.find((p) => p.socket !== socket);
        if (sender && target) {
          queueMicrotask(() => {
            target.socket.simulateServerEvent('signal:receive', {
              roomId: payload.roomId,
              peerId: sender.peerId,
              signalData: payload.signalData,
            });
          });
        }
      }

      return socket;
    };

    return socket;
  }

  ioFactory.recordedEmits = recordedEmits;
  return ioFactory;
}

describe('Accessible shared room-board UX (ticket [55])', () => {
  it('generates offline ISO/IEC 18004 QR matrices and SVG paths for #key= invite links', () => {
    const sampleUrl =
      'https://shipri.app/room/ship-a1b2#key=0123456789abcdef0123456789abcdef0123456789a';
    const qr = encodeQrMatrix(sampleUrl);

    expect(qr.version).toBeGreaterThanOrEqual(4);
    expect(qr.version).toBeLessThanOrEqual(9);
    expect(qr.size).toBe(qr.version * 4 + 17);
    expect(qr.matrix).toHaveLength(qr.size);

    // Top-left 7x7 finder outer ring + center dark 3x3
    expect(qr.matrix[0][0]).toBe(1);
    expect(qr.matrix[0][6]).toBe(1);
    expect(qr.matrix[6][0]).toBe(1);
    expect(qr.matrix[1][1]).toBe(0);
    expect(qr.matrix[3][3]).toBe(1);
    // Fixed dark module at (4*version + 9, 8)
    expect(qr.matrix[4 * qr.version + 9][8]).toBe(1);

    const svgPath = buildQrSvgPath(qr.matrix);
    expect(svgPath.startsWith('M')).toBe(true);
    expect(svgPath.length).toBeGreaterThan(200);
    expect(() => encodeQrMatrix('')).toThrow(RangeError);
  });

  it('keeps main.jsx and ui/ modules strictly isolated from prototype shell modules', () => {
    const mainDeps = collectModuleDependencies(path.join(CLIENT_SRC_DIR, 'main.jsx'));
    const depPaths = Array.from(mainDeps, (p) =>
      path.relative(CLIENT_SRC_DIR, p).replace(/\\/g, '/'),
    );

    expect(depPaths).toContain('ui/RoomBoardApp.jsx');
    expect(depPaths).not.toContain('App.jsx');
    expect(depPaths.some((p) => p.startsWith('prototype/'))).toBe(false);

    const css = fs.readFileSync(path.join(CLIENT_SRC_DIR, 'index.css'), 'utf8');
    expect(css).toContain('.board-shell');
    expect(css).toContain(':focus-visible');
    expect(css).toContain('@media (max-width: 768px)');
  });

  it('renders accessible entry, waiting, TURN relay, shared board, unavailable-peer, error copy, and transfer rows without sender/receiver roles', () => {
    const entryMarkup = renderToStaticMarkup(
      React.createElement(RoomBoardApp, {
        initialState: createInitialRoomBoardUiState({
          connectionStatus: 'connected',
        }),
      }),
    );
    expect(entryMarkup).toContain('Shipri');
    expect(entryMarkup).toContain('Create Room');
    expect(entryMarkup).toContain('Join Room');
    expect(entryMarkup).not.toContain('Diagnostic Prototype Shell');
    expect(entryMarkup).not.toContain('Sender Mode');
    expect(entryMarkup).not.toContain('Receiver Mode');

    const shareUrl =
      'https://shipri.app/room/ship-77aa#key=0123456789abcdef0123456789abcdef0123456789a';
    const boardState = createInitialRoomBoardUiState({
      connectionStatus: 'connected',
      peerState: 'connected',
      roomId: 'ship-77aa',
      peerReady: true,
      remoteSyncState: 'peer_disconnected_grace',
      shareUrl,
      qrVisible: true,
      selectedPath: {
        mode: 'relay',
        relayed: true,
        localCandidateType: 'relay',
        remoteCandidateType: 'relay',
      },
      capability: {
        supported: false,
        mode: 'unsupported',
        reason: 'MISSING_FILE_SYSTEM_ACCESS_API',
        guidance:
          'This browser does not support window.showSaveFilePicker() for direct-to-disk streaming.',
      },
      statusAnnouncement: 'TURN relay active. Waiting for remote peer to reconnect.',
      errorBanner: {
        code: 'DIRECTION_BUSY',
        title: 'Download already in progress',
        message: 'Finish or cancel the current incoming download before starting another.',
      },
      localFiles: [
        {
          fileId: 'aaaaaaaaaaaaaaaaaaaaaa',
          fileName: 'design-spec.pdf',
          fileSize: 2048,
          fileType: 'application/pdf',
          availability: 'available',
        },
      ],
      remoteFiles: [
        {
          fileId: 'bbbbbbbbbbbbbbbbbbbbbb',
          fileName: 'photo.png',
          fileSize: 4096,
          fileType: 'image/png',
          availability: 'unavailable_reconnecting',
        },
      ],
      transfers: [
        {
          transferId: 't-out-1',
          fileId: 'aaaaaaaaaaaaaaaaaaaaaa',
          fileName: 'design-spec.pdf',
          totalBytes: 2048,
          bytesTransferred: 1024,
          progressPercent: 50,
          bytesPerSecond: 1024,
          etaSeconds: 1,
          role: 'owner',
          directionLabel: 'sending',
          state: 'active',
        },
        {
          transferId: 't-in-1',
          fileId: 'bbbbbbbbbbbbbbbbbbbbbb',
          fileName: 'photo.png',
          totalBytes: 4096,
          bytesTransferred: 2048,
          progressPercent: 50,
          bytesPerSecond: 0,
          etaSeconds: null,
          role: 'downloader',
          directionLabel: 'downloading',
          state: 'paused_by_user',
        },
      ],
    });

    const boardMarkup = renderToStaticMarkup(
      React.createElement(RoomBoardApp, { initialState: boardState }),
    );
    expect(boardMarkup).toContain('role="status"');
    expect(boardMarkup).toContain('role="alert"');
    expect(boardMarkup).toContain('TURN Relay');
    expect(boardMarkup).toContain('Copy Share Link');
    expect(boardMarkup).toContain('Hide QR Code');
    expect(boardMarkup).toContain('Room invite QR code');
    expect(boardMarkup).toContain('Shared by you');
    expect(boardMarkup).toContain('Available from peer');
    expect(boardMarkup).toContain('design-spec.pdf');
    expect(boardMarkup).toContain('photo.png');
    expect(boardMarkup).toContain('Unavailable');
    expect(boardMarkup).toContain('tabindex="0"');
    expect(boardMarkup).toContain('role="progressbar"');
    expect(boardMarkup).toContain('Pause');
    expect(boardMarkup).toContain('Resume');
    expect(boardMarkup).toContain('Cancel');
    expect(boardMarkup).toContain('showSaveFilePicker');
  });

  it('connects two peers cleanly via share URL, strips #key=, shares files, and completes download with zero leaked keys or filenames', async () => {
    const sampleKey = generateMasterKey().masterKeyBase64Url;
    const parsedLink = parseRoomEntryInput(
      `https://shipri.app/room/ship-a1b2#key=${sampleKey}`,
      { origin: 'https://shipri.app' },
    );
    expect(parsedLink).toEqual({
      ok: true,
      roomId: 'ship-a1b2',
      masterKeyBase64Url: sampleKey,
    });

    const ioFactory = createAuthRelaySocketFactory();
    const clientA = createSignalingClient({ url: 'https://shipri.app', ioFactory });
    const clientB = createSignalingClient({ url: 'https://shipri.app', ioFactory });

    const locA = { origin: 'https://shipri.app', pathname: '/', search: '', hash: '' };
    const locB = { origin: 'https://shipri.app', pathname: '/', search: '', hash: '' };
    const storageA = createMemoryStorage();
    const storageB = createMemoryStorage();

    const savedBytes = [];
    const saveWindowB = {
      isSecureContext: true,
      showSaveFilePicker: vi.fn(async () => ({
        async createWritable() {
          return {
            async write(chunk) {
              savedBytes.push(new Uint8Array(chunk));
            },
            async close() {},
            async abort() {},
          };
        },
      })),
    };

    const controllerA = createRoomBoardController({
      signalingClient: clientA,
      peerConnectionFactory: createMockPeerConnectionFactory(),
      storage: storageA,
      locationObj: locA,
      historyObj: { replaceState: () => {} },
      windowObj: { isSecureContext: true },
      navigatorObj: {},
      origin: 'https://shipri.app',
      autoConnect: true,
    });

    const controllerB = createRoomBoardController({
      signalingClient: clientB,
      peerConnectionFactory: createMockPeerConnectionFactory(),
      storage: storageB,
      locationObj: locB,
      historyObj: {
        replaceState: () => {
          locB.hash = '';
        },
      },
      windowObj: saveWindowB,
      navigatorObj: {},
      origin: 'https://shipri.app',
      autoConnect: false,
    });

    await controllerA.createRoom();
    await vi.waitFor(() => {
      expect(controllerA.getState().roomId).toMatch(/^ship-[a-f0-9]{4}$/);
      expect(controllerA.getState().hasShareUrl).toBe(true);
    });

    const copied = [];
    await controllerA.copyShareLink({
      writeText: async (text) => copied.push(text),
    });
    expect(copied).toHaveLength(1);
    const shareUrl = copied[0];
    expect(shareUrl).toContain('#key=');

    controllerA.toggleQrCode(true);
    expect(controllerA.getState().qrPayload?.path).toBeTruthy();
    controllerA.toggleQrCode(false);

    // Simulate joining by pasting full invite URL while locationObj stays at '/'
    clientB.connect();
    await controllerB.joinRoom(shareUrl);

    await vi.waitFor(() => {
      expect(controllerB.getState().roomId).toBe(controllerA.getState().roomId);
    });
    expect(locB.hash).toBe('');
    expect(storageB.size()).toBe(1);

    // Wire reliable mock WebRTC channels between Peer A and Peer B
    const pmA = controllerA.getConnection().getPeerManager();
    const pmB = controllerB.getConnection().getPeerManager();
    await vi.waitFor(() => {
      expect(pmA.getPeerConnection()).not.toBeNull();
      expect(pmB.getPeerConnection()).not.toBeNull();
    });

    const ctrlA = pmA.getChannel(PRODUCTION_CONTROL_CHANNEL_LABEL);
    const binA = pmA.getChannel(PRODUCTION_BINARY_CHANNEL_LABEL);
    const pcB = pmB.getPeerConnection();
    const ctrlB = pcB.simulateRemoteDataChannel(PRODUCTION_CONTROL_CHANNEL_LABEL);
    const binB = pcB.simulateRemoteDataChannel(PRODUCTION_BINARY_CHANNEL_LABEL);

    const ctrlLink = linkReliableChannels(ctrlA, ctrlB);
    const binLink = linkReliableChannels(binA, binB);
    ctrlLink.openBoth();
    binLink.openBoth();

    await vi.waitFor(() => {
      expect(controllerA.getState().peerReady).toBe(true);
      expect(controllerB.getState().peerReady).toBe(true);
    });

    // Peer A shares secret-report.txt
    const payload = new TextEncoder().encode('equal peer encrypted board payload');
    await controllerA.addLocalFiles([
      {
        name: 'secret-report.txt',
        size: payload.byteLength,
        type: 'text/plain',
        lastModified: 1_785_700_000_000,
        slice(start = 0, end = payload.byteLength) {
          const sub = payload.slice(start, end);
          return {
            async arrayBuffer() {
              return sub.buffer.slice(sub.byteOffset, sub.byteOffset + sub.byteLength);
            },
          };
        },
      },
    ]);

    await vi.waitFor(() => {
      expect(controllerB.getState().remoteFiles).toHaveLength(1);
    });
    expect(controllerB.getState().remoteFiles[0].fileName).toBe('secret-report.txt');

    // Peer B clicks Download and writes decrypted bytes via showSaveFilePicker
    const remoteFileId = controllerB.getState().remoteFiles[0].fileId;
    const dlResult = await controllerB.downloadRemoteFile(remoteFileId);
    expect(dlResult.ok).toBe(true);

    await vi.waitFor(() => {
      expect(controllerB.getState().transfers[0]?.state).toBe('completed');
      expect(controllerA.getState().transfers[0]?.state).toBe('completed');
    });

    const totalLen = savedBytes.reduce((sum, c) => sum + c.byteLength, 0);
    const merged = new Uint8Array(totalLen);
    let offset = 0;
    for (const chunk of savedBytes) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    expect(merged.byteLength).toBe(payload.byteLength);
    expect(Buffer.compare(merged, payload)).toBe(0);

    // Verify UI state snapshots, connection snapshots, and Socket.IO emits never leak #key, filename, or contents
    const emitsJson = JSON.stringify(ioFactory.recordedEmits);
    const rawKey = new URL(shareUrl).hash.slice('#key='.length);
    const controllerAStateJson = JSON.stringify(controllerA.getState());
    const controllerBStateJson = JSON.stringify(controllerB.getState());
    const connAStateJson = JSON.stringify(controllerA.getConnection().getState());
    expect(controllerB.getState().hasShareUrl).toBe(true);
    expect(controllerAStateJson).not.toContain(rawKey);
    expect(controllerBStateJson).not.toContain(rawKey);
    expect(connAStateJson).not.toContain(rawKey);
    expect(emitsJson).not.toContain(rawKey);
    expect(emitsJson).not.toContain('secret-report.txt');
    expect(emitsJson).not.toContain('equal peer encrypted board payload');

    controllerA.dispose();
    controllerB.dispose();
    clientA.dispose();
    clientB.dispose();
  });
});
