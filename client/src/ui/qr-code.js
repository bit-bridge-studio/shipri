// Zero-dependency offline ISO/IEC 18004 QR Code encoder (Byte mode, EC Level L,
// Versions 1-9, up to 230 UTF-8 bytes) so URL #key= fragments never leave the browser.

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
{
  let value = 1;
  for (let i = 0; i < 255; i += 1) {
    GF_EXP[i] = value;
    GF_LOG[value] = i;
    value <<= 1;
    if (value & 0x100) {
      value ^= 0x11d;
    }
  }
  for (let i = 255; i < 512; i += 1) {
    GF_EXP[i] = GF_EXP[i - 255];
  }
}

function gfMul(a, b) {
  if (a === 0 || b === 0) {
    return 0;
  }
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

function rsGeneratorPoly(ecCount) {
  let poly = new Uint8Array([1]);
  for (let i = 0; i < ecCount; i += 1) {
    const next = new Uint8Array(poly.length + 1);
    const factor = GF_EXP[i];
    for (let j = 0; j < poly.length; j += 1) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], factor);
    }
    poly = next;
  }
  return poly;
}

function computeRsRemainder(dataBytes, ecCount) {
  const gen = rsGeneratorPoly(ecCount);
  const work = new Uint8Array(dataBytes.length + ecCount);
  work.set(dataBytes, 0);
  for (let i = 0; i < dataBytes.length; i += 1) {
    const lead = work[i];
    if (lead === 0) {
      continue;
    }
    for (let j = 0; j < gen.length; j += 1) {
      work[i + j] ^= gfMul(gen[j], lead);
    }
  }
  return work.subarray(dataBytes.length);
}

const VERSION_SPECS = [
  { version: 1, dataCodewords: 19, numBlocks: 1, blockData: 19, ecPerBlock: 7, align: [] },
  { version: 2, dataCodewords: 34, numBlocks: 1, blockData: 34, ecPerBlock: 10, align: [6, 18] },
  { version: 3, dataCodewords: 55, numBlocks: 1, blockData: 55, ecPerBlock: 15, align: [6, 22] },
  { version: 4, dataCodewords: 80, numBlocks: 1, blockData: 80, ecPerBlock: 20, align: [6, 26] },
  { version: 5, dataCodewords: 108, numBlocks: 1, blockData: 108, ecPerBlock: 26, align: [6, 30] },
  { version: 6, dataCodewords: 136, numBlocks: 2, blockData: 68, ecPerBlock: 18, align: [6, 34] },
  { version: 7, dataCodewords: 156, numBlocks: 2, blockData: 78, ecPerBlock: 20, align: [6, 22, 38] },
  { version: 8, dataCodewords: 194, numBlocks: 2, blockData: 97, ecPerBlock: 24, align: [6, 24, 42] },
  { version: 9, dataCodewords: 232, numBlocks: 2, blockData: 116, ecPerBlock: 30, align: [6, 26, 46] },
];

function bchRemainder(value, poly, degree) {
  let shifted = value << degree;
  while (31 - Math.clz32(shifted) >= degree) {
    const shift = 31 - Math.clz32(shifted) - degree;
    shifted ^= poly << shift;
  }
  return shifted;
}

function encodeDataCodewords(bytes, spec) {
  const bits = [];
  const pushBits = (val, width) => {
    for (let i = width - 1; i >= 0; i -= 1) {
      bits.push((val >>> i) & 1);
    }
  };

  pushBits(0b0100, 4); // Byte mode
  pushBits(bytes.length, 8); // Character count for Versions 1-9
  for (const byte of bytes) {
    pushBits(byte, 8);
  }

  const maxBits = spec.dataCodewords * 8;
  const terminatorLen = Math.min(4, maxBits - bits.length);
  pushBits(0, terminatorLen);

  while (bits.length % 8 !== 0) {
    bits.push(0);
  }

  const data = new Uint8Array(spec.dataCodewords);
  for (let i = 0; i < bits.length / 8; i += 1) {
    let b = 0;
    for (let bit = 0; bit < 8; bit += 1) {
      b = (b << 1) | bits[i * 8 + bit];
    }
    data[i] = b;
  }

  let padToggle = 0;
  for (let idx = bits.length / 8; idx < spec.dataCodewords; idx += 1) {
    data[idx] = padToggle === 0 ? 0xec : 0x11;
    padToggle ^= 1;
  }

  const blocks = [];
  const ecBlocks = [];
  let offset = 0;
  for (let b = 0; b < spec.numBlocks; b += 1) {
    const slice = data.subarray(offset, offset + spec.blockData);
    offset += spec.blockData;
    blocks.push(slice);
    ecBlocks.push(computeRsRemainder(slice, spec.ecPerBlock));
  }

  const interleaved = [];
  for (let i = 0; i < spec.blockData; i += 1) {
    for (const block of blocks) {
      interleaved.push(block[i]);
    }
  }
  for (let i = 0; i < spec.ecPerBlock; i += 1) {
    for (const ec of ecBlocks) {
      interleaved.push(ec[i]);
    }
  }
  return Uint8Array.from(interleaved);
}

