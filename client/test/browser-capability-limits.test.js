import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { createLocalFileBoard } from '../src/board/local-board.js';
import { createRemoteFileBoard } from '../src/board/remote-board.js';
import {
  generateMasterKey,
  generateMemberId,
} from '../src/crypto/fragment-key.js';
import {
  DEFERRED_PERSISTENCE_EXTENSIONS,
  PROTOCOL_MAX_CHUNKS,
  PROTOCOL_MAX_FILE_SIZE_BYTES,
  detectBrowserPersistenceProfile,
  evaluateFilePersistenceEligibility,
} from '../src/persistence/capability-limits.js';
import { evaluatePersistenceCapability } from '../src/persistence/file-persistence.js';
import { createSignalingClient } from '../src/signaling/socket-client.js';
import { createDownloadNegotiator } from '../src/transfer/download-negotiator.js';
import RoomBoardApp from '../src/ui/RoomBoardApp.jsx';
import {
  createInitialRoomBoardUiState,
  createRoomBoardController,
} from '../src/ui/room-board-controller.js';
import { createMockSocketFactory } from './helpers/mock-socket.js';
import { createMockPeerConnectionFactory } from './helpers/mock-webrtc.js';

const ROOM_ID = 'ship-7c21';

function createMockFile({ name = 'sample.bin', size = 256 } = {}) {
  const bytes = new Uint8Array(size).fill(0x5a);
  return {
    name,
    size: bytes.byteLength,
    type: 'application/octet-stream',
    lastModified: 1_785_200_000_000,
    slice(start = 0, end = bytes.byteLength) {
      const sub = bytes.slice(start, end);
      return {
        async arrayBuffer() {
          return sub.buffer.slice(sub.byteOffset, sub.byteOffset + sub.byteLength);
        },
      };
    },
  };
}

function createMemoryStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
}

