import { describe, expect, it, vi } from 'vitest';
import { createLocalFileBoard } from '../src/board/local-board.js';
import { createRemoteFileBoard } from '../src/board/remote-board.js';
import {
  generateMasterKey,
  generateMemberId,
} from '../src/crypto/fragment-key.js';
import { CHUNK_SIZE_BYTES } from '../src/transfer/owner-streamer.js';
import { createTransferCoordinator } from '../src/transfer/transfer-coordinator.js';

const ROOM_ID = 'ship-c5d8';

function createDeterministicBytes(length, seed = 11) {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) {
    bytes[i] = (i * 23 + seed) & 0xff;
  }
  return bytes;
}

function concatUint8Arrays(chunks) {
  const total = chunks.reduce((sum, c) => sum + c.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

function createMockReadableFile({
  name,
  bytes,
  lastModified = 1_785_400_000_000,
} = {}) {
  let currentSize = bytes.byteLength;
  return {
    name,
    get size() {
      return currentSize;
    },
    type: 'application/octet-stream',
    lastModified,
    slice(start = 0, end = currentSize) {
      const sub = bytes.slice(start, end);
      return {
        async arrayBuffer() {
          return sub.buffer.slice(sub.byteOffset, sub.byteOffset + sub.byteLength);
        },
      };
    },
    mutateSize(nextSize) {
      currentSize = nextSize;
    },
  };
}

function createSaveWindowHarness(writeDelayMs = 0) {
  const savedFiles = new Map();
  const windowObj = {
    isSecureContext: true,
    showSaveFilePicker: vi.fn(async ({ suggestedName }) => {
      const chunks = [];
      const record = {
        fileName: suggestedName,
        chunks,
        closed: false,
        aborted: false,
        getBytes: () => concatUint8Arrays(chunks),
      };
      const list = savedFiles.get(suggestedName) ?? [];
      list.push(record);
      savedFiles.set(suggestedName, list);

      return {
        name: suggestedName,
        async createWritable() {
          return {
            async write(chunk) {
              if (writeDelayMs > 0) {
                await new Promise((resolve) => setTimeout(resolve, writeDelayMs));
              }
              chunks.push(new Uint8Array(chunk));
            },
            async close() {
              record.closed = true;
            },
            async abort() {
              record.aborted = true;
            },
          };
        },
      };
    }),
  };

  return { windowObj, savedFiles };
}

function createLinkedPeerPair({
  fileWriteDelayMsA = 2,
  fileWriteDelayMsB = 2,
  nowFn = Date.now,
} = {}) {
  const { masterKeyBytes } = generateMasterKey();
  const memberA = generateMemberId();
  const memberB = generateMemberId();

  const localBoardA = createLocalFileBoard({ roomId: ROOM_ID, masterKeyBytes });
  const localBoardB = createLocalFileBoard({ roomId: ROOM_ID, masterKeyBytes });
  const remoteBoardA = createRemoteFileBoard({ roomId: ROOM_ID, masterKeyBytes });
  const remoteBoardB = createRemoteFileBoard({ roomId: ROOM_ID, masterKeyBytes });

  const saveHarnessA = createSaveWindowHarness(fileWriteDelayMsA);
  const saveHarnessB = createSaveWindowHarness(fileWriteDelayMsB);

  const controlLogAtoB = [];
  const controlLogBtoA = [];

  let coordA;
  let coordB;

  const channelA = {
    readyState: 'open',
    bufferedAmount: 0,
    bufferedAmountLowThreshold: 0,
    addEventListener() {},
    removeEventListener() {},
    send(frame) {
      coordB.handleBinaryFrame(frame);
    },
  };
  const channelB = {
    readyState: 'open',
    bufferedAmount: 0,
    bufferedAmountLowThreshold: 0,
    addEventListener() {},
    removeEventListener() {},
    send(frame) {
      coordA.handleBinaryFrame(frame);
    },
  };

  const deliverControl = (targetGetter, senderId, logList) => async (msg) => {
    logList.push(msg);
    await new Promise((resolve) => setTimeout(resolve, 1));
    await targetGetter().handleControlMessage(msg, senderId);
  };

  coordA = createTransferCoordinator({
    roomId: ROOM_ID,
    masterKeyBytes,
    localMemberId: memberA,
    getRemoteMemberId: () => memberB,
    localBoard: localBoardA,
    remoteBoard: remoteBoardA,
    getBinaryChannel: () => channelA,
    sendControlMessage: deliverControl(() => coordB, memberA, controlLogAtoB),
    windowObj: saveHarnessA.windowObj,
    navigatorObj: {},
    nowFn,
  });

  coordB = createTransferCoordinator({
    roomId: ROOM_ID,
    masterKeyBytes,
    localMemberId: memberB,
    getRemoteMemberId: () => memberA,
    localBoard: localBoardB,
    remoteBoard: remoteBoardB,
    getBinaryChannel: () => channelB,
    sendControlMessage: deliverControl(() => coordA, memberB, controlLogBtoA),
    windowObj: saveHarnessB.windowObj,
    navigatorObj: {},
    nowFn,
  });

  async function publishLocalBoards() {
    await remoteBoardB.handleControlMessage(await localBoardA.getBoardSyncMessage());
    await remoteBoardA.handleControlMessage(await localBoardB.getBoardSyncMessage());
    coordA.refreshRemoteCapabilities();
    coordB.refreshRemoteCapabilities();
  }

  return {
    memberA,
    memberB,
    localBoardA,
    localBoardB,
    remoteBoardA,
    remoteBoardB,
    saveHarnessA,
    saveHarnessB,
    controlLogAtoB,
    controlLogBtoA,
    coordA,
    coordB,
    publishLocalBoards,
    dispose() {
      coordA.dispose();
      coordB.dispose();
      localBoardA.dispose();
      localBoardB.dispose();
      remoteBoardA.dispose();
      remoteBoardB.dispose();
    },
  };
}

describe('Independent transfer progress and controls (FF-5)', () => {
  it('runs simultaneous opposite-direction transfers with independent progress, speed, and ETA to byte-for-byte completion', async () => {
    let clockMs = 1_785_500_000_000;
    const peerPair = createLinkedPeerPair({
      fileWriteDelayMsA: 3,
      fileWriteDelayMsB: 3,
      nowFn: () => {
        clockMs += 50;
        return clockMs;
      },
    });

    const bytesFromA = createDeterministicBytes(CHUNK_SIZE_BYTES * 6 + 321, 13);
    const bytesFromB = createDeterministicBytes(CHUNK_SIZE_BYTES * 4 + 99, 77);

    const addedA = await peerPair.localBoardA.addFiles([
      createMockReadableFile({ name: 'from-a.bin', bytes: bytesFromA }),
    ]);
    const addedB = await peerPair.localBoardB.addFiles([
      createMockReadableFile({ name: 'from-b.bin', bytes: bytesFromB }),
    ]);
    await peerPair.publishLocalBoards();

    const fileFromAId = addedA.advertised[0].fileId;
    const fileFromBId = addedB.advertised[0].fileId;

    const reqBDownloadsA = await peerPair.coordB.requestDownload(fileFromAId);
    const reqADownloadsB = await peerPair.coordA.requestDownload(fileFromBId);

    expect(reqBDownloadsA.ok).toBe(true);
    expect(reqADownloadsB.ok).toBe(true);
    expect(reqBDownloadsA.transferId).not.toBe(reqADownloadsB.transferId);

    await vi.waitFor(
      () => {
        expect(
          peerPair.coordA.getTransfer(reqBDownloadsA.transferId)?.state,
        ).toBe('completed');
        expect(
          peerPair.coordB.getTransfer(reqBDownloadsA.transferId)?.state,
        ).toBe('completed');
        expect(
          peerPair.coordA.getTransfer(reqADownloadsB.transferId)?.state,
        ).toBe('completed');
        expect(
          peerPair.coordB.getTransfer(reqADownloadsB.transferId)?.state,
        ).toBe('completed');
      },
      { timeout: 5000 },
    );

    const aIncoming = peerPair.coordA.getTransfer(reqADownloadsB.transferId);
    const aOutgoing = peerPair.coordA.getTransfer(reqBDownloadsA.transferId);
    expect(aIncoming).toMatchObject({
      transferId: reqADownloadsB.transferId,
      directionLabel: 'downloading',
      totalBytes: bytesFromB.byteLength,
      bytesTransferred: bytesFromB.byteLength,
      progressPercent: 100,
      state: 'completed',
      etaSeconds: null,
    });
    expect(aOutgoing).toMatchObject({
      transferId: reqBDownloadsA.transferId,
      directionLabel: 'sending',
      totalBytes: bytesFromA.byteLength,
      bytesTransferred: bytesFromA.byteLength,
      progressPercent: 100,
      state: 'completed',
      etaSeconds: null,
    });

    const savedAtA = peerPair.saveHarnessA.savedFiles.get('from-b.bin')[0];
    const savedAtB = peerPair.saveHarnessB.savedFiles.get('from-a.bin')[0];
    expect(savedAtA.closed).toBe(true);
    expect(savedAtB.closed).toBe(true);
    expect(Buffer.compare(savedAtA.getBytes(), bytesFromB)).toBe(0);
    expect(Buffer.compare(savedAtB.getBytes(), bytesFromA)).toBe(0);

    peerPair.dispose();
  });

  it('pauses and resumes one transfer without stalling the opposite direction and exposes live speed and ETA', async () => {
    let clockMs = 1_785_600_000_000;
    const peerPair = createLinkedPeerPair({
      fileWriteDelayMsA: 2,
      fileWriteDelayMsB: 6,
      nowFn: () => {
        clockMs += 100;
        return clockMs;
      },
    });

    // Make A->B exceed the 2 MiB initial credit window (36 * 64 KiB + 100 bytes)
    // so pausing early halts credit expansion before all chunks can be sent.
    const largeFromA = createDeterministicBytes(CHUNK_SIZE_BYTES * 36 + 100, 3);
    const smallFromB = createDeterministicBytes(CHUNK_SIZE_BYTES * 3 + 50, 9);

    const addedA = await peerPair.localBoardA.addFiles([
      createMockReadableFile({ name: 'pausable-a.bin', bytes: largeFromA }),
    ]);
    const addedB = await peerPair.localBoardB.addFiles([
      createMockReadableFile({ name: 'fast-b.bin', bytes: smallFromB }),
    ]);
    await peerPair.publishLocalBoards();

    const dlBfromA = await peerPair.coordB.requestDownload(addedA.advertised[0].fileId);
    expect(dlBfromA.ok).toBe(true);

    // Wait until B receives first chunk, then pause A->B from downloader B
    await vi.waitFor(() => {
      const snap = peerPair.coordB.getTransfer(dlBfromA.transferId);
      expect(snap?.bytesTransferred).toBeGreaterThanOrEqual(CHUNK_SIZE_BYTES);
    });

    const midSnapshot = peerPair.coordB.getTransfer(dlBfromA.transferId);
    expect(midSnapshot.bytesPerSecond).toBeGreaterThan(0);
    expect(midSnapshot.etaSeconds).toBeGreaterThanOrEqual(1);

    expect(peerPair.coordB.pauseTransfer(dlBfromA.transferId)).toBe(true);
    await vi.waitFor(() => {
      expect(peerPair.coordB.getTransfer(dlBfromA.transferId)?.state).toBe(
        'paused_by_user',
      );
      expect(peerPair.coordA.getTransfer(dlBfromA.transferId)?.state).toBe(
        'paused_by_user',
      );
    });
    expect(peerPair.coordB.getTransfer(dlBfromA.transferId)?.etaSeconds).toBeNull();

    // Opposite direction (A downloads from B) starts and completes while A->B stays paused
    const dlAfromB = await peerPair.coordA.requestDownload(addedB.advertised[0].fileId);
    expect(dlAfromB.ok).toBe(true);
    await vi.waitFor(() => {
      expect(peerPair.coordA.getTransfer(dlAfromB.transferId)?.state).toBe(
        'completed',
      );
    });
    expect(peerPair.coordB.getTransfer(dlBfromA.transferId)?.state).toBe(
      'paused_by_user',
    );

    // Resume A->B and verify completion and byte integrity
    expect(await peerPair.coordB.resumeTransfer(dlBfromA.transferId)).toBe(true);
    await vi.waitFor(() => {
      expect(peerPair.coordB.getTransfer(dlBfromA.transferId)?.state).toBe(
        'completed',
      );
      expect(peerPair.coordA.getTransfer(dlBfromA.transferId)?.state).toBe(
        'completed',
      );
    });

    const savedA = peerPair.saveHarnessB.savedFiles.get('pausable-a.bin')[0];
    const savedB = peerPair.saveHarnessA.savedFiles.get('fast-b.bin')[0];
    expect(Buffer.compare(savedA.getBytes(), largeFromA)).toBe(0);
    expect(Buffer.compare(savedB.getBytes(), smallFromB)).toBe(0);

    peerPair.dispose();
  });

  it('cancelling or failing one transfer isolates the opposite direction and leaves board advertisements intact', async () => {
    const peerPair = createLinkedPeerPair({
      fileWriteDelayMsA: 2,
      fileWriteDelayMsB: 20,
    });

    const fileA = createMockReadableFile({
      name: 'cancel-me.bin',
      bytes: createDeterministicBytes(CHUNK_SIZE_BYTES * 8, 21),
    });
    const fileBBytes = createDeterministicBytes(CHUNK_SIZE_BYTES * 3 + 5, 42);
    const fileB = createMockReadableFile({
      name: 'keep-me.bin',
      bytes: fileBBytes,
    });
    const badFileA = createMockReadableFile({
      name: 'corrupt-midflight.bin',
      bytes: createDeterministicBytes(CHUNK_SIZE_BYTES * 4, 55),
    });

    const addedA = await peerPair.localBoardA.addFiles([fileA, badFileA]);
    const addedB = await peerPair.localBoardB.addFiles([fileB]);
    await peerPair.publishLocalBoards();

    const dlCancel = await peerPair.coordB.requestDownload(addedA.advertised[0].fileId);
    const dlKeep = await peerPair.coordA.requestDownload(addedB.advertised[0].fileId);

    await vi.waitFor(() => {
      expect(peerPair.coordB.getTransfer(dlCancel.transferId)?.state).toBe('active');
    });

    expect(await peerPair.coordB.cancelTransfer(dlCancel.transferId)).toBe(true);

    await vi.waitFor(() => {
      expect(peerPair.coordB.getTransfer(dlCancel.transferId)?.state).toBe(
        'cancelled',
      );
      expect(peerPair.coordA.getTransfer(dlCancel.transferId)?.state).toBe(
        'cancelled',
      );
      expect(peerPair.coordA.getTransfer(dlKeep.transferId)?.state).toBe(
        'completed',
      );
    });

    const cancelledTarget = peerPair.saveHarnessB.savedFiles.get('cancel-me.bin')[0];
    expect(cancelledTarget.aborted).toBe(true);
    expect(
      Buffer.compare(
        peerPair.saveHarnessA.savedFiles.get('keep-me.bin')[0].getBytes(),
        fileBBytes,
      ),
    ).toBe(0);

    // Advertisements remain on both boards after cancellation
    expect(peerPair.localBoardA.getAdvertisedEntry(addedA.advertised[0].fileId)).not.toBeNull();
    expect(peerPair.remoteBoardB.getEntry(addedA.advertised[0].fileId)).not.toBeNull();

    // Start another download on badFileA, mutate size right before accept/stream -> fails only that transfer while board remains intact
    const dlFail = await peerPair.coordB.requestDownload(addedA.advertised[1].fileId);
    badFileA.mutateSize(3);
    // Start simultaneous B->A download on second file copy
    const dlSecondB = await peerPair.coordA.requestDownload(addedB.advertised[0].fileId);

    await vi.waitFor(() => {
      const failSnap = peerPair.coordB.getTransfer(dlFail.transferId);
      expect(['rejected', 'failed']).toContain(failSnap?.state);
      expect(peerPair.coordA.getTransfer(dlSecondB.transferId)?.state).toBe(
        'completed',
      );
    });

    expect(peerPair.remoteBoardB.getEntry(addedA.advertised[1].fileId)).not.toBeNull();
    peerPair.dispose();
  });
});
