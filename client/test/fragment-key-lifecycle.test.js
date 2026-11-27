import { describe, expect, it, vi } from 'vitest';
import {
  MEMBER_ID_BYTES,
  ROOM_KEY_BYTES,
  SESSION_STORAGE_PREFIX,
  createFragmentKeyLifecycle,
  decodeMasterKey,
  extractAndStripFragmentKey,
  generateMasterKey,
  generateMemberId,
} from '../src/crypto/fragment-key.js';
import { buildRoomShareUrl } from '../src/crypto/room-auth.js';

function createMockSessionStorage() {
  const map = new Map();
  return {
    getItem: vi.fn((key) => (map.has(key) ? map.get(key) : null)),
    setItem: vi.fn((key, value) => {
      map.set(key, String(value));
    }),
    removeItem: vi.fn((key) => {
      map.delete(key);
    }),
    snapshot: () => Object.fromEntries(map.entries()),
  };
}

describe('URL fragment key lifecycle (ticket [44])', () => {
  it('generates a 256-bit master key and 16-byte memberId and builds fragment-only share links', () => {
    const first = generateMasterKey();
    const second = generateMasterKey();

    expect(first.masterKeyBytes).toBeInstanceOf(Uint8Array);
    expect(first.masterKeyBytes.byteLength).toBe(ROOM_KEY_BYTES);
    expect(first.masterKeyBase64Url).toHaveLength(43);
    expect(first.masterKeyBase64Url).not.toBe(second.masterKeyBase64Url);
    expect(decodeMasterKey(first.masterKeyBase64Url)).toEqual(
      first.masterKeyBytes,
    );

    const memberId = generateMemberId();
    expect(memberId).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(MEMBER_ID_BYTES).toBe(16);

    const shareUrl = buildRoomShareUrl({
      origin: 'https://shipri.app',
      roomId: 'ship-1a2b',
      masterKeyBase64Url: first.masterKeyBase64Url,
    });
    expect(shareUrl).toBe(
      `https://shipri.app/room/ship-1a2b#key=${first.masterKeyBase64Url}`,
    );
  });

  it('extracts #key= from location.hash and immediately strips it via window.history.replaceState', () => {
    const { masterKeyBase64Url, masterKeyBytes } = generateMasterKey();
    const locationObj = {
      origin: 'https://shipri.app',
      pathname: '/room/ship-1a2b',
      search: '',
      hash: `#key=${masterKeyBase64Url}`,
    };
    const historyObj = {
      replaceState: vi.fn((_state, _title, nextUrl) => {
        locationObj.hash = '';
        locationObj.pathname = nextUrl;
      }),
    };

    const result = extractAndStripFragmentKey({ locationObj, historyObj });
    expect(result.ok).toBe(true);
    expect(result.masterKeyBase64Url).toBe(masterKeyBase64Url);
    expect(result.masterKeyBytes).toEqual(masterKeyBytes);
    expect(historyObj.replaceState).toHaveBeenCalledTimes(1);
    expect(historyObj.replaceState).toHaveBeenCalledWith(
      null,
      '',
      '/room/ship-1a2b',
    );
    expect(locationObj.hash).toBe('');
  });

  it('caches key in tab-scoped sessionStorage[roomId] for reload recovery and wipes on leave, terminal error, or reset', () => {
    const storage = createMockSessionStorage();
    const { masterKeyBase64Url } = generateMasterKey();
    const locationObj = {
      origin: 'https://shipri.app',
      pathname: '/room/ship-9f01',
      search: '',
      hash: `#key=${masterKeyBase64Url}`,
    };
    const historyObj = {
      replaceState: vi.fn(() => {
        locationObj.hash = '';
      }),
    };

    const lifecycle = createFragmentKeyLifecycle({
      storage,
      locationObj,
      historyObj,
    });

    // Initial join extracts, strips fragment, and caches in sessionStorage
    const joined = lifecycle.resolveForRoom('ship-9f01');
    expect(joined.ok).toBe(true);
    expect(joined.source).toBe('fragment');
    expect(historyObj.replaceState).toHaveBeenCalledWith(
      null,
      '',
      '/room/ship-9f01',
    );
    const storageKey = `${SESSION_STORAGE_PREFIX}ship-9f01`;
    expect(storage.setItem).toHaveBeenCalledWith(
      storageKey,
      expect.any(String),
    );
    const savedMemberId = joined.memberId;

    // Simulate same-tab reload (hash is now empty, new lifecycle instance)
    const reloadedLifecycle = createFragmentKeyLifecycle({
      storage,
      locationObj,
      historyObj,
    });
    const recovered = reloadedLifecycle.resolveForRoom('ship-9f01');
    expect(recovered.ok).toBe(true);
    expect(recovered.source).toBe('session_storage');
    expect(recovered.masterKeyBase64Url).toBe(masterKeyBase64Url);
    expect(recovered.memberId).toBe(savedMemberId);

    // Explicit leave wipes sessionStorage and zeros in-memory bytes
    const liveBytesRef = recovered.masterKeyBytes;
    reloadedLifecycle.wipeForLeave();
    expect(storage.removeItem).toHaveBeenCalledWith(storageKey);
    expect(storage.snapshot()[storageKey]).toBeUndefined();
    expect(liveBytesRef.every((byte) => byte === 0)).toBe(true);
    expect(reloadedLifecycle.getActiveSession()).toBeNull();

    // Terminal room error also wipes sessionStorage and memory
    const created = reloadedLifecycle.createForRoom('ship-44aa');
    expect(created.ok).toBe(true);
    expect(
      storage.snapshot()[`${SESSION_STORAGE_PREFIX}ship-44aa`],
    ).toBeDefined();
    reloadedLifecycle.handleTerminalRoomError('ROOM_NOT_FOUND');
    expect(
      storage.snapshot()[`${SESSION_STORAGE_PREFIX}ship-44aa`],
    ).toBeUndefined();
    expect(reloadedLifecycle.getActiveSession()).toBeNull();

    // Explicit session reset wipes cached key
    const created2 = reloadedLifecycle.createForRoom('ship-55bb');
    expect(created2.ok).toBe(true);
    reloadedLifecycle.reset();
    expect(
      storage.snapshot()[`${SESSION_STORAGE_PREFIX}ship-55bb`],
    ).toBeUndefined();
    expect(reloadedLifecycle.getActiveSession()).toBeNull();
  });

  it('fails safely on missing, malformed, corrupted, or query-leaked keys without logging key material', () => {
    const storage = createMockSessionStorage();
    const malformedFragment = 'not-a-valid-32-byte-secret-value!!!';

    // Malformed fragment still strips URL and returns safe error without echoing secret
    const badLoc = {
      origin: 'https://shipri.app',
      pathname: '/room/ship-77cc',
      search: '',
      hash: `#key=${malformedFragment}`,
    };
    const badHistory = {
      replaceState: vi.fn(() => {
        badLoc.hash = '';
      }),
    };

    const badResult = extractAndStripFragmentKey({
      locationObj: badLoc,
      historyObj: badHistory,
    });
    expect(badResult.ok).toBe(false);
    expect(badResult.code).toBe('INVALID_KEY');
    expect(badHistory.replaceState).toHaveBeenCalledWith(
      null,
      '',
      '/room/ship-77cc',
    );
    expect(JSON.stringify(badResult)).not.toContain(malformedFragment);

    // Query-string key leak is rejected safely
    const leakedKey = generateMasterKey().masterKeyBase64Url;
    const queryLoc = {
      origin: 'https://shipri.app',
      pathname: '/room/ship-77cc',
      search: `?key=${leakedKey}`,
      hash: '',
    };
    const queryHistory = { replaceState: vi.fn() };
    const queryResult = extractAndStripFragmentKey({
      locationObj: queryLoc,
      historyObj: queryHistory,
    });
    expect(queryResult.ok).toBe(false);
    expect(queryResult.code).toBe('INSECURE_KEY_TRANSPORT');
    expect(JSON.stringify(queryResult)).not.toContain(leakedKey);

    // Missing key when neither fragment nor sessionStorage exists
    const emptyLoc = {
      origin: 'https://shipri.app',
      pathname: '/room/ship-77cc',
      search: '',
      hash: '',
    };
    const lifecycle = createFragmentKeyLifecycle({
      storage,
      locationObj: emptyLoc,
      historyObj: { replaceState: vi.fn() },
    });
    const missing = lifecycle.resolveForRoom('ship-77cc');
    expect(missing).toEqual({
      ok: false,
      code: 'MISSING_KEY',
      message: 'Room encryption key is missing from the link.',
    });

    // Corrupted sessionStorage entry is cleared and rejected safely
    storage.setItem(
      `${SESSION_STORAGE_PREFIX}ship-77cc`,
      '{"masterKeyBase64Url":"corrupt","memberId":"bad"}',
    );
    const corrupted = lifecycle.resolveForRoom('ship-77cc');
    expect(corrupted.ok).toBe(false);
    expect(corrupted.code).toBe('INVALID_KEY');
    expect(
      storage.snapshot()[`${SESSION_STORAGE_PREFIX}ship-77cc`],
    ).toBeUndefined();
  });
});
