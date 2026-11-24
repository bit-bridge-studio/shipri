import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  DEFAULT_TURN_CREDENTIAL_TTL_SECONDS,
  resolveDevelopmentIceServers,
} from './config.js';

const TURN_USERNAME_PATTERN = /^(\d+):([A-Za-z0-9_-]{1,64})$/;

/**
 * Generates Coturn REST API time-limited HMAC-SHA1 credentials compatible with use-auth-secret.
 */
export function generateTurnCredentials({
  turnSharedSecret,
  ttlSeconds = DEFAULT_TURN_CREDENTIAL_TTL_SECONDS,
  now = () => Date.now(),
  randomBytesFn = randomBytes,
}) {
  if (
    typeof turnSharedSecret !== 'string' ||
    turnSharedSecret.trim().length === 0
  ) {
    throw new Error('TURN shared secret is required to generate credentials.');
  }

  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > 86_400) {
    throw new Error('TURN credential TTL must be an integer between 60 and 86400 seconds.');
  }

  const expiresAt = Math.floor(now() / 1000) + ttlSeconds;
  const opaqueTag = randomBytesFn(8).toString('hex');
  const username = `${expiresAt}:${opaqueTag}`;
  const credential = createHmac('sha1', turnSharedSecret)
    .update(username)
    .digest('base64');

  return {
    username,
    credential,
    expiresAt,
  };
}

/**
 * Verifies a Coturn REST HMAC-SHA1 credential and enforces timestamp expiry in constant time.
 */
export function verifyTurnCredential({
  username,
  credential,
  turnSharedSecret,
  now = () => Date.now(),
}) {
  if (
    typeof username !== 'string' ||
    typeof credential !== 'string' ||
    typeof turnSharedSecret !== 'string' ||
    turnSharedSecret.trim().length === 0
  ) {
    return false;
  }

  const match = TURN_USERNAME_PATTERN.exec(username);
  if (!match) {
    return false;
  }

  const expiresAt = Number.parseInt(match[1], 10);
  const currentEpoch = Math.floor(now() / 1000);
  if (!Number.isSafeInteger(expiresAt) || currentEpoch >= expiresAt) {
    return false;
  }

  const expected = createHmac('sha1', turnSharedSecret)
    .update(username)
    .digest('base64');
  const expectedBuf = Buffer.from(expected, 'utf8');
  const actualBuf = Buffer.from(credential, 'utf8');

  if (expectedBuf.length !== actualBuf.length) {
    return false;
  }

  return timingSafeEqual(expectedBuf, actualBuf);
}

/**
 * Resolves STUN and optional/required time-limited TURN RTCIceServer entries.
 * Fails closed ({ ok: false }) without leaking secrets if required TURN config is incomplete.
 */
export function resolveIceServers({
  stunUrls,
  turnUrls = [],
  turnSharedSecret = null,
  turnCredentialTtlSeconds = DEFAULT_TURN_CREDENTIAL_TTL_SECONDS,
  requireTurn = false,
  now = () => Date.now(),
  randomBytesFn = randomBytes,
}) {
  const stunResult = resolveDevelopmentIceServers(stunUrls);
  if (!stunResult.ok) {
    return { ok: false };
  }

  const hasTurnUrls = Array.isArray(turnUrls) && turnUrls.length > 0;
  const hasTurnSecret =
    typeof turnSharedSecret === 'string' && turnSharedSecret.trim().length > 0;

  if (requireTurn && (!hasTurnUrls || !hasTurnSecret)) {
    return { ok: false };
  }

  if (hasTurnUrls && !hasTurnSecret) {
    return { ok: false };
  }

  const iceServers = [...stunResult.iceServers];

  if (hasTurnUrls && hasTurnSecret) {
    try {
      const { username, credential } = generateTurnCredentials({
        turnSharedSecret,
        ttlSeconds: turnCredentialTtlSeconds,
        now,
        randomBytesFn,
      });

      iceServers.push({
        urls: [...turnUrls],
        username,
        credential,
      });
    } catch {
      return { ok: false };
    }
  }

  return {
    ok: true,
    iceServers,
  };
}
