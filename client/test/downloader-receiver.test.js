import { describe, expect, it, vi } from 'vitest';
import { createLocalFileBoard } from '../src/board/local-board.js';
import {
  BINARY_FRAME_HEADER_BYTES,
  encryptBinaryChunkFrame,
  MAX_PLAINTEXT_CHUNK_BYTES,
} from '../src/crypto/binary-framing.js';
import { generateFileId } from '../src/crypto/board-metadata.js';
import { generateTransferId } from '../src/crypto/control-codec.js';
import {
  generateMasterKey,
  generateMemberId,
} from '../src/crypto/fragment-key.js';
import {
  createDownloaderReceiver,
  MAX_IN_FLIGHT_BYTES,
  RECEIVER_CREDIT_GRANT_STEP_BYTES,
  RECEIVER_INITIAL_CREDIT_WINDOW_BYTES,
  RECEIVER_MAX_QUEUED_BYTES,
} from '../src/transfer/downloader-receiver.js';
import {
  CHUNK_SIZE_BYTES,
  createOwnerChunkStreamer,
} from '../src/transfer/owner-streamer.js';
import { createChunkCryptoProcessor } from '../src/workers/chunk-worker-client.js';

const ROOM_ID = 'ship-9e12';

function createDeterministicBytes(length, seed = 41) {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) {
    bytes[i] = (i * 19 + seed) & 0xff;
  }
  return bytes;
}

function concatUint8Arrays(chunks) {
  const total = chunks.reduce((sum, c) => sum + c.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function createFakePersistenceTarget({
  writeDelayMs = 0,
  throwOnWrite = null,
  onClose,
} = {}) {
  const chunks = [];
  let closed = false;
  let aborted = false;

  return {
    chunks,
    isFinished: () => closed || aborted,
    isClosed: () => closed,
    isAborted: () => aborted,
    async write(data) {
      if (throwOnWrite) {
        throw throwOnWrite;
      }
      if (writeDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, writeDelayMs));
      }
      chunks.push(new Uint8Array(data));
    },
    async close() {
      onClose?.(concatUint8Arrays(chunks));
      closed = true;
    },
    async abort() {
      aborted = true;
    },
    getBytes() {
      return concatUint8Arrays(chunks);
    },
  };
}