function buildBaseTemplate(spec) {
  const size = spec.version * 4 + 17;
  const modules = Array.from({ length: size }, () => new Uint8Array(size));
  const isFunction = Array.from({ length: size }, () => new Uint8Array(size));

  const setFunction = (r, c, dark) => {
    modules[r][c] = dark ? 1 : 0;
    isFunction[r][c] = 1;
  };

  const drawFinder = (top, left) => {
    for (let dr = -1; dr <= 7; dr += 1) {
      for (let dc = -1; dc <= 7; dc += 1) {
        const r = top + dr;
        const c = left + dc;
        if (r < 0 || r >= size || c < 0 || c >= size) {
          continue;
        }
        const inRing = dr === 0 || dr === 6 || dc === 0 || dc === 6;
        const inCenter = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
        const insideFinder = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6;
        setFunction(r, c, insideFinder && (inRing || inCenter));
      }
    }
  };

  drawFinder(0, 0);
  drawFinder(0, size - 7);
  drawFinder(size - 7, 0);

  for (let i = 8; i <= size - 9; i += 1) {
    setFunction(6, i, i % 2 === 0);
    setFunction(i, 6, i % 2 === 0);
  }

  for (const rCenter of spec.align) {
    for (const cCenter of spec.align) {
      if (
        (rCenter <= 8 && cCenter <= 8) ||
        (rCenter <= 8 && cCenter >= size - 9) ||
        (rCenter >= size - 9 && cCenter <= 8)
      ) {
        continue;
      }
      for (let dr = -2; dr <= 2; dr += 1) {
        for (let dc = -2; dc <= 2; dc += 1) {
          const dark =
            Math.max(Math.abs(dr), Math.abs(dc)) === 2 ||
            (dr === 0 && dc === 0);
          setFunction(rCenter + dr, cCenter + dc, dark);
        }
      }
    }
  }

  // Reserve format info coordinates + dark module
  for (let i = 0; i <= 8; i += 1) {
    if (i !== 6) {
      setFunction(8, i, false);
      setFunction(i, 8, false);
    }
  }
  for (let i = 0; i < 8; i += 1) {
    setFunction(8, size - 1 - i, false);
  }
  for (let i = 0; i < 7; i += 1) {
    setFunction(size - 1 - i, 8, false);
  }
  setFunction(4 * spec.version + 9, 8, true);

  if (spec.version >= 7) {
    const verData = (spec.version << 12) | bchRemainder(spec.version, 0x1f25, 12);
    for (let k = 0; k < 18; k += 1) {
      const bit = (verData >>> k) & 1;
      const a = Math.floor(k / 3);
      const b = size - 11 + (k % 3);
      setFunction(b, a, bit === 1);
      setFunction(a, b, bit === 1);
    }
  }

  return { size, modules, isFunction, setFunction };
}

function placeDataBits(modules, isFunction, size, codewords) {
  let bitIdx = 0;
  const totalBits = codewords.length * 8;
  let upward = true;

  for (let rightCol = size - 1; rightCol >= 1; rightCol -= 2) {
    if (rightCol === 6) {
      rightCol = 5;
    }
    for (let step = 0; step < size; step += 1) {
      const row = upward ? size - 1 - step : step;
      for (let colOffset = 0; colOffset < 2; colOffset += 1) {
        const col = rightCol - colOffset;
        if (isFunction[row][col]) {
          continue;
        }
        let bit = 0;
        if (bitIdx < totalBits) {
          bit = (codewords[bitIdx >>> 3] >>> (7 - (bitIdx & 7))) & 1;
          bitIdx += 1;
        }
        modules[row][col] = bit;
      }
    }
    upward = !upward;
  }
}

function maskMatches(maskId, r, c) {
  switch (maskId) {
    case 0:
      return (r + c) % 2 === 0;
    case 1:
      return r % 2 === 0;
    case 2:
      return c % 3 === 0;
    case 3:
      return (r + c) % 3 === 0;
    case 4:
      return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
    case 5:
      return ((r * c) % 2) + ((r * c) % 3) === 0;
    case 6:
      return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0;
    default:
      return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0;
  }
}

function applyFormatAndMask(size, baseModules, isFunction, maskId) {
  const matrix = baseModules.map((row) => Uint8Array.from(row));
  for (let r = 0; r < size; r += 1) {
    for (let c = 0; c < size; c += 1) {
      if (!isFunction[r][c] && maskMatches(maskId, r, c)) {
        matrix[r][c] ^= 1;
      }
    }
  }

  const ecLevelLBits = 0b01;
  const formatPayload = (ecLevelLBits << 3) | maskId;
  const formatCode =
    ((formatPayload << 10) | bchRemainder(formatPayload, 0x537, 10)) ^ 0x5412;

  for (let i = 0; i <= 5; i += 1) {
    matrix[8][i] = (formatCode >>> (14 - i)) & 1;
    matrix[size - 1 - i][8] = (formatCode >>> (14 - i)) & 1;
  }
  matrix[8][7] = (formatCode >>> 8) & 1;
  matrix[size - 7][8] = (formatCode >>> 8) & 1;
  matrix[8][8] = (formatCode >>> 7) & 1;
  matrix[7][8] = (formatCode >>> 6) & 1;
  for (let i = 0; i <= 5; i += 1) {
    matrix[5 - i][8] = (formatCode >>> (5 - i)) & 1;
  }
  for (let i = 0; i < 8; i += 1) {
    matrix[8][size - 8 + i] = (formatCode >>> (7 - i)) & 1;
  }
  return matrix;
}

