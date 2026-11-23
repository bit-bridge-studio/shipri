import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, test, vi } from 'vitest';
import App from '../src/App.jsx';
import { createDiagnosticChannelController } from '../src/prototype/diagnostic-channel.js';
import {
  applyDiagnosticChannelState,
  applyWebRtcState,
  bindSignalingClient,
  createInitialPrototypeState,
  createRoomLifecycleActions,
} from '../src/prototype/diagnostic-state.js';
import { createWebRtcHarness } from '../src/prototype/webrtc-harness.js';
import {
  DEFAULT_SIGNALING_URL,
  createSignalingClient,
  resolveSignalingUrl,
} from '../src/signaling/socket-client.js';
import { createMockSocketFactory } from './helpers/mock-socket.js';
import { createMockPeerConnectionFactory } from './helpers/mock-webrtc.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../..');

function readRepoFile(relativePath) {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');
}

async function flushMicrotasks(rounds = 32) {
  for (let i = 0; i < rounds; i += 1) {
    await Promise.resolve();
  }
}

function linkMockDataChannels(channelA, channelB) {
  const originalSendA = channelA.send.bind(channelA);
  const originalSendB = channelB.send.bind(channelB);

  channelA.send = (data) => {
    originalSendA(data);
    if (channelB.readyState === 'open') {
      channelB.simulateMessage(data);
    }
  };

  channelB.send = (data) => {
    originalSendB(data);
    if (channelA.readyState === 'open') {
      channelA.simulateMessage(data);
    }
  };
}

function createReactStateHarness(initialOverrides = {}) {
  let state = createInitialPrototypeState(initialOverrides);
  const setState = (updater) => {
    state = typeof updater === 'function' ? updater(state) : updater;
  };
  return {
    getState: () => state,
    setState,
  };
}

