import { describe, expect, it, vi } from 'vitest';
import { createLocalFileBoard } from '../src/board/local-board.js';
import {
  decodeBinaryFrameHeader,
  decryptBinaryChunkFrame,
  MAX_PLAINTEXT_CHUNK_BYTES as FRAMING_CHUNK_BYTES,
} from '../src/crypto/binary-framing.js';
import { generateTransferId } from '../src/crypto/control-codec.js';
import {
  generateMasterKey,
  generateMemberId,
} from '../src/crypto/fragment-key.js';
import {
  CHUNK_SIZE_BYTES,
  OWNER_CHANNEL_HIGH_WATER_MARK_BYTES,
  OWNER_CHANNEL_LOW_WATER_MARK_BYTES,
  createOwnerChunkStreamer,
} from '../src/transfer/owner-streamer.js';
import { createChunkCryptoProcessor } from '../src/workers/chunk-worker-client.js';
import { createChunkWorkerMessageHandler } from '../src/workers/chunk-crypto.worker.js';

const ROOM_ID = 'ship-7b31';

function createDeterministicBytes(length, seed = 17) {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) {
    bytes[i] = (i * 31 + seed) & 0xff;
  }
  return bytes;
}

function createReadableMockFile({
  name = 'payload.bin',
  bytes = createDeterministicBytes(1024),
  type = 'application/octet-stream',
  lastModified = 1_785_200_000_000,
  onSlice,
  throwOnSlice = false,
} = {}) {
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
      onSlice?.(start, end);
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
    setSize(nextSize) {
      size = nextSize;
    },
  };
}

function createBackpressureMockChannel() {
  const listeners = new Map();
  return {
    readyState: 'open',
    bufferedAmount: 0,
    bufferedAmountLowThreshold: 0,
    sentFrames: [],
    addEventListener(type, fn) {
      const set = listeners.get(type) ?? new Set();
      set.add(fn);
      listeners.set(type, set);
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn);
    },
    send(data) {
      this.sentFrames.push(data);
    },
    emitBufferedAmountLow() {
      for (const fn of [...(listeners.get('bufferedamountlow') ?? [])]) {
        fn({ type: 'bufferedamountlow' });
      }
    },
  };
}

async function setupSingleFileStreamer({
  bytes,
  binaryChannel = createBackpressureMockChannel(),
  cryptoProcessor = createChunkCryptoProcessor(),
  onSlice,
} = {}) {
  const { masterKeyBytes } = generateMasterKey();
  const ownerMemberId = generateMemberId();
  const downloaderMemberId = generateMemberId();
  const direction = `${ownerMemberId}->${downloaderMemberId}`;
  const transferId = generateTransferId();
  const controlMessages = [];

  const localBoard = createLocalFileBoard({ roomId: ROOM_ID, masterKeyBytes });
  const file = createReadableMockFile({ name: 'sample.bin', bytes, onSlice });
  const added = await localBoard.addFiles([file]);
  const entry = added.advertised[0];
  localBoard.registerActiveTransfer(transferId, entry.fileId);

  const streamer = createOwnerChunkStreamer({
    roomId: ROOM_ID,
    masterKeyBytes,
    transferId,
    fileId: entry.fileId,
    direction,
    epoch: 1,
    fileSize: entry.fileSize,
    lastModified: file.lastModified,
    localBoard,
    binaryChannel,
    cryptoProcessor,
    sendControlMessage: async (msg) => controlMessages.push(msg),
  });

  return {
    masterKeyBytes,
    ownerMemberId,
    downloaderMemberId,
    direction,
    transferId,
    fileId: entry.fileId,
    file,
    localBoard,
    binaryChannel,
    cryptoProcessor,
    controlMessages,
    streamer,
  };
}

