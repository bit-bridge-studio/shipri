# UI/UX Screens & Client States Specification (Shipri)

Shipri presents a two-peer room with an encrypted shared file board (`FF-0`). There are no permanent sender and receiver screens. Both connected members are equal peers who may add local files and download remote files independently.

---

## 1. Room Entry & Key Lifecycle

### Create room
The creating peer generates a 256-bit CSPRNG master secret and persistent 16-byte `memberId`, derives the HKDF `shipri-room-auth-v1` `authVerifier`, creates the room via Socket.IO, caches `{ masterKeyBase64Url, memberId }` in tab-scoped `sessionStorage` keyed by `roomId`, displays the shareable URL (`https://shipri.app/room/ship-xxxx#key=...`) plus QR code, and enters the room board immediately.

### Join room
The joining peer opens the shared link, extracts `#key=...` from the URL fragment, immediately strips the fragment from the address bar via `window.history.replaceState(null, '', window.location.pathname)`, caches `{ masterKeyBase64Url, memberId }` in tab-scoped `sessionStorage` for same-tab reload recovery, derives `authToken` via HKDF `shipri-room-auth-v1`, joins via Socket.IO, and enters the same room board.

* Creator and joiner labels and `offerer`/`answerer` negotiation duties are never shown as transfer roles.
* Leaving the room (`room:leave`), resetting the session, or encountering a terminal room error (`ROOM_NOT_FOUND`, `UNAUTHORIZED`, `ROOM_FULL`) immediately clears the room key from memory and `sessionStorage`.
* Missing or malformed `#key=` values show clear recovery guidance without logging the fragment.

---

## 2. Shared File Board

The main screen contains:

* room connection state (`waiting_for_peer`, `connected`, `reconnecting`) and direct vs. relayed (`TURN`) indicator with relay bandwidth notice when relayed;
* copy-link and QR controls (copying the full `#key=` URL on demand without exposing it in the visible address bar);
* a drag-and-drop dropzone and file picker available to either peer at any time;
* cards for local files (`Shared by you`) with `Remove` action;
* cards for decrypted remote files (`Available from peer`) with `Download` action and pre-evaluated browser capability/limit status;
* independent transfer progress rows for outgoing and incoming transfers.

File metadata (`fileName`, `fileSize`, `fileType`) is displayed only after local AES-GCM decryption (`shipri-board-metadata-v1`). A remote file card never implies that the file is uploaded to or stored on the backend server.

---

## 3. Add and Remove Files

When either peer drops or selects one or more local files:

1. local `File` handles stay strictly on the owner's device;
2. encrypted `FILE_ADVERTISE` messages (`base64url` nested `encryptedMetadata` wrapped in `shipri-control-v1` AEAD `ControlEnvelope`) are sent over `shipri-control`;
3. the remote peer decrypts and renders the cards without starting any file transfer.

Removing a local advertisement emits `FILE_REMOVE` and removes the card from both boards. Active transfers continue unless explicitly cancelled via `TRANSFER_CANCEL`.

---

## 4. Download Flow, Concurrency & Browser Capability Limits

### 4.1. Pre-Evaluated Capability & Synchronous Save Dialog
1. When remote `FILE_ADVERTISE` entries arrive, the client pre-evaluates File System Access API support (`typeof window.showSaveFilePicker === 'function'` in a Secure Context) and caches optional `navigator.storage.estimate()` capacity hints on the card state.
2. Unsupported browsers (or non-secure contexts) display explicit capability guidance on the board before any download request can be initiated; Service Worker streaming and IndexedDB buffering are deferred future extensions and are not promised as active MVP fallbacks.
3. Clicking `Download` invokes `window.showSaveFilePicker()` **synchronously inside the click gesture** before any asynchronous work so transient user activation is preserved.
4. Cancelling the save dialog (`AbortError`) leaves the board unchanged and sends zero network messages.
5. Only after the writable file stream is open does the downloader allocate a random `transferId`, emit `DOWNLOAD_REQUEST`, and wait for `DOWNLOAD_ACCEPTED` before granting initial cumulative `FLOW_CREDIT` (`2 MiB`).

### 4.2. Single-Transfer-Per-Direction Concurrency UX
The MVP permits at most **one active or paused transfer per direction** (`ownerMemberId -> downloaderMemberId`), while allowing simultaneous opposite-direction transfers:
* While an incoming transfer from the remote peer is `requesting`, `active`, `paused_by_user`, `paused_reconnecting`, or `resuming`, clicking `Download` on another remote file is disabled with clear inline guidance (`Finish or cancel the current download before starting another`), and any race-condition `DOWNLOAD_REJECTED` (`reason: "BUSY"`) surfaces non-destructive feedback without interrupting the active transfer.
* Outgoing transfers requested by the remote peer run independently in their own progress row without blocking incoming downloads.

### 4.3. Independent Transfer Progress Rows
Each transfer row is keyed by `transferId` and displays:
* direction (`Downloading` / `Sending`), filename, persisted/sent bytes, throughput, ETA, transfer state (`active`, `paused_by_user`, `paused_reconnecting`, `resuming`, `completed`, `cancelled`, `failed`, `rejected`), and direct/relayed path indicator;
* user-initiated `Pause` / `Resume` (`TRANSFER_PAUSE` / `TRANSFER_RESUME`, completely independent from internal receiver `FLOW_CREDIT` backpressure);
* `Cancel` (`TRANSFER_CANCEL`), affecting only that `transferId` and never removing the board advertisement.

---

## 5. Connection, Reconnection & Failure States

* When alone (`waiting_for_peer`), the room board stays usable for adding local files and displays `Waiting for another peer`.
* When the remote peer disconnects (`peer:left`), remote file cards transition to `unavailable_reconnecting` and active/paused transfers enter `paused_reconnecting` for the 60-second grace window (`RECONNECT_BOARD_GRACE_MS = 60000`).
* Reconnection restores the encrypted board via `PEER_HELLO` + `BOARD_SYNC` and resumes eligible transfers via `RESUME_REQUEST` / `RESUME_ACCEPTED` with cryptographic epoch rotation from the last persisted chunk.
* A failed, rejected, or cancelled transfer isolates its error state strictly to its own progress row.
* Keyboard navigation, visible focus rings, ARIA live status announcements (`role="status"` / `aria-live="polite"`), and responsive mobile/desktop layouts are required for every board and transfer action.