function createMockReadableFile(name, bytes) {
  return {
    name,
    size: bytes.byteLength,
    type: 'application/octet-stream',
    lastModified: 1_785_300_000_000,
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

describe('Bounded downloader flow control and direct persistence (FF-5)', () => {
  it('enforces frozen 2 MiB credit window, 512 KiB step, and 4 MiB max queue with slow disk writes', async () => {
    expect(RECEIVER_INITIAL_CREDIT_WINDOW_BYTES).toBe(2_097_152);
    expect(MAX_IN_FLIGHT_BYTES).toBe(2_097_152);
    expect(RECEIVER_CREDIT_GRANT_STEP_BYTES).toBe(524_288);
    expect(RECEIVER_MAX_QUEUED_BYTES).toBe(4_194_304);

    // File larger than initial 2 MiB window (3.25 MiB = 52 chunks) to exercise slow persistence & window grants
    const fileSize = 52 * CHUNK_SIZE_BYTES + 1234;
    const rawBytes = createDeterministicBytes(fileSize, 7);

    const { masterKeyBytes } = generateMasterKey();
    const ownerMemberId = generateMemberId();
    const downloaderMemberId = generateMemberId();
    const direction = `${ownerMemberId}->${downloaderMemberId}`;
    const transferId = generateTransferId();

    const localBoard = createLocalFileBoard({ roomId: ROOM_ID, masterKeyBytes });
    const file = createMockReadableFile('large.bin', rawBytes);
    const added = await localBoard.addFiles([file]);
    const fileId = added.advertised[0].fileId;
    localBoard.registerActiveTransfer(transferId, fileId);

    // Slow disk persistence (3ms per chunk write)
    let closeSawAllBytes = false;
    const persistenceTarget = createFakePersistenceTarget({
      writeDelayMs: 3,
      onClose: (persisted) => {
        closeSawAllBytes = persisted.byteLength === fileSize;
      },
    });

    const downloaderToOwnerControl = [];
    const ownerBinaryChannel = {
      readyState: 'open',
      bufferedAmount: 0,
      bufferedAmountLowThreshold: 0,
      addEventListener() {},
      removeEventListener() {},
      send(frameBuffer) {
        receiver.handleBinaryFrame(frameBuffer);
      },
    };

    let receiverClosedBeforeComplete = false;
    const receiver = createDownloaderReceiver({
      roomId: ROOM_ID,
      masterKeyBytes,
      transferId,
      fileId,
      direction,
      epoch: 1,
      fileSize,
      persistenceTarget,
      cryptoProcessor: createChunkCryptoProcessor(),
      sendControlMessage: async (msg) => {
        downloaderToOwnerControl.push(msg);
        if (msg.type === 'FLOW_CREDIT') {
          await new Promise((resolve) => setTimeout(resolve, 2));
          streamer.handleFlowCredit(msg);
          // Replaying a duplicate or lower-sequence FLOW_CREDIT must never expand the window
          const beforeMax = streamer.getState().maxPlaintextOffsetExclusive;
          const dupRes = streamer.handleFlowCredit(msg);
          expect(dupRes.accepted).toBe(false);
          if (msg.payload.sequence > 1) {
            const staleRes = streamer.handleFlowCredit({
              ...msg,
              payload: {
                ...msg.payload,
                sequence: msg.payload.sequence - 1,
                maxPlaintextOffsetExclusive: fileSize,
              },
            });
            expect(staleRes.accepted).toBe(false);
          }
          expect(streamer.getState().maxPlaintextOffsetExclusive).toBe(beforeMax);
        } else if (msg.type === 'TRANSFER_COMPLETE') {
          receiverClosedBeforeComplete = persistenceTarget.isClosed();
          streamer.handleTransferComplete(msg);
        }
      },
    });

    const streamer = createOwnerChunkStreamer({
      roomId: ROOM_ID,
      masterKeyBytes,
      transferId,
      fileId,
      direction,
      epoch: 1,
      fileSize,
      lastModified: file.lastModified,
      localBoard,
      binaryChannel: ownerBinaryChannel,
      cryptoProcessor: createChunkCryptoProcessor(),
      sendControlMessage: async () => {},
    });

    // Zero FLOW_CREDIT before activate()
    expect(downloaderToOwnerControl).toEqual([]);

    await receiver.activate();
    expect(downloaderToOwnerControl[0]).toMatchObject({
      type: 'FLOW_CREDIT',
      payload: {
        transferId,
        fileId,
        direction,
        epoch: 1,
        sequence: 1,
        maxPlaintextOffsetExclusive: RECEIVER_INITIAL_CREDIT_WINDOW_BYTES,
      },
    });

    await vi.waitFor(
      () => {
        expect(receiver.getState().state).toBe('completed');
        expect(streamer.getState().state).toBe('completed');
      },
      { timeout: 5000 },
    );

    const creditMessages = downloaderToOwnerControl.filter(
      (m) => m.type === 'FLOW_CREDIT',
    );
    expect(creditMessages.length).toBeGreaterThan(2);
    for (let i = 1; i < creditMessages.length; i += 1) {
      expect(creditMessages[i].payload.sequence).toBe(
        creditMessages[i - 1].payload.sequence + 1,
      );
      expect(creditMessages[i].payload.maxPlaintextOffsetExclusive).toBeGreaterThan(
        creditMessages[i - 1].payload.maxPlaintextOffsetExclusive,
      );
    }

    const rxState = receiver.getState();
    expect(rxState.maxObservedQueuedBytes).toBeLessThanOrEqual(
      RECEIVER_MAX_QUEUED_BYTES,
    );
    expect(rxState.maxObservedInFlightBudget).toBeLessThanOrEqual(
      MAX_IN_FLIGHT_BYTES,
    );
    expect(closeSawAllBytes).toBe(true);
    expect(receiverClosedBeforeComplete).toBe(true);
    const persistedBytes = persistenceTarget.getBytes();
    expect(persistedBytes.byteLength).toBe(rawBytes.byteLength);
    expect(Buffer.compare(persistedBytes, rawBytes)).toBe(0);

    receiver.dispose();
    streamer.dispose();
    localBoard.dispose();
  });

  it('completes zero-byte files immediately after closing target without binary frames', async () => {
    const { masterKeyBytes } = generateMasterKey();
    const ownerMemberId = generateMemberId();
    const downloaderMemberId = generateMemberId();
    const direction = `${ownerMemberId}->${downloaderMemberId}`;
    const transferId = generateTransferId();
    const fileId = generateFileId();
    const controlSent = [];
    const persistenceTarget = createFakePersistenceTarget();

    const receiver = createDownloaderReceiver({
      roomId: ROOM_ID,
      masterKeyBytes,
      transferId,
      fileId,
      direction,
      epoch: 1,
      fileSize: 0,
      persistenceTarget,
      cryptoProcessor: createChunkCryptoProcessor(),
      sendControlMessage: async (msg) => controlSent.push(msg),
    });

    await receiver.activate();
    expect(persistenceTarget.isClosed()).toBe(true);
    expect(receiver.getState().state).toBe('completed');
    expect(controlSent).toEqual([
      {
        type: 'TRANSFER_COMPLETE',
        payload: {
          transferId,
          fileId,
          direction,
          epoch: 1,
          totalPersistedBytes: 0,
        },
      },
    ]);

    receiver.dispose();
  });

  it('fails closed on invalid, duplicate, cross-transfer, out-of-order, over-credit, tampered frames and quota/write errors', async () => {
    const { masterKeyBytes } = generateMasterKey();
    const ownerMemberId = generateMemberId();
    const downloaderMemberId = generateMemberId();
    const direction = `${ownerMemberId}->${downloaderMemberId}`;

    async function buildReceiver(fileSize = CHUNK_SIZE_BYTES * 2, targetOpts = {}) {
      const transferId = generateTransferId();
      const fileId = generateFileId();
      const controlSent = [];
      const target = createFakePersistenceTarget(targetOpts);
      const receiver = createDownloaderReceiver({
        roomId: ROOM_ID,
        masterKeyBytes,
        transferId,
        fileId,
        direction,
        epoch: 1,
        fileSize,
        persistenceTarget: target,
        cryptoProcessor: createChunkCryptoProcessor(),
        sendControlMessage: async (msg) => controlSent.push(msg),
      });
      await receiver.activate();
      return { transferId, fileId, controlSent, target, receiver };
    }

    // 1. Cross-transfer frame
    {
      const { transferId, fileId, controlSent, target, receiver } = await buildReceiver();
      const otherFrame = await encryptBinaryChunkFrame({
        masterKeyBytes,
        roomId: ROOM_ID,
        transferId: generateTransferId(),
        fileId,
        direction,
        epoch: 1,
        chunkIndex: 0,
        plaintext: createDeterministicBytes(CHUNK_SIZE_BYTES),
        isFinalChunk: false,
      });
      const res = receiver.handleBinaryFrame(otherFrame);
      expect(res.ok).toBe(false);
      await vi.waitFor(() => expect(receiver.getState().state).toBe('failed'));
      expect(target.isAborted()).toBe(true);
      expect(controlSent.find((m) => m.type === 'TRANSFER_ERROR')?.payload).toMatchObject({
        transferId,
        code: 'INVALID_FRAME',
      });
    }

    // 2. Out-of-order frame (chunk 1 before chunk 0) & duplicate chunk 0
    {
      const { transferId, fileId, controlSent, target, receiver } = await buildReceiver();
      const chunk1 = await encryptBinaryChunkFrame({
        masterKeyBytes,
        roomId: ROOM_ID,
        transferId,
        fileId,
        direction,
        epoch: 1,
        chunkIndex: 1,
        plaintext: createDeterministicBytes(CHUNK_SIZE_BYTES),
        isFinalChunk: true,
      });
      receiver.handleBinaryFrame(chunk1);
      await vi.waitFor(() => expect(receiver.getState().state).toBe('failed'));
      expect(target.isAborted()).toBe(true);
      expect(controlSent.find((m) => m.type === 'TRANSFER_ERROR')?.payload.code).toBe(
        'INVALID_FRAME',
      );
    }

    {
      const { transferId, fileId, controlSent, target, receiver } = await buildReceiver();
      const chunk0 = await encryptBinaryChunkFrame({
        masterKeyBytes,
        roomId: ROOM_ID,
        transferId,
        fileId,
        direction,
        epoch: 1,
        chunkIndex: 0,
        plaintext: createDeterministicBytes(CHUNK_SIZE_BYTES),
        isFinalChunk: false,
      });
      receiver.handleBinaryFrame(chunk0);
      receiver.handleBinaryFrame(chunk0); // duplicate chunk 0
      await vi.waitFor(() => expect(receiver.getState().state).toBe('failed'));
      expect(target.isAborted()).toBe(true);
      expect(controlSent.find((m) => m.type === 'TRANSFER_ERROR')?.payload.code).toBe(
        'INVALID_FRAME',
      );
    }

    // 3. Tampered ciphertext fails AES-GCM auth
    {
      const { transferId, fileId, controlSent, target, receiver } = await buildReceiver(100);
      const validFrame = await encryptBinaryChunkFrame({
        masterKeyBytes,
        roomId: ROOM_ID,
        transferId,
        fileId,
        direction,
        epoch: 1,
        chunkIndex: 0,
        plaintext: createDeterministicBytes(100),
        isFinalChunk: true,
      });
      const copy = new Uint8Array(validFrame.slice(0));
      copy[copy.byteLength - 1] ^= 0xff;
      receiver.handleBinaryFrame(copy.buffer);
      await vi.waitFor(() => expect(receiver.getState().state).toBe('failed'));
      expect(target.isAborted()).toBe(true);
      expect(controlSent.find((m) => m.type === 'TRANSFER_ERROR')?.payload.code).toBe(
        'AUTH_FAILED',
      );
    }

    // 4. QuotaExceededError maps cleanly to QUOTA_EXCEEDED
    {
      const quotaErr = new Error('Storage quota exceeded.');
      quotaErr.name = 'QuotaExceededError';
      const { transferId, fileId, controlSent, target, receiver } = await buildReceiver(100, {
        throwOnWrite: quotaErr,
      });
      const validFrame = await encryptBinaryChunkFrame({
        masterKeyBytes,
        roomId: ROOM_ID,
        transferId,
        fileId,
        direction,
        epoch: 1,
        chunkIndex: 0,
        plaintext: createDeterministicBytes(100),
        isFinalChunk: true,
      });
      receiver.handleBinaryFrame(validFrame);
      await vi.waitFor(() => expect(receiver.getState().state).toBe('failed'));
      expect(target.isAborted()).toBe(true);
      expect(controlSent.find((m) => m.type === 'TRANSFER_ERROR')?.payload.code).toBe(
        'QUOTA_EXCEEDED',
      );
    }

    // 5. Over-credit binary frame (sending chunk beyond initial 2 MiB credit without more grants)
    {
      const largeSize = RECEIVER_INITIAL_CREDIT_WINDOW_BYTES + CHUNK_SIZE_BYTES;
      const transferId = generateTransferId();
      const fileId = generateFileId();
      const controlSent = [];
      // Delay write forever so initial credit never advances beyond 2 MiB
      const target = createFakePersistenceTarget({ writeDelayMs: 500 });
      const receiver = createDownloaderReceiver({
        roomId: ROOM_ID,
        masterKeyBytes,
        transferId,
        fileId,
        direction,
        epoch: 1,
        fileSize: largeSize,
        persistenceTarget: target,
        cryptoProcessor: createChunkCryptoProcessor(),
        sendControlMessage: async (msg) => controlSent.push(msg),
      });
      await receiver.activate();

      const total = RECEIVER_INITIAL_CREDIT_WINDOW_BYTES / CHUNK_SIZE_BYTES + 1;
      for (let i = 0; i < total; i += 1) {
        const frame = await encryptBinaryChunkFrame({
          masterKeyBytes,
          roomId: ROOM_ID,
          transferId,
          fileId,
          direction,
          epoch: 1,
          chunkIndex: i,
          plaintext: createDeterministicBytes(CHUNK_SIZE_BYTES, i),
          isFinalChunk: i === total - 1,
        });
        const res = receiver.handleBinaryFrame(frame);
        if (i === total - 1) {
          expect(res).toMatchObject({ ok: false, code: 'FLOW_CREDIT_EXCEEDED' });
        }
      }
      await vi.waitFor(() => expect(receiver.getState().state).toBe('failed'));
      expect(target.isAborted()).toBe(true);
      expect(controlSent.find((m) => m.type === 'TRANSFER_ERROR')?.payload.code).toBe(
        'FLOW_CREDIT_EXCEEDED',
      );
      expect(BINARY_FRAME_HEADER_BYTES).toBe(52);
    }

    // 6. Explicit cancel aborts persistence target
    {
      const { target, receiver } = await buildReceiver(100);
      await receiver.cancel();
      expect(receiver.getState().state).toBe('cancelled');
      expect(target.isAborted()).toBe(true);
    }
  });
});
