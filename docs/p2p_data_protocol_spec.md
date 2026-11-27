# P2P File Board & Transfer Protocol Specification (Shipri)

This document defines the frozen Part 4 peer-to-peer file board, transfer session, flow-control, binary framing, execution-boundary, and browser-persistence contract (`FF-0`).

Shipri rooms expose a shared, encrypted file board between two equal peers. Each peer may advertise local files. A file remains on its owner's device and is transferred only when the remote peer clicks it, opens a verified persistence target, and sends a download request.

TypeScript notation below is a documentation convention only; the implementation remains JavaScript. All binary-to-text JSON fields use unpadded `base64url` (`RFC 4648` Section 5).

---

## 1. Core Model & Backend Privacy Boundary

* **Peer**: either connected room member, identified across reconnects by a persistent random 16-byte `memberId` (`base64url`). Creator/joiner and `offerer`/`answerer` are signaling-only duties and never imply transfer roles.
* **File owner**: the peer that selected a local `File` handle and advertised it on the shared board.
* **Downloader**: the remote peer requesting and persisting that file to local disk.
* **File advertisement**: encrypted metadata representing an available local file (`fileId`).
* **Transfer session**: one requested download (`transferId`) identified independently from `fileId`.

A peer may be an owner for one transfer and a downloader for another at the same time. The MVP supports multiple advertised files, **at most one active or paused transfer per direction**, and simultaneous opposite-direction transfers.

### 1.1. Explicit Backend Exclusion Boundary
The signaling server (`server/`) and Socket.IO transport strictly handle room authorization, peer membership, ICE credentials, and opaque WebRTC SDP/ICE relay. The backend MUST NEVER receive, store, inspect, or log:
* `#key=` URL fragments, master secrets, or derived E2EE keys;
* shared file-board snapshots, `FILE_ADVERTISE`, `FILE_REMOVE`, or `BOARD_SYNC` messages;
* plaintext filenames, file sizes, MIME types, or file checksums;
* `DOWNLOAD_REQUEST`, `DOWNLOAD_ACCEPTED`, `DOWNLOAD_REJECTED`, `FLOW_CREDIT`, pause/resume/cancel control messages, or transfer progress;
* encrypted or plaintext binary file chunks.

---

## 2. Data Channels & Cross-Channel Ordering Rule

The `offerer` creates two reliable ordered `RTCDataChannel` instances during WebRTC negotiation and the `answerer` accepts both via `ondatachannel`:

| Channel Label | Reliability / Order | Wire Format | Purpose |
| :--- | :--- | :--- | :--- |
| `shipri-control` | Reliable, ordered (`ordered: true`) | UTF-8 JSON `ControlEnvelope` (`shipri-control-v1` AES-256-GCM AEAD) | Peer identity handshake, encrypted file board sync, download negotiation, cumulative `FLOW_CREDIT`, user pause/resume, cancel, completion, errors, and epoch resume. |
| `shipri-binary` | Reliable, ordered (`ordered: true`, `binaryType = "arraybuffer"`) | 52-byte deterministic binary header (AAD) + AES-256-GCM ciphertext + 16-byte tag (`client/src/crypto/binary-framing.js`) | Sequential encrypted file chunk streaming for active transfers. |

### 2.1. No Cross-Channel Ordering Assumption
While each individual SCTP channel (`shipri-control` and `shipri-binary`) delivers its own messages in order, **relative ordering between `shipri-control` and `shipri-binary` is NEVER assumed**. Implementations MUST enforce these fail-safe rules:
* **Late frames after cancel/error/epoch rotation**: Any binary frame whose `transferId` is already `cancelled`, `failed`, `completed`, unknown, or whose `epoch` is less than the active epoch is silently dropped (after cancel/epoch bump) or fails closed without writing to disk.
* **Over-credit or premature binary frames**: A binary frame arriving before `DOWNLOAD_ACCEPTED` and initial `FLOW_CREDIT`, or whose ending plaintext offset exceeds the downloader's granted `maxPlaintextOffsetExclusive`, immediately aborts the affected transfer (`TRANSFER_ERROR` `code: "FLOW_CREDIT_EXCEEDED"`) without mutating any other transfer.
* **Stale/reordered control messages**: `FLOW_CREDIT`, `TRANSFER_PAUSE`, `TRANSFER_RESUME`, `TRANSFER_CANCEL`, and `RESUME_*` messages bound to stale epochs, unknown transfer IDs, or non-increasing `sequence` values fail safely as no-ops or explicit rejections without expanding sender credit windows.