describe('Browser capability detection and persistence limits (FF-7)', () => {
  it('detects verified File System Access path or unsupported browser with accurate guidance and deferred extensions metadata', () => {
    expect(PROTOCOL_MAX_CHUNKS).toBe(0x100000000);
    expect(PROTOCOL_MAX_FILE_SIZE_BYTES).toBe(281_474_976_710_656);

    expect(Object.isFrozen(DEFERRED_PERSISTENCE_EXTENSIONS)).toBe(true);
    expect(DEFERRED_PERSISTENCE_EXTENSIONS.serviceWorkerStreaming.enabled).toBe(
      false,
    );
    expect(DEFERRED_PERSISTENCE_EXTENSIONS.serviceWorkerStreaming.status).toBe(
      'deferred_future_extension',
    );
    expect(DEFERRED_PERSISTENCE_EXTENSIONS.indexedDbBuffering.enabled).toBe(false);
    expect(DEFERRED_PERSISTENCE_EXTENSIONS.indexedDbBuffering.status).toBe(
      'deferred_future_extension',
    );

    const supported = detectBrowserPersistenceProfile({
      windowObj: {
        isSecureContext: true,
        showSaveFilePicker: async () => {},
      },
      navigatorObj: {
        userAgent:
          'Mozilla/5.0 (Macintosh; Intel Mac OS X) AppleWebKit/537.36 Chrome/134.0.0.0 Safari/537.36',
      },
    });
    expect(supported).toMatchObject({
      supported: true,
      mode: 'file-system-access',
      reason: null,
      guidance: null,
      maxProtocolFileSizeBytes: PROTOCOL_MAX_FILE_SIZE_BYTES,
      deferredExtensions: DEFERRED_PERSISTENCE_EXTENSIONS,
    });
    expect(
      evaluatePersistenceCapability({
        windowObj: {
          isSecureContext: true,
          showSaveFilePicker: async () => {},
        },
      }),
    ).toEqual(supported);

    const insecure = detectBrowserPersistenceProfile({
      windowObj: {
        isSecureContext: false,
        showSaveFilePicker: async () => {},
      },
    });
    expect(insecure).toMatchObject({
      supported: false,
      mode: 'unsupported',
      reason: 'INSECURE_CONTEXT',
      maxProtocolFileSizeBytes: PROTOCOL_MAX_FILE_SIZE_BYTES,
    });
    expect(insecure.guidance).toContain('HTTPS');

    const unsupportedBrowser = detectBrowserPersistenceProfile({
      windowObj: {
        isSecureContext: true,
      },
      navigatorObj: {
        userAgent:
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7) AppleWebKit/605.1.15 Safari/605.1.15',
      },
    });
    expect(unsupportedBrowser).toMatchObject({
      supported: false,
      mode: 'unsupported',
      reason: 'MISSING_FILE_SYSTEM_ACCESS_API',
      deferredExtensions: DEFERRED_PERSISTENCE_EXTENSIONS,
    });
    expect(unsupportedBrowser.guidance).toContain(
      'This browser does not support window.showSaveFilePicker() for direct-to-disk streaming.',
    );
    expect(unsupportedBrowser.guidance).toContain('Chromium');
    expect(unsupportedBrowser.guidance).toContain('Service Worker');
    expect(unsupportedBrowser.guidance).toContain('IndexedDB');
  });

  it('evaluates file persistence eligibility against capability, available storage, and protocol 256 TiB limit', () => {
    const supportedCap = detectBrowserPersistenceProfile({
      windowObj: {
        isSecureContext: true,
        showSaveFilePicker: async () => {},
      },
    });
    const unsupportedCap = detectBrowserPersistenceProfile({
      windowObj: { isSecureContext: true },
    });

    expect(
      evaluateFilePersistenceEligibility({
        fileSize: 1024,
        capability: unsupportedCap,
        storageEstimate: { availableBytes: 10_000_000 },
      }),
    ).toMatchObject({
      eligible: false,
      reason: 'MISSING_FILE_SYSTEM_ACCESS_API',
      guidance: unsupportedCap.guidance,
    });

    expect(
      evaluateFilePersistenceEligibility({
        fileSize: PROTOCOL_MAX_FILE_SIZE_BYTES + 1,
        capability: supportedCap,
        storageEstimate: { availableBytes: null },
      }),
    ).toMatchObject({
      eligible: false,
      reason: 'LIMIT_EXCEEDED',
      exceedsProtocolLimit: true,
      insufficientStorage: false,
      maxBytes: PROTOCOL_MAX_FILE_SIZE_BYTES,
    });

    expect(
      evaluateFilePersistenceEligibility({
        fileSize: -5,
        capability: supportedCap,
        storageEstimate: { availableBytes: 10_000 },
      }),
    ).toMatchObject({
      eligible: false,
      reason: 'LIMIT_EXCEEDED',
      exceedsProtocolLimit: true,
      insufficientStorage: false,
    });

    const overStorage = evaluateFilePersistenceEligibility({
      fileSize: 5_000,
      capability: supportedCap,
      storageEstimate: { availableBytes: 4_000 },
    });
    expect(overStorage).toMatchObject({
      eligible: false,
      reason: 'LIMIT_EXCEEDED',
      insufficientStorage: true,
      exceedsProtocolLimit: false,
      maxBytes: 4_000,
    });
    expect(overStorage.guidance).toBeTruthy();

    expect(
      evaluateFilePersistenceEligibility({
        fileSize: 0,
        capability: supportedCap,
        storageEstimate: { availableBytes: 0 },
      }),
    ).toMatchObject({
      eligible: true,
      reason: null,
      guidance: null,
      insufficientStorage: false,
      exceedsProtocolLimit: false,
      maxBytes: 0,
    });

    expect(
      evaluateFilePersistenceEligibility({
        fileSize: 2048,
        capability: supportedCap,
        storageEstimate: { availableBytes: 1_000_000 },
      }),
    ).toMatchObject({
      eligible: true,
      reason: null,
      guidance: null,
      insufficientStorage: false,
      exceedsProtocolLimit: false,
      maxBytes: 1_000_000,
    });
  });

  it('blocks unsupported browsers and oversized files before showSaveFilePicker or DOWNLOAD_REQUEST', async () => {
    const { masterKeyBytes } = generateMasterKey();
    const ownerMemberId = generateMemberId();
    const downloaderMemberId = generateMemberId();

    const localBoard = createLocalFileBoard({ roomId: ROOM_ID, masterKeyBytes });
    const remoteBoard = createRemoteFileBoard({ roomId: ROOM_ID, masterKeyBytes });

    const added = await localBoard.addFiles([
      createMockFile({ name: 'too-big-for-quota.bin', size: 2048 }),
      createMockFile({ name: 'fits.bin', size: 512 }),
    ]);
    for (const msg of added.messages) {
      await remoteBoard.handleControlMessage(msg);
    }
    const [bigEntry, smallEntry] = remoteBoard.getEntries();

    // 1. Unsupported browser (no showSaveFilePicker) blocks download before any DOWNLOAD_REQUEST
    const unsupportedSent = [];
    const unsupportedNegotiator = createDownloadNegotiator({
      localMemberId: downloaderMemberId,
      getRemoteMemberId: () => ownerMemberId,
      remoteBoard,
      localBoard: null,
      sendControlMessage: async (m) => unsupportedSent.push(m),
      windowObj: { isSecureContext: true },
      navigatorObj: {
        storage: { estimate: async () => ({ quota: 1_000_000, usage: 0 }) },
      },
    });
    await unsupportedNegotiator.preEvaluateAdvertisements(remoteBoard.getEntries());
    expect(
      unsupportedNegotiator.getPreEvaluatedEntry(smallEntry.fileId),
    ).toMatchObject({
      canDownload: false,
      limitReason: 'MISSING_FILE_SYSTEM_ACCESS_API',
    });

    const unsupportedRes = await unsupportedNegotiator.requestRemoteFile(
      smallEntry.fileId,
    );
    expect(unsupportedRes.ok).toBe(false);
    expect(unsupportedRes.code).toBe('MISSING_FILE_SYSTEM_ACCESS_API');
    expect(unsupportedRes.guidance).toContain('window.showSaveFilePicker()');
    expect(unsupportedSent).toHaveLength(0);

    // 2. Supported browser with low storage estimate blocks oversized file before picker & request
    const pickerSpy = vi.fn(async () => ({
      async createWritable() {
        return { async write() {}, async close() {}, async abort() {} };
      },
    }));
    const supportedSent = [];
    const supportedNegotiator = createDownloadNegotiator({
      localMemberId: downloaderMemberId,
      getRemoteMemberId: () => ownerMemberId,
      remoteBoard,
      localBoard: null,
      sendControlMessage: async (m) => supportedSent.push(m),
      windowObj: {
        isSecureContext: true,
        showSaveFilePicker: pickerSpy,
      },
      navigatorObj: {
        storage: { estimate: async () => ({ quota: 1024, usage: 0 }) },
      },
    });
    await supportedNegotiator.preEvaluateAdvertisements(remoteBoard.getEntries());

    const bigPreEval = supportedNegotiator.getPreEvaluatedEntry(bigEntry.fileId);
    expect(bigPreEval).toMatchObject({
      canDownload: false,
      insufficientStorage: true,
      exceedsProtocolLimit: false,
      limitReason: 'LIMIT_EXCEEDED',
    });
    expect(bigPreEval.limitGuidance).toBeTruthy();

    const smallPreEval = supportedNegotiator.getPreEvaluatedEntry(
      smallEntry.fileId,
    );
    expect(smallPreEval).toMatchObject({
      canDownload: true,
      insufficientStorage: false,
      exceedsProtocolLimit: false,
    });

    const overQuotaRes = await supportedNegotiator.requestRemoteFile(
      bigEntry.fileId,
    );
    expect(overQuotaRes.ok).toBe(false);
    expect(overQuotaRes.code).toBe('LIMIT_EXCEEDED');
    expect(overQuotaRes.guidance).toBeTruthy();
    expect(pickerSpy).not.toHaveBeenCalled();
    expect(supportedSent).toHaveLength(0);

    // 3. Protocol limit check (> 256 TiB) also blocks before picker & request
    const hugeFileId = added.advertised[0].fileId;
    const protocolCapNegotiator = createDownloadNegotiator({
      localMemberId: downloaderMemberId,
      getRemoteMemberId: () => ownerMemberId,
      remoteBoard: {
        getEntries: () => [
          {
            fileId: hugeFileId,
            fileName: 'giant.raw',
            fileSize: PROTOCOL_MAX_FILE_SIZE_BYTES + 1,
            availability: 'available',
          },
        ],
        getEntry: (id) =>
          id === hugeFileId
            ? {
                fileId: hugeFileId,
                fileName: 'giant.raw',
                fileSize: PROTOCOL_MAX_FILE_SIZE_BYTES + 1,
                availability: 'available',
              }
            : null,
      },
      localBoard: null,
      sendControlMessage: async (m) => supportedSent.push(m),
      windowObj: {
        isSecureContext: true,
        showSaveFilePicker: pickerSpy,
      },
      navigatorObj: {},
    });
    await protocolCapNegotiator.preEvaluateAdvertisements();
    expect(protocolCapNegotiator.getPreEvaluatedEntry(hugeFileId)).toMatchObject({
      canDownload: false,
      exceedsProtocolLimit: true,
      limitReason: 'LIMIT_EXCEEDED',
    });
    const overProtocolRes = await protocolCapNegotiator.requestRemoteFile(hugeFileId);
    expect(overProtocolRes).toMatchObject({
      ok: false,
      code: 'LIMIT_EXCEEDED',
    });
    expect(overProtocolRes.guidance).toContain('256');
    expect(pickerSpy).not.toHaveBeenCalled();
    expect(supportedSent).toHaveLength(0);

    // 4. Controller propagates capability guidance on downloadRemoteFile without socket room emit
    const controller = createRoomBoardController({
      signalingClient: createSignalingClient({
        url: 'https://shipri.example',
        ioFactory: createMockSocketFactory(),
      }),
      peerConnectionFactory: createMockPeerConnectionFactory(),
      storage: createMemoryStorage(),
      locationObj: {
        origin: 'https://shipri.example',
        pathname: '/',
        hash: '',
      },
      historyObj: { replaceState: () => {} },
      windowObj: { isSecureContext: false },
      navigatorObj: {},
      autoConnect: false,
    });
    expect(controller.getState().capability).toMatchObject({
      supported: false,
      reason: 'INSECURE_CONTEXT',
    });
    const controllerRes = await controller.downloadRemoteFile(smallEntry.fileId);
    expect(controllerRes.ok).toBe(false);
    expect(controllerRes.code).toBe('INSECURE_CONTEXT');
    expect(controllerRes.guidance).toContain('HTTPS');
    expect(controller.getState().errorBanner?.code).toBe('INSECURE_CONTEXT');

    controller.dispose();
    protocolCapNegotiator.dispose();
    unsupportedNegotiator.dispose();
    supportedNegotiator.dispose();
    localBoard.dispose();
    remoteBoard.dispose();
  });

  it('renders capability warnings, storage limits, and disabled oversized downloads in RoomBoardApp', () => {
    const unsupportedHtml = renderToStaticMarkup(
      React.createElement(RoomBoardApp, {
        initialState: createInitialRoomBoardUiState({
          connectionStatus: 'connected',
          peerState: 'connected',
          peerReady: true,
          roomId: 'ship-8d12',
          capability: detectBrowserPersistenceProfile({
            windowObj: { isSecureContext: true },
          }),
          remoteFiles: [
            {
              fileId: 'aaaaaaaaaaaaaaaaaaaaaa',
              fileName: 'archive.tar',
              fileSize: 2048,
              fileType: 'application/x-tar',
              availability: 'available',
            },
          ],
        }),
      }),
    );
    expect(unsupportedHtml).toContain('Direct file saving unavailable:');
    expect(unsupportedHtml).toContain('window.showSaveFilePicker()');
    expect(unsupportedHtml).toMatch(/disabled=""[^>]*aria-label="Download archive\.tar"|aria-label="Download archive\.tar"[^>]*disabled=""/);

    const supportedHtml = renderToStaticMarkup(
      React.createElement(RoomBoardApp, {
        initialState: createInitialRoomBoardUiState({
          connectionStatus: 'connected',
          peerState: 'connected',
          peerReady: true,
          roomId: 'ship-8d12',
          capability: detectBrowserPersistenceProfile({
            windowObj: {
              isSecureContext: true,
              showSaveFilePicker: async () => {},
            },
          }),
          storageEstimate: {
            quotaBytes: 2_000_000,
            usageBytes: 1_000_000,
            availableBytes: 1_000_000,
          },
          remoteFiles: [
            {
              fileId: 'bbbbbbbbbbbbbbbbbbbbbb',
              fileName: 'too-large.iso',
              fileSize: 5_000_000,
              fileType: 'application/octet-stream',
              availability: 'available',
              insufficientStorage: true,
              exceedsProtocolLimit: false,
              limitGuidance:
                'File exceeds estimated available local storage (1000000 bytes).',
            },
            {
              fileId: 'cccccccccccccccccccccc',
              fileName: 'notes.txt',
              fileSize: 256,
              fileType: 'text/plain',
              availability: 'available',
              insufficientStorage: false,
              exceedsProtocolLimit: false,
              limitGuidance: null,
            },
          ],
        }),
      }),
    );

    expect(supportedHtml).toContain('Direct-to-disk saving active');
    expect(supportedHtml).toContain('Estimated available storage');
    expect(supportedHtml).toContain(
      'File exceeds estimated available local storage',
    );
    expect(supportedHtml).toMatch(/disabled=""[^>]*aria-label="Download too-large\.iso"|aria-label="Download too-large\.iso"[^>]*disabled=""/);
    expect(supportedHtml).not.toMatch(/disabled=""[^>]*aria-label="Download notes\.txt"|aria-label="Download notes\.txt"[^>]*disabled=""/);
  });
});