function scorePenalty(matrix, size) {
  let penalty = 0;

  // N1 & N3 on rows and cols
  const evalLine = (getter) => {
    let runColor = getter(0);
    let runLen = 1;
    for (let i = 1; i < size; i += 1) {
      const bit = getter(i);
      if (bit === runColor) {
        runLen += 1;
      } else {
        if (runLen >= 5) {
          penalty += 3 + (runLen - 5);
        }
        runColor = bit;
        runLen = 1;
      }
    }
    if (runLen >= 5) {
      penalty += 3 + (runLen - 5);
    }

    for (let i = 0; i <= size - 11; i += 1) {
      const matchA =
        getter(i) === 1 &&
        getter(i + 1) === 0 &&
        getter(i + 2) === 1 &&
        getter(i + 3) === 1 &&
        getter(i + 4) === 1 &&
        getter(i + 5) === 0 &&
        getter(i + 6) === 1 &&
        getter(i + 7) === 0 &&
        getter(i + 8) === 0 &&
        getter(i + 9) === 0 &&
        getter(i + 10) === 0;
      const matchB =
        getter(i) === 0 &&
        getter(i + 1) === 0 &&
        getter(i + 2) === 0 &&
        getter(i + 3) === 0 &&
        getter(i + 4) === 1 &&
        getter(i + 5) === 0 &&
        getter(i + 6) === 1 &&
        getter(i + 7) === 1 &&
        getter(i + 8) === 1 &&
        getter(i + 9) === 0 &&
        getter(i + 10) === 1;
      if (matchA || matchB) {
        penalty += 40;
      }
    }
  };

  for (let r = 0; r < size; r += 1) {
    evalLine((c) => matrix[r][c]);
  }
  for (let c = 0; c < size; c += 1) {
    evalLine((r) => matrix[r][c]);
  }

  // N2: 2x2 identical blocks
  for (let r = 0; r < size - 1; r += 1) {
    for (let c = 0; c < size - 1; c += 1) {
      const v = matrix[r][c];
      if (
        matrix[r][c + 1] === v &&
        matrix[r + 1][c] === v &&
        matrix[r + 1][c + 1] === v
      ) {
        penalty += 3;
      }
    }
  }

  // N4: dark ratio deviation
  let darkCount = 0;
  for (let r = 0; r < size; r += 1) {
    for (let c = 0; c < size; c += 1) {
      if (matrix[r][c]) {
        darkCount += 1;
      }
    }
  }
  const percent = (darkCount * 100) / (size * size);
  const kPrev = Math.floor(Math.abs(percent - 50) / 5);
  penalty += kPrev * 10;

  return penalty;
}

/**
 * Encodes UTF-8 text into a masked ISO/IEC 18004 QR Code matrix completely offline.
 * @param {string} text
 */
export function encodeQrMatrix(text) {
  if (typeof text !== 'string' || text.length === 0) {
    throw new RangeError('Expected a non-empty string for QR encoding.');
  }
  const bytes = new TextEncoder().encode(text);
  const spec = VERSION_SPECS.find((s) => bytes.length <= s.dataCodewords - 2);
  if (!spec) {
    throw new RangeError(
      `Input exceeds offline QR capacity (${bytes.length} bytes > 230 max).`,
    );
  }

  const codewords = encodeDataCodewords(bytes, spec);
  const { size, modules, isFunction } = buildBaseTemplate(spec);
  placeDataBits(modules, isFunction, size, codewords);

  let bestMatrix = null;
  let bestScore = Infinity;
  for (let maskId = 0; maskId < 8; maskId += 1) {
    const candidate = applyFormatAndMask(size, modules, isFunction, maskId);
    const score = scorePenalty(candidate, size);
    if (score < bestScore) {
      bestScore = score;
      bestMatrix = candidate;
    }
  }

  return Object.freeze({
    version: spec.version,
    size,
    modulesCount: size,
    dataByteLength: bytes.length,
    matrix: bestMatrix,
  });
}

/**
 * Converts a QR module matrix into a compact SVG <path d="..." /> string with
 * a standard 4-module quiet zone around the code.
 */
export function buildQrSvgPath(matrix, quietZone = 4) {
  const size = matrix.length;
  const parts = [];
  for (let r = 0; r < size; r += 1) {
    const row = matrix[r];
    for (let c = 0; c < size; c += 1) {
      if (row[c]) {
        parts.push(`M${c + quietZone},${r + quietZone}h1v1h-1z`);
      }
    }
  }
  return parts.join('');
}