---

## 3. State Machines & Concurrency Rules

### 3.1. Room Membership State Machine
| State | Description | Valid Transitions |
| :--- | :--- | :--- |
| `unaffiliated` | Not joined to any room | `room:created` -> `waiting_for_peer`; `room:joined` -> `connected` |
| `waiting_for_peer` | Alone in room; local file board usable | `peer:joined` -> `connected`; `room:leave` / terminal `room:error` -> `unaffiliated` |
| `connected` | Both peers present; `shipri-control` & `shipri-binary` negotiated | `peer:left` -> `reconnecting` (with grace timer); local `room:leave` -> `unaffiliated` |
| `reconnecting` | Remote peer departed or socket temporarily dropped | Replacement `peer:joined` + channels open -> `connected`; grace timeout (`60000ms`) -> `waiting_for_peer`; local `room:leave` -> `unaffiliated` |

### 3.2. Board Synchronization & File Availability State Machine
* **Board Sync States**: `empty` -> `syncing` (upon `shipri-control` open, both peers exchange `PEER_HELLO` and `BOARD_SYNC` snapshot) -> `synced`; on `peer:left` -> `peer_disconnected_grace` (60s reconnect window, `RECONNECT_BOARD_GRACE_MS = 60000`).
* **Per-File Availability States**:
  * Local file: `available` (selectable and advertised) -> `removed` (user removes advertisement; sends `FILE_REMOVE`; does NOT implicitly cancel active transfers).
  * Remote file: `available` (decrypted and downloadable) -> `unavailable_reconnecting` (remote owner disconnected; download button disabled during 60s grace window) -> restored to `available` if present in post-reconnect `BOARD_SYNC`, or `removed` when owner sends `FILE_REMOVE` or grace window expires.
* **Implementation Modules (`FF-3`)**: `client/src/board/local-board.js` (`createLocalFileBoard`) manages owner-only `File` handles and encrypted `FILE_ADVERTISE`/`BOARD_SYNC`/`FILE_REMOVE` emission, and `client/src/board/remote-board.js` (`createRemoteFileBoard`, `RECONNECT_BOARD_GRACE_MS = 60000`) decrypts peer advertisements into read-only entries and enforces the reconnect grace expiry state machine.

### 3.3. Independent Transfer Session State Machine
Each `transferId` tracks its own state independently of `fileId` and independently of any transfer in the opposite direction:

| State | Owner / Downloader Meaning |
| :--- | :--- |
| `preparing_persistence` | Downloader-only: synchronous `showSaveFilePicker()` + writable stream open before any `DOWNLOAD_REQUEST` is sent. Cancelling returns to idle with zero network messages. |
| `requesting` | Downloader sent `DOWNLOAD_REQUEST`, awaiting `DOWNLOAD_ACCEPTED` or `DOWNLOAD_REJECTED`. |
| `active` | Streaming encrypted chunks governed by cumulative `FLOW_CREDIT` and `bufferedAmount` watermarks. |
| `paused_by_user` | Paused by explicit `TRANSFER_PAUSE` from either peer; resumes only on `TRANSFER_RESUME` (independent of `FLOW_CREDIT`). |
| `paused_reconnecting` | Connection dropped during an active or user-paused transfer; eligible for `RESUME_REQUEST` with epoch rotation within grace window. |
| `resuming` | Negotiating `RESUME_REQUEST` / `RESUME_ACCEPTED` (`newEpoch = epoch + 1`, verified `lastPersistedChunkIndex`). |
| `completed` | All chunks decrypted, written, flushed, and file handle closed (`TRANSFER_COMPLETE`). Terminal. |
| `cancelled` | Explicitly cancelled via `TRANSFER_CANCEL`; partial persistence target aborted/closed. Terminal. |
| `failed` | Cryptographic verification failure, unreadable local file, disk write/quota error, or over-credit violation (`TRANSFER_ERROR`). Terminal. |
| `rejected` | Owner returned `DOWNLOAD_REJECTED` (`NOT_FOUND`, `UNAVAILABLE`, `BUSY`, `INVALID_REQUEST`, `LIMIT_EXCEEDED`). Terminal. |

