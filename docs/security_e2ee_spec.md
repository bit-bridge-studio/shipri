# Security & End-to-End Encryption (E2EE) Specification (Shipri)

This document describes the Zero-Knowledge security architecture for Project Shipri. It guarantees that neither the signaling server, internet service providers (ISPs), nor any third-party intermediary can inspect the filenames, file sizes, or binary contents of the files being transferred.

---

## 1. Threat Model & Security Goals

### 1.1. Assumptions & Trust Boundaries
* **Signaling Server**: Deemed **untrusted**. The system must remain secure even if the signaling server is compromised or controlled by an adversary.
* **Network Path**: Deemed **untrusted**. Standard WebRTC uses DTLS-SRTP for transport encryption, but we add an additional layer of application-level E2EE for maximum security.
* **Client Browsers (Host & Receiver)**: Deemed **trusted**. The code executing in both user browsers is assumed to be running in secure, non-compromised sandboxes.

### 1.2. Security Targets
1. **Confidentiality**: Only the Host and the Receiver can decrypt the file.
2. **Integrity**: Any tampering with the ciphertext by a malicious intermediary or network error must be detected instantly, aborting the transfer.
3. **Zero Metadata Leakage**: The signaling server must not see the file name, file type, or size.

---

## 2. Key Generation & Distribution (URL Fragment Method)

The fundamental pillar of Shipri's Zero-Knowledge architecture is that the decryption key is **never transmitted to any server**, including our own.

```mermaid
sequenceDiagram
    participant Host as Host (Sender Browser)
    participant Server as Signaling Server
    participant Recv as Receiver Browser

    Note over Host: 1. Generate 256-bit master key in RAM<br/>2. Create Room via WebSocket
    Host->>Server: room:create
    Server-->>Host: room:created (roomId: ship-83a1)
    Note over Host: 3. Format URL with Key in Hash:<br/>shipri.app/room/ship-83a1#key=ABC...
    Note over Host: 4. Share link via secure channel (IM/QR)
    Host->>Recv: Share link (including URL #Hash)
    Note over Recv: 5. Extract Key from window.location.hash<br/>(Hash is never sent to Server)
    Recv->>Server: room:join (roomId: ship-83a1)
    Server-->>Host: peer:joined
```

### 2.1. Master Key Generation
The Host generates a cryptographically secure, random 256-bit master secret using the Web Crypto API:
```javascript
const masterKeyBytes = crypto.getRandomValues(new Uint8Array(32));
const keyStringBase64 = btoa(String.fromCharCode(...masterKeyBytes))
  .replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, ""); // URL-safe Base64
```

The URL fragment carries only this random master secret. Runtime encryption keys are derived from it after import.

### 2.2. Key Derivation
Shipri derives separate AES-GCM keys for independent encryption domains:

1. `shipri-metadata-v1`: encrypts metadata and control-plane file proposals.
2. `shipri-file-chunks-v1`: encrypts binary file chunks.

The derivation uses Web Crypto HKDF with SHA-256, a per-room salt derived from `roomId`, and a domain-specific `info` value:

```javascript
const hkdfKey = await crypto.subtle.importKey(
  "raw",
  masterKeyBytes,
  "HKDF",
  false,
  ["deriveKey"]
);

async function deriveAesGcmKey(infoLabel, roomId) {
  const encoder = new TextEncoder();
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: encoder.encode(`shipri:${roomId}`),
      info: encoder.encode(infoLabel),
    },
    hkdfKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}
```

### 2.3. URL Hash Anchor (`#`)
The key is appended to the room URL as a fragment identifier:
`https://shipri.app/room/ship-83a1#key=url_safe_base64_key`

* **Why this is secure**: According to RFC 3986, the fragment identifier (everything after `#`) is processed strictly client-side by the browser. It is **never** sent to the server in HTTP requests or WebSocket handshake headers.
* **Required cleanup**: After extracting the key, the receiver must remove the fragment from the visible address bar with `window.history.replaceState(null, "", window.location.pathname)`.

---

## 3. Metadata Encryption

Since the signaling server must not know what file is being sent, the file metadata block is encrypted before it crosses any network channel.

1. **Structure of Plaintext Metadata**:
   ```json
   {
     "fileName": "project_confidential.pdf",
     "fileSize": 54200102,
     "fileType": "application/pdf",
     "sha256": "optional_streaming_sha256_if_available"
   }
   ```
2. **Encryption**:
   * The metadata is JSON-stringified and encrypted using the `shipri-metadata-v1` AES-GCM key.
   * We use a random 12-byte Initialization Vector (IV) generated with `crypto.getRandomValues`.
