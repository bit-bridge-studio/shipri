function normalizeIp(rawIp) {
  if (typeof rawIp !== 'string') {
    return 'unknown';
  }

  const trimmed = rawIp.trim();
  if (trimmed.length === 0) {
    return 'unknown';
  }

  if (trimmed.startsWith('::ffff:')) {
    return trimmed.slice(7);
  }

  return trimmed;
}

function isLoopbackIp(ip) {
  return ip === '::1' || ip === 'localhost' || ip.startsWith('127.');
}

function isLinkLocalIp(ip) {
  return ip.startsWith('169.254.') || ip.toLowerCase().startsWith('fe80:');
}

function isUniqueLocalIp(ip) {
  if (ip.startsWith('10.') || ip.startsWith('192.168.')) {
    return true;
  }

  if (ip.startsWith('172.')) {
    const secondOctet = Number.parseInt(ip.split('.')[1] ?? '', 10);
    if (secondOctet >= 16 && secondOctet <= 31) {
      return true;
    }
  }

  const lower = ip.toLowerCase();
  return lower.startsWith('fc') || lower.startsWith('fd');
}

function matchesTrustedProxySpec(ip, specEntries) {
  for (const spec of specEntries) {
    const lower = spec.toLowerCase();
    if (lower === 'loopback' && isLoopbackIp(ip)) {
      return true;
    }
    if (lower === 'linklocal' && isLinkLocalIp(ip)) {
      return true;
    }
    if (lower === 'uniquelocal' && isUniqueLocalIp(ip)) {
      return true;
    }
    if (normalizeIp(spec) === ip) {
      return true;
    }
  }

  return false;
}

function parseForwardedForHeader(rawHeader) {
  if (typeof rawHeader !== 'string') {
    return [];
  }

  return rawHeader
    .split(',')
    .map((entry) => normalizeIp(entry))
    .filter((entry) => entry !== 'unknown');
}

/**
 * Resolves the client IP address for a Socket.IO connection while honoring TRUST_PROXY.
 */
export function resolveClientIp(socket, trustProxy = false) {
  const directIp = normalizeIp(
    socket?.handshake?.address ?? socket?.conn?.remoteAddress ?? '',
  );

  if (trustProxy === false || trustProxy === 0) {
    return directIp;
  }

  const forwardedChain = parseForwardedForHeader(
    socket?.handshake?.headers?.['x-forwarded-for'],
  );
  if (forwardedChain.length === 0) {
    return directIp;
  }

  if (trustProxy === true) {
    return forwardedChain[0];
  }

  const fullChain = [...forwardedChain, directIp];

  if (typeof trustProxy === 'number' && Number.isInteger(trustProxy) && trustProxy > 0) {
    const targetIndex = Math.max(0, fullChain.length - 1 - trustProxy);
    return fullChain[targetIndex];
  }

  if (typeof trustProxy === 'string') {
    const specs = trustProxy
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);

    for (let index = fullChain.length - 1; index >= 0; index -= 1) {
      const candidateIp = fullChain[index];
      if (!matchesTrustedProxySpec(candidateIp, specs)) {
        return candidateIp;
      }
    }

    return fullChain[0];
  }

  return directIp;
}

/**
 * Creates an in-memory per-IP room:create rate limiter with automatic window expiry.
 */
export function createRoomCreateRateLimiter({
  maxAttempts,
  windowMs,
  now = () => Date.now(),
}) {
  const buckets = new Map();

  function consume(clientIp) {
    const key = normalizeIp(clientIp);
    const timestamp = now();
    const existing = buckets.get(key);

    if (!existing || timestamp >= existing.windowResetAt) {
      const nextBucket = {
        count: 1,
        windowResetAt: timestamp + windowMs,
      };
      buckets.set(key, nextBucket);
      return {
        allowed: nextBucket.count <= maxAttempts,
        remaining: Math.max(0, maxAttempts - nextBucket.count),
        resetAt: nextBucket.windowResetAt,
      };
    }

    existing.count += 1;
    return {
      allowed: existing.count <= maxAttempts,
      remaining: Math.max(0, maxAttempts - existing.count),
      resetAt: existing.windowResetAt,
    };
  }

  function purgeExpired() {
    const timestamp = now();
    let purged = 0;

    for (const [key, bucket] of buckets.entries()) {
      if (timestamp >= bucket.windowResetAt) {
        buckets.delete(key);
        purged += 1;
      }
    }

    return purged;
  }

  function size() {
    return buckets.size;
  }

  function clear() {
    buckets.clear();
  }

  return {
    buckets,
    consume,
    purgeExpired,
    size,
    clear,
  };
}