### 3.4. Explicit Single-Transfer-Per-Direction Concurrency Rule
The MVP allows **one active or paused transfer per direction** (`ownerMemberId -> downloaderMemberId`):
1. While a direction has an existing transfer in `requesting`, `active`, `paused_by_user`, `paused_reconnecting`, or `resuming`, the **owner MUST deterministically reject** any second `DOWNLOAD_REQUEST` for that direction with `DOWNLOAD_REJECTED { transferId, fileId, reason: "BUSY" }` without disrupting the existing transfer or interleaving uncredited frames.
2. On the downloader side, the UI surfaces that a download from the remote peer is already in progress or paused and disables starting a second concurrent download in that direction until the existing transfer completes or is cancelled, while still allowing the remote peer to simultaneously download a file in the opposite direction.

---

## 4. Authenticated Control Protocol (`shipri-control`)

Every message on `shipri-control` is encrypted in the canonical `ControlEnvelope` (`shipri-control-v1` AEAD) defined in `security_e2ee_spec.md` Section `3.1`:

```typescript
type Base64Url = string; // Unpadded base64url
type MemberId = Base64Url; // 16 random bytes (22 chars)
type FileId = Base64Url; // 16 random bytes (22 chars)
type TransferId = Base64Url; // 16 random bytes (22 chars)
type TransferDirection = `${MemberId}->${MemberId}`; // ownerMemberId->downloaderMemberId

interface ControlEnvelope {
  v: 1;
  senderMemberId: MemberId;
  iv: Base64Url; // 12-byte CSPRNG random IV
  ciphertext: Base64Url; // AES-256-GCM(UTF-8 JSON ControlMessage) + 16-byte tag
}

interface EncryptedMetadataBlob {
  iv: Base64Url; // 12-byte CSPRNG random IV
  ciphertext: Base64Url; // AES-256-GCM(UTF-8 JSON PlaintextFileMetadata) + 16-byte tag
}

type ControlMessage =
  | {
      type: 'PEER_HELLO';
      payload: { memberId: MemberId; protocolVersion: 1 };
    }
  | {
      type: 'BOARD_SYNC';
      payload: {
        files: Array<{
          fileId: FileId;
          encryptedMetadata: EncryptedMetadataBlob;
        }>;
      };
    }
  | {
      type: 'FILE_ADVERTISE';
      payload: {
        fileId: FileId;
        encryptedMetadata: EncryptedMetadataBlob;
      };
    }
  | {
      type: 'FILE_REMOVE';
      payload: { fileId: FileId };
    }
  | {
      type: 'DOWNLOAD_REQUEST';
      payload: {
        transferId: TransferId;
        fileId: FileId;
        direction: TransferDirection;
        initialEpoch: 1;
      };
    }
  | {
      type: 'DOWNLOAD_ACCEPTED';
      payload: {
        transferId: TransferId;
        fileId: FileId;
        direction: TransferDirection;
        epoch: 1;
        chunkSize: 65536;
        totalChunks: number;
        fileSize: number;
      };
    }
  | {
      type: 'DOWNLOAD_REJECTED';
      payload: {
        transferId: TransferId;
        fileId: FileId;
        reason:
          | 'NOT_FOUND'
          | 'UNAVAILABLE'
          | 'BUSY'
          | 'INVALID_REQUEST'
          | 'LIMIT_EXCEEDED';
      };
    }
  | {
      type: 'FLOW_CREDIT';
      payload: {
        transferId: TransferId;
        fileId: FileId;
        direction: TransferDirection;
        epoch: number; // uint32 >= 1
        sequence: number; // Strictly monotonic per (transferId, epoch), starts at 1
        maxPlaintextOffsetExclusive: number; // Cumulative plaintext byte offset limit
      };
    }
  | {
      type: 'TRANSFER_PAUSE';
      payload: { transferId: TransferId; direction: TransferDirection; epoch: number };
    }
  | {
      type: 'TRANSFER_RESUME';
      payload: { transferId: TransferId; direction: TransferDirection; epoch: number };
    }
  | {
      type: 'TRANSFER_CANCEL';
      payload: {
        transferId: TransferId;
        direction: TransferDirection;
        reason?: 'USER_CANCELLED' | 'PERSISTENCE_CLOSED';
      };
    }
  | {
      type: 'TRANSFER_COMPLETE';
      payload: {
        transferId: TransferId;
        fileId: FileId;
        direction: TransferDirection;
        epoch: number;
        totalPersistedBytes: number;
      };
    }
  | {
      type: 'TRANSFER_ERROR';
      payload: {
        transferId: TransferId;
        direction: TransferDirection;
        code:
          | 'AUTH_FAILED'
          | 'FLOW_CREDIT_EXCEEDED'
          | 'INVALID_FRAME'
          | 'FILE_UNREADABLE'
          | 'PERSISTENCE_FAILED'
          | 'QUOTA_EXCEEDED'
          | 'EPOCH_MISMATCH'
          | 'INTERNAL_ERROR';
      };
    }
  | {
      type: 'RESUME_REQUEST';
      payload: {
        transferId: TransferId;
        fileId: FileId;
        direction: TransferDirection;
        nextEpoch: number; // Strictly greater than last completed/active epoch
        lastPersistedChunkIndex: number; // -1 if zero chunks persisted
        persistedPlaintextBytes: number;
      };
    }
  | {
      type: 'RESUME_ACCEPTED';
      payload: {
        transferId: TransferId;
        fileId: FileId;
        direction: TransferDirection;
        epoch: number; // Matches nextEpoch
        resumeFromChunkIndex: number; // lastPersistedChunkIndex + 1
      };
    }
  | {
      type: 'RESUME_REJECTED';
      payload: {
        transferId: TransferId;
        fileId: FileId;
        reason: 'NOT_FOUND' | 'FILE_CHANGED' | 'INVALID_EPOCH' | 'BUSY';
      };
    };
```

