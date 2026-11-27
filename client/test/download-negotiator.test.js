import { describe, expect, it, vi } from 'vitest';
import { createLocalFileBoard } from '../src/board/local-board.js';
import { createRemoteFileBoard } from '../src/board/remote-board.js';
import {
  generateMasterKey,
  generateMemberId,
} from '../src/crypto/fragment-key.js';
import {
  evaluatePersistenceCapability,
  openSaveTargetSynchronously,
} from '../src/persistence/file-persistence.js';
import { createDownloadNegotiator } from '../src/transfer/download-negotiator.js';
import { generateTransferId } from '../src/crypto/control-codec.js';

const ROOM_ID = 'ship-4f2a';

function createMockFile({
  name,
  content = 'payload bytes',
  type = 'application/octet-stream',
  lastModified = 1_785_100_000_000,
  throwOnSlice = false,
} = {}) {
  const bytes =
    typeof content === 'string' ? new TextEncoder().encode(content) : content;
  let size = bytes.byteLength;
  let mod = lastModified;
  return {
    name,
    get size() {
      return size;
    },
    type,
    get lastModified() {
      return mod;
    },
    slice(start = 0, end = size) {
      if (throwOnSlice) {
        throw new Error('NotReadableError');
      }
      const sub = bytes.slice(start, end);
      return {
        async arrayBuffer() {
          return sub.buffer.slice(sub.byteOffset, sub.byteOffset + sub.byteLength);
        },
      };
    },
    mutateSize(nextSize) {
      size = nextSize;
    },
    mutateModified(nextMod) {
      mod = nextMod;
    },
  };
}

