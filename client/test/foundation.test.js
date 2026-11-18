import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import App from '../src/App.jsx';
import {
  createMockSocket,
  createMockSocketFactory,
} from './helpers/mock-socket.js';

describe('frontend prototype test foundation', () => {
  test('createMockSocket tracks connection lifecycle, inbound server events, outbound emits, and listener cleanup', () => {
    const socket = createMockSocket({ id: 'mock-peer-1' });
    const events = [];

    const onConnect = () => events.push(['connect', socket.connected]);
    const onCreated = (payload) => events.push(['room:created', payload.roomId]);
    const onOnceLeft = (payload) => events.push(['peer:left', payload.reason]);

    socket.on('connect', onConnect);
    socket.on('room:created', onCreated);
    socket.once('peer:left', onOnceLeft);

    expect(socket.connected).toBe(false);
    expect(socket.getListenerCount()).toBe(3);

    socket.simulateConnect();
    expect(socket.connected).toBe(true);

    socket.emit('room:create', {});
    expect(socket.emittedEvents).toEqual([{ event: 'room:create', args: [{}] }]);

    socket.simulateServerEvent('room:created', {
      roomId: 'ship-83a1',
      peerId: 'peer-a',
      negotiationDuty: 'offerer',
    });
    socket.simulateServerEvent('peer:left', {
      roomId: 'ship-83a1',
      peerId: 'peer-b',
      reason: 'leave',
    });
    socket.simulateServerEvent('peer:left', {
      roomId: 'ship-83a1',
      peerId: 'peer-c',
      reason: 'disconnect',
    });

    expect(events).toEqual([
      ['connect', true],
      ['room:created', 'ship-83a1'],
      ['peer:left', 'leave'],
    ]);
    expect(socket.getListenerCount('peer:left')).toBe(0);

    socket.off('room:created', onCreated);
    expect(socket.getListenerCount('room:created')).toBe(0);

    const connectErrors = [];
    socket.on('connect_error', (error) => connectErrors.push(error.message));
    socket.simulateConnectError(new Error('Network offline'));
    expect(connectErrors).toEqual(['Network offline']);

    socket.simulateDisconnect('transport close');
    expect(socket.connected).toBe(false);

    socket.removeAllListeners();
    expect(socket.getListenerCount()).toBe(0);
  });

  test('createMockSocketFactory records connection URLs and options without a live backend', () => {
    const factory = createMockSocketFactory();
    const first = factory('http://localhost:5001', { autoConnect: false });
    const second = factory('https://poc.shipri.app', {
      transports: ['websocket'],
    });

    expect(factory.calls).toHaveLength(2);
    expect(factory.calls[0]).toMatchObject({
      url: 'http://localhost:5001',
      options: { autoConnect: false },
      socket: first,
    });
    expect(factory.calls[1]).toMatchObject({
      url: 'https://poc.shipri.app',
      options: { transports: ['websocket'] },
      socket: second,
    });
    expect(factory.lastSocket).toBe(second);

    first.clearEmitted();
    first.connect();
    expect(first.connectCalls).toBe(1);
    expect(first.connected).toBe(true);
    first.disconnect();
    expect(first.disconnectCalls).toBe(1);
    expect(first.connected).toBe(false);
  });

  test('renders baseline App shell in Vitest without a browser', () => {
    const markup = renderToStaticMarkup(React.createElement(App));

    expect(markup).toContain('Shipri');
  });
});