> [!NOTE]
> `FLOW_PAUSE` and `FLOW_RESUME` are permanently removed from the protocol and replaced by cumulative `FLOW_CREDIT`. User-initiated `TRANSFER_PAUSE` and `TRANSFER_RESUME` remain independent controls. The authenticated `ControlEnvelope` codec and `FLOW_CREDIT` monotonic sequence tracker are implemented in `client/src/crypto/control-codec.js`.

---

## 5. Bounded-Memory Flow Control & Numeric Limits

Both owner-side transport backpressure and downloader-side cumulative credit are enforced **independently**:

| Constant | Frozen MVP Value | Purpose |
| :--- | :--- | :--- |
| `CHUNK_SIZE_BYTES` | `65536` (64 KiB) | Plaintext chunk size per binary frame (final chunk `<= 65536` bytes). |
| `OWNER_CHANNEL_HIGH_WATER_MARK_BYTES` | `1048576` (1 MiB) | Owner pauses reading/sending when `binaryChannel.bufferedAmount >= 1 MiB`. |
| `OWNER_CHANNEL_LOW_WATER_MARK_BYTES` | `262144` (256 KiB) | Owner sets `binaryChannel.bufferedAmountLowThreshold = 256 KiB` and resumes on `bufferedamountlow`. |
| `RECEIVER_INITIAL_CREDIT_WINDOW_BYTES` | `2097152` (2 MiB) | Initial `FLOW_CREDIT.maxPlaintextOffsetExclusive` granted ONLY after persistence target is open and `DOWNLOAD_ACCEPTED` is received. |
| `MAX_IN_FLIGHT_BYTES` | `2097152` (2 MiB) | Invariant: `maxPlaintextOffsetExclusive - lastPersistedPlaintextOffset <= 2 MiB`. |
| `RECEIVER_CREDIT_GRANT_STEP_BYTES` | `524288` (512 KiB) | Minimum persisted progress delta before emitting the next cumulative `FLOW_CREDIT` (or immediately when remaining credit drops below 50%). |
| `RECEIVER_MAX_QUEUED_BYTES` | `4194304` (4 MiB) | Hard upper bound on queued unpersisted plaintext/ciphertext bytes per receive direction; exceeding fails closed with `FLOW_CREDIT_EXCEEDED`. |
| `RECONNECT_BOARD_GRACE_MS` | `60000` (60 s) | Time window to retain unavailable remote board entries and paused-reconnecting transfers after `peer:left`. |

### 5.1. Credit Accounting Rules
1. **Owner Gate**: The owner may encrypt and send chunk `i` (with ending plaintext offset `chunkEndOffset = i * CHUNK_SIZE_BYTES + plaintextLength`) ONLY when:
   * transfer state is `active` (not `paused_by_user`);
   * `chunkEndOffset <= latestValidMaxPlaintextOffsetExclusive`; and
   * `binaryChannel.bufferedAmount < OWNER_CHANNEL_HIGH_WATER_MARK_BYTES`.
