# P2P File Board & Transfer Protocol Specification (Shipri)

Shipri rooms expose a shared, encrypted file board between two equal peers. Each peer may advertise local files. A file remains on its owner's device and is transferred only when the remote peer clicks it, chooses a persistence target, and sends a download request.

The signaling backend never receives this protocol.

---

## 1. Core Model

* **Peer**: either connected room member.
* **File owner**: the peer that selected a local file and advertised it.
* **Downloader**: the remote peer requesting and saving that file.
* **File advertisement**: encrypted metadata representing an available local file.
* **Transfer session**: one requested download identified independently from the file advertisement.

A peer may be an owner for one transfer and a downloader for another at the same time. The MVP supports multiple advertised files and one active transfer per direction, allowing simultaneous bidirectional transfers.

---

## 2. Data Channels

### `shipri-control`

Reliable ordered JSON messages for board synchronization and transfer control.

### `shipri-binary`

Reliable ordered binary frames. Every frame includes a validated header containing `transferId`, `fileId`, `epoch`, and `chunkIndex`, followed by encrypted chunk bytes.

---

## 3. Encrypted File Board

The board is reconstructed peer-to-peer after the data channels open.

### Advertise or update a local file

```json
{
  "type": "FILE_ADVERTISE",
  "payload": {
    "fileId": "opaque-file-id",
    "encryptedMetadata": {
      "iv": "base64url",
      "ciphertext": "base64url"
    }
  }
}
```

The encrypted metadata contains filename, size, MIME type, chunk size, total chunks, and optional checksum. `fileId` is an opaque random identifier and does not expose metadata.

### Remove a local file

```json
{
  "type": "FILE_REMOVE",
  "payload": {
    "fileId": "opaque-file-id"
  }
}
```

Advertisements owned by a disconnected peer are marked unavailable and removed after the documented reconnect window.

---

## 4. Download Request Lifecycle

Clicking a remote file does not immediately start network transfer.

1. The downloader checks browser capability and opens the supported save dialog or persistence path.
2. After persistence is ready, the downloader creates a random `transferId` and sends:

```json
{
  "type": "DOWNLOAD_REQUEST",
  "payload": {
    "transferId": "opaque-transfer-id",
    "fileId": "opaque-file-id"
  }
}
```

3. The owner verifies that the file is still available and replies with `DOWNLOAD_ACCEPTED` or `DOWNLOAD_REJECTED`.
4. Only an accepted request starts encrypted chunk streaming.
5. `TRANSFER_PAUSE`, `TRANSFER_RESUME`, `TRANSFER_CANCEL`, `TRANSFER_COMPLETE`, `TRANSFER_ERROR`, `FLOW_PAUSE`, `FLOW_RESUME`, and `RESUME_REQUEST` always include `transferId`.

The owner may remove an advertisement before a request starts. Removing it during an active transfer does not implicitly cancel that transfer.

---

## 5. Bounded-Memory Transfer

### Owner-side backpressure

* Read the local file sequentially with `Blob.slice()`.
* Encrypt only bounded chunks.
* Stop reading when `RTCDataChannel.bufferedAmount` exceeds the high-water mark.
* Resume only after `bufferedamountlow`.

### Downloader-side backpressure

An async `onmessage` handler alone does not provide backpressure. The downloader must:

* keep a bounded decrypt/write queue measured in bytes;
* send `FLOW_PAUSE` before the queue exceeds its high-water mark;
* send `FLOW_RESUME` after it drains below its low-water mark;
* reject frames with unknown transfer IDs, invalid sequencing, or unsafe queue growth.

### Persistence

1. Primary: File System Access API direct writes.
2. Secondary: verified Service Worker streaming.
3. Fallback: explicitly size-limited IndexedDB buffering.

The UI must disclose limits before the download request is sent.

---

## 6. Resume and Integrity

* AES-GCM authenticates every chunk.
* Binary frame identity prevents chunks from being applied to the wrong transfer.
* The downloader acknowledges only fully persisted chunks.
* `RESUME_REQUEST` includes `transferId`, last persisted chunk, and the next transfer epoch.
* Reusing a chunk index requires a newly derived epoch key.
* Stale, forged, duplicate, or cross-transfer messages fail closed.

---

## 7. Failure Rules

* If an owner disconnects, its files become unavailable and active outgoing transfers pause for the reconnect window.
* If a downloader cancels a save dialog, no `DOWNLOAD_REQUEST` is sent.
* If a local file changes or becomes unreadable, the owner sends `TRANSFER_ERROR`.
* Cancellation affects only the referenced transfer session.
* Board advertisements, progress, and control messages never pass through Socket.IO.
