import { describe, expect, it, vi } from 'vitest';
import { createLocalFileBoard } from '../src/board/local-board.js';
import { decryptFileAdvertisement } from '../src/crypto/board-metadata.js';
import { validateControlMessage } from '../src/crypto/control-codec.js';
import { generateMasterKey } from '../src/crypto/fragment-key.js';

function createMockFile({
  name,
  content = 'sample file payload',
  type = 'text/plain',
  lastModified = 1_785_000_000_000,
  throwOnSlice = false,
} = {}) {
  const bytes =
    typeof content === 'string'
      ? new TextEncoder().encode(content)
      : content;
  let currentSize = bytes.byteLength;
  let currentLastModified = lastModified;

  return {
    name,
    get size() {
      return currentSize;
    },
    type,
    get lastModified() {
      return currentLastModified;
    },
    slice(start = 0, end = currentSize) {
      if (throwOnSlice) {
        throw new Error('NotReadableError: underlying file was moved or deleted.');
      }
      const sub = bytes.slice(start, end);
      return {
        arrayBuffer: async () => sub.buffer,
      };
    },
    mutateExternally({ newSize, newLastModified }) {
      if (newSize !== undefined) {
        currentSize = newSize;
      }
      if (newLastModified !== undefined) {
        currentLastModified = newLastModified;
      }
    },
  };
}

describe('local file advertisements (ticket [49])', () => {
  it('adds multiple local files, encrypts FILE_ADVERTISE messages, suppresses duplicates, and isolates File references to owner RAM', async () => {
    const { masterKeyBytes } = generateMasterKey();
    const roomId = 'ship-83a1';
    const published = [];

    const board = createLocalFileBoard({
      roomId,
      masterKeyBytes,
      publishControlMessage: (msg) => {
        published.push(msg);
      },
    });

    const f1 = createMockFile({ name: 'design_spec.pdf', content: 'pdf-bytes', type: 'application/pdf' });
    const f2 = createMockFile({ name: 'dataset.csv', content: 'id,val\n1,42', type: 'text/csv', lastModified: 1_785_000_001_000 });

    const res = await board.addFiles([f1, f2, createMockFile({ name: 'design_spec.pdf', content: 'pdf-bytes', type: 'application/pdf' })]);

    expect(res.advertised).toHaveLength(2);
    expect(res.duplicates).toHaveLength(1);
    expect(res.duplicates[0].fileName).toBe('design_spec.pdf');
    expect(published).toHaveLength(2);

    // Every published FILE_ADVERTISE decrypts cleanly and reveals zero File handles or plaintext on wire
    for (const msg of published) {
      expect(validateControlMessage(msg).ok).toBe(true);
      expect(msg.type).toBe('FILE_ADVERTISE');
      const dec = await decryptFileAdvertisement({
        masterKeyBytes,
        roomId,
        message: msg,
      });
      expect(dec.ok).toBe(true);
    }

    // State snapshot exposes read-only metadata without File handle objects or private plaintext on wire
    const entries = board.getPublicEntries();
    expect(entries).toHaveLength(2);
    for (const entry of entries) {
      expect(Object.isFrozen(entry)).toBe(true);
      expect(entry.file).toBeUndefined();
      expect(typeof entry.slice).toBe('undefined');
    }

    const syncMsg = await board.getBoardSyncMessage();
    expect(validateControlMessage(syncMsg).ok).toBe(true);
    expect(syncMsg.type).toBe('BOARD_SYNC');
    expect(syncMsg.payload.files).toHaveLength(2);

    board.dispose();
  });

  it('removes advertisements via FILE_REMOVE while preserving File handles for active transfers until those transfers finish', async () => {
    const { masterKeyBytes } = generateMasterKey();
    const roomId = 'ship-83a1';
    const published = [];

    const board = createLocalFileBoard({
      roomId,
      masterKeyBytes,
      publishControlMessage: (msg) => published.push(msg),
    });

    const f1 = createMockFile({ name: 'backup.tar', content: 'tar-content-bytes' });
    const added = await board.addFiles([f1]);
    const fileId = added.advertised[0].fileId;

    // Register an active transfer referencing fileId
    const transferId = 'transfer-active-01';
    expect(board.registerActiveTransfer(transferId, fileId)).toBe(true);

    // Removing advertisement removes it from board and publishes FILE_REMOVE...
    const removed = await board.removeFile(fileId);
    expect(removed).toBe(true);
    expect(board.getPublicEntries()).toHaveLength(0);
    expect(board.getAdvertisedEntry(fileId)).toBeNull();
    expect(published.at(-1)).toEqual({
      type: 'FILE_REMOVE',
      payload: { fileId },
    });

    // ...without cancelling active transfer: retained File handle remains readable for transferId
    expect(board.resolveFileForTransfer(transferId, fileId)?.file).toBe(f1);

    // After active transfer finishes, retained File handle is garbage collected
    board.unregisterActiveTransfer(transferId);
    expect(board.resolveFileForTransfer(transferId, fileId)).toBeNull();

    // Removing missing fileId returns false safely
    expect(await board.removeFile(fileId)).toBe(false);
    board.dispose();
  });

  it('detects unavailable or externally modified local files cleanly and wipes all references on cleanup', async () => {
    const { masterKeyBytes } = generateMasterKey();
    const board = createLocalFileBoard({
      roomId: 'ship-83a1',
      masterKeyBytes,
      publishControlMessage: vi.fn(),
    });

    const mutableFile = createMockFile({ name: 'changing.bin', content: 'initial' });
    const unreadableFile = createMockFile({
      name: 'vanished.bin',
      content: 'gone',
      throwOnSlice: true,
    });

    const { advertised } = await board.addFiles([mutableFile, unreadableFile]);
    const [changedEntry, vanishedEntry] = advertised;

    // Valid initially for unchanged file
    expect((await board.verifyLocalFileReadable(changedEntry.fileId)).ok).toBe(true);

    // Mutate file size externally -> fails readability check with FILE_UNREADABLE
    mutableFile.mutateExternally({ newSize: 99999 });
    expect(await board.verifyLocalFileReadable(changedEntry.fileId)).toEqual({
      ok: false,
      code: 'FILE_UNREADABLE',
    });

    // Unreadable file fails cleanly with FILE_UNREADABLE
    expect(await board.verifyLocalFileReadable(vanishedEntry.fileId)).toEqual({
      ok: false,
      code: 'FILE_UNREADABLE',
    });

    // Reject invalid non-file inputs during addFiles
    const badRes = await board.addFiles([{ name: 'invalid-no-slice' }, null]);
    expect(badRes.advertised).toHaveLength(0);
    expect(badRes.rejected).toHaveLength(2);

    // Clear removes all advertisements and internal references
    board.clear();
    expect(board.getPublicEntries()).toHaveLength(0);
    expect(await board.verifyLocalFileReadable(changedEntry.fileId)).toEqual({
      ok: false,
      code: 'NOT_FOUND',
    });
    board.dispose();
  });
});