2. **Downloader Monotonicity**: Each `FLOW_CREDIT` binds to `(transferId, fileId, direction, epoch)` and carries a strictly increasing `sequence` (`1, 2, 3, ...`). The owner MUST ignore any `FLOW_CREDIT` whose `transferId`, `fileId`, `direction`, or `epoch` does not match the active transfer, whose `sequence <= lastAcceptedSequence`, or whose `maxPlaintextOffsetExclusive <= currentCreditLimit`. Duplicate, stale, or reordered credit messages NEVER expand the sender window.
3. **Zero-Byte Files**: For `fileSize === 0` (`totalChunks === 0`), once `DOWNLOAD_ACCEPTED` is received and the empty file handle is opened and closed, the downloader immediately emits `TRANSFER_COMPLETE { totalPersistedBytes: 0 }` with zero binary chunks needed.
4. **Implementation Modules**: Owner-side bounded chunk slicing and `bufferedAmount` watermark backpressure are implemented in `client/src/transfer/owner-streamer.js`, and downloader-side bounded decrypt/write queueing, `FLOW_CREDIT` issuance, and File System Access API target management are implemented in `client/src/transfer/downloader-receiver.js`.

---

## 6. Resume & Cryptographic Epoch Rotation

1. On reconnect (`shipri-control` re-opens after `peer:left` within `RECONNECT_BOARD_GRACE_MS` = `60_000ms`), peers first exchange `PEER_HELLO` and `BOARD_SYNC` to reconcile remote file availability. Automatic ICE/peer recovery is bounded by `client/src/webrtc/reconnect-supervisor.js` (`MAX_RECONNECT_ATTEMPTS = 3`, exponential backoff `1_000ms` to `8_000ms`, overall grace timeout `60_000ms`), while `client/src/webrtc/room-connection.js` disposes prior data channels, timers, and listeners and gates inbound messages by negotiation generation.
2. For an eligible `paused_reconnecting` transfer, the downloader (`client/src/transfer/transfer-coordinator.js` and `client/src/transfer/downloader-receiver.js`) sends `RESUME_REQUEST` specifying `transferId`, `fileId`, `direction`, `nextEpoch = previousEpoch + 1`, `lastPersistedChunkIndex`, and `persistedPlaintextBytes`.
3. The owner (`client/src/transfer/transfer-coordinator.js` and `client/src/transfer/owner-streamer.js`) verifies the local file still exists with unchanged `fileSize` (and `lastModified` / fingerprint) and that `nextEpoch > previousEpoch`, derives the new HKDF key for `nextEpoch`, and replies with `RESUME_ACCEPTED { epoch: nextEpoch, resumeFromChunkIndex: lastPersistedChunkIndex + 1 }`. Stale `nextEpoch` or modified local files fail with `RESUME_REJECTED` (`INVALID_EPOCH` without aborting newer epochs, or `FILE_CHANGED` terminal failure).
4. The downloader rotates its chunk decryption key to `nextEpoch`, resets its `FLOW_CREDIT` `sequence` counter to `1` for the new epoch, and sends a fresh `FLOW_CREDIT` bound to `nextEpoch` anchored at `persistedPlaintextBytes + RECEIVER_INITIAL_CREDIT_WINDOW_BYTES`.
5. Any leftover binary frame tagged with `epoch < nextEpoch` is dropped safely, while out-of-order or duplicate chunk frames within the active epoch fail closed with `INVALID_FRAME`.

---

## 7. Browser Execution Model & Worker Boundaries

### 7.1. Thread & Module Ownership
| Component | Execution Context | Responsibility |
| :--- | :--- | :--- |
| Socket.IO signaling (`client/src/signaling/socket-client.js`) | Main Thread | Room auth, membership, ICE retrieval, SDP/trickle ICE relay. |
| `RTCPeerConnection` & negotiation lifecycle | Main Thread (Required) | Window API ownership, ICE state, selected-path stats, channel creation. |
| `RTCDataChannel` (`shipri-control`, `shipri-binary`) | Main Thread (Compatibility Baseline) | Tested default transport path; forwards binary `ArrayBuffer`s to/from crypto worker via transfer lists. |
| Encryption / Decryption & Binary Framing Worker | Dedicated Web Worker (`client/src/workers/chunk-crypto.worker.js`, `chunk-worker-client.js`) | `Blob.slice()`, HKDF/AES-GCM encrypt & decrypt, 52-byte header encode/validate, zero-copy buffer handoff. |
| File Persistence (`FileSystemWritableFileStream`) | Main Thread (MVP) or Worker where verified | Sequential chunk writes, `close()` on completion, `abort()` on cancel/failure. |