describe('Bounded owner-side encrypted chunk streaming (FF-5)', () => {
  it('uses frozen 64 KiB / 1 MiB / 256 KiB watermarks and streams exact chunk boundaries on valid credits', async () => {
    expect(CHUNK_SIZE_BYTES).toBe(65_536);
    expect(CHUNK_SIZE_BYTES).toBe(FRAMING_CHUNK_BYTES);
    expect(OWNER_CHANNEL_HIGH_WATER_MARK_BYTES).toBe(1_048_576);
    expect(OWNER_CHANNEL_LOW_WATER_MARK_BYTES).toBe(262_144);

    // Exact multi-chunk boundary + remainder: 2 * 65536 + 17 = 131089 bytes (3 chunks)
    const rawBytes = createDeterministicBytes(CHUNK_SIZE_BYTES * 2 + 17, 5);
    const sliceCalls = [];
    const ctx = await setupSingleFileStreamer({
      bytes: rawBytes,
      onSlice: (start, end) => sliceCalls.push([start, end]),
    });

    // Initially credit window is 0 -> zero slices or sends happen
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(sliceCalls).toEqual([]);
    expect(ctx.binaryChannel.sentFrames).toEqual([]);

    // Grant credit for exactly 1 chunk (65536)
    ctx.streamer.handleFlowCredit({
      type: 'FLOW_CREDIT',
      payload: {
        transferId: ctx.transferId,
        fileId: ctx.fileId,
        direction: ctx.direction,
        epoch: 1,
        sequence: 1,
        maxPlaintextOffsetExclusive: CHUNK_SIZE_BYTES,
      },
    });

    await vi.waitFor(() => {
      expect(ctx.binaryChannel.sentFrames).toHaveLength(1);
    });
    expect(sliceCalls).toEqual([[0, CHUNK_SIZE_BYTES]]);

    // Stale, duplicate, lower-offset, wrong-epoch, and wrong-transfer credits do NOT expand window
    expect(
      ctx.streamer.handleFlowCredit({
        type: 'FLOW_CREDIT',
        payload: {
          transferId: ctx.transferId,
          fileId: ctx.fileId,
          direction: ctx.direction,
          epoch: 1,
          sequence: 1,
          maxPlaintextOffsetExclusive: rawBytes.byteLength,
        },
      }).accepted,
    ).toBe(false);
    expect(
      ctx.streamer.handleFlowCredit({
        type: 'FLOW_CREDIT',
        payload: {
          transferId: ctx.transferId,
          fileId: ctx.fileId,
          direction: ctx.direction,
          epoch: 2,
          sequence: 2,
          maxPlaintextOffsetExclusive: rawBytes.byteLength,
        },
      }).accepted,
    ).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(ctx.binaryChannel.sentFrames).toHaveLength(1);

    // Partial offset insufficient for chunk 1 ending (131072): 131071 MUST NOT send chunk 1 yet
    ctx.streamer.handleFlowCredit({
      type: 'FLOW_CREDIT',
      payload: {
        transferId: ctx.transferId,
        fileId: ctx.fileId,
        direction: ctx.direction,
        epoch: 1,
        sequence: 2,
        maxPlaintextOffsetExclusive: CHUNK_SIZE_BYTES * 2 - 1,
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(ctx.binaryChannel.sentFrames).toHaveLength(1);

    // Delayed valid credit reaches total fileSize -> sends chunks 1 and 2 sequentially
    ctx.streamer.handleFlowCredit({
      type: 'FLOW_CREDIT',
      payload: {
        transferId: ctx.transferId,
        fileId: ctx.fileId,
        direction: ctx.direction,
        epoch: 1,
        sequence: 3,
        maxPlaintextOffsetExclusive: rawBytes.byteLength,
      },
    });
    await vi.waitFor(() => {
      expect(ctx.binaryChannel.sentFrames).toHaveLength(3);
    });

    // Verify decrypted frames match exact rawBytes
    const reconstructed = new Uint8Array(rawBytes.byteLength);
    let writeOffset = 0;
    for (let i = 0; i < 3; i += 1) {
      const dec = await decryptBinaryChunkFrame({
        masterKeyBytes: ctx.masterKeyBytes,
        roomId: ROOM_ID,
        expectedTransferId: ctx.transferId,
        expectedFileId: ctx.fileId,
        expectedDirection: ctx.direction,
        expectedEpoch: 1,
        expectedChunkIndex: i,
        frameBuffer: ctx.binaryChannel.sentFrames[i],
      });
      expect(dec.ok).toBe(true);
      expect(dec.header.isFinalChunk).toBe(i === 2);
      reconstructed.set(new Uint8Array(dec.plaintext), writeOffset);
      writeOffset += dec.header.plaintextLength;
    }
    expect(reconstructed).toEqual(rawBytes);

    // Completion message cleans up transfer handle
    ctx.streamer.handleTransferComplete({
      type: 'TRANSFER_COMPLETE',
      payload: {
        transferId: ctx.transferId,
        fileId: ctx.fileId,
        direction: ctx.direction,
        epoch: 1,
        totalPersistedBytes: rawBytes.byteLength,
      },
    });
    expect(ctx.streamer.getState().state).toBe('completed');
    expect(ctx.localBoard.resolveFileForTransfer(ctx.transferId, ctx.fileId)).toBeNull();

    ctx.localBoard.dispose();
  });

  it('enforces bufferedAmount high/low watermarks independently of abundant FLOW_CREDIT', async () => {
    const totalChunks = 5;
    const rawBytes = createDeterministicBytes(CHUNK_SIZE_BYTES * totalChunks, 9);
    const channel = createBackpressureMockChannel();
    const sentAtBuffered = [];

    channel.send = (frame) => {
      sentAtBuffered.push(channel.bufferedAmount);
      channel.sentFrames.push(frame);
      // Simulate channel hitting high watermark after 2 frames
      if (channel.sentFrames.length === 2) {
        channel.bufferedAmount = OWNER_CHANNEL_HIGH_WATER_MARK_BYTES;
      }
    };

    const ctx = await setupSingleFileStreamer({
      bytes: rawBytes,
      binaryChannel: channel,
    });

    expect(channel.bufferedAmountLowThreshold).toBe(
      OWNER_CHANNEL_LOW_WATER_MARK_BYTES,
    );

    // Grant full file credit immediately
    ctx.streamer.handleFlowCredit({
      type: 'FLOW_CREDIT',
      payload: {
        transferId: ctx.transferId,
        fileId: ctx.fileId,
        direction: ctx.direction,
        epoch: 1,
        sequence: 1,
        maxPlaintextOffsetExclusive: rawBytes.byteLength,
      },
    });

    await vi.waitFor(() => {
      expect(channel.sentFrames).toHaveLength(2);
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(channel.sentFrames).toHaveLength(2);
    expect(ctx.streamer.getState().backpressured).toBe(true);

    // Drain only partway (still above low watermark): stays paused
    channel.bufferedAmount = OWNER_CHANNEL_LOW_WATER_MARK_BYTES + 1;
    channel.emitBufferedAmountLow();
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(channel.sentFrames).toHaveLength(2);

    // Drain below low watermark and fire bufferedamountlow -> resumes and completes remaining chunks
    channel.bufferedAmount = OWNER_CHANNEL_LOW_WATER_MARK_BYTES;
    channel.emitBufferedAmountLow();

    await vi.waitFor(() => {
      expect(channel.sentFrames).toHaveLength(totalChunks);
    });
    expect(ctx.streamer.getState().backpressured).toBe(false);

    ctx.streamer.dispose();
    ctx.localBoard.dispose();
  });

  it('isolates missing/changed file failures and encryption failures without disrupting sibling transfers', async () => {
    const { masterKeyBytes } = generateMasterKey();
    const ownerMemberId = generateMemberId();
    const downloaderMemberId = generateMemberId();
    const direction = `${ownerMemberId}->${downloaderMemberId}`;

    const localBoard = createLocalFileBoard({ roomId: ROOM_ID, masterKeyBytes });
    const badFile = createReadableMockFile({
      name: 'bad.bin',
      bytes: createDeterministicBytes(CHUNK_SIZE_BYTES * 2, 1),
    });
    const goodBytes = createDeterministicBytes(CHUNK_SIZE_BYTES, 2);
    const goodFile = createReadableMockFile({ name: 'good.bin', bytes: goodBytes });
    const added = await localBoard.addFiles([badFile, goodFile]);

    const [badEntry, goodEntry] = added.advertised;
    const tidBad = generateTransferId();
    const tidGood = generateTransferId();
    localBoard.registerActiveTransfer(tidBad, badEntry.fileId);
    localBoard.registerActiveTransfer(tidGood, goodEntry.fileId);

    // Corrupt local file size before streaming badFile
    badFile.setSize(12);

    const badChannel = createBackpressureMockChannel();
    const goodChannel = createBackpressureMockChannel();
    const badControl = [];
    const goodControl = [];

    const badStreamer = createOwnerChunkStreamer({
      roomId: ROOM_ID,
      masterKeyBytes,
      transferId: tidBad,
      fileId: badEntry.fileId,
      direction,
      epoch: 1,
      fileSize: badEntry.fileSize,
      lastModified: badFile.lastModified,
      localBoard,
      binaryChannel: badChannel,
      cryptoProcessor: createChunkCryptoProcessor(),
      sendControlMessage: async (msg) => badControl.push(msg),
    });

    const goodStreamer = createOwnerChunkStreamer({
      roomId: ROOM_ID,
      masterKeyBytes,
      transferId: tidGood,
      fileId: goodEntry.fileId,
      direction: `${downloaderMemberId}->${ownerMemberId}`,
      epoch: 1,
      fileSize: goodEntry.fileSize,
      lastModified: goodFile.lastModified,
      localBoard,
      binaryChannel: goodChannel,
      cryptoProcessor: createChunkCryptoProcessor(),
      sendControlMessage: async (msg) => goodControl.push(msg),
    });

    badStreamer.handleFlowCredit({
      type: 'FLOW_CREDIT',
      payload: {
        transferId: tidBad,
        fileId: badEntry.fileId,
        direction,
        epoch: 1,
        sequence: 1,
        maxPlaintextOffsetExclusive: badEntry.fileSize,
      },
    });
    goodStreamer.handleFlowCredit({
      type: 'FLOW_CREDIT',
      payload: {
        transferId: tidGood,
        fileId: goodEntry.fileId,
        direction: `${downloaderMemberId}->${ownerMemberId}`,
        epoch: 1,
        sequence: 1,
        maxPlaintextOffsetExclusive: goodEntry.fileSize,
      },
    });

    await vi.waitFor(() => {
      expect(badStreamer.getState().state).toBe('failed');
      expect(goodChannel.sentFrames).toHaveLength(1);
    });

    expect(badStreamer.getState().errorCode).toBe('FILE_UNREADABLE');
    expect(badControl).toEqual([
      {
        type: 'TRANSFER_ERROR',
        payload: {
          transferId: tidBad,
          direction,
          code: 'FILE_UNREADABLE',
        },
      },
    ]);
    expect(goodStreamer.getState().state).toBe('active');
    expect(decodeBinaryFrameHeader(goodChannel.sentFrames[0]).ok).toBe(true);

    // Also verify encryption failure + cancellation on separate instance
    const brokenCryptoChannel = createBackpressureMockChannel();
    const brokenControl = [];
    const tidFailCrypto = generateTransferId();
    localBoard.registerActiveTransfer(tidFailCrypto, goodEntry.fileId);
    const cryptoFailStreamer = createOwnerChunkStreamer({
      roomId: ROOM_ID,
      masterKeyBytes,
      transferId: tidFailCrypto,
      fileId: goodEntry.fileId,
      direction,
      epoch: 1,
      fileSize: goodEntry.fileSize,
      lastModified: goodFile.lastModified,
      localBoard,
      binaryChannel: brokenCryptoChannel,
      cryptoProcessor: {
        async encryptChunk() {
          throw new Error('Crypto failure');
        },
        async releaseTransfer() {},
      },
      sendControlMessage: async (msg) => brokenControl.push(msg),
    });
    cryptoFailStreamer.handleFlowCredit({
      type: 'FLOW_CREDIT',
      payload: {
        transferId: tidFailCrypto,
        fileId: goodEntry.fileId,
        direction,
        epoch: 1,
        sequence: 1,
        maxPlaintextOffsetExclusive: goodEntry.fileSize,
      },
    });
    await vi.waitFor(() => {
      expect(cryptoFailStreamer.getState().state).toBe('failed');
    });
    expect(brokenControl[0]?.payload.code).toBe('INTERNAL_ERROR');

    // Verify cancellation stops pending send and cleans handle
    await goodStreamer.cancel('USER_CANCELLED');
    expect(goodStreamer.getState().state).toBe('cancelled');
    expect(localBoard.resolveFileForTransfer(tidGood, goodEntry.fileId)).toBeNull();

    badStreamer.dispose();
    goodStreamer.dispose();
    cryptoFailStreamer.dispose();
    localBoard.dispose();
  });

  it('transfers ArrayBuffer payloads across worker message handler without retaining copies', async () => {
    const posted = [];
    const handler = createChunkWorkerMessageHandler((response, transferList) => {
      posted.push({ response, transferList });
    });

    const { masterKeyBytes } = generateMasterKey();
    const ownerMemberId = generateMemberId();
    const downloaderMemberId = generateMemberId();
    const direction = `${ownerMemberId}->${downloaderMemberId}`;
    const transferId = generateTransferId();
    const fileId = generateTransferId();
    const plaintext = createDeterministicBytes(512, 33);

    await handler({
      data: {
        id: 1,
        action: 'ENCRYPT_CHUNK',
        payload: {
          masterKeyBytes,
          roomId: ROOM_ID,
          transferId,
          fileId,
          direction,
          epoch: 1,
          chunkIndex: 0,
          plaintextBuffer: plaintext.buffer.slice(0),
          isFinalChunk: true,
        },
      },
    });

    expect(posted).toHaveLength(1);
    expect(posted[0].response.ok).toBe(true);
    expect(posted[0].transferList).toEqual([posted[0].response.frameBuffer]);

    await handler({
      data: {
        id: 2,
        action: 'DECRYPT_CHUNK',
        payload: {
          masterKeyBytes,
          roomId: ROOM_ID,
          expectedTransferId: transferId,
          expectedFileId: fileId,
          expectedDirection: direction,
          expectedEpoch: 1,
          expectedChunkIndex: 0,
          frameBuffer: posted[0].response.frameBuffer,
        },
      },
    });

    expect(posted).toHaveLength(2);
    expect(posted[1].response.ok).toBe(true);
    expect(posted[1].transferList).toEqual([posted[1].response.plaintextBuffer]);
    expect(new Uint8Array(posted[1].response.plaintextBuffer)).toEqual(plaintext);
  });
});
