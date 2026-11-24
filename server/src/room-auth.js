import { createHash, hkdfSync, timingSafeEqual } from 'node:crypto';

export const ROOM_AUTH_HKDF_SALT = 'shipri-room-auth-salt-v1';
export const ROOM_AUTH_HKDF_INFO = 'shipri-room-auth-v1';
export const AUTH_VERIFIER_PATTERN = /^[A-Za-z0-9_-]{43}$/;
export const MAX_AUTH_TOKEN_LENGTH = 256;

/**
 * Decodes an unpadded 43-character base64url SHA-256 authVerifier into a 32-byte Buffer.
 */
export function decodeAuthVerifier(value) {
  if (typeof value !== 'string' || !AUTH_VERIFIER_PATTERN.test(value)) {
    return null;
  }

  const decoded = Buffer.from(value, 'base64url');
  if (decoded.length !== 32 || decoded.toString('base64url') !== value) {
    return null;
  }

  return decoded;
}

/**
 * Checks whether a value is a valid 43-character unpadded base64url SHA-256 verifier.
 */
export function isValidAuthVerifier(value) {
  return decodeAuthVerifier(value) !== null;
}

/**
 * Checks whether a room:join authToken is a non-empty string within protocol length limits.
 */
export function isValidAuthToken(value) {
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= MAX_AUTH_TOKEN_LENGTH
  );
}

/**
 * Computes the 32-byte SHA-256 digest of a UTF-8 authToken.
 */
export function hashAuthToken(authToken) {
  return createHash('sha256').update(authToken, 'utf8').digest();
}

/**
 * Encodes the SHA-256 digest of a UTF-8 authToken as a 43-character unpadded base64url string.
 */
export function createAuthVerifierFromToken(authToken) {
  return hashAuthToken(authToken).toString('base64url');
}

/**
 * Verifies an incoming authToken against a stored 32-byte SHA-256 authVerifierHash in constant time.
 */
export function verifyAuthToken(authToken, authVerifierHash) {
  if (
    !isValidAuthToken(authToken) ||
    !Buffer.isBuffer(authVerifierHash) ||
    authVerifierHash.length !== 32
  ) {
    return false;
  }

  const candidateHash = hashAuthToken(authToken);
  return timingSafeEqual(candidateHash, authVerifierHash);
}

/**
 * Derives an HKDF-SHA256 room authorization token and SHA-256 verifier from a 32-byte master secret.
 */
export function deriveRoomAuthFromMasterSecret(masterSecretBytes) {
  if (
    !(masterSecretBytes instanceof Uint8Array) ||
    masterSecretBytes.byteLength !== 32
  ) {
    throw new TypeError('Expected a 32-byte Uint8Array or Buffer master secret.');
  }

  const derivedBits = hkdfSync(
    'sha256',
    masterSecretBytes,
    Buffer.from(ROOM_AUTH_HKDF_SALT, 'utf8'),
    Buffer.from(ROOM_AUTH_HKDF_INFO, 'utf8'),
    32,
  );
  const authToken = Buffer.from(derivedBits).toString('base64url');
  const authVerifier = createAuthVerifierFromToken(authToken);

  return { authToken, authVerifier };
}
