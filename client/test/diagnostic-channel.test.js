import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, test, vi } from 'vitest';
import App from '../src/App.jsx';
import {
  DIAGNOSTIC_CHANNEL_LABEL,
  MAX_DIAGNOSTIC_TEXT_LENGTH,
  createDiagnosticChannelController,
  createInitialDiagnosticChannelState,
  validateDiagnosticText,
} from '../src/prototype/diagnostic-channel.js';
import {
  applyDiagnosticChannelState,
  applyPeerLeft,
  applyRoomCreated,
  applyRoomJoined,
  clearLastError,
  createInitialPrototypeState,
  resetRoomMembership,
} from '../src/prototype/diagnostic-state.js';
import { createWebRtcHarness } from '../src/prototype/webrtc-harness.js';
import { createSignalingClient } from '../src/signaling/socket-client.js';
import { createMockSocketFactory } from './helpers/mock-socket.js';
import {
  createMockDataChannel,
  createMockPeerConnectionFactory,
} from './helpers/mock-webrtc.js';

async function flushMicrotasks(rounds = 24) {
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

function createConnectedDataChannelPair() {
  const ioFactory = createMockSocketFactory();
  let tick = 0;
  const socketNow = () =>
    `2026-11-23T12:00:${String(tick++).padStart(2, '0')}.000Z`;

  let clockAMs = 1_700_000_000_000;
  let clockBMs = 1_700_005_000_000;

  const clientA = createSignalingClient({ ioFactory, now: socketNow });
  const clientB = createSignalingClient({ ioFactory, now: socketNow });

  clientA.connect();
  const socketA = ioFactory.calls[0].socket;
  clientB.connect();
  const socketB = ioFactory.calls[1].socket;

  const pcFactoryA = createMockPeerConnectionFactory();
  const pcFactoryB = createMockPeerConnectionFactory();

  const statesA = [];
  const statesB = [];
  const errorsA = [];
  const errorsB = [];

  const controllerA = createDiagnosticChannelController({
    signalingClient: clientA,
    now: () => clockAMs,
    onStateChange: (next) => statesA.push(next),
    onError: (err) => errorsA.push(err),
  });
  const controllerB = createDiagnosticChannelController({
    signalingClient: clientB,
    now: () => clockBMs,
    onStateChange: (next) => statesB.push(next),
    onError: (err) => errorsB.push(err),
  });

  const harnessA = createWebRtcHarness({
    signalingClient: clientA,
    peerConnectionFactory: pcFactoryA,
    onDataChannel: (channel, meta) => controllerA.attachChannel(channel, meta),
  });
  const harnessB = createWebRtcHarness({
    signalingClient: clientB,
    peerConnectionFactory: pcFactoryB,
    onDataChannel: (channel, meta) => controllerB.attachChannel(channel, meta),
  });

  const membership = {
    roomId: 'ship-83a1',
    peerA: 'peer-a',
    peerB: 'peer-b',
  };

  function setupRelay(socket, selfPeerId, getRemoteSocket) {
    const origEmit = socket.emit.bind(socket);
    socket.emit = (event, ...args) => {
      origEmit(event, ...args);
      if (event === 'ice:get') {
        const payload = args[0];
        if (payload?.roomId === membership.roomId) {
          queueMicrotask(() => {
            socket.simulateServerEvent('ice:credentials', {
              roomId: membership.roomId,
              iceServers: [{ urls: ['stun:stun.l.google.com:19302'] }],
            });
          });
        }
      }
      if (event === 'signal:forward') {
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

  setupRelay(socketA, membership.peerA, () => socketB);
  setupRelay(socketB, membership.peerB, () => socketA);

  return {
    clientA,
    clientB,
    socketA,
    socketB,
    pcFactoryA,
    pcFactoryB,
    harnessA,
    harnessB,
    controllerA,
    controllerB,
    statesA,
    statesB,
    errorsA,
    errorsB,
    setClockA(ms) {
      clockAMs = ms;
    },
    advanceClockA(deltaMs) {
      clockAMs += deltaMs;
    },
    setClockB(ms) {
      clockBMs = ms;
    },
    advanceClockB(deltaMs) {
      clockBMs += deltaMs;
    },
    cleanup() {
      harnessA.dispose();
      harnessB.dispose();
      controllerA.dispose();
      controllerB.dispose();
      clientA.dispose();
      clientB.dispose();
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('diagnostic channel state defaults, validation, and prototype state integration', () => {
  test('preserves baseline 6-key createInitialPrototypeState and validates diagnostic text limits and sanitization', () => {
    expect(DIAGNOSTIC_CHANNEL_LABEL).toBe('shipri-diagnostic');
    expect(MAX_DIAGNOSTIC_TEXT_LENGTH).toBeGreaterThan(0);

    expect(createInitialPrototypeState()).toEqual({
      connectionStatus: 'disconnected',
      roomId: null,
      peerState: 'unaffiliated',
      negotiationDuty: null,
      lastError: null,
      eventLog: [],
    });

    const initialChannel = createInitialDiagnosticChannelState();
    expect(initialChannel).toEqual({
      channelState: 'none',
      label: null,
      role: null,
      peerId: null,
      generation: 0,
      lastRttMs: null,
      pingsSent: 0,
      pongsReceived: 0,
      pendingPingCount: 0,
      messagesSent: 0,
      messagesReceived: 0,
      messages: [],
      lastError: null,
    });

    expect(validateDiagnosticText('')).toMatchObject({
      ok: false,
      error: { code: 'INVALID_DIAGNOSTIC_TEXT' },
    });
    expect(validateDiagnosticText('   \n\t  ')).toMatchObject({
      ok: false,
      error: { code: 'INVALID_DIAGNOSTIC_TEXT' },
    });
    expect(validateDiagnosticText(42)).toMatchObject({
      ok: false,
      error: { code: 'INVALID_DIAGNOSTIC_TEXT' },
    });
    expect(
      validateDiagnosticText('a'.repeat(MAX_DIAGNOSTIC_TEXT_LENGTH + 1)),
    ).toMatchObject({
      ok: false,
      error: { code: 'DIAGNOSTIC_TEXT_TOO_LONG' },
    });

    const valid = validateDiagnosticText(
      '  hello peer https://shipri.app/#key=secretFrag authToken=tok999  ',
    );
    expect(valid.ok).toBe(true);
    expect(valid.body).toContain('hello peer');
    expect(valid.body).not.toContain('secretFrag');
    expect(valid.body).not.toContain('tok999');

    const withChannel = createInitialPrototypeState({
      connectionStatus: 'connected',
      roomId: 'ship-83a1',
      peerState: 'connected',
      negotiationDuty: 'answerer',
      diagnosticChannel: {
        channelState: 'open',
        label: 'shipri-diagnostic',
        role: 'answerer',
        peerId: 'peer-a',
        generation: 1,
        lastRttMs: 24,
        messages: [
          {
            id: 'text-1',
            direction: 'inbound',
            type: 'text',
            body: 'Ping check #key=secretLeakInMessage',
            timestamp: '2026-11-23T12:00:00.000Z',
          },
        ],
        lastError: {
          code: 'CHANNEL_ERROR',
          message: 'Error with authToken=secretInError',
        },
      },
    });
    expect(withChannel.diagnosticChannel.channelState).toBe('open');
    expect(withChannel.diagnosticChannel.lastRttMs).toBe(24);
    expect(JSON.stringify(withChannel)).not.toContain('secretLeakInMessage');
    expect(JSON.stringify(withChannel)).not.toContain('secretInError');
    expect(() => createInitialDiagnosticChannelState('bad')).toThrow(TypeError);
  });

  test('diagnostic-state lifecycle reducers update, clear, and reset diagnosticChannel cleanly', () => {
    let state = createInitialPrototypeState({ connectionStatus: 'connected' });
    state = applyRoomCreated(state, {
      roomId: 'ship-83a1',
      peerId: 'peer-a',
      negotiationDuty: 'offerer',
    });
    state = applyDiagnosticChannelState(state, {
      channelState: 'open',
      label: 'shipri-diagnostic',
      role: 'offerer',
      peerId: 'peer-b',
      generation: 1,
      lastRttMs: 18,
      pingsSent: 1,
      pongsReceived: 1,
      pendingPingCount: 1,
      lastError: { code: 'CHANNEL_ERROR', message: 'Transient error' },
    });

    const clearedErr = clearLastError(state);
    expect(clearedErr.diagnosticChannel.lastError).toBeNull();

    const afterPeerLeft = applyPeerLeft(clearedErr, {
      roomId: 'ship-83a1',
      peerId: 'peer-b',
      reason: 'leave',
    });
    expect(afterPeerLeft.diagnosticChannel.channelState).toBe('closed');
    expect(afterPeerLeft.diagnosticChannel.peerId).toBeNull();
    expect(afterPeerLeft.diagnosticChannel.pendingPingCount).toBe(0);

    const afterReset = resetRoomMembership(afterPeerLeft);
    expect(afterReset.diagnosticChannel).toEqual(
      createInitialDiagnosticChannelState(),
    );

    const afterRejoin = applyRoomJoined(afterPeerLeft, {
      roomId: 'ship-beef',
      peerId: 'peer-z',
      negotiationDuty: 'answerer',
    });
    expect(afterRejoin.diagnosticChannel).toEqual(
      createInitialDiagnosticChannelState(),
    );
  });
});

describe('bidirectional diagnostic data-channel creation, ping/pong, and text exchange', () => {
  test('offerer creates single reliable shipri-diagnostic channel, answerer accepts it, and either peer exchanges bidirectional ping/pong and short text', async () => {
    const pair = createConnectedDataChannelPair();

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
    expect(pcA.createdDataChannels).toHaveLength(1);
    const channelA = pcA.createdDataChannels[0];
    expect(channelA.label).toBe('shipri-diagnostic');
    expect(channelA.ordered).toBe(true);
    expect(pair.controllerA.getState().channelState).toBe('connecting');

    const channelB = pcB.simulateRemoteDataChannel('shipri-diagnostic', {
      ordered: true,
    });
    expect(pair.controllerB.getState().channelState).toBe('connecting');

    linkMockDataChannels(channelA, channelB);
    channelA.simulateOpen();
    channelB.simulateOpen();

    expect(pair.harnessA.getState().dataChannelState).toBe('open');
    expect(pair.harnessB.getState().dataChannelState).toBe('open');
    expect(pair.controllerA.getState()).toMatchObject({
      channelState: 'open',
      label: 'shipri-diagnostic',
      role: 'offerer',
      peerId: 'peer-b',
      generation: 1,
      lastError: null,
    });
    expect(pair.controllerB.getState()).toMatchObject({
      channelState: 'open',
      label: 'shipri-diagnostic',
      role: 'answerer',
      peerId: 'peer-a',
      generation: 1,
      lastError: null,
    });

    pair.socketA.clearEmitted();
    pair.socketB.clearEmitted();

    // 1. Offerer -> Answerer ping/pong with RTT calculation using offerer clock.
    const origSendA = channelA.send.bind(channelA);
    channelA.send = (data) => {
      pair.advanceClockA(37);
      origSendA(data);
    };
    const pingFromOfferer = pair.controllerA.sendPing();
    expect(pingFromOfferer.ok).toBe(true);

    expect(pair.controllerA.getState()).toMatchObject({
      lastRttMs: 37,
      pingsSent: 1,
      pongsReceived: 1,
      pendingPingCount: 0,
      messagesSent: 1,
      messagesReceived: 1,
    });
    expect(pair.controllerA.getState().messages).toEqual([
      {
        id: pingFromOfferer.id,
        direction: 'outbound',
        type: 'ping',
        timestamp: expect.any(String),
      },
      {
        id: pingFromOfferer.id,
        direction: 'inbound',
        type: 'pong',
        rttMs: 37,
        timestamp: expect.any(String),
      },
    ]);
    expect(pair.controllerB.getState()).toMatchObject({
      messagesReceived: 1,
      messagesSent: 1,
    });
    expect(pair.controllerB.getState().messages).toEqual([
      {
        id: pingFromOfferer.id,
        direction: 'inbound',
        type: 'ping',
        timestamp: expect.any(String),
      },
      {
        id: pingFromOfferer.id,
        direction: 'outbound',
        type: 'pong',
        timestamp: expect.any(String),
      },
    ]);

    // 2. Answerer -> Offerer ping/pong (equal peer capability!).
    const origSendB = channelB.send.bind(channelB);
    channelB.send = (data) => {
      pair.advanceClockB(19);
      origSendB(data);
    };
    const pingFromAnswerer = pair.controllerB.sendPing();
    expect(pingFromAnswerer.ok).toBe(true);

    expect(pair.controllerB.getState()).toMatchObject({
      lastRttMs: 19,
      pingsSent: 1,
      pongsReceived: 1,
      pendingPingCount: 0,
      messagesSent: 2,
      messagesReceived: 2,
    });
    expect(pair.controllerB.getState().messages.at(-1)).toMatchObject({
      id: pingFromAnswerer.id,
      direction: 'inbound',
      type: 'pong',
      rttMs: 19,
    });
    expect(pair.controllerA.getState()).toMatchObject({
      lastRttMs: 37,
      messagesSent: 2,
      messagesReceived: 2,
    });

    // 3. Offerer -> Answerer short text exchange.
    const textFromOfferer = pair.controllerA.sendText(
      '  hello from offerer  ',
    );
    expect(textFromOfferer.ok).toBe(true);
    expect(pair.controllerB.getState().messages.at(-1)).toMatchObject({
      id: textFromOfferer.id,
      direction: 'inbound',
      type: 'text',
      body: 'hello from offerer',
    });

    // 4. Answerer -> Offerer short text exchange with secret redaction.
    const textFromAnswerer = pair.controllerB.sendText(
      'hello from answerer https://shipri.app/#key=secretHashKey authToken=tok123',
    );
    expect(textFromAnswerer.ok).toBe(true);
    const offererInboundText = pair.controllerA.getState().messages.at(-1);
    expect(offererInboundText).toMatchObject({
      id: textFromAnswerer.id,
      direction: 'inbound',
      type: 'text',
    });
    expect(offererInboundText.body).toContain('hello from answerer');
    expect(offererInboundText.body).not.toContain('secretHashKey');
    expect(offererInboundText.body).not.toContain('tok123');

    // Data-channel frames never emit over Socket.IO.
    expect(pair.socketA.emittedEvents).toHaveLength(0);
    expect(pair.socketB.emittedEvents).toHaveLength(0);

    pair.cleanup();
  });
});

describe('diagnostic channel error handling and malformed inputs', () => {
  test('handles non-open sends, invalid text, malformed inbound frames, send throws, and channel error events cleanly', () => {
    let nowMs = 5_000;
    const errors = [];
    const controller = createDiagnosticChannelController({
      now: () => nowMs,
      onError: (err) => errors.push(err),
    });

    // No channel attached.
    expect(controller.sendPing()).toMatchObject({
      ok: false,
      error: { code: 'CHANNEL_NOT_OPEN' },
    });
    expect(controller.sendText('hello')).toMatchObject({
      ok: false,
      error: { code: 'CHANNEL_NOT_OPEN' },
    });
    expect(controller.getState().lastError.code).toBe('CHANNEL_NOT_OPEN');

    // Channel attached in connecting state.
    const channel = createMockDataChannel('shipri-diagnostic', {
      ordered: true,
      readyState: 'connecting',
    });
    controller.attachChannel(channel, {
      role: 'offerer',
      generation: 1,
      peerId: 'peer-b',
    });
    expect(controller.sendPing()).toMatchObject({
      ok: false,
      error: { code: 'CHANNEL_NOT_OPEN' },
    });

    channel.simulateOpen();

    // Empty / whitespace / oversized text rejected without calling channel.send.
    const emptyRes = controller.sendText('   ');
    expect(emptyRes.ok).toBe(false);
    expect(emptyRes.error.code).toBe('INVALID_DIAGNOSTIC_TEXT');
    expect(channel.sentMessages).toHaveLength(0);

    const longRes = controller.sendText(
      'x'.repeat(MAX_DIAGNOSTIC_TEXT_LENGTH + 1),
    );
    expect(longRes.ok).toBe(false);
    expect(longRes.error.code).toBe('DIAGNOSTIC_TEXT_TOO_LONG');
    expect(channel.sentMessages).toHaveLength(0);

    // Malformed inbound frames set lastError without throwing.
    channel.simulateMessage(new Uint8Array([1, 2, 3]));
    expect(controller.getState().lastError.code).toBe(
      'INVALID_DIAGNOSTIC_MESSAGE',
    );

    channel.simulateMessage('{bad-json');
    expect(controller.getState().lastError.code).toBe(
      'INVALID_DIAGNOSTIC_MESSAGE',
    );

    channel.simulateMessage(JSON.stringify(['not', 'an', 'object']));
    expect(controller.getState().lastError.code).toBe(
      'INVALID_DIAGNOSTIC_MESSAGE',
    );

    channel.simulateMessage(
      JSON.stringify({ type: 'unknown', id: 'x-1', sentAt: 100 }),
    );
    expect(controller.getState().lastError.code).toBe(
      'INVALID_DIAGNOSTIC_MESSAGE',
    );

    channel.simulateMessage(
      JSON.stringify({ type: 'pong', id: 'p-1', sentAt: 100 }),
    );
    expect(controller.getState().lastError.code).toBe(
      'INVALID_DIAGNOSTIC_MESSAGE',
    );

    channel.simulateMessage(
      JSON.stringify({
        type: 'text',
        id: 't-1',
        sentAt: 100,
        body: '   ',
      }),
    );
    expect(controller.getState().lastError.code).toBe(
      'INVALID_DIAGNOSTIC_TEXT',
    );

    channel.simulateMessage(
      JSON.stringify({
        type: 'text',
        id: 't-2',
        sentAt: 100,
        body: 'y'.repeat(MAX_DIAGNOSTIC_TEXT_LENGTH + 1),
      }),
    );
    expect(controller.getState().lastError.code).toBe(
      'DIAGNOSTIC_TEXT_TOO_LONG',
    );
    expect(controller.getState().messages).toHaveLength(0);

    // Inbound raw text carrying #key= fragment is sanitized on receipt.
    channel.simulateMessage(
      JSON.stringify({
        type: 'text',
        id: 't-3',
        sentAt: 100,
        body: 'Raw peer message https://shipri.app/#key=inboundSecretFrag',
      }),
    );
    expect(controller.getState().messages).toHaveLength(1);
    expect(controller.getState().messages[0].body).not.toContain(
      'inboundSecretFrag',
    );

    // Throwing channel.send() on sendPing, sendText, and auto-pong reply.
    channel.send = () => {
      throw new Error('SCTP buffer full #key=throwSecret');
    };
    const pingThrowRes = controller.sendPing();
    expect(pingThrowRes.ok).toBe(false);
    expect(pingThrowRes.error.code).toBe('CHANNEL_SEND_FAILED');
    expect(pingThrowRes.error.message).not.toContain('throwSecret');
    expect(controller.getState().pingsSent).toBe(0);
    expect(controller.getState().pendingPingCount).toBe(0);

    const textThrowRes = controller.sendText('will fail');
    expect(textThrowRes.ok).toBe(false);
    expect(textThrowRes.error.code).toBe('CHANNEL_SEND_FAILED');

    // Auto-pong failure when send throws on inbound ping.
    channel.simulateMessage(
      JSON.stringify({ type: 'ping', id: 'remote-ping-1', sentAt: 900 }),
    );
    expect(controller.getState().lastError.code).toBe('CHANNEL_SEND_FAILED');
    expect(controller.getState().messagesReceived).toBe(2);

    // Channel error event sets sanitized lastError and clearError clears it cleanly.
    channel.simulateError(
      new Error('DataChannel failure authToken=errTokenLeak'),
    );
    expect(controller.getState().lastError.code).toBe('CHANNEL_ERROR');
    expect(controller.getState().lastError.message).not.toContain(
      'errTokenLeak',
    );
    expect(errors.length).toBeGreaterThan(0);

    controller.clearError();
    expect(controller.getState().lastError).toBeNull();
    expect(controller.getState().messages).toHaveLength(2);

    controller.dispose();
  });
});

describe('diagnostic channel cleanup, detachment, and generation isolation', () => {
  test('detaches channel cleanly, clears channel.onmessage, ignores late messages, and resets on peer:left, room:leave, disconnect, and dispose', async () => {
    const controller = createDiagnosticChannelController();
    const ch1 = createMockDataChannel('shipri-diagnostic', {
      readyState: 'open',
    });
    controller.attachChannel(ch1, {
      role: 'offerer',
      generation: 1,
      peerId: 'peer-b',
    });
    expect(typeof ch1.onmessage).toBe('function');

    controller.sendPing();
    expect(controller.getState().pendingPingCount).toBe(1);

    // Replacing ch1 with ch2 detaches ch1 and ignores late messages on ch1.
    const ch2 = createMockDataChannel('shipri-diagnostic', {
      readyState: 'open',
    });
    controller.attachChannel(ch2, {
      role: 'offerer',
      generation: 2,
      peerId: 'peer-c',
    });
    expect(ch1.onmessage).toBeNull();
    expect(controller.getState().generation).toBe(2);
    expect(controller.getState().pendingPingCount).toBe(0);
    expect(controller.getState().messages).toEqual([]);

    ch1.simulateMessage(
      JSON.stringify({
        type: 'text',
        id: 'late-1',
        sentAt: 10,
        body: 'late msg from ch1',
      }),
    );
    expect(controller.getState().messages).toEqual([]);

    // Natural close clears message handler and ignores late messages.
    ch2.close();
    expect(ch2.onmessage).toBeNull();
    expect(controller.getState().channelState).toBe('closed');
    ch2.simulateMessage(
      JSON.stringify({
        type: 'text',
        id: 'late-2',
        sentAt: 12,
        body: 'late msg after close',
      }),
    );
    expect(controller.getState().messages).toEqual([]);
    controller.dispose();

    // End-to-end harness teardown: peer:left -> closed, room:leave -> reset, disconnect -> reset, dispose -> detached.
    const pair = createConnectedDataChannelPair();
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

    const chA1 = pair.pcFactoryA.lastInstance.createdDataChannels[0];
    const chB1 = pair.pcFactoryB.lastInstance.simulateRemoteDataChannel(
      'shipri-diagnostic',
      { ordered: true },
    );
    linkMockDataChannels(chA1, chB1);
    chA1.simulateOpen();
    chB1.simulateOpen();

    pair.controllerA.sendText('before peer left');
    expect(pair.controllerA.getState().messages).toHaveLength(1);
    expect(pair.controllerB.getState().messages).toHaveLength(1);

    // peer:left on offerer detaches chA1 (onmessage = null), closes channel, preserves transcript until replacement/reset.
    pair.socketA.simulateServerEvent('peer:left', {
      roomId: 'ship-83a1',
      peerId: 'peer-b',
      reason: 'leave',
    });
    expect(chA1.onmessage).toBeNull();
    expect(chA1.readyState).toBe('closed');
    expect(pair.controllerA.getState().channelState).toBe('closed');
    expect(pair.controllerA.getState().peerId).toBeNull();
    expect(pair.controllerA.getState().pendingPingCount).toBe(0);

    // Late message on closed chA1 is ignored.
    chA1.simulateMessage(
      JSON.stringify({
        type: 'text',
        id: 'stale-a',
        sentAt: 1,
        body: 'should be ignored',
      }),
    );
    expect(pair.controllerA.getState().messages).toHaveLength(1);

    // room:leave resets transient channel state cleanly on peer A.
    pair.clientA.leaveRoom('ship-83a1');
    expect(pair.controllerA.getState()).toEqual(
      createInitialDiagnosticChannelState(),
    );

    // disconnect on peer B detaches chB1 and resets transient channel state cleanly.
    pair.socketB.simulateDisconnect('transport close');
    expect(chB1.onmessage).toBeNull();
    expect(chB1.readyState).toBe('closed');
    expect(pair.controllerB.getState()).toEqual(
      createInitialDiagnosticChannelState(),
    );

    pair.cleanup();
  });

  test('tracks subscribeState updates, multiple pending pings, unmatched pongs, and harness.dispose() channel teardown', async () => {
    let clockMs = 10_000;
    const snapshots = [];
    const controller = createDiagnosticChannelController({
      now: () => clockMs,
    });
    const unsubscribe = controller.subscribeState((snap) => {
      snapshots.push(snap.channelState);
    });

    const ch = createMockDataChannel('shipri-diagnostic', {
      readyState: 'open',
    });
    controller.attachChannel(ch, {
      role: 'answerer',
      generation: 1,
      peerId: 'peer-a',
    });

    const p1 = controller.sendPing();
    clockMs += 10;
    const p2 = controller.sendPing();
    expect(controller.getState().pendingPingCount).toBe(2);

    clockMs += 15;
    ch.simulateMessage(
      JSON.stringify({
        type: 'pong',
        id: p1.id,
        sentAt: 10_000,
        repliedAt: 10_010,
      }),
    );
    expect(controller.getState().lastRttMs).toBe(25);
    expect(controller.getState().pendingPingCount).toBe(1);

    // Unmatched pong does not drop pendingPingCount or overwrite lastRttMs.
    ch.simulateMessage(
      JSON.stringify({
        type: 'pong',
        id: 'unknown-ping',
        sentAt: 9_000,
        repliedAt: 9_005,
      }),
    );
    expect(controller.getState().lastRttMs).toBe(25);
    expect(controller.getState().pendingPingCount).toBe(1);

    clockMs += 5;
    ch.simulateMessage(
      JSON.stringify({
        type: 'pong',
        id: p2.id,
        sentAt: 10_010,
        repliedAt: 10_015,
      }),
    );
    expect(controller.getState().lastRttMs).toBe(20);
    expect(controller.getState().pendingPingCount).toBe(0);

    unsubscribe();
    const countBeforeDetach = snapshots.length;
    controller.detachChannel();
    expect(snapshots).toHaveLength(countBeforeDetach);
    expect(ch.onmessage).toBeNull();
    controller.dispose();

    // Verify harness.dispose() detaches an open channel cleanly.
    const pair = createConnectedDataChannelPair();
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

    const chOpen = pair.pcFactoryA.lastInstance.createdDataChannels[0];
    chOpen.simulateOpen();
    expect(typeof chOpen.onmessage).toBe('function');

    pair.harnessA.dispose();
    expect(chOpen.onmessage).toBeNull();
    expect(chOpen.readyState).toBe('closed');
    expect(pair.controllerA.getState().channelState).toBe('closed');
    pair.cleanup();
  });
});

describe('App static markup for Diagnostic Data Channel panel', () => {
  test('renders Diagnostic Data Channel controls, channel state, RTT, sanitized transcript, error banner, and equal-peer note without sender/receiver terms', () => {
    const rtcSpy = vi.fn();
    vi.stubGlobal('RTCPeerConnection', rtcSpy);

    const defaultMarkup = renderToStaticMarkup(React.createElement(App));
    expect(defaultMarkup).toContain('Diagnostic Data Channel');
    expect(defaultMarkup).toContain('Channel State');
    expect(defaultMarkup).toContain('Send Ping');
    expect(defaultMarkup).toContain('Send Text');
    expect(defaultMarkup).toContain('Last RTT');
    expect(defaultMarkup).toContain('No diagnostic data-channel messages exchanged yet.');
    expect(defaultMarkup).toMatch(/either.*peer/i);
    expect(defaultMarkup).toMatch(
      /<button[^>]*disabled=""[^>]*>Send Ping<\/button>/,
    );
    expect(defaultMarkup).toMatch(
      /<button[^>]*disabled=""[^>]*>Send Text<\/button>/,
    );
    expect(defaultMarkup).not.toMatch(/\bsender\b|\breceiver\b/i);
    expect(rtcSpy).not.toHaveBeenCalled();

    // Both open offerer and open answerer have enabled Send Ping and short text input.
    for (const duty of ['offerer', 'answerer']) {
      const openMarkup = renderToStaticMarkup(
        React.createElement(App, {
          initialState: {
            connectionStatus: 'connected',
            roomId: 'ship-83a1',
            peerState: 'connected',
            entryRole: duty === 'offerer' ? 'creator' : 'joiner',
            negotiationDuty: duty,
            diagnosticChannel: {
              channelState: 'open',
              label: 'shipri-diagnostic',
              role: duty,
              peerId: 'peer-remote',
              generation: 1,
              lastRttMs: 37,
              pingsSent: 1,
              pongsReceived: 1,
              pendingPingCount: 0,
              messagesSent: 2,
              messagesReceived: 2,
              messages: [
                {
                  id: 'ping-1',
                  direction: 'outbound',
                  type: 'ping',
                  timestamp: '2026-11-23T12:00:00.000Z',
                },
                {
                  id: 'ping-1',
                  direction: 'inbound',
                  type: 'pong',
                  rttMs: 37,
                  timestamp: '2026-11-23T12:00:01.000Z',
                },
                {
                  id: 'text-2',
                  direction: 'inbound',
                  type: 'text',
                  body: 'Hello peer https://shipri.app/#key=secretUiFrag',
                  timestamp: '2026-11-23T12:00:02.000Z',
                },
              ],
              lastError: {
                code: 'CHANNEL_ERROR',
                message: 'Channel warning authToken=secretChannelTok',
              },
            },
          },
        }),
      );

      expect(openMarkup).toContain('Diagnostic Data Channel');
      expect(openMarkup).toContain('open');
      expect(openMarkup).toContain('37 ms');
      expect(openMarkup).toContain('ping-1');
      expect(openMarkup).toContain('Hello peer');
      expect(openMarkup).toContain('CHANNEL_ERROR');
      expect(openMarkup).not.toContain('secretUiFrag');
      expect(openMarkup).not.toContain('secretChannelTok');
      expect(openMarkup).toMatch(
        /<button(?![^>]*disabled)[^>]*>Send Ping<\/button>/,
      );
      expect(openMarkup).toMatch(
        /<input(?![^>]*disabled)[^>]*id="diagnostic-channel-text"/,
      );
      expect(openMarkup).not.toMatch(/\bsender\b|\breceiver\b/i);
    }

    expect(rtcSpy).not.toHaveBeenCalled();
  });
});
