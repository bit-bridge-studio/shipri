const UNPADDED_BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * Returns true if value is a non-empty strict unpadded RFC 4648 base64url string.
 * @param {unknown} value
 */
export function isValidBase64Url(value) {
  if (typeof value !== 'string' || value.length === 0) {
    return false;
  }
  if (!UNPADDED_BASE64URL_PATTERN.test(value)) {
    return false;
  }
  // Base64 strings cannot have length % 4 === 1
  return value.length % 4 !== 1;
}

/**
 * Encodes a Uint8Array into strict unpadded RFC 4648 base64url.
 * @param {Uint8Array} bytes
 */
export function encodeBase64Url(bytes) {
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError('Expected a Uint8Array to encode as base64url.');
  }
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
 * Decodes a strict unpadded RFC 4648 base64url string into a Uint8Array.
 * Rejects standard base64 characters (+, /), padding (=), whitespace, or invalid encodings.
 * @param {string} value
 */
export function decodeBase64Url(value) {
  if (!isValidBase64Url(value)) {
    throw new TypeError('Expected a valid unpadded base64url string.');
  }
  const paddedLength = Math.ceil(value.length / 4) * 4;
  const standardBase64 = value
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(paddedLength, '=');
  const binary = atob(standardBase64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  // Enforce canonical encoding (reject non-zero trailing unused bits)
  if (encodeBase64Url(bytes) !== value) {
    throw new TypeError('Non-canonical base64url encoding.');
  }
  return bytes;
}
