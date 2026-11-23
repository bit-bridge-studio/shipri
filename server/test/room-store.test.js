import { describe, expect, test } from 'vitest';
import { createRoomStore } from '../src/room-store.js';

describe('createRoomStore', () => {
  test('creates rooms, tracks reverse socket membership, and updates timestamps via injected clock', () => {
    let currentTime = 1_700_000_000_000;
    const store = createRoomStore({ now: () => currentTime });

    const { room, peer } = store.createRoom({
      roomId: 'ship-1a2b',
      peerId: 'peer-1111111111111111',
      socketId: 'socket-creator',
    });

    expect(store.size()).toBe(1);
    expect(store.activeRooms.get('ship-1a2b')).toBe(room);
    expect(store.socketRooms.get('socket-creator')).toBe('ship-1a2b');
    expect(peer).toEqual({
      peerId: 'peer-1111111111111111',
      socketId: 'socket-creator',
      joinedAt: 1_700_000_000_000,
    });
    expect(room.createdAt).toBe(1_700_000_000_000);
    expect(room.lastActivityAt).toBe(1_700_000_000_000);
    expect(store.hasActiveRoomMembership('socket-creator')).toBe(true);

    currentTime += 5_000;
    const joiner = store.addPeer(room, {
      peerId: 'peer-2222222222222222',
      socketId: 'socket-joiner',
    });

    expect(joiner.joinedAt).toBe(1_700_000_005_000);
    expect(room.peers).toHaveLength(2);
    expect(room.lastActivityAt).toBe(1_700_000_005_000);
    expect(store.socketRooms.get('socket-joiner')).toBe('ship-1a2b');
  });

  test('removes peers in O(1), deletes empty rooms immediately, and self-heals stale reverse entries', () => {
    let currentTime = 1_700_000_000_000;
    const store = createRoomStore({ now: () => currentTime });

    const { room } = store.createRoom({
      roomId: 'ship-9f0e',
      peerId: 'peer-aaaaaaaaaaaaaaaa',
      socketId: 'socket-1',
    });
    store.addPeer(room, {
      peerId: 'peer-bbbbbbbbbbbbbbbb',
      socketId: 'socket-2',
    });

    currentTime += 1_000;
    const firstRemoval = store.removePeer(room, 1);
    expect(firstRemoval.roomDeleted).toBe(false);
    expect(firstRemoval.removedPeer.socketId).toBe('socket-2');
    expect(firstRemoval.remainingPeer.socketId).toBe('socket-1');
    expect(store.socketRooms.has('socket-2')).toBe(false);
    expect(store.activeRooms.has('ship-9f0e')).toBe(true);

    const secondRemoval = store.removePeer(room, 0);
    expect(secondRemoval.roomDeleted).toBe(true);
    expect(secondRemoval.remainingPeer).toBeNull();
    expect(store.size()).toBe(0);
    expect(store.socketRooms.size).toBe(0);

    store.socketRooms.set('stale-socket', 'ship-dead');
    expect(store.findSocketMembership('stale-socket')).toBeNull();
    expect(store.socketRooms.has('stale-socket')).toBe(false);
  });

  test('clears all rooms and socket indices cleanly', () => {
    const store = createRoomStore();
    store.createRoom({
      roomId: 'ship-cafe',
      peerId: 'peer-cccccccccccccccc',
      socketId: 'socket-c',
    });

    expect(store.size()).toBe(1);
    expect(store.socketRooms.size).toBe(1);

    store.clear();
    expect(store.size()).toBe(0);
    expect(store.socketRooms.size).toBe(0);
  });
});