3. **Payload Sent to Receiver** (preferred over the P2P control channel after WebRTC connects; allowed through signaling only if encrypted):
   ```json
   {
     "type": "META_ENCRYPTED",
     "payload": {
       "iv": "base64_encoded_12_bytes_iv",
       "ciphertext": "base64_encoded_encrypted_metadata"
     }
   }
   ```
4. **Decryption**: The Receiver extracts the `iv` and `ciphertext`, derives the same metadata key from the URL fragment master key, decrypts it, and recovers the original file metadata to present it in the UI.

The plaintext `META` structure in `p2p_data_protocol_spec.md` is the logical content before encryption. It must not be transmitted as plaintext.

---

## 4. Binary Chunk Encryption (AES-GCM Streaming)

To support arbitrary file sizes, the file is encrypted chunk-by-chunk on the fly. 

* **Algorithm**: **AES-GCM (Galois/Counter Mode)**. This is an Authenticated Encryption with Associated Data (AEAD) algorithm. It provides both encryption (confidentiality) and authentication (integrity) via an authentication tag.
* **Chunk Overhead**: AES-GCM adds a small size overhead per chunk:
  * **16 bytes** for the Authentication Tag (automatically appended by Web Crypto API).
  * The IV is deterministic from the chunk index and is not transmitted per chunk.
  * Total wire overhead per 64KB chunk = **16 bytes**. For a 1GB file (16,384 chunks), the total encryption overhead is **256 KB**, which is negligible.

### 4.1. Nonce/IV Management
To prevent cryptographic attacks, **never reuse an IV with the same key**.
* We use a 12-byte (96-bit) counter initialization vector with the `shipri-file-chunks-v1` key.
* The IV starts at `0` for the first chunk and increments by `1` for each subsequent chunk.
* Because the chunk index is deterministic, the Receiver reconstructs the matching IV based on the index of the chunk it is processing.

```javascript
// Example of creating the IV buffer from a chunk index counter
function getIvForChunk(chunkIndex) {
  const buffer = new ArrayBuffer(12);
  const view = new DataView(buffer);
  // Write the 64-bit integer index into the last 8 bytes of the 12-byte buffer
  // (leaving the first 4 bytes as 0)
  view.setBigUint64(4, BigInt(chunkIndex), false); // Big-endian
  return buffer;
}
```

### 4.2. Encryption Flow (Sender)
```javascript
const iv = getIvForChunk(currentChunkIndex);
const encryptedChunk = await window.crypto.subtle.encrypt(
  {
    name: "AES-GCM",
    iv: iv
  },
  fileChunksKey,
  rawChunkArrayBuffer
);
// Send the encrypted encryptedChunk (which includes the 16-byte auth tag at the end)
binaryChannel.send(encryptedChunk);
```

### 4.3. Decryption Flow (Receiver)
```javascript
const iv = getIvForChunk(expectedChunkIndex);
try {
  const decryptedChunk = await window.crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: iv
    },
    fileChunksKey,
    incomingEncryptedChunk
  );
  
  // Write decryptedChunk to disk
  await writableStream.write(decryptedChunk);
  expectedChunkIndex++;
} catch (error) {
  // Integrity check failed! (e.g. tag mismatch or tampered chunk)
  console.error("Decryption failed! The chunk has been tampered with or corrupted.");
  abortTransfer();
}
```

---

## 5. Summary of Web Crypto API Constraints & Workarounds

1. **Main-Thread Performance**: Encrypting and decrypting blocks of 64KB via the Web Crypto API on the main thread is fast enough for connections up to ~200-300 Mbps. For Gigabit speeds, the main thread can stall, causing UI stuttering.
   * **Mitigation**: Move the encryption (Sender) and decryption (Receiver) loops inside a browser **Web Worker**. Web Workers have full access to `crypto.subtle` and can perform encryption off the main thread, keeping the interface running at 60 FPS.
2. **Secure Contexts Required**: The `crypto.subtle` API is **only** available in Secure Contexts (HTTPS or `localhost`). Shipri cannot run in E2EE mode over plain HTTP.

---

## 6. References

* [MDN Web Crypto API `AesGcmParams`](https://developer.mozilla.org/en-US/docs/Web/API/AesGcmParams): AES-GCM IVs must be unique for every encryption operation with a given key.
* [NIST SP 800-38D](https://nvlpubs.nist.gov/nistpubs/legacy/sp/nistspecialpublication800-38d.pdf): GCM IVs are nonces and 96-bit IVs are the recommended form for interoperability and performance.
