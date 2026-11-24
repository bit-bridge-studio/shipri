export const ROOM_AUTH_HKDF_SALT = 'shipri-room-auth-salt-v1';
export const ROOM_AUTH_HKDF_INFO = 'shipri-room-auth-v1';

function encodeBase64Url(bytes) {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index]);
  }
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

/**
 * Derives HKDF-SHA256 roomAuthToken and SHA-256 authVerifier from a 32-byte master secret.
 */
export async function deriveRoomAuthCredentials(masterSecretBytes) {
  if (
    !(masterSecretBytes instanceof Uint8Array) ||
    masterSecretBytes.byteLength !== 32
  ) {
    throw new TypeError('Expected a 32-byte Uint8Array master secret.');
  }

  const encoder = new TextEncoder();
  const baseKey = await globalThis.crypto.subtle.importKey(
    'raw',
    masterSecretBytes,
    'HKDF',
    false,
    ['deriveBits'],
  );

  const derivedBits = await globalThis.crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: encoder.encode(ROOM_AUTH_HKDF_SALT),
      info: encoder.encode(ROOM_AUTH_HKDF_INFO),
    },
    baseKey,
    256,
  );

  const authToken = encodeBase64Url(new Uint8Array(derivedBits));
  const verifierBuffer = await globalThis.crypto.subtle.digest(
    'SHA-256',
    encoder.encode(authToken),
  );
  const authVerifier = encodeBase64Url(new Uint8Array(verifierBuffer));

  return { authToken, authVerifier };
}

/**
 * Generates an ephemeral prototype-only 256-bit secret and derives its room authorization pair.
 */
export async function generatePrototypeRoomAuth() {
  const randomSecret = new Uint8Array(32);
  globalThis.crypto.getRandomValues(randomSecret);
  return deriveRoomAuthCredentials(randomSecret);
}
