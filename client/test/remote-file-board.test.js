import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  encryptFileAdvertisement,
  FIXED_CHUNK_SIZE_BYTES,
  generateFileId,
} from '../src/crypto/board-metadata.js';
import { createLocalFileBoard } from '../src/board/local-board.js';
import {
  createRemoteFileBoard,
  RECONNECT_BOARD_GRACE_MS,
} from '../src/board/remote-board.js';

const ROOM_ID = 'ship-a1b2';
const OTHER_ROOM_ID = 'ship-c3d4';

function createKeyBytes(fillByte) {
  return new Uint8Array(32).fill(fillByte);
}

function makeMetadata(name, size, extra = {}) {
  return {
    fileName: name,
    fileSize: size,
    fileType: 'application/octet-stream',
    chunkSize: FIXED_CHUNK_SIZE_BYTES,
    totalChunks: size === 0 ? 0 : Math.ceil(size / FIXED_CHUNK_SIZE_BYTES),
    ...extra,
  };
}

describe('Remote file board synchronization', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('rejects invalid roomId or masterKeyBytes on creation', () => {
    expect(() =>
      createRemoteFileBoard({
        roomId: 'invalid-room',
        masterKeyBytes: createKeyBytes(1),
      }),
    ).toThrow(TypeError);

    expect(() =>
      createRemoteFileBoard({
        roomId: ROOM_ID,
        masterKeyBytes: new Uint8Array(16),
      }),
    ).toThrow(TypeError);

    expect(RECONNECT_BOARD_GRACE_MS).toBe(60_000);
  });

  it('decrypts initial BOARD_SYNC and incremental updates into frozen read-only entries without duplicates', async () => {
    const masterKeyBytes = createKeyBytes(7);
    const changes = [];
    const board = createRemoteFileBoard({
      roomId: ROOM_ID,
      masterKeyBytes,
      onChange: (snapshot) => changes.push(snapshot),
    });

    expect(board.getSyncState()).toBe('empty');
    expect(board.getEntries()).toEqual([]);

    const helloResult = await board.handleControlMessage({
      type: 'PEER_HELLO',
      payload: { memberId: 'peer-1', protocolVersion: 1 },
    });
    expect(helloResult.ok).toBe(true);
    expect(board.getSyncState()).toBe('syncing');

    const fileAId = generateFileId();
    const fileBId = generateFileId();
    const advA = await encryptFileAdvertisement({
      masterKeyBytes,
      roomId: ROOM_ID,
      fileId: fileAId,
      metadata: makeMetadata('report.pdf', 1024),
    });
    const advB = await encryptFileAdvertisement({
      masterKeyBytes,
      roomId: ROOM_ID,
      fileId: fileBId,
      metadata: makeMetadata('archive.tar', 150_000),
    });

    const syncResult = await board.handleControlMessage({
      type: 'BOARD_SYNC',
      payload: {
        files: [
          advA.payload,
          advB.payload,
          advA.payload, // duplicate entry inside snapshot should converge
        ],
      },
    });
    expect(syncResult.ok).toBe(true);
    expect(board.getSyncState()).toBe('synced');

    const entries = board.getEntries();
    expect(entries).toHaveLength(2);
    expect(Object.isFrozen(entries)).toBe(true);
    expect(Object.isFrozen(entries[0])).toBe(true);
    expect(entries.map((entry) => entry.fileId)).toEqual([fileAId, fileBId]);
    expect(board.getEntry(fileAId)).toEqual({
      fileId: fileAId,
      fileName: 'report.pdf',
      fileSize: 1024,
      fileType: 'application/octet-stream',
      chunkSize: FIXED_CHUNK_SIZE_BYTES,
      totalChunks: 1,
      availability: 'available',
    });
    expect('file' in board.getEntry(fileAId)).toBe(false);

    // Replay FILE_ADVERTISE for fileA with same fileId converges without duplicates
    const replayResult = await board.handleControlMessage(advA);
    expect(replayResult.ok).toBe(true);
    expect(board.getEntries()).toHaveLength(2);

    // Add fileC via FILE_ADVERTISE and remove fileA via FILE_REMOVE
    const fileCId = generateFileId();
    const advC = await encryptFileAdvertisement({
      masterKeyBytes,
      roomId: ROOM_ID,
      fileId: fileCId,
      metadata: makeMetadata('notes.txt', 12),
    });
    const addCResult = await board.handleControlMessage(advC);
    expect(addCResult.ok).toBe(true);
    expect(board.getEntries().map((entry) => entry.fileId)).toEqual([
      fileAId,
      fileBId,
      fileCId,
    ]);

    const removeAResult = await board.handleControlMessage({
      type: 'FILE_REMOVE',
      payload: { fileId: fileAId },
    });
    expect(removeAResult).toEqual({
      ok: true,
      removed: true,
      fileId: fileAId,
    });
    expect(board.getEntries().map((entry) => entry.fileId)).toEqual([
      fileBId,
      fileCId,
    ]);
    expect(board.getEntry(fileAId)).toBeNull();
    expect(changes.length).toBeGreaterThanOrEqual(4);

    board.dispose();
  });

  it('prunes stale entries on replacement BOARD_SYNC and transitions availability across disconnect, reconnect, and grace expiry', async () => {
    const masterKeyBytes = createKeyBytes(11);
    const board = createRemoteFileBoard({
      roomId: ROOM_ID,
      masterKeyBytes,
      graceWindowMs: RECONNECT_BOARD_GRACE_MS,
    });

    const fileAId = generateFileId();
    const fileBId = generateFileId();
    const fileCId = generateFileId();

    const advA = await encryptFileAdvertisement({
      masterKeyBytes,
      roomId: ROOM_ID,
      fileId: fileAId,
      metadata: makeMetadata('a.bin', 200),
    });
    const advB = await encryptFileAdvertisement({
      masterKeyBytes,
      roomId: ROOM_ID,
      fileId: fileBId,
      metadata: makeMetadata('b.bin', 400),
    });
    const advC = await encryptFileAdvertisement({
      masterKeyBytes,
      roomId: ROOM_ID,
      fileId: fileCId,
      metadata: makeMetadata('c.bin', 600),
    });

    await board.handleBoardSync({
      type: 'BOARD_SYNC',
      payload: { files: [advA.payload, advB.payload] },
    });
    expect(board.getSyncState()).toBe('synced');

    // Peer disconnects: entries become unavailable_reconnecting during 60s grace window
    board.handlePeerDisconnected();
    expect(board.getSyncState()).toBe('peer_disconnected_grace');
    expect(
      board.getEntries().every(
        (entry) => entry.availability === 'unavailable_reconnecting',
      ),
    ).toBe(true);

    // Reconnect before grace timeout: fileA was removed while offline, fileB kept, fileC added
    await vi.advanceTimersByTimeAsync(20_000);
    await board.handleBoardSync({
      type: 'BOARD_SYNC',
      payload: { files: [advB.payload, advC.payload] },
    });

    expect(board.getSyncState()).toBe('synced');
    expect(board.getEntry(fileAId)).toBeNull();
    expect(board.getEntries().map((entry) => entry.fileId)).toEqual([
      fileBId,
      fileCId,
    ]);
    expect(
      board.getEntries().every((entry) => entry.availability === 'available'),
    ).toBe(true);

    // Advancing past original 60s mark does not expire restored entries because grace timer was cleared
    await vi.advanceTimersByTimeAsync(RECONNECT_BOARD_GRACE_MS);
    expect(board.getSyncState()).toBe('synced');
    expect(board.getEntries()).toHaveLength(2);

    // Disconnect again without reconnect -> grace window expires and clears entries
    board.handlePeerDisconnected();
    expect(board.getSyncState()).toBe('peer_disconnected_grace');
    await vi.advanceTimersByTimeAsync(RECONNECT_BOARD_GRACE_MS);

    expect(board.getSyncState()).toBe('empty');
    expect(board.getEntries()).toEqual([]);

    board.dispose();
  });

  it('drops stale in-flight advertisements across disconnect/expiry and fails closed on wrong-key, wrong-room, tampered, or malformed input', async () => {
    const masterKeyBytes = createKeyBytes(19);
    const wrongKeyBytes = createKeyBytes(99);
    const errors = [];
    const board = createRemoteFileBoard({
      roomId: ROOM_ID,
      masterKeyBytes,
      onError: (err) => errors.push(err),
    });

    const validId = generateFileId();
    const validAdv = await encryptFileAdvertisement({
      masterKeyBytes,
      roomId: ROOM_ID,
      fileId: validId,
      metadata: makeMetadata('keep.txt', 50),
    });
    await board.handleFileAdvertise(validAdv);
    expect(board.getEntries()).toHaveLength(1);

    // Wrong key advertisement
    const wrongKeyAdv = await encryptFileAdvertisement({
      masterKeyBytes: wrongKeyBytes,
      roomId: ROOM_ID,
      fileId: generateFileId(),
      metadata: makeMetadata('wrong-key.txt', 20),
    });
    const wrongKeyRes = await board.handleControlMessage(wrongKeyAdv);
    expect(wrongKeyRes.ok).toBe(false);
    expect(wrongKeyRes.code).toBe('DECRYPTION_FAILED');

    // Wrong room AAD advertisement
    const wrongRoomAdv = await encryptFileAdvertisement({
      masterKeyBytes,
      roomId: OTHER_ROOM_ID,
      fileId: generateFileId(),
      metadata: makeMetadata('wrong-room.txt', 20),
    });
    const wrongRoomRes = await board.handleControlMessage(wrongRoomAdv);
    expect(wrongRoomRes.ok).toBe(false);
    expect(wrongRoomRes.code).toBe('DECRYPTION_FAILED');

    // Tampered fileId mismatching AAD
    const tamperedAdv = {
      type: 'FILE_ADVERTISE',
      payload: {
        fileId: generateFileId(),
        encryptedMetadata: validAdv.payload.encryptedMetadata,
      },
    };
    const tamperedRes = await board.handleControlMessage(tamperedAdv);
    expect(tamperedRes.ok).toBe(false);
    expect(tamperedRes.code).toBe('DECRYPTION_FAILED');

    // Malformed BOARD_SYNC snapshot with one invalid entry leaves valid board intact
    const badSyncRes = await board.handleControlMessage({
      type: 'BOARD_SYNC',
      payload: {
        files: [validAdv.payload, wrongKeyAdv.payload],
      },
    });
    expect(badSyncRes.ok).toBe(false);
    expect(badSyncRes.code).toBe('DECRYPTION_FAILED');
    expect(board.getEntries()).toHaveLength(1);
    expect(board.getEntry(validId)?.fileName).toBe('keep.txt');

    // Malformed FILE_REMOVE and non-object control message fail closed
    const badRemove = await board.handleControlMessage({
      type: 'FILE_REMOVE',
      payload: { fileId: 'not-valid' },
    });
    expect(badRemove.ok).toBe(false);
    const nonObj = await board.handleControlMessage('invalid');
    expect(nonObj.ok).toBe(false);

    // Unrelated valid transfer control messages are cleanly ignored without error
    const ignored = await board.handleControlMessage({
      type: 'DOWNLOAD_ACCEPTED',
      payload: { transferId: 'tr-1' },
    });
    expect(ignored).toEqual({ ok: true, ignored: true });
    expect(errors.length).toBeGreaterThanOrEqual(6);

    // Queued advertisement before disconnect + expiry does not resurrect after grace window expires
    const staleAdv = await encryptFileAdvertisement({
      masterKeyBytes,
      roomId: ROOM_ID,
      fileId: generateFileId(),
      metadata: makeMetadata('stale.bin', 10),
    });
    const stalePromise = board.handleFileAdvertise(staleAdv);
    board.handlePeerDisconnected();
    await vi.advanceTimersByTimeAsync(RECONNECT_BOARD_GRACE_MS);

    const staleRes = await stalePromise;
    expect(staleRes.ok).toBe(false);
    expect(staleRes.code).toBe('STALE_EPOCH');
    expect(board.getSyncState()).toBe('empty');
    expect(board.getEntries()).toEqual([]);

    board.dispose();
  });

  it('synchronizes end-to-end with createLocalFileBoard without exposing local File handles', async () => {
    const masterKeyBytes = createKeyBytes(29);
    const remoteBoard = createRemoteFileBoard({
      roomId: ROOM_ID,
      masterKeyBytes,
    });
    const localBoard = createLocalFileBoard({
      roomId: ROOM_ID,
      masterKeyBytes,
      publishControlMessage: (msg) => remoteBoard.handleControlMessage(msg),
    });

    const alphaBytes = new TextEncoder().encode('alpha payload');
    const betaBytes = new TextEncoder().encode('beta payload');
    const createFileLike = (name, bytes, lastModified) => ({
      name,
      size: bytes.byteLength,
      type: 'text/plain',
      lastModified,
      slice(start = 0, end = bytes.byteLength) {
        const sub = bytes.slice(start, end);
        return {
          async arrayBuffer() {
            return sub.buffer.slice(sub.byteOffset, sub.byteOffset + sub.byteLength);
          },
        };
      },
    });

    const addRes = await localBoard.addFiles([
      createFileLike('alpha.txt', alphaBytes, 1_785_000_000_001),
      createFileLike('beta.txt', betaBytes, 1_785_000_000_002),
    ]);
    expect(addRes.advertised).toHaveLength(2);
    expect(remoteBoard.getSyncState()).toBe('synced');
    expect(remoteBoard.getEntries().map((entry) => entry.fileName)).toEqual([
      'alpha.txt',
      'beta.txt',
    ]);
    for (const remoteEntry of remoteBoard.getEntries()) {
      expect('file' in remoteEntry).toBe(false);
    }

    const [alphaEntry, betaEntry] = addRes.advertised;
    await localBoard.removeFile(alphaEntry.fileId);
    expect(remoteBoard.getEntry(alphaEntry.fileId)).toBeNull();
    expect(remoteBoard.getEntries().map((entry) => entry.fileId)).toEqual([
      betaEntry.fileId,
    ]);

    remoteBoard.handlePeerDisconnected();
    expect(remoteBoard.getSyncState()).toBe('peer_disconnected_grace');
    expect(remoteBoard.getEntry(betaEntry.fileId)?.availability).toBe(
      'unavailable_reconnecting',
    );

    const syncRes = await remoteBoard.handleControlMessage(
      await localBoard.getBoardSyncMessage(),
    );
    expect(syncRes.ok).toBe(true);
    expect(remoteBoard.getSyncState()).toBe('synced');
    expect(remoteBoard.getEntry(betaEntry.fileId)?.availability).toBe(
      'available',
    );

    localBoard.dispose();
    remoteBoard.dispose();
  });
});