function createFakeSaveWindow({
  isSecureContext = true,
  hasPicker = true,
  cancelOnPick = false,
  onShowPicker,
} = {}) {
  const createdWritables = [];
  const windowObj = {
    isSecureContext,
  };

  if (hasPicker) {
    windowObj.showSaveFilePicker = vi.fn(({ suggestedName }) => {
      onShowPicker?.(suggestedName);
      if (cancelOnPick) {
        const err = new Error('The user aborted a request.');
        err.name = 'AbortError';
        return Promise.reject(err);
      }
      const writable = {
        writes: [],
        closed: false,
        aborted: false,
        async write(chunk) {
          this.writes.push(chunk);
        },
        async close() {
          this.closed = true;
        },
        async abort() {
          this.aborted = true;
        },
      };
      createdWritables.push(writable);
      return Promise.resolve({
        name: suggestedName,
        async createWritable() {
          return writable;
        },
      });
    });
  }

  return { windowObj, createdWritables };
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('File persistence and download request negotiation (FF-4)', () => {
  it('pre-evaluates capability and storage estimate on advertisement arrival and preserves transient user gesture on click', async () => {
    const { masterKeyBytes } = generateMasterKey();
    const ownerMemberId = generateMemberId();
    const downloaderMemberId = generateMemberId();

    const ownerMessages = [];
    const ownerBoard = createLocalFileBoard({
      roomId: ROOM_ID,
      masterKeyBytes,
      publishControlMessage: (msg) => ownerMessages.push(msg),
    });
    const remoteBoard = createRemoteFileBoard({
      roomId: ROOM_ID,
      masterKeyBytes,
    });

    await ownerBoard.addFiles([createMockFile({ name: 'video.mp4', content: 'abc' })]);
    for (const msg of ownerMessages) {
      await remoteBoard.handleControlMessage(msg);
    }
    const remoteFile = remoteBoard.getEntries()[0];

    let transientActivation = false;
    let activationObservedInsidePicker = false;
    const estimateFn = vi.fn(async () => ({ quota: 1_000_000, usage: 100_000 }));
    const { windowObj } = createFakeSaveWindow({
      onShowPicker: () => {
        activationObservedInsidePicker = transientActivation;
      },
    });
    const sentByDownloader = [];

    const negotiator = createDownloadNegotiator({
      localMemberId: downloaderMemberId,
      getRemoteMemberId: () => ownerMemberId,
      remoteBoard,
      localBoard: null,
      sendControlMessage: async (msg) => {
        sentByDownloader.push(msg);
      },
      windowObj,
      navigatorObj: {
        storage: { estimate: estimateFn },
      },
    });

    // Pre-evaluate when advertisement arrives, NOT inside click handler
    await negotiator.preEvaluateAdvertisements(remoteBoard.getEntries());
    expect(estimateFn).toHaveBeenCalledTimes(1);
    expect(negotiator.getPreEvaluatedEntry(remoteFile.fileId)).toMatchObject({
      fileId: remoteFile.fileId,
      canDownload: true,
      insufficientStorage: false,
      capability: { supported: true, mode: 'file-system-access' },
      storageEstimate: {
        quotaBytes: 1_000_000,
        usageBytes: 100_000,
        availableBytes: 900_000,
      },
    });

    // Simulate browser click gesture where transient user activation expires after current turn
    transientActivation = true;
    queueMicrotask(() => {
      transientActivation = false;
    });
    const reqPromise = negotiator.requestRemoteFile(remoteFile.fileId);
    expect(activationObservedInsidePicker).toBe(true);
    expect(estimateFn).toHaveBeenCalledTimes(1);

    const res = await reqPromise;
    expect(res.ok).toBe(true);
    expect(sentByDownloader).toHaveLength(1);
    expect(sentByDownloader[0].type).toBe('DOWNLOAD_REQUEST');
    expect(sentByDownloader[0].payload.transferId).toBe(res.transferId);
    expect(negotiator.getSession(res.transferId)?.state).toBe('requesting');
    expect('persistenceTarget' in negotiator.getSession(res.transferId)).toBe(false);

    negotiator.dispose();
    ownerBoard.dispose();
    remoteBoard.dispose();
  });

  it('cancelling the save dialog creates no transferId and sends zero DOWNLOAD_REQUEST messages', async () => {
    const { masterKeyBytes } = generateMasterKey();
    const ownerMemberId = generateMemberId();
    const downloaderMemberId = generateMemberId();

    const localBoard = createLocalFileBoard({ roomId: ROOM_ID, masterKeyBytes });
    const remoteBoard = createRemoteFileBoard({ roomId: ROOM_ID, masterKeyBytes });
    const added = await localBoard.addFiles([createMockFile({ name: 'doc.pdf' })]);
    await remoteBoard.handleControlMessage(added.messages[0]);
    const entry = remoteBoard.getEntries()[0];

    const { windowObj } = createFakeSaveWindow({ cancelOnPick: true });
    const sent = [];

    const negotiator = createDownloadNegotiator({
      localMemberId: downloaderMemberId,
      getRemoteMemberId: () => ownerMemberId,
      remoteBoard,
      localBoard: null,
      sendControlMessage: async (msg) => sent.push(msg),
      windowObj,
      navigatorObj: {},
    });

    negotiator.preEvaluateAdvertisements();
    const res = await negotiator.requestRemoteFile(entry.fileId);
    expect(res).toEqual({
      ok: false,
      cancelled: true,
      code: 'SAVE_CANCELLED',
    });
    expect(sent).toEqual([]);
    expect(negotiator.getSessions()).toEqual([]);

    // Also reject unsupported or insecure browsers before picker or request
    const unsupportedCap = evaluatePersistenceCapability({
      windowObj: { isSecureContext: false },
    });
    expect(unsupportedCap.supported).toBe(false);
    expect(unsupportedCap.reason).toBe('INSECURE_CONTEXT');
    const directOpen = await openSaveTargetSynchronously({
      fileName: 'doc.pdf',
      windowObj: { isSecureContext: true },
    });
    expect(directOpen.ok).toBe(false);
    expect(directOpen.code).toBe('MISSING_FILE_SYSTEM_ACCESS_API');

    negotiator.dispose();
    localBoard.dispose();
    remoteBoard.dispose();
  });

  it('suppresses duplicate same-direction download clicks while preparing persistence or active', async () => {
    const { masterKeyBytes } = generateMasterKey();
    const ownerMemberId = generateMemberId();
    const downloaderMemberId = generateMemberId();

    const localBoard = createLocalFileBoard({ roomId: ROOM_ID, masterKeyBytes });
    const remoteBoard = createRemoteFileBoard({ roomId: ROOM_ID, masterKeyBytes });
    const added = await localBoard.addFiles([
      createMockFile({ name: 'first.bin', content: 'one' }),
      createMockFile({ name: 'second.bin', content: 'two' }),
    ]);
    for (const msg of added.messages) {
      await remoteBoard.handleControlMessage(msg);
    }
    const [firstEntry, secondEntry] = remoteBoard.getEntries();

    const pickerDeferred = createDeferred();
    const writable = {
      write: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      abort: vi.fn(async () => {}),
    };
    const windowObj = {
      isSecureContext: true,
      showSaveFilePicker: vi.fn(() => pickerDeferred.promise),
    };
    const sent = [];

    const negotiator = createDownloadNegotiator({
      localMemberId: downloaderMemberId,
      getRemoteMemberId: () => ownerMemberId,
      remoteBoard,
      localBoard: null,
      sendControlMessage: async (msg) => sent.push(msg),
      windowObj,
      navigatorObj: {},
    });

    negotiator.preEvaluateAdvertisements();
    const firstAttempt = negotiator.requestRemoteFile(firstEntry.fileId);
    const secondAttemptDuringPicker = await negotiator.requestRemoteFile(secondEntry.fileId);

    expect(secondAttemptDuringPicker).toEqual({
      ok: false,
      code: 'DIRECTION_BUSY',
    });
    expect(windowObj.showSaveFilePicker).toHaveBeenCalledTimes(1);

    pickerDeferred.resolve({
      async createWritable() {
        return writable;
      },
    });
    const firstResult = await firstAttempt;
    expect(firstResult.ok).toBe(true);
    expect(sent).toHaveLength(1);

    // Second request while first is 'requesting' is also suppressed
    const duplicateWhileRequesting = await negotiator.requestRemoteFile(firstEntry.fileId);
    expect(duplicateWhileRequesting).toEqual({
      ok: false,
      code: 'DIRECTION_BUSY',
    });
    expect(sent).toHaveLength(1);

    negotiator.dispose();
    localBoard.dispose();
    remoteBoard.dispose();
  });

  it('accepts available files and rejects missing, removed, unreadable, busy, and invalid requests on owner side', async () => {
    const { masterKeyBytes } = generateMasterKey();
    const ownerMemberId = generateMemberId();
    const downloaderMemberId = generateMemberId();

    const ownerMessages = [];
    const ownerLocalBoard = createLocalFileBoard({
      roomId: ROOM_ID,
      masterKeyBytes,
      publishControlMessage: (msg) => ownerMessages.push(msg),
    });
    const downloaderRemoteBoard = createRemoteFileBoard({
      roomId: ROOM_ID,
      masterKeyBytes,
    });

    const readableFile = createMockFile({ name: 'good.txt', content: 'hello' });
    const removedFile = createMockFile({ name: 'gone.txt', content: 'removed' });
    const brokenFile = createMockFile({
      name: 'broken.txt',
      content: 'changed later',
      lastModified: 1_785_100_000_999,
    });

    const added = await ownerLocalBoard.addFiles([
      readableFile,
      removedFile,
      brokenFile,
    ]);
    for (const msg of ownerMessages) {
      await downloaderRemoteBoard.handleControlMessage(msg);
    }

    const [goodEntry, removedEntry, brokenEntry] = ownerLocalBoard.getPublicEntries();

    // Remove second file locally and mutate broken file so it fails readability check
    await ownerLocalBoard.removeFile(removedEntry.fileId);
    await downloaderRemoteBoard.handleControlMessage(
      ownerMessages[ownerMessages.length - 1],
    );
    brokenFile.mutateSize(999);

    const { windowObj, createdWritables } = createFakeSaveWindow();
    let ownerNegotiator;
    let downloaderNegotiator;

    const acceptedByDownloader = [];
    ownerNegotiator = createDownloadNegotiator({
      localMemberId: ownerMemberId,
      getRemoteMemberId: () => downloaderMemberId,
      remoteBoard: null,
      localBoard: ownerLocalBoard,
      sendControlMessage: async (msg) => {
        await downloaderNegotiator.handleControlMessage(msg, ownerMemberId);
      },
      windowObj,
      navigatorObj: {},
    });

    downloaderNegotiator = createDownloadNegotiator({
      localMemberId: downloaderMemberId,
      getRemoteMemberId: () => ownerMemberId,
      remoteBoard: downloaderRemoteBoard,
      localBoard: null,
      sendControlMessage: async (msg) => {
        await ownerNegotiator.handleControlMessage(msg, downloaderMemberId);
      },
      windowObj,
      navigatorObj: {},
      onDownloadAccepted: (session) => acceptedByDownloader.push(session),
    });

    downloaderNegotiator.preEvaluateAdvertisements();

    // 1. Missing fileId on owner -> NOT_FOUND and writable aborted on downloader
    const missingId = generateTransferId();
    const missingTid = generateTransferId();
    const ownerRejectLog = [];
    const spyingOwner = createDownloadNegotiator({
      localMemberId: ownerMemberId,
      getRemoteMemberId: () => downloaderMemberId,
      remoteBoard: null,
      localBoard: ownerLocalBoard,
      sendControlMessage: async (msg) => ownerRejectLog.push(msg),
      windowObj,
      navigatorObj: {},
    });

    await spyingOwner.handleControlMessage(
      {
        type: 'DOWNLOAD_REQUEST',
        payload: {
          transferId: missingTid,
          fileId: missingId,
          direction: `${ownerMemberId}->${downloaderMemberId}`,
          initialEpoch: 1,
        },
      },
      downloaderMemberId,
    );
    await spyingOwner.handleControlMessage(
      {
        type: 'DOWNLOAD_REQUEST',
        payload: {
          transferId: generateTransferId(),
          fileId: removedEntry.fileId,
          direction: `${ownerMemberId}->${downloaderMemberId}`,
          initialEpoch: 1,
        },
      },
      downloaderMemberId,
    );
    await spyingOwner.handleControlMessage(
      {
        type: 'DOWNLOAD_REQUEST',
        payload: {
          transferId: generateTransferId(),
          fileId: brokenEntry.fileId,
          direction: `${ownerMemberId}->${downloaderMemberId}`,
          initialEpoch: 1,
        },
      },
      downloaderMemberId,
    );
    await spyingOwner.handleControlMessage(
      {
        type: 'DOWNLOAD_REQUEST',
        payload: {
          transferId: generateTransferId(),
          fileId: goodEntry.fileId,
          direction: `${downloaderMemberId}->${ownerMemberId}`, // wrong direction
          initialEpoch: 1,
        },
      },
      downloaderMemberId,
    );

    expect(ownerRejectLog.map((m) => [m.type, m.payload.reason])).toEqual([
      ['DOWNLOAD_REJECTED', 'NOT_FOUND'],
      ['DOWNLOAD_REJECTED', 'NOT_FOUND'],
      ['DOWNLOAD_REJECTED', 'UNAVAILABLE'],
      ['DOWNLOAD_REJECTED', 'INVALID_REQUEST'],
    ]);

    // 2. Downloader receives DOWNLOAD_REJECTED -> writable target is aborted and session marked rejected
    const fakeReqRes = await downloaderNegotiator.requestRemoteFile(goodEntry.fileId);
    expect(fakeReqRes.ok).toBe(true);
    expect(acceptedByDownloader).toHaveLength(1);
    expect(acceptedByDownloader[0].state).toBe('active');
    expect(ownerNegotiator.getSession(fakeReqRes.transferId)?.state).toBe('active');

    // 3. Second request in same direction while first is active -> owner rejects with BUSY
    const ownerBusySent = [];
    const ownerWithBusySpy = ownerNegotiator;
    const busyRes = await ownerWithBusySpy.handleControlMessage(
      {
        type: 'DOWNLOAD_REQUEST',
        payload: {
          transferId: generateTransferId(),
          fileId: goodEntry.fileId,
          direction: `${ownerMemberId}->${downloaderMemberId}`,
          initialEpoch: 1,
        },
      },
      downloaderMemberId,
    );
    expect(busyRes).toMatchObject({ ok: false, code: 'BUSY' });
    expect(ownerNegotiator.getSession(fakeReqRes.transferId)?.state).toBe('active');

    // Verify downloader aborts persistence target when DOWNLOAD_REJECTED matches a requesting session
    const rejectableDownloader = createDownloadNegotiator({
      localMemberId: downloaderMemberId,
      getRemoteMemberId: () => ownerMemberId,
      remoteBoard: downloaderRemoteBoard,
      localBoard: null,
      sendControlMessage: async (msg) => {
        ownerBusySent.push(msg);
        await spyingOwner.handleControlMessage(
          {
            ...msg,
            payload: { ...msg.payload, fileId: removedEntry.fileId },
          },
          downloaderMemberId,
        );
      },
      windowObj,
      navigatorObj: {},
    });
    const reqForRemoved = await rejectableDownloader.requestRemoteFile(goodEntry.fileId);
    expect(reqForRemoved.ok).toBe(true);
    const rejectedMsg = ownerRejectLog[ownerRejectLog.length - 1];
    await rejectableDownloader.handleControlMessage(
      {
        type: 'DOWNLOAD_REJECTED',
        payload: {
          transferId: reqForRemoved.transferId,
          fileId: goodEntry.fileId,
          reason: rejectedMsg.payload.reason,
        },
      },
      ownerMemberId,
    );
    expect(rejectableDownloader.getSession(reqForRemoved.transferId)).toMatchObject({
      state: 'rejected',
      rejectReason: 'NOT_FOUND',
    });
    expect(createdWritables[1].aborted).toBe(true);

    expect(added.advertised).toHaveLength(3);

    spyingOwner.dispose();
    rejectableDownloader.dispose();
    ownerNegotiator.dispose();
    downloaderNegotiator.dispose();
    ownerLocalBoard.dispose();
    downloaderRemoteBoard.dispose();
  });
});
