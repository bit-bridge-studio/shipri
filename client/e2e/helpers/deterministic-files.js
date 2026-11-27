import { createHash } from 'node:crypto';

export const CHUNK_SIZE_BYTES = 65_536;

/**
 * Generates deterministic pseudo-random bytes from a numeric seed without
 * relying on committed binary fixture files.
 */
export function createDeterministicBytes(sizeBytes, seed = 1) {
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
    throw new TypeError('Expected non-negative integer sizeBytes.');
  }
  let state = (seed >>> 0) || 1;
  const out = new Uint8Array(sizeBytes);
  for (let i = 0; i < sizeBytes; i += 4) {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    out[i] = state & 0xff;
    if (i + 1 < sizeBytes) out[i + 1] = (state >>> 8) & 0xff;
    if (i + 2 < sizeBytes) out[i + 2] = (state >>> 16) & 0xff;
    if (i + 3 < sizeBytes) out[i + 3] = (state >>> 24) & 0xff;
  }
  return out;
}

export function computeSha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Computes a chunk-chained SHA-256 digest over fixed 64 KiB blocks matching
 * the browser O(1)-memory streaming persistence stub.
 */
export function computeStreamingDigestHex(bytes, blockSize = CHUNK_SIZE_BYTES) {
  let chain = Buffer.alloc(32, 0);
  if (bytes.byteLength === 0) {
    return createHash('sha256').update(chain).digest('hex');
  }
  for (let offset = 0; offset < bytes.byteLength; offset += blockSize) {
    const end = Math.min(bytes.byteLength, offset + blockSize);
    const slice = Buffer.from(bytes.buffer, bytes.byteOffset + offset, end - offset);
    chain = createHash('sha256').update(chain).update(slice).digest();
  }
  return chain.toString('hex');
}

/**
 * Attaches a deterministic in-memory virtual file to the page's file input
 * and returns expected digests for downstream E2E verification.
 */
export async function attachInputFile(
  page,
  { name, sizeBytes = 0, seed = 1, mimeType = 'application/octet-stream' },
) {
  const bytes = createDeterministicBytes(sizeBytes, seed);
  await page.locator('input[type="file"]').setInputFiles({
    name,
    mimeType,
    buffer: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
  });
  return {
    name,
    sizeBytes,
    seed,
    mimeType,
    bytes,
    sha256Hex: computeSha256Hex(bytes),
    streamDigestHex: computeStreamingDigestHex(bytes),
  };
}

/**
 * Generates a deterministic File inside the browser context and drops it onto
 * the shared board dropzone without transferring large buffers across IPC.
 */
export async function dropVirtualFile(
  page,
  {
    name,
    sizeBytes = 0,
    seed = 1,
    mimeType = 'application/octet-stream',
    lastModified = 1_785_300_000_000,
  },
) {
  const expectedBytes = createDeterministicBytes(sizeBytes, seed);
  const sha256Hex = computeSha256Hex(expectedBytes);
  const streamDigestHex = computeStreamingDigestHex(expectedBytes);

  await page.evaluate(
    ({ fileName, totalBytes, fileSeed, type, modTime }) => {
      const dropzone = document.querySelector(
        '[aria-label="Drop local files here or press Enter to add files"]',
      );
      if (!dropzone) {
        throw new Error('Board dropzone element not found.');
      }
      let state = (fileSeed >>> 0) || 1;
      const out = new Uint8Array(totalBytes);
      for (let i = 0; i < totalBytes; i += 4) {
        state ^= state << 13;
        state >>>= 0;
        state ^= state >>> 17;
        state ^= state << 5;
        state >>>= 0;
        out[i] = state & 0xff;
        if (i + 1 < totalBytes) out[i + 1] = (state >>> 8) & 0xff;
        if (i + 2 < totalBytes) out[i + 2] = (state >>> 16) & 0xff;
        if (i + 3 < totalBytes) out[i + 3] = (state >>> 24) & 0xff;
      }
      const file = new File([out], fileName, {
        type,
        lastModified: modTime,
      });
      const dt = new DataTransfer();
      dt.items.add(file);
      const dropEvent = new DragEvent('drop', {
        bubbles: true,
        cancelable: true,
        dataTransfer: dt,
      });
      dropzone.dispatchEvent(dropEvent);
    },
    {
      fileName: name,
      totalBytes: sizeBytes,
      fileSeed: seed,
      type: mimeType,
      modTime: lastModified,
    },
  );

  return {
    name,
    sizeBytes,
    seed,
    mimeType,
    bytes: sizeBytes <= 2 * 1024 * 1024 ? expectedBytes : null,
    sha256Hex,
    streamDigestHex,
  };
}
