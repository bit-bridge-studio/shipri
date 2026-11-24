import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import App from '../src/App.jsx';
import { createDiagnosticChannelController } from '../src/prototype/diagnostic-channel.js';
import { createInitialPrototypeState } from '../src/prototype/diagnostic-state.js';
import {
  RELAY_BANDWIDTH_WARNING,
  createInitialWebRtcState,
  createWebRtcHarness,
  extractCandidateType,
  inspectSelectedPathFromStats,
} from '../src/prototype/webrtc-harness.js';
import { createSignalingClient } from '../src/signaling/socket-client.js';
import { createMockSocketFactory } from './helpers/mock-socket.js';
import { createMockPeerConnectionFactory } from './helpers/mock-webrtc.js';

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

function createTurnRelayMockSocketFactory() {
  const baseFactory = createMockSocketFactory({ idPrefix: 'nat-peer' });
  const rooms = new Map();

  return function ioFactory(url, options) {
    const socket = baseFactory(url, options);
    const originalEmit = socket.emit.bind(socket);

    socket.emit = (event, ...args) => {
      originalEmit(event, ...args);
      const payload = args[0];

      if (event === 'room:create') {
        const roomId = 'ship-77aa';
        const peerId = 'peer-offerer-nat';
        rooms.set(roomId, [{ socket, peerId }]);
        queueMicrotask(() => {
          socket.simulateServerEvent('room:created', {
            roomId,
            peerId,
            negotiationDuty: 'offerer',
          });
        });
      }

      if (event === 'room:join') {
        const roomId = payload.roomId;
        const peers = rooms.get(roomId);
        const peerId = 'peer-answerer-nat';
        const existing = peers[0];
        peers.push({ socket, peerId });
        queueMicrotask(() => {
          socket.simulateServerEvent('room:joined', {
            roomId,
            peerId,
            negotiationDuty: 'answerer',
          });
          existing.socket.simulateServerEvent('peer:joined', {
            roomId,
            peerId,
          });
        });
      }

      if (event === 'ice:get') {
        queueMicrotask(() => {
          socket.simulateServerEvent('ice:credentials', {
            roomId: payload.roomId,
            iceServers: [
              {
                urls: ['stun:stun.l.google.com:19302'],
              },
              {
                urls: [
                  'turn:turn.shipri.app:3478?transport=udp',
                  'turns:turn.shipri.app:443?transport=tcp',
                ],
                username: '1785239200:nattag0123456789',
                credential: 'ephemeral_hmac_credential_never_leak',
              },
            ],
          });
        });
      }

      if (event === 'signal:forward') {
        const peers = rooms.get(payload.roomId) ?? [];
        const sender = peers.find((entry) => entry.socket === socket);
        const target = peers.find((entry) => entry.socket !== socket);
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
  };
}

describe('FP-5 NAT and forced-TURN prototype diagnostics', () => {
  test('extracts candidate types and selected-path mode without leaking IPs, ports, or TURN credentials', () => {
    expect(
      extractCandidateType({
        candidate:
          'candidate:1 1 UDP 2122252543 192.168.1.42 54321 typ host generation 0',
      }),
    ).toBe('host');
    expect(
      extractCandidateType({
        candidate:
          'candidate:2 1 UDP 1686052607 198.51.100.12 49152 typ srflx raddr 192.168.1.42 rport 54321',
      }),
    ).toBe('srflx');
    expect(
      extractCandidateType({
        candidate:
          'candidate:3 1 UDP 41885439 203.0.113.99 50000 typ relay raddr 198.51.100.12 rport 49152',
      }),
    ).toBe('relay');

    const relayStats = new Map([
      [
        'pair-1',
        {
          type: 'candidate-pair',
          state: 'succeeded',
          nominated: true,
          localCandidateId: 'local-1',
          remoteCandidateId: 'remote-1',
        },
      ],
      [
        'local-1',
        {
          type: 'local-candidate',
          candidateType: 'relay',
          address: '203.0.113.99',
          port: 50000,
        },
      ],
      [
        'remote-1',
        {
          type: 'remote-candidate',
          candidateType: 'relay',
          address: '203.0.113.100',
          port: 50001,
        },
      ],
    ]);

    const summary = inspectSelectedPathFromStats(relayStats);
    expect(summary).toEqual({
      mode: 'relay',
      localCandidateType: 'relay',
      remoteCandidateType: 'relay',
      relayWarning: true,
    });
    expect(JSON.stringify(summary)).not.toContain('203.0.113');
    expect(JSON.stringify(summary)).not.toContain('50000');
  });

  test.each(['all', 'relay'])(
    'completes bidirectional diagnostic ping/pong and text exchange under iceTransportPolicy=%j without leaking credentials',
    async (policy) => {
      const ioFactory = createTurnRelayMockSocketFactory();
      const clientA = createSignalingClient({
        url: 'https://shipri.app',
        ioFactory,
      });
      const clientB = createSignalingClient({
        url: 'https://shipri.app',
        ioFactory,
      });

      const logsA = [];
      const logsB = [];
      clientA.subscribeEvents((entry) => logsA.push(entry));
      clientB.subscribeEvents((entry) => logsB.push(entry));

      const pcFactoryA = createMockPeerConnectionFactory();
      const pcFactoryB = createMockPeerConnectionFactory();

      const channelCtrlA = createDiagnosticChannelController({
        signalingClient: clientA,
      });
      const channelCtrlB = createDiagnosticChannelController({
        signalingClient: clientB,
      });

      const harnessA = createWebRtcHarness({
        signalingClient: clientA,
        peerConnectionFactory: pcFactoryA,
        iceTransportPolicy: policy,
        allowTurn: true,
        onDataChannel: (ch, meta) => channelCtrlA.attachChannel(ch, meta),
      });
      const harnessB = createWebRtcHarness({
        signalingClient: clientB,
        peerConnectionFactory: pcFactoryB,
        iceTransportPolicy: policy,
        allowTurn: true,
        onDataChannel: (ch, meta) => channelCtrlB.attachChannel(ch, meta),
      });

      clientA.connect();
      clientB.connect();
      clientA.createRoom();
      await flushMicrotasks();
      clientB.joinRoom('ship-77aa');
      await flushMicrotasks();

      const pcA = harnessA.getPeerConnection();
      const pcB = harnessB.getPeerConnection();
      expect(pcA.config.iceTransportPolicy).toBe(policy);
      expect(pcB.config.iceTransportPolicy).toBe(policy);

      const candidateLine =
        policy === 'relay'
          ? 'candidate:1 1 UDP 41885439 203.0.113.5 50100 typ relay'
          : 'candidate:1 1 UDP 1686052607 198.51.100.5 50100 typ srflx';

      pcA.simulateIceCandidate({
        candidate: candidateLine,
        sdpMid: '0',
        sdpMLineIndex: 0,
      });
      pcB.simulateIceCandidate({
        candidate: candidateLine,
        sdpMid: '0',
        sdpMLineIndex: 0,
      });
      await flushMicrotasks();

      const chA = harnessA.getDataChannel();
      const chB = pcB.simulateRemoteDataChannel('shipri-diagnostic');
      linkMockDataChannels(chA, chB);
      chA.simulateOpen();
      chB.simulateOpen();

      pcA.simulateIceConnectionStateChange('connected');
      pcA.simulateConnectionStateChange('connected');
      pcB.simulateIceConnectionStateChange('connected');
      pcB.simulateConnectionStateChange('connected');
      await flushMicrotasks();

      const stateA = harnessA.getState();
      expect(stateA.iceTransportPolicy).toBe(policy);
      expect(stateA.selectedPath.mode).toBe(
        policy === 'relay' ? 'relay' : 'direct',
      );
      expect(stateA.selectedPath.relayWarning).toBe(policy === 'relay');
      expect(
        stateA.candidateTypes.local[policy === 'relay' ? 'relay' : 'srflx'],
      ).toBe(1);

      // Bidirectional ping/pong and text from both equal peers
      expect(channelCtrlA.sendPing().ok).toBe(true);
      expect(channelCtrlB.sendPing().ok).toBe(true);
      expect(channelCtrlA.sendText(`hello-${policy}-from-A`).ok).toBe(true);
      expect(channelCtrlB.sendText(`hello-${policy}-from-B`).ok).toBe(true);
      await flushMicrotasks();

      expect(channelCtrlA.getState().pongsReceived).toBe(1);
      expect(channelCtrlB.getState().pongsReceived).toBe(1);
      expect(
        channelCtrlB
          .getState()
          .messages.some((msg) => msg.body === `hello-${policy}-from-A`),
      ).toBe(true);
      expect(
        channelCtrlA
          .getState()
          .messages.some((msg) => msg.body === `hello-${policy}-from-B`),
      ).toBe(true);

      const serializedAll = JSON.stringify({
        stateA,
        stateB: harnessB.getState(),
        logsA,
        logsB,
      });
      expect(serializedAll).not.toContain('1785239200:nattag0123456789');
      expect(serializedAll).not.toContain('ephemeral_hmac_credential_never_leak');
      expect(serializedAll).not.toContain('203.0.113.5');
      expect(serializedAll).not.toContain('198.51.100.5');

      harnessA.dispose();
      harnessB.dispose();
      channelCtrlA.dispose();
      channelCtrlB.dispose();
      clientA.dispose();
      clientB.dispose();
    },
  );

  test('renders ICE Transport Policy selector, candidate summary, selected path, and relay warning in App markup', () => {
    const html = renderToStaticMarkup(
      React.createElement(App, {
        initialState: createInitialPrototypeState({
          connectionStatus: 'connected',
          roomId: 'ship-77aa',
          peerState: 'connected',
          negotiationDuty: 'offerer',
          webrtc: createInitialWebRtcState({
            status: 'connected',
            iceTransportPolicy: 'relay',
            candidateTypes: {
              local: { host: 0, srflx: 0, prflx: 0, relay: 2 },
              remote: { host: 0, srflx: 0, prflx: 0, relay: 2 },
            },
            selectedPath: {
              mode: 'relay',
              localCandidateType: 'relay',
              remoteCandidateType: 'relay',
              relayWarning: true,
            },
          }),
        }),
      }),
    );

    expect(html).toContain('ICE Transport Policy');
    expect(html).toContain('Selected Path');
    expect(html).toContain('relay');
    expect(html).toContain(RELAY_BANDWIDTH_WARNING);
  });
});
