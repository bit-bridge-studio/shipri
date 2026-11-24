import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, test, vi } from 'vitest';
import App from '../src/App.jsx';
import {
  applyPeerLeft,
  applyRoomCreated,
  applyWebRtcState,
  bindSignalingClient,
  createInitialPrototypeState,
} from '../src/prototype/diagnostic-state.js';
import {
  ICE_GATHERING_STALL_TIMEOUT_MS,
  createInitialWebRtcState,
  createWebRtcHarness,
} from '../src/prototype/webrtc-harness.js';
import { createSignalingClient } from '../src/signaling/socket-client.js';
import { createMockSocketFactory } from './helpers/mock-socket.js';
import { createMockPeerConnectionFactory } from './helpers/mock-webrtc.js';

function createConnectedPeerPair({
  autoRelaySignals = true,
  offererPcBehavior = {},
  answererPcBehavior = {},
  offererOptions = {},
  answererOptions = {},
} = {}) {
  const ioFactory = createMockSocketFactory();
  let tick = 0;
  const now = () => `2026-11-23T01:00:${String(tick++).padStart(2, '0')}.000Z`;

  const clientA = createSignalingClient({ ioFactory, now });
  const clientB = createSignalingClient({ ioFactory, now });

  clientA.connect();
  const socketA = ioFactory.calls[0].socket;
  clientB.connect();
  const socketB = ioFactory.calls[1].socket;

  const pcFactoryA = createMockPeerConnectionFactory(offererPcBehavior);
  const pcFactoryB = createMockPeerConnectionFactory(answererPcBehavior);

  const statesA = [];
  const statesB = [];

  const harnessA = createWebRtcHarness({
    signalingClient: clientA,
    peerConnectionFactory: pcFactoryA,
    onStateChange: (next) => statesA.push(next),
    ...offererOptions,
  });

  const harnessB = createWebRtcHarness({
    signalingClient: clientB,
    peerConnectionFactory: pcFactoryB,
    onStateChange: (next) => statesB.push(next),
    ...answererOptions,
  });

  const membership = {
    roomId: 'ship-83a1',
    peerA: 'peer-a',
    peerB: 'peer-b',
  };

  function setupTwoPeerRelay(socket, selfPeerId, getRemoteSocket) {
    const origEmit = socket.emit.bind(socket);
    socket.emit = (event, ...args) => {
      origEmit(event, ...args);
      if (event === 'ice:get') {
        const payload = args[0];
        if (payload?.roomId === membership.roomId) {
          queueMicrotask(() => {
            socket.simulateServerEvent('ice:credentials', {
              roomId: membership.roomId,
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
      }
      if (event === 'signal:forward' && autoRelaySignals) {
        const payload = args[0];
        const remoteSocket = getRemoteSocket();
        if (remoteSocket && payload?.roomId === membership.roomId) {
          queueMicrotask(() => {
            remoteSocket.simulateServerEvent('signal:receive', {
              roomId: membership.roomId,
              peerId: selfPeerId,
              signalData: payload.signalData,
            });
          });
        }
      }
      return socket;
    };
  }

  setupTwoPeerRelay(socketA, membership.peerA, () => socketB);
  setupTwoPeerRelay(socketB, membership.peerB, () => socketA);

  return {
    clientA,
    clientB,
    socketA,
    socketB,
    pcFactoryA,
    pcFactoryB,
    harnessA,
    harnessB,
    statesA,
    statesB,
    membership,
    cleanup() {
      harnessA.dispose();
      harnessB.dispose();
      clientA.dispose();
      clientB.dispose();
    },
  };
}

async function flushMicrotasks(rounds = 24) {
  for (let i = 0; i < rounds; i += 1) {
    await Promise.resolve();
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('createInitialWebRtcState and baseline prototype state compatibility', () => {
  test('preserves exact 6-key createInitialPrototypeState when webrtc is omitted and sanitizes when provided', () => {
    expect(ICE_GATHERING_STALL_TIMEOUT_MS).toBe(5000);
    expect(createInitialPrototypeState()).toEqual({
      connectionStatus: 'disconnected',
      roomId: null,
      peerState: 'unaffiliated',
      negotiationDuty: null,
      lastError: null,
      eventLog: [],
    });

    const initialWebRtc = createInitialWebRtcState();
    expect(initialWebRtc).toEqual({
      status: 'idle',
      iceTransportPolicy: 'all',
      generation: 0,
      remoteGeneration: null,
      activePeerId: null,
      signalingState: 'idle',
      iceGatheringState: 'new',
      iceConnectionState: 'new',
      connectionState: 'new',
      dataChannelState: 'none',
      stalledGathering: false,
      stalledDiagnostic: null,
      localDescriptionForwarded: false,
      localCandidatesSent: 0,
      remoteCandidatesReceived: 0,
      remoteCandidatesQueued: 0,
      remoteCandidatesApplied: 0,
      queuedCandidateCount: 0,
      staleEventsIgnored: 0,
      candidateTypes: {
        local: { host: 0, srflx: 0, prflx: 0, relay: 0 },
        remote: { host: 0, srflx: 0, prflx: 0, relay: 0 },
      },
      selectedPath: {
        mode: 'unknown',
        localCandidateType: null,
        remoteCandidateType: null,
        relayWarning: false,
      },
      lastError: null,
    });

    const withWebRtc = createInitialPrototypeState({
      connectionStatus: 'connected',
      roomId: 'ship-83a1',
      peerState: 'connected',
      negotiationDuty: 'offerer',
      webrtc: {
        status: 'negotiating',
        generation: 2,
        remoteGeneration: 2,
        activePeerId: 'peer-b',
        signalingState: 'have-local-offer',
        iceGatheringState: 'gathering',
        stalledGathering: true,
        stalledDiagnostic:
          'Stalled candidate:1 1 UDP 123 198.51.100.10 5000 typ srflx a=ice-pwd:secretPwd',
      },
    });
    expect(withWebRtc.webrtc.status).toBe('negotiating');
    expect(withWebRtc.webrtc.generation).toBe(2);
    expect(JSON.stringify(withWebRtc)).not.toContain('198.51.100.10');
    expect(JSON.stringify(withWebRtc)).not.toContain('secretPwd');
  });
});

describe('equal-peer offerer/answerer handshake and trickle ICE', () => {
  test('offerer forwards SDP offer immediately after setLocalDescription without waiting for ICE completion, answerer responds, and both trickle ICE', async () => {
    const offererChannels = [];
    const answererChannels = [];
    const pair = createConnectedPeerPair({
      offererOptions: {
        onDataChannel: (channel, meta) => offererChannels.push({ channel, meta }),
      },
      answererOptions: {
        onDataChannel: (channel, meta) =>
          answererChannels.push({ channel, meta }),
      },
    });

    pair.socketA.simulateServerEvent('room:created', {
      roomId: 'ship-83a1',
      peerId: 'peer-a',
      negotiationDuty: 'offerer',
    });
    pair.socketB.simulateServerEvent('room:joined', {
      roomId: 'ship-83a1',
      peerId: 'peer-b',
      negotiationDuty: 'answerer',
    });
    pair.socketA.simulateServerEvent('peer:joined', {
      roomId: 'ship-83a1',
      peerId: 'peer-b',
    });

    await flushMicrotasks();

    const pcA = pair.pcFactoryA.lastInstance;
    const pcB = pair.pcFactoryB.lastInstance;
    expect(pcA).not.toBeNull();
    expect(pcB).not.toBeNull();

    // Offerer created 'shipri-diagnostic' channel and forwarded offer while ICE gathering is still 'gathering'.
    expect(pcA.iceGatheringState).toBe('gathering');
    expect(pcB.iceGatheringState).toBe('gathering');
    expect(pcA.createdDataChannels.map((c) => c.label)).toEqual([
      'shipri-diagnostic',
    ]);
    expect(offererChannels).toHaveLength(1);
    expect(offererChannels[0].channel.label).toBe('shipri-diagnostic');

    const forwardedByA = pair.socketA.emittedEvents.filter(
      (e) => e.event === 'signal:forward',
    );
    expect(forwardedByA).toHaveLength(1);
    expect(forwardedByA[0].args[0]).toMatchObject({
      roomId: 'ship-83a1',
      signalData: {
        type: 'offer',
        generation: 1,
      },
    });

    const forwardedByB = pair.socketB.emittedEvents.filter(
      (e) => e.event === 'signal:forward',
    );
    expect(forwardedByB).toHaveLength(1);
    expect(forwardedByB[0].args[0]).toMatchObject({
      roomId: 'ship-83a1',
      signalData: {
        type: 'answer',
        generation: 1,
      },
    });

    // Both peers settled to stable signaling state without waiting for ICE gathering completion.
    expect(pcA.signalingState).toBe('stable');
    expect(pcB.signalingState).toBe('stable');
    expect(pair.harnessA.getState().localDescriptionForwarded).toBe(true);
    expect(pair.harnessB.getState().localDescriptionForwarded).toBe(true);

    // Trickle ICE candidates bidirectionally as produced.
    pcA.simulateIceCandidate({
      candidate: 'candidate:1 1 UDP 2122252543 198.51.100.11 50001 typ srflx',
      sdpMid: '0',
      sdpMLineIndex: 0,
      toJSON() {
        return {
          candidate: this.candidate,
          sdpMid: this.sdpMid,
          sdpMLineIndex: this.sdpMLineIndex,
        };
      },
    });
    pcB.simulateIceCandidate({
      candidate: 'candidate:2 1 UDP 2122252543 203.0.113.22 50002 typ srflx',
      sdpMid: '0',
      sdpMLineIndex: 0,
      toJSON() {
        return {
          candidate: this.candidate,
          sdpMid: this.sdpMid,
          sdpMLineIndex: this.sdpMLineIndex,
        };
      },
    });

    await flushMicrotasks();

    expect(pcB.addedIceCandidates).toHaveLength(1);
    expect(pcB.addedIceCandidates[0].candidate).toContain('198.51.100.11');
    expect(pcA.addedIceCandidates).toHaveLength(1);
    expect(pcA.addedIceCandidates[0].candidate).toContain('203.0.113.22');

    expect(pair.harnessA.getState()).toMatchObject({
      generation: 1,
      remoteGeneration: 1,
      activePeerId: 'peer-b',
      localCandidatesSent: 1,
      remoteCandidatesReceived: 1,
      remoteCandidatesApplied: 1,
      queuedCandidateCount: 0,
      staleEventsIgnored: 0,
    });
    expect(pair.harnessB.getState()).toMatchObject({
      generation: 1,
      remoteGeneration: 1,
      activePeerId: 'peer-a',
      localCandidatesSent: 1,
      remoteCandidatesReceived: 1,
      remoteCandidatesApplied: 1,
      queuedCandidateCount: 0,
      staleEventsIgnored: 0,
    });

    // Simulate data channel opening and peer connection becoming connected.
    pcB.simulateRemoteDataChannel('shipri-diagnostic', { ordered: true });
    expect(answererChannels).toHaveLength(1);
    offererChannels[0].channel.simulateOpen();
    answererChannels[0].channel.simulateOpen();
    pcA.simulateConnectionStateChange('connected');
    pcB.simulateConnectionStateChange('connected');

    expect(pair.harnessA.getState().status).toBe('connected');
    expect(pair.harnessA.getState().dataChannelState).toBe('open');
    expect(pair.harnessB.getState().status).toBe('connected');
    expect(pair.harnessB.getState().dataChannelState).toBe('open');

    // Sanitized diagnostic state never contains raw SDP or ICE candidate details.
    const serializedStates = JSON.stringify({
      a: pair.harnessA.getState(),
      b: pair.harnessB.getState(),
    });
    expect(serializedStates).not.toContain('198.51.100.11');
    expect(serializedStates).not.toContain('203.0.113.22');
    expect(serializedStates).not.toContain('mockOfferSecretIcePwd');
    expect(serializedStates).not.toContain('mockAnswerSecretIcePwd');

    pair.cleanup();
  });

  test('queues early remote ICE candidates received before setRemoteDescription and applies them in order afterward', async () => {
    const pair = createConnectedPeerPair({
      autoRelaySignals: false,
      offererPcBehavior: { deferSetRemoteDescription: true },
      answererPcBehavior: { deferSetRemoteDescription: true },
    });

    pair.socketA.simulateServerEvent('room:created', {
      roomId: 'ship-83a1',
      peerId: 'peer-a',
      negotiationDuty: 'offerer',
    });
    pair.socketB.simulateServerEvent('room:joined', {
      roomId: 'ship-83a1',
      peerId: 'peer-b',
      negotiationDuty: 'answerer',
    });
    // Provide ICE credentials to answerer before offer arrives.
    await flushMicrotasks();

    // Deliver two early candidates to Answerer BEFORE the offer arrives.
    const earlyCand1 = {
      candidate: 'candidate:1 1 UDP 2122252543 198.51.100.1 40001 typ host',
      sdpMid: '0',
      sdpMLineIndex: 0,
    };
    const earlyCand2 = {
      candidate: 'candidate:2 1 UDP 2122252543 198.51.100.2 40002 typ srflx',
      sdpMid: '0',
      sdpMLineIndex: 0,
    };

    pair.socketB.simulateServerEvent('signal:receive', {
      roomId: 'ship-83a1',
      peerId: 'peer-a',
      signalData: { candidate: earlyCand1, generation: 1 },
    });
    pair.socketB.simulateServerEvent('signal:receive', {
      roomId: 'ship-83a1',
      peerId: 'peer-a',
      signalData: { candidate: earlyCand2, generation: 1 },
    });

    expect(pair.harnessB.getState()).toMatchObject({
      remoteCandidatesReceived: 2,
      remoteCandidatesQueued: 2,
      remoteCandidatesApplied: 0,
      queuedCandidateCount: 2,
    });

    // Now Offerer joins/starts and emits offer; relay offer manually to Answerer.
    pair.socketA.simulateServerEvent('peer:joined', {
      roomId: 'ship-83a1',
      peerId: 'peer-b',
    });
    await flushMicrotasks();

    const offerMsg = pair.socketA.emittedEvents.find(
      (e) =>
        e.event === 'signal:forward' && e.args[0]?.signalData?.type === 'offer',
    );
    expect(offerMsg).toBeDefined();

    pair.socketB.simulateServerEvent('signal:receive', {
      roomId: 'ship-83a1',
      peerId: 'peer-a',
      signalData: offerMsg.args[0].signalData,
    });
    await flushMicrotasks();

    const pcB = pair.pcFactoryB.lastInstance;
    expect(pcB).not.toBeNull();

    // A third candidate arrives while Answerer's setRemoteDescription is still pending.
    const earlyCand3 = {
      candidate: 'candidate:3 1 UDP 2122252543 198.51.100.3 40003 typ srflx',
      sdpMid: '0',
      sdpMLineIndex: 0,
    };
    pair.socketB.simulateServerEvent('signal:receive', {
      roomId: 'ship-83a1',
      peerId: 'peer-a',
      signalData: { candidate: earlyCand3, generation: 1 },
    });

    // addIceCandidate must NOT have been called yet before setRemoteDescription resolves.
    expect(pcB.addedIceCandidates).toHaveLength(0);
    expect(pair.harnessB.getState().queuedCandidateCount).toBe(3);

    // Resolve Answerer's setRemoteDescription -> queued candidates flush in exact order.
    pcB.resolvePendingSetRemoteDescription();
    await flushMicrotasks();

    expect(pcB.addedIceCandidates).toEqual([earlyCand1, earlyCand2, earlyCand3]);
    expect(pair.harnessB.getState()).toMatchObject({
      remoteCandidatesReceived: 3,
      remoteCandidatesQueued: 3,
      remoteCandidatesApplied: 3,
      queuedCandidateCount: 0,
    });

    // Now verify early candidate queuing on Offerer before Answerer's SDP answer resolves setRemoteDescription.
    const answerMsg = pair.socketB.emittedEvents.find(
      (e) =>
        e.event === 'signal:forward' &&
        e.args[0]?.signalData?.type === 'answer',
    );
    expect(answerMsg).toBeDefined();

    const answererEarlyCand = {
      candidate: 'candidate:4 1 UDP 2122252543 203.0.113.44 41000 typ srflx',
      sdpMid: '0',
      sdpMLineIndex: 0,
    };
    pair.socketA.simulateServerEvent('signal:receive', {
      roomId: 'ship-83a1',
      peerId: 'peer-b',
      signalData: { candidate: answererEarlyCand, generation: 1 },
    });

    const pcA = pair.pcFactoryA.lastInstance;
    expect(pcA.addedIceCandidates).toHaveLength(0);
    expect(pair.harnessA.getState()).toMatchObject({
      remoteCandidatesReceived: 1,
      remoteCandidatesQueued: 1,
      remoteCandidatesApplied: 0,
      queuedCandidateCount: 1,
    });

    pair.socketA.simulateServerEvent('signal:receive', {
      roomId: 'ship-83a1',
      peerId: 'peer-b',
      signalData: answerMsg.args[0].signalData,
    });
    await flushMicrotasks();

    // Still queued while offerer's setRemoteDescription(answer) is pending.
    expect(pcA.addedIceCandidates).toHaveLength(0);
    pcA.resolvePendingSetRemoteDescription();
    await flushMicrotasks();

    expect(pcA.addedIceCandidates).toEqual([answererEarlyCand]);
    expect(pair.harnessA.getState()).toMatchObject({
      remoteCandidatesReceived: 1,
      remoteCandidatesQueued: 1,
      remoteCandidatesApplied: 1,
      queuedCandidateCount: 0,
    });

    pair.cleanup();
  });
});

describe('five-second ICE gathering bound and delayed candidates', () => {
  test('surfaces stalledGathering diagnostics after 5000ms without delaying initial SDP offer, and continues trickling late candidates', async () => {
    vi.useFakeTimers();

    const ioFactory = createMockSocketFactory();
    const client = createSignalingClient({ ioFactory });
    client.connect();
    const socket = ioFactory.lastSocket;

    const pcFactory = createMockPeerConnectionFactory();
    const harness = createWebRtcHarness({
      signalingClient: client,
      peerConnectionFactory: pcFactory,
      autoRequestIce: false,
    });

    socket.simulateServerEvent('room:created', {
      roomId: 'ship-83a1',
      peerId: 'peer-a',
      negotiationDuty: 'offerer',
    });
    socket.simulateServerEvent('ice:credentials', {
      roomId: 'ship-83a1',
      iceServers: [{ urls: ['stun:stun.l.google.com:19302'] }],
    });
    socket.simulateServerEvent('peer:joined', {
      roomId: 'ship-83a1',
      peerId: 'peer-b',
    });

    await flushMicrotasks();

    // Initial SDP offer was forwarded immediately at t=0 without waiting 5 seconds.
    const initialOffers = socket.emittedEvents.filter(
      (e) =>
        e.event === 'signal:forward' && e.args[0]?.signalData?.type === 'offer',
    );
    expect(initialOffers).toHaveLength(1);
    expect(harness.getState().localDescriptionForwarded).toBe(true);
    expect(harness.getState().stalledGathering).toBe(false);

    // At 4999ms, stalledGathering is still false.
    vi.advanceTimersByTime(4999);
    expect(harness.getState().stalledGathering).toBe(false);
    expect(harness.getState().stalledDiagnostic).toBeNull();

    // At 5000ms, stalledGathering and diagnostic message surface.
    vi.advanceTimersByTime(1);
    expect(harness.getState().stalledGathering).toBe(true);
    expect(harness.getState().stalledDiagnostic).toMatch(/5000ms/i);

    // Late ICE candidate produced after 5000ms still trickles while active.
    const pc = pcFactory.lastInstance;
    pc.simulateIceCandidate({
      candidate: 'candidate:9 1 UDP 2122252543 198.51.100.99 55000 typ srflx',
      sdpMid: '0',
      sdpMLineIndex: 0,
    });
    expect(harness.getState().localCandidatesSent).toBe(1);
    const forwardedIce = socket.emittedEvents.filter(
      (e) =>
        e.event === 'signal:forward' &&
        e.args[0]?.signalData?.candidate !== undefined,
    );
    expect(forwardedIce).toHaveLength(1);
    expect(forwardedIce[0].args[0].signalData.generation).toBe(1);

    // Completing ICE gathering clears the stalled diagnostic.
    pc.simulateIceGatheringStateChange('complete');
    expect(harness.getState().iceGatheringState).toBe('complete');
    expect(harness.getState().stalledGathering).toBe(false);
    expect(harness.getState().stalledDiagnostic).toBeNull();

    harness.dispose();
    client.dispose();
  });
});

describe('peer departure during negotiation, stale event filtering, and replacement negotiation', () => {
  test('peer:left during pending negotiation closes RTCPeerConnection, clears timers, aborts unresolved async work, and ignores stale events', async () => {
    vi.useFakeTimers();

    const ioFactory = createMockSocketFactory();
    const client = createSignalingClient({ ioFactory });
    client.connect();
    const socket = ioFactory.lastSocket;

    const pcFactory = createMockPeerConnectionFactory({
      deferCreateOffer: true,
    });
    const harness = createWebRtcHarness({
      signalingClient: client,
      peerConnectionFactory: pcFactory,
      autoRequestIce: false,
    });

    socket.simulateServerEvent('room:created', {
      roomId: 'ship-83a1',
      peerId: 'peer-a',
      negotiationDuty: 'offerer',
    });
    socket.simulateServerEvent('ice:credentials', {
      roomId: 'ship-83a1',
      iceServers: [{ urls: ['stun:stun.l.google.com:19302'] }],
    });
    socket.simulateServerEvent('peer:joined', {
      roomId: 'ship-83a1',
      peerId: 'peer-b',
    });

    const firstPc = pcFactory.lastInstance;
    expect(firstPc).not.toBeNull();
    expect(harness.getState()).toMatchObject({
      status: 'negotiating',
      generation: 1,
      activePeerId: 'peer-b',
    });

    // Remote peer leaves while createOffer is still pending!
    socket.simulateServerEvent('peer:left', {
      roomId: 'ship-83a1',
      peerId: 'peer-b',
      reason: 'disconnect',
    });

    expect(firstPc.closeCalls).toBe(1);
    expect(firstPc.closed).toBe(true);
    expect(harness.getState()).toMatchObject({
      status: 'closed',
      generation: 2,
      remoteGeneration: null,
      activePeerId: null,
      signalingState: 'closed',
      connectionState: 'closed',
      stalledGathering: false,
    });

    // Resolve the orphaned createOffer promise -> must abort cleanly without emitting signal:forward!
    firstPc.resolvePendingOffer();
    await flushMicrotasks();
    expect(
      socket.emittedEvents.filter((e) => e.event === 'signal:forward'),
    ).toHaveLength(0);

    // Advancing timers past 5000ms must not mark the closed session as stalled.
    vi.advanceTimersByTime(6000);
    expect(harness.getState().stalledGathering).toBe(false);

    // Late SDP or ICE events from departed peer-b or stale generation are ignored.
    socket.simulateServerEvent('signal:receive', {
      roomId: 'ship-83a1',
      peerId: 'peer-b',
      signalData: { type: 'answer', sdp: 'v=0\r\n', generation: 1 },
    });
    socket.simulateServerEvent('signal:receive', {
      roomId: 'ship-83a1',
      peerId: 'peer-b',
      signalData: {
        candidate: { candidate: 'candidate:1 1 UDP 1 198.51.100.1 1234 typ host' },
        generation: 1,
      },
    });
    expect(harness.getState().staleEventsIgnored).toBe(2);

    harness.dispose();
    client.dispose();
  });

  test('promoted joiner starts fresh generation for replacement peer and ignores late events from replaced negotiations', async () => {
    const ioFactory = createMockSocketFactory();
    const client = createSignalingClient({ ioFactory });
    client.connect();
    const socket = ioFactory.lastSocket;

    const pcFactory = createMockPeerConnectionFactory();
    const harness = createWebRtcHarness({
      signalingClient: client,
      peerConnectionFactory: pcFactory,
      autoRequestIce: false,
    });

    // Joiner enters room as answerer and completes initial negotiation with peer-a (generation 1).
    socket.simulateServerEvent('room:joined', {
      roomId: 'ship-83a1',
      peerId: 'peer-b',
      negotiationDuty: 'answerer',
    });
    socket.simulateServerEvent('ice:credentials', {
      roomId: 'ship-83a1',
      iceServers: [{ urls: ['stun:stun.l.google.com:19302'] }],
    });
    socket.simulateServerEvent('signal:receive', {
      roomId: 'ship-83a1',
      peerId: 'peer-a',
      signalData: { type: 'offer', sdp: 'v=0\r\no=peer-a', generation: 1 },
    });

    await flushMicrotasks();

    const firstPc = pcFactory.instances[0];
    expect(pcFactory.instances).toHaveLength(1);
    expect(harness.getState()).toMatchObject({
      activePeerId: 'peer-a',
      remoteGeneration: 1,
      localDescriptionForwarded: true,
    });

    // Creator (peer-a) leaves -> joiner (peer-b) stays in room as offerer and closes stale PC.
    socket.simulateServerEvent('peer:left', {
      roomId: 'ship-83a1',
      peerId: 'peer-a',
      reason: 'leave',
    });

    expect(firstPc.closed).toBe(true);
    const invalidatedGen = harness.getState().generation;
    expect(invalidatedGen).toBeGreaterThan(1);

    // Replacement peer (peer-c) joins -> promoted joiner (peer-b) starts fresh offerer negotiation!
    socket.simulateServerEvent('peer:joined', {
      roomId: 'ship-83a1',
      peerId: 'peer-c',
    });

    await flushMicrotasks();

    expect(pcFactory.instances).toHaveLength(2);
    const replacementPc = pcFactory.instances[1];
    const replacementGen = harness.getState().generation;
    expect(replacementGen).toBeGreaterThan(invalidatedGen);
    expect(harness.getState()).toMatchObject({
      status: 'negotiating',
      activePeerId: 'peer-c',
      remoteGeneration: replacementGen,
      localDescriptionForwarded: true,
    });

    const offerForReplacement = socket.emittedEvents.filter(
      (e) =>
        e.event === 'signal:forward' &&
        e.args[0]?.signalData?.type === 'offer' &&
        e.args[0]?.signalData?.generation === replacementGen,
    );
    expect(offerForReplacement).toHaveLength(1);
    expect(replacementPc.createdDataChannels.map((c) => c.label)).toEqual([
      'shipri-diagnostic',
    ]);

    // Stale events are ignored:
    // 1. Departed peerId with old generation
    socket.simulateServerEvent('signal:receive', {
      roomId: 'ship-83a1',
      peerId: 'peer-a',
      signalData: {
        candidate: { candidate: 'candidate:1 1 UDP 1 198.51.100.5 9999 typ host' },
        generation: 1,
      },
    });
    // 2. Departed peerId even if carrying replacement generation
    socket.simulateServerEvent('signal:receive', {
      roomId: 'ship-83a1',
      peerId: 'peer-a',
      signalData: {
        type: 'answer',
        sdp: 'v=0\r\n',
        generation: replacementGen,
      },
    });
    // 3. Current peerId carrying old generation
    socket.simulateServerEvent('signal:receive', {
      roomId: 'ship-83a1',
      peerId: 'peer-c',
      signalData: {
        type: 'answer',
        sdp: 'v=0\r\n',
        generation: 1,
      },
    });
    // 4. Wrong roomId
    socket.simulateServerEvent('signal:receive', {
      roomId: 'ship-ffff',
      peerId: 'peer-c',
      signalData: {
        type: 'answer',
        sdp: 'v=0\r\n',
        generation: replacementGen,
      },
    });

    expect(harness.getState().staleEventsIgnored).toBe(4);
    expect(replacementPc.remoteDescription).toBeNull();
    expect(replacementPc.addedIceCandidates).toHaveLength(0);

    // Valid answer and candidate from peer-c for replacement generation are accepted.
    socket.simulateServerEvent('signal:receive', {
      roomId: 'ship-83a1',
      peerId: 'peer-c',
      signalData: {
        type: 'answer',
        sdp: 'v=0\r\no=peer-c',
        generation: replacementGen,
      },
    });
    socket.simulateServerEvent('signal:receive', {
      roomId: 'ship-83a1',
      peerId: 'peer-c',
      signalData: {
        candidate: {
          candidate: 'candidate:8 1 UDP 2122252543 203.0.113.88 58000 typ srflx',
          sdpMid: '0',
          sdpMLineIndex: 0,
        },
        generation: replacementGen,
      },
    });

    await flushMicrotasks();

    expect(replacementPc.signalingState).toBe('stable');
    expect(replacementPc.addedIceCandidates).toHaveLength(1);
    expect(harness.getState().remoteCandidatesApplied).toBe(1);
    expect(harness.getState().staleEventsIgnored).toBe(4);

    // Local room:leave closes active replacement peer connection and resets harness state.
    socket.clearEmitted();
    client.leaveRoom('ship-83a1');
    expect(replacementPc.closed).toBe(true);
    expect(harness.getState()).toEqual(createInitialWebRtcState());

    harness.dispose();
    client.dispose();
  });

  test('answerer buffers pending offer until ice:credentials arrives, supports manual startNegotiation, and tears down on socket disconnect', async () => {
    const ioFactory = createMockSocketFactory();
    const client = createSignalingClient({ ioFactory });
    client.connect();
    const socket = ioFactory.lastSocket;

    const pcFactory = createMockPeerConnectionFactory();
    const harness = createWebRtcHarness({
      signalingClient: client,
      peerConnectionFactory: pcFactory,
      autoRequestIce: false,
    });

    socket.simulateServerEvent('room:joined', {
      roomId: 'ship-83a1',
      peerId: 'peer-b',
      negotiationDuty: 'answerer',
    });

    // Offer arrives before ice:credentials.
    socket.simulateServerEvent('signal:receive', {
      roomId: 'ship-83a1',
      peerId: 'peer-a',
      signalData: {
        type: 'offer',
        sdp: 'v=0\r\no=peer-a',
        generation: 1,
      },
    });
    expect(pcFactory.instances).toHaveLength(0);

    // Valid ice:credentials unblocks pending offer and forwards SDP answer.
    socket.simulateServerEvent('ice:credentials', {
      roomId: 'ship-83a1',
      iceServers: [{ urls: ['stun:stun.l.google.com:19302'] }],
    });
    await flushMicrotasks();

    expect(pcFactory.instances).toHaveLength(1);
    const answerPc = pcFactory.lastInstance;
    expect(
      socket.emittedEvents.filter(
        (e) =>
          e.event === 'signal:forward' &&
          e.args[0]?.signalData?.type === 'answer',
      ),
    ).toHaveLength(1);

    // Socket disconnect closes PC and resets state back to idle.
    socket.simulateDisconnect('transport close');
    expect(answerPc.closed).toBe(true);
    expect(harness.getState()).toEqual(createInitialWebRtcState());

    // Reconnect and verify manual startNegotiation when autoNegotiate is false.
    socket.simulateConnect();
    const manualPcFactory = createMockPeerConnectionFactory();
    const manualHarness = createWebRtcHarness({
      signalingClient: client,
      peerConnectionFactory: manualPcFactory,
      autoRequestIce: false,
      autoNegotiate: false,
    });

    socket.simulateServerEvent('room:created', {
      roomId: 'ship-94b2',
      peerId: 'peer-x',
      negotiationDuty: 'offerer',
    });
    socket.simulateServerEvent('ice:credentials', {
      roomId: 'ship-94b2',
      iceServers: [{ urls: ['stun:stun.l.google.com:19302'] }],
    });
    socket.simulateServerEvent('peer:joined', {
      roomId: 'ship-94b2',
      peerId: 'peer-y',
    });

    await flushMicrotasks();
    expect(manualPcFactory.instances).toHaveLength(0);

    await manualHarness.startNegotiation();
    await flushMicrotasks();
    expect(manualPcFactory.instances).toHaveLength(1);
    expect(manualHarness.getState()).toMatchObject({
      status: 'negotiating',
      generation: 1,
      activePeerId: 'peer-y',
      localDescriptionForwarded: true,
    });

    manualHarness.dispose();
    harness.dispose();
    client.dispose();
  });

  test('bindSignalingClient and applyWebRtcState integrate cleanly without double-incrementing generation', () => {
    let state = createInitialPrototypeState({ connectionStatus: 'connected' });
    state = applyRoomCreated(state, {
      roomId: 'ship-83a1',
      peerId: 'peer-a',
      negotiationDuty: 'offerer',
    });
    state = applyWebRtcState(state, {
      status: 'negotiating',
      generation: 1,
      remoteGeneration: 1,
      activePeerId: 'peer-b',
      signalingState: 'have-local-offer',
    });
    const afterPeerLeft = applyPeerLeft(state, {
      roomId: 'ship-83a1',
      peerId: 'peer-b',
      reason: 'leave',
    });
    expect(afterPeerLeft.webrtc.status).toBe('closed');
    expect(afterPeerLeft.webrtc.signalingState).toBe('closed');
    expect(afterPeerLeft.webrtc.activePeerId).toBeNull();
    expect(afterPeerLeft.webrtc.generation).toBe(1);

    const ioFactory = createMockSocketFactory();
    const client = createSignalingClient({ ioFactory });
    let boundState = createInitialPrototypeState();
    const unbind = bindSignalingClient(client, (updater) => {
      boundState = typeof updater === 'function' ? updater(boundState) : updater;
    });
    client.connect();
    expect(boundState.webrtc).toBeUndefined();
    unbind();
    client.dispose();
  });
});

describe('App static markup for WebRTC signaling harness diagnostics', () => {
  test('renders signaling, ICE, connection states, generation, counters, stalled notice, Start WebRTC Negotiation control, and equal-peer copy without instantiating RTCPeerConnection', () => {
    const rtcSpy = vi.fn();
    vi.stubGlobal('RTCPeerConnection', rtcSpy);

    const defaultMarkup = renderToStaticMarkup(React.createElement(App));
    expect(defaultMarkup).toContain('WebRTC Signaling Harness');
    expect(defaultMarkup).toContain('Start WebRTC Negotiation');
    expect(defaultMarkup).toContain('Signaling State');
    expect(defaultMarkup).toContain('ICE Gathering State');
    expect(defaultMarkup).toContain('ICE Connection State');
    expect(defaultMarkup).toContain('Peer Connection State');
    expect(defaultMarkup).toContain('Negotiation Generation');
    expect(defaultMarkup).toContain('Trickle ICE Counters');
    expect(defaultMarkup).toContain('Data Channel');
    expect(defaultMarkup).toMatch(
      /negotiation duty.*never restricts application messages/i,
    );
    expect(defaultMarkup).toMatch(
      /<button[^>]*disabled=""[^>]*>Start WebRTC Negotiation<\/button>/,
    );
    expect(defaultMarkup).not.toMatch(/\bsender\b|\breceiver\b/i);
    expect(rtcSpy).not.toHaveBeenCalled();

    const activeOffererMarkup = renderToStaticMarkup(
      React.createElement(App, {
        initialState: {
          connectionStatus: 'connected',
          roomId: 'ship-83a1',
          peerState: 'connected',
          entryRole: 'creator',
          negotiationDuty: 'offerer',
          selfPeerId: 'peer-a',
          remotePeerId: 'peer-b',
          webrtc: {
            status: 'connected',
            generation: 3,
            remoteGeneration: 3,
            activePeerId: 'peer-b',
            signalingState: 'stable',
            iceGatheringState: 'gathering',
            iceConnectionState: 'connected',
            connectionState: 'connected',
            dataChannelState: 'open',
            stalledGathering: true,
            stalledDiagnostic:
              'ICE candidate gathering exceeded 5000ms; continuing with trickled candidates.',
            localDescriptionForwarded: true,
            localCandidatesSent: 2,
            remoteCandidatesReceived: 3,
            remoteCandidatesQueued: 1,
            remoteCandidatesApplied: 3,
            queuedCandidateCount: 0,
            staleEventsIgnored: 1,
          },
        },
      }),
    );

    expect(activeOffererMarkup).toContain('stable');
    expect(activeOffererMarkup).toContain('gathering');
    expect(activeOffererMarkup).toContain('ICE Gathering Stalled');
    expect(activeOffererMarkup).toContain('5000ms');
    expect(activeOffererMarkup).toContain('Out: 2 / In: 3 / Applied: 3');
    expect(activeOffererMarkup).toContain('Stale ignored: 1');
    expect(activeOffererMarkup).toContain('open');
    expect(activeOffererMarkup).toMatch(
      /<button(?![^>]*disabled)[^>]*>Start WebRTC Negotiation<\/button>/,
    );
    expect(activeOffererMarkup).not.toMatch(/\bsender\b|\breceiver\b/i);
    expect(rtcSpy).not.toHaveBeenCalled();

    const answererMarkup = renderToStaticMarkup(
      React.createElement(App, {
        initialState: {
          connectionStatus: 'connected',
          roomId: 'ship-83a1',
          peerState: 'connected',
          entryRole: 'joiner',
          negotiationDuty: 'answerer',
        },
      }),
    );
    expect(answererMarkup).toMatch(
      /<button[^>]*disabled=""[^>]*>Start WebRTC Negotiation<\/button>/,
    );
    expect(rtcSpy).not.toHaveBeenCalled();
  });
});