function createStagingRelayMockSocketFactory() {
  const baseFactory = createMockSocketFactory({ idPrefix: 'staging-peer' });
  const rooms = new Map();
  const socketToRoom = new Map();
  let roomSequence = 0;

  function removeSocketFromRoom(socket) {
    const roomId = socketToRoom.get(socket);
    if (!roomId) {
      return;
    }
    socketToRoom.delete(socket);
    const room = rooms.get(roomId);
    if (!room) {
      return;
    }
    const departedMember = room.members.find((entry) => entry.socket === socket);
    room.members = room.members.filter((entry) => entry.socket !== socket);
    if (room.members.length === 0) {
      rooms.delete(roomId);
      return;
    }
    const remaining = room.members[0];
    queueMicrotask(() => {
      remaining.socket.simulateServerEvent('peer:left', {
        roomId,
        peerId: departedMember?.peerId ?? socket.id,
        reason: 'leave',
      });
    });
  }

  function stagingIoFactory(url, options) {
    const socket = baseFactory(url, options);
    const originalEmit = socket.emit.bind(socket);

    socket.emit = (event, ...args) => {
      originalEmit(event, ...args);
      const payload = args[0];

      if (event === 'room:create') {
        roomSequence += 1;
        const roomId = `ship-${(0x83a0 + roomSequence).toString(16).padStart(4, '0')}`;
        const peerId = `${socket.id}-a`;
        rooms.set(roomId, {
          roomId,
          members: [{ socket, peerId }],
        });
        socketToRoom.set(socket, roomId);
        queueMicrotask(() => {
          socket.simulateServerEvent('room:created', {
            roomId,
            peerId,
            negotiationDuty: 'offerer',
          });
        });
      }

      if (event === 'room:join') {
        const roomId = payload?.roomId;
        const room = rooms.get(roomId);
        if (!room) {
          queueMicrotask(() => {
            socket.simulateServerEvent('room:error', {
              roomId,
              code: 'ROOM_NOT_FOUND',
              message: 'Room does not exist or has expired.',
            });
          });
          return socket;
        }
        if (room.members.length >= 2) {
          queueMicrotask(() => {
            socket.simulateServerEvent('room:error', {
              roomId,
              code: 'ROOM_FULL',
              message: 'This room already has two active peers.',
            });
          });
          return socket;
        }

        const peerId = `${socket.id}-b`;
        const existingMember = room.members[0];
        room.members.push({ socket, peerId });
        socketToRoom.set(socket, roomId);
        queueMicrotask(() => {
          socket.simulateServerEvent('room:joined', {
            roomId,
            peerId,
            negotiationDuty: 'answerer',
          });
          existingMember.socket.simulateServerEvent('peer:joined', {
            roomId,
            peerId,
          });
        });
      }

      if (event === 'ice:get') {
        const roomId = payload?.roomId;
        queueMicrotask(() => {
          socket.simulateServerEvent('ice:credentials', {
            roomId,
            iceServers: [
              {
                urls: [
                  'stun:stun.l.google.com:19302',
                  'stun:stun1.l.google.com:19302',
                ],
              },
            ],
          });
        });
      }

      if (event === 'signal:forward') {
        const roomId = payload?.roomId;
        const room = rooms.get(roomId);
        const sender = room?.members.find((entry) => entry.socket === socket);
        const remote = room?.members.find((entry) => entry.socket !== socket);
        if (room && sender && remote) {
          queueMicrotask(() => {
            remote.socket.simulateServerEvent('signal:receive', {
              roomId,
              peerId: sender.peerId,
              signalData: payload.signalData,
            });
          });
        }
      }

      if (event === 'room:leave') {
        removeSocketFromRoom(socket);
      }

      return socket;
    };

    return socket;
  }

  stagingIoFactory.calls = baseFactory.calls;
  stagingIoFactory.getActiveRoomCount = () => rooms.size;
  stagingIoFactory.getRoomMemberCount = (roomId) =>
    rooms.get(roomId)?.members.length ?? 0;

  return stagingIoFactory;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('POC staging signaling URL resolution and HTTPS same-origin fallback', () => {
  test('resolves remote HTTPS origin via locationOrigin option or window.location when VITE_SIGNALING_URL is omitted', () => {
    expect(resolveSignalingUrl({})).toBe(DEFAULT_SIGNALING_URL);
    expect(
      resolveSignalingUrl({}, { locationOrigin: 'https://poc.shipri.app' }),
    ).toBe('https://poc.shipri.app');
    expect(
      resolveSignalingUrl(
        { VITE_SIGNALING_URL: '   ' },
        { locationOrigin: 'https://poc.shipri.app/' },
      ),
    ).toBe('https://poc.shipri.app');
    expect(
      resolveSignalingUrl({}, { fallbackOrigin: 'https://poc.shipri.app:8443/' }),
    ).toBe('https://poc.shipri.app:8443');

    vi.stubGlobal('window', {
      location: { origin: 'https://poc.shipri.app' },
    });
    expect(resolveSignalingUrl({})).toBe('https://poc.shipri.app');

    const ioFactory = createMockSocketFactory();
    const client = createSignalingClient({ env: {}, ioFactory });
    expect(client.getUrl()).toBe('https://poc.shipri.app');
    client.dispose();
  });

  test('ignores non-HTTPS, localhost, and malformed fallback origins and prefers explicit VITE_SIGNALING_URL', () => {
    vi.stubGlobal('window', {
      location: { origin: 'http://localhost:3000' },
    });
    expect(resolveSignalingUrl({})).toBe('http://localhost:5001');

    vi.stubGlobal('window', {
      location: { origin: 'https://localhost:5173' },
    });
    expect(resolveSignalingUrl({})).toBe('http://localhost:5001');

    vi.stubGlobal('window', {
      location: { origin: 'https://127.0.0.1:5173' },
    });
    expect(resolveSignalingUrl({})).toBe('http://localhost:5001');

    vi.stubGlobal('window', {
      location: { origin: 'https://[::1]:5173' },
    });
    expect(resolveSignalingUrl({})).toBe('http://localhost:5001');

    vi.stubGlobal('window', {
      location: { origin: 'http://poc.shipri.app' },
    });
    expect(resolveSignalingUrl({})).toBe('http://localhost:5001');

    expect(
      resolveSignalingUrl({}, { locationOrigin: 'https://user:pass@poc.shipri.app' }),
    ).toBe('http://localhost:5001');
    expect(
      resolveSignalingUrl({}, { locationOrigin: 'https://poc.shipri.app/app' }),
    ).toBe('http://localhost:5001');
    expect(
      resolveSignalingUrl({}, { locationOrigin: 'null' }),
    ).toBe('http://localhost:5001');

    vi.stubGlobal('window', {
      location: { origin: 'https://poc.shipri.app' },
    });
    expect(
      resolveSignalingUrl(
        { VITE_SIGNALING_URL: 'http://localhost:5001' },
        { locationOrigin: 'https://poc.shipri.app' },
      ),
    ).toBe('http://localhost:5001');
    expect(
      resolveSignalingUrl(
        { VITE_SIGNALING_URL: 'https://custom.shipri.app/' },
        { locationOrigin: 'https://poc.shipri.app' },
      ),
    ).toBe('https://custom.shipri.app');
    expect(() =>
      resolveSignalingUrl(
        { VITE_SIGNALING_URL: 'ws://poc.shipri.app' },
        { locationOrigin: 'https://poc.shipri.app' },
      ),
    ).toThrow(/http/i);
  });
});

describe('POC staging Docker and Compose build configuration', () => {
  test('client/Dockerfile declares VITE_SIGNALING_URL build ARG and ENV defaulting to https://poc.shipri.app before npm run build', () => {
    const dockerfile = readRepoFile('client/Dockerfile');

    const argMatch = dockerfile.match(
      /^ARG\s+VITE_SIGNALING_URL=https:\/\/poc\.shipri\.app\s*$/m,
    );
    const envMatch = dockerfile.match(
      /^ENV\s+VITE_SIGNALING_URL=\$\{?VITE_SIGNALING_URL\}?\s*$/m,
    );
    const buildMatch = dockerfile.match(/^RUN\s+npm\s+run\s+build\s*$/m);

    expect(argMatch).not.toBeNull();
    expect(envMatch).not.toBeNull();
    expect(buildMatch).not.toBeNull();
    expect(argMatch.index).toBeLessThan(envMatch.index);
    expect(envMatch.index).toBeLessThan(buildMatch.index);
  });

  test('docker-compose.prod.yml and docker-compose.yml pass VITE_SIGNALING_URL defaulting to https://poc.shipri.app without host 5001 or TURN secrets', () => {
    const prodCompose = readRepoFile('docker-compose.prod.yml');
    const standaloneCompose = readRepoFile('docker-compose.yml');

    const expectedBuildArgPattern =
      /client:[\s\S]*build:[\s\S]*args:[\s\S]*VITE_SIGNALING_URL(?:\s*:\s*|=\s*)\$\{VITE_SIGNALING_URL:-https:\/\/poc\.shipri\.app\}/;

    expect(prodCompose).toMatch(expectedBuildArgPattern);
    expect(standaloneCompose).toMatch(expectedBuildArgPattern);

    expect(prodCompose).not.toMatch(/^\s*ports:/m);
    expect(prodCompose).not.toContain('TURN_SHARED_SECRET');
    expect(prodCompose).not.toContain('coturn');

    expect(standaloneCompose).not.toMatch(/5001:5001/);
    expect(standaloneCompose).not.toContain('TURN_SHARED_SECRET');
    expect(standaloneCompose).toMatch(
      /coturn:[\s\S]*profiles:\s*\n\s*-\s*turn|coturn:[\s\S]*profiles:\s*\[\s*["']?turn["']?\s*\]/,
    );
  });
});

describe('two-remote-peer POC staging prototype integration', () => {
  test('two peers configured against https://poc.shipri.app create, join, negotiate, exchange bidirectional diagnostic messages, redact logs, and leave cleanly', async () => {
    const ioFactory = createStagingRelayMockSocketFactory();
    let clockAMs = 1_700_100_000_000;
    let clockBMs = 1_700_105_000_000;
    let tick = 0;
    const nowIso = () =>
      `2026-11-23T16:00:${String(tick++).padStart(2, '0')}.000Z`;

    const reactA = createReactStateHarness();
    const reactB = createReactStateHarness();

    const clientA = createSignalingClient({
      env: { VITE_SIGNALING_URL: 'https://poc.shipri.app' },
      ioFactory,
      now: nowIso,
    });
    const clientB = createSignalingClient({
      env: {},
      locationOrigin: 'https://poc.shipri.app',
      ioFactory,
      now: nowIso,
    });

    expect(clientA.getUrl()).toBe('https://poc.shipri.app');
    expect(clientB.getUrl()).toBe('https://poc.shipri.app');

    const unbindA = bindSignalingClient(clientA, reactA.setState);
    const unbindB = bindSignalingClient(clientB, reactB.setState);
    const actionsA = createRoomLifecycleActions(clientA, reactA.setState);
    const actionsB = createRoomLifecycleActions(clientB, reactB.setState);

    const controllerA = createDiagnosticChannelController({
      signalingClient: clientA,
      now: () => clockAMs,
      onStateChange: (nextChannel) => {
        reactA.setState((prev) => applyDiagnosticChannelState(prev, nextChannel));
      },
    });
    const controllerB = createDiagnosticChannelController({
      signalingClient: clientB,
      now: () => clockBMs,
      onStateChange: (nextChannel) => {
        reactB.setState((prev) => applyDiagnosticChannelState(prev, nextChannel));
      },
    });

    const pcFactoryA = createMockPeerConnectionFactory();
    const pcFactoryB = createMockPeerConnectionFactory();

    const harnessA = createWebRtcHarness({
      signalingClient: clientA,
      peerConnectionFactory: pcFactoryA,
      onStateChange: (nextWebRtc) => {
        reactA.setState((prev) => applyWebRtcState(prev, nextWebRtc));
      },
      onDataChannel: (channel, meta) => controllerA.attachChannel(channel, meta),
    });
    const harnessB = createWebRtcHarness({
      signalingClient: clientB,
      peerConnectionFactory: pcFactoryB,
      onStateChange: (nextWebRtc) => {
        reactB.setState((prev) => applyWebRtcState(prev, nextWebRtc));
      },
      onDataChannel: (channel, meta) => controllerB.attachChannel(channel, meta),
    });

    clientA.connect();
    clientB.connect();
    expect(ioFactory.calls.map((entry) => entry.url)).toEqual([
      'https://poc.shipri.app',
      'https://poc.shipri.app',
    ]);

    actionsA.createRoom();
    await flushMicrotasks();

    const roomId = reactA.getState().roomId;
    expect(roomId).toMatch(/^ship-[a-f0-9]{4}$/);
    expect(reactA.getState()).toMatchObject({
      connectionStatus: 'connected',
      peerState: 'waiting_for_peer',
      entryRole: 'creator',
      negotiationDuty: 'offerer',
    });

    actionsB.joinRoom(roomId);
    await flushMicrotasks();

    expect(reactA.getState()).toMatchObject({
      roomId,
      peerState: 'connected',
      negotiationDuty: 'offerer',
      iceDiagnostics: {
        status: 'ready',
        isStunOnly: true,
        serverEntryCount: 1,
        endpointCount: 2,
        schemes: ['stun'],
        stunCount: 2,
        turnCount: 0,
      },
    });
    expect(reactB.getState()).toMatchObject({
      roomId,
      peerState: 'connected',
      entryRole: 'joiner',
      negotiationDuty: 'answerer',
      iceDiagnostics: {
        status: 'ready',
        isStunOnly: true,
        serverEntryCount: 1,
        endpointCount: 2,
        schemes: ['stun'],
        stunCount: 2,
        turnCount: 0,
      },
    });

    const pcA = pcFactoryA.lastInstance;
    const pcB = pcFactoryB.lastInstance;
    expect(pcA).not.toBeNull();
    expect(pcB).not.toBeNull();

    pcA.simulateIceCandidate({
      candidate: 'candidate:1 1 UDP 2122252543 198.51.100.42 55100 typ srflx',
      sdpMid: '0',
      sdpMLineIndex: 0,
    });
    pcB.simulateIceCandidate({
      candidate: 'candidate:1 1 UDP 2122252543 203.0.113.77 55200 typ srflx',
      sdpMid: '0',
      sdpMLineIndex: 0,
    });
    pcA.simulateIceCandidate(null);
    pcB.simulateIceCandidate(null);
    await flushMicrotasks();

    expect(pcB.addedIceCandidates).toHaveLength(1);
    expect(pcA.addedIceCandidates).toHaveLength(1);
    expect(reactA.getState().webrtc).toMatchObject({
      localDescriptionForwarded: true,
      localCandidatesSent: 1,
      remoteCandidatesReceived: 1,
      remoteCandidatesApplied: 1,
      iceGatheringState: 'complete',
    });
    expect(reactB.getState().webrtc).toMatchObject({
      localDescriptionForwarded: true,
      localCandidatesSent: 1,
      remoteCandidatesReceived: 1,
      remoteCandidatesApplied: 1,
      iceGatheringState: 'complete',
    });

    const channelA = pcA.createdDataChannels[0];
    expect(channelA).toBeDefined();
    expect(channelA.label).toBe('shipri-diagnostic');
    const channelB = pcB.simulateRemoteDataChannel('shipri-diagnostic', {
      ordered: true,
    });
    linkMockDataChannels(channelA, channelB);
    channelA.simulateOpen();
    channelB.simulateOpen();
    pcA.simulateIceConnectionStateChange('connected');
    pcA.simulateConnectionStateChange('connected');
    pcB.simulateIceConnectionStateChange('connected');
    pcB.simulateConnectionStateChange('connected');

    expect(reactA.getState().webrtc).toMatchObject({
      status: 'connected',
      connectionState: 'connected',
      dataChannelState: 'open',
    });
    expect(reactB.getState().webrtc).toMatchObject({
      status: 'connected',
      connectionState: 'connected',
      dataChannelState: 'open',
    });
    expect(reactA.getState().diagnosticChannel.channelState).toBe('open');
    expect(reactB.getState().diagnosticChannel.channelState).toBe('open');

    const origSendA = channelA.send.bind(channelA);
    channelA.send = (data) => {
      clockAMs += 23;
      origSendA(data);
    };
    const origSendB = channelB.send.bind(channelB);
    channelB.send = (data) => {
      clockBMs += 17;
      origSendB(data);
    };

    const pingA = controllerA.sendPing();
    expect(pingA.ok).toBe(true);
    expect(reactA.getState().diagnosticChannel).toMatchObject({
      pingsSent: 1,
      pongsReceived: 1,
      lastRttMs: 23,
    });

    const pingB = controllerB.sendPing();
    expect(pingB.ok).toBe(true);
    expect(reactB.getState().diagnosticChannel).toMatchObject({
      pingsSent: 1,
      pongsReceived: 1,
      lastRttMs: 17,
    });

    expect(controllerA.sendText('hello from staging peer A').ok).toBe(true);
    expect(controllerB.sendText('hello from staging peer B').ok).toBe(true);

    expect(reactB.getState().diagnosticChannel.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          direction: 'inbound',
          type: 'text',
          body: 'hello from staging peer A',
        }),
      ]),
    );
    expect(reactA.getState().diagnosticChannel.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          direction: 'inbound',
          type: 'text',
          body: 'hello from staging peer B',
        }),
      ]),
    );

    const markupA = renderToStaticMarkup(
      React.createElement(App, {
        signalingClient: clientA,
        initialState: reactA.getState(),
      }),
    );
    const markupB = renderToStaticMarkup(
      React.createElement(App, {
        signalingClient: clientB,
        initialState: reactB.getState(),
      }),
    );
    expect(markupA).toContain(roomId);
    expect(markupA).toContain('hello from staging peer B');
    expect(markupB).toContain(roomId);
    expect(markupB).toContain('hello from staging peer A');

    const serializedStateA = JSON.stringify(reactA.getState().eventLog);
    const serializedStateB = JSON.stringify(reactB.getState().eventLog);
    for (const serializedLog of [serializedStateA, serializedStateB]) {
      expect(serializedLog).toContain('ice:credentials');
      expect(serializedLog).toContain('signal:forward');
      expect(serializedLog).toContain('signal:receive');
      expect(serializedLog).not.toContain('mockOfferSecretIcePwd');
      expect(serializedLog).not.toContain('mockAnswerSecretIcePwd');
      expect(serializedLog).not.toContain('mockOfferUfrag');
      expect(serializedLog).not.toContain('mockAnswerUfrag');
      expect(serializedLog).not.toContain('203.0.113.10');
      expect(serializedLog).not.toContain('198.51.100.20');
      expect(serializedLog).not.toContain('198.51.100.42');
      expect(serializedLog).not.toContain('203.0.113.77');
      expect(serializedLog).not.toContain('55100');
      expect(serializedLog).not.toContain('55200');
      expect(serializedLog).not.toContain('stun.l.google.com');
      expect(serializedLog).not.toContain('TURN_SHARED_SECRET');
    }

    // Peer B leaves explicitly, Peer A stays waiting as offerer, then Peer A leaves cleanly.
    actionsB.leaveRoom(roomId);
    await flushMicrotasks();

    expect(reactB.getState()).toMatchObject({
      roomId: null,
      peerState: 'unaffiliated',
      negotiationDuty: null,
      webrtc: {
        status: 'idle',
        dataChannelState: 'none',
      },
      diagnosticChannel: {
        channelState: 'none',
      },
    });
    expect(reactA.getState()).toMatchObject({
      roomId,
      peerState: 'waiting_for_peer',
      negotiationDuty: 'offerer',
      webrtc: {
        status: 'closed',
        dataChannelState: 'closed',
      },
      diagnosticChannel: {
        channelState: 'closed',
      },
    });
    expect(ioFactory.getRoomMemberCount(roomId)).toBe(1);

    actionsA.leaveRoom(roomId);
    await flushMicrotasks();

    expect(reactA.getState()).toMatchObject({
      roomId: null,
      peerState: 'unaffiliated',
      negotiationDuty: null,
      webrtc: {
        status: 'idle',
      },
      diagnosticChannel: {
        channelState: 'none',
      },
    });
    expect(ioFactory.getActiveRoomCount()).toBe(0);

    unbindA();
    unbindB();
    harnessA.dispose();
    harnessB.dispose();
    controllerA.dispose();
    controllerB.dispose();
    clientA.dispose();
    clientB.dispose();
  });
});