### 7.2. Transferable `ArrayBuffer` Ownership & Optional Worker `RTCDataChannel`
* **Zero-Copy Handoffs**: Every chunk payload crossing between the main thread and the crypto/framing worker MUST be transferred via `postMessage(message, [buffer])`. Once transferred, the sender's `ArrayBuffer` is detached (`byteLength === 0`) and never retained, keeping memory usage strictly bounded under `RECEIVER_MAX_QUEUED_BYTES`.
* **Main-Thread `RTCDataChannel` Compatibility Baseline**: All automated unit tests and MVP browser flows MUST pass with `RTCDataChannel` owned on the main thread and crypto/framing offloaded to a Web Worker (with a synchronous/async fallback harness for Node/Vitest unit tests).
* **Worker-Owned `RTCDataChannel` (Optional Optimization)**: Transferring `RTCDataChannel` into a dedicated worker is explicitly treated as an optional future optimization and MUST NOT be enabled by default until the supported browser compatibility matrix verifies it end-to-end.

---

## 8. Browser Persistence & MVP Support Limits

1. **Verified MVP Persistence Path**: File System Access API (`window.showSaveFilePicker()` + `FileSystemWritableFileStream`) direct-to-disk sequential writes, evaluated by `client/src/persistence/capability-limits.js` (`detectBrowserPersistenceProfile`, `evaluateFilePersistenceEligibility`) and invoked via `client/src/persistence/file-persistence.js`.
2. **Protocol & Storage Limits**: The binary chunk header defines a `uint32` `chunkIndex` over fixed `65_536`-byte chunks, bounding addressable protocol file transfers at `PROTOCOL_MAX_CHUNKS = 0x100000000` (`4_294_967_296` chunks = `PROTOCOL_MAX_FILE_SIZE_BYTES = 281_474_976_710_656` bytes = `256 TiB`). Before opening `showSaveFilePicker()` or emitting `DOWNLOAD_REQUEST`, `download-negotiator.js` checks both this protocol cap and cached `navigator.storage.estimate().availableBytes` hints, returning `LIMIT_EXCEEDED` with guidance when exceeded.
3. **Synchronous User Activation Rule**: Browser capability (`Boolean(window.isSecureContext) && typeof window.showSaveFilePicker === 'function'`) and optional `navigator.storage.estimate()` hints MUST be evaluated when remote `FILE_ADVERTISE` entries arrive on the board, NEVER asynchronously inside the click handler prior to opening the save dialog. Clicking `Download` invokes `window.showSaveFilePicker()` synchronously inside the user gesture before awaiting persistence setup or sending `DOWNLOAD_REQUEST`.
4. **Supported vs. Unsupported Browsers**: Desktop Chromium browsers (Chrome, Edge, Brave, Opera) over HTTPS or `localhost` satisfy the File System Access MVP path. Browsers lacking `window.showSaveFilePicker()` (Firefox, Safari, mobile WebViews) or non-secure HTTP contexts select the `unsupported` profile (`MISSING_FILE_SYSTEM_ACCESS_API` or `INSECURE_CONTEXT`) and display explicit guidance before any `DOWNLOAD_REQUEST` is emitted.
5. **Deferred Future Extensions**: `DEFERRED_PERSISTENCE_EXTENSIONS` explicitly keeps `serviceWorkerStreaming` (`enabled: false`) and `indexedDbBuffering` (`enabled: false`) disabled (`status: "deferred_future_extension"`); they are not active MVP fallbacks and require separate browser-support approval before implementation.

---

## 9. Failure Rules

* Cancelling the save dialog (`AbortError`) leaves the board untouched and sends zero control messages.
* Removing a local file advertisement (`FILE_REMOVE`) removes it from both boards but does NOT implicitly cancel an already-accepted transfer; active transfers require explicit `TRANSFER_CANCEL`.
* If a local file changes or becomes unreadable during streaming, the owner emits `TRANSFER_ERROR { code: "FILE_UNREADABLE" }` and stops only that transfer.
* If AES-GCM tag verification, header validation, or credit bounds fail on a frame, the downloader aborts the writable stream, emits `TRANSFER_ERROR`, and isolates the failure to that `transferId`.
