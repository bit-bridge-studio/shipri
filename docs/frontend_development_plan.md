# Shipri Final Frontend Development Plan

This plan covers Part 4: building the production two-peer file room after backend contracts pass acceptance.

---

## 1. Product Architecture

Both room members are equal peers. Either peer can advertise local files and download remote files. The shared board is synchronized only over the encrypted P2P control channel; advertised files stay on the owner's device until requested.

The MVP supports multiple advertised files, one active transfer per direction, and simultaneous bidirectional transfers.

---

## 2. Entry Criteria

* Backend tests and prototype acceptance scenarios pass.
* Room authorization, signaling, ICE, and deployment contracts are frozen.
* File-board, download-request, binary framing, backpressure, resume, and browser-support contracts are resolved.

---

## 3. Frontend Stages

### FF-0: Freeze Production Architecture

**Status:** Completed (`2026-11-24`) - froze the encrypted peer-room state machines, single-transfer-per-direction concurrency (`BUSY`), canonical `base64url` `FILE_ADVERTISE` and `shipri-control-v1` AEAD `ControlEnvelope` schemas, 52-byte AAD binary frame layout, cumulative `FLOW_CREDIT` numeric limits replacing `FLOW_PAUSE`/`FLOW_RESUME`, main-thread `RTCPeerConnection` + worker crypto/framing transferable `ArrayBuffer` execution model, MVP File System Access persistence boundary, and backend exclusion rules across `security_e2ee_spec.md`, `p2p_data_protocol_spec.md`, `ui_ux_flow_spec.md`, and `testing_strategy.md`.

Define peer-room state, encrypted board synchronization, transfer-session identity, control messages, binary framing, persistence limits, and module boundaries.

#### Frozen Part 4 Client Module Boundaries (`FF-0`)

Prototype-only modules listed in `client/src/prototype/prototype-manifest.js` (`client/src/prototype/*` and the diagnostic prototype `client/src/App.jsx` shell) are excluded from production routes and replaced by isolated production modules:

| Production Module Directory | Execution Context | Responsibility |
| :--- | :--- | :--- |
| `client/src/signaling/` | Main Thread | Reused `socket-client.js` transport wrapper (`room:create`, `room:join`, `room:leave`, `ice:get`, `signal:forward`, sanitized errors) with zero board/file knowledge. |
| `client/src/crypto/` | Main Thread + Worker | URL `#key=` lifecycle (`replaceState` + `sessionStorage[roomId]`), HKDF-SHA256 domain key schedule (`shipri-room-auth-v1`, `shipri-board-metadata-v1`, `shipri-control-v1`, per-transfer-epoch `shipri-file-chunks-v1`), `ControlEnvelope` AEAD codec, and 52-byte binary frame AAD codec. |
| `client/src/webrtc/` | Main Thread | Production `RTCPeerConnection` lifecycle, trickle ICE, generation-scoped cleanup on `peer:left`, `shipri-control` and `shipri-binary` channel ownership (main-thread `RTCDataChannel` compatibility baseline; worker-owned `RTCDataChannel` deferred as optional optimization). |
| `client/src/board/` | Main Thread | Equal-peer local file registry, encrypted `FILE_ADVERTISE`/`FILE_REMOVE`/`BOARD_SYNC` state machine, and 60s disconnect grace window. |
| `client/src/transfer/` | Main Thread + Worker | Independent per-`transferId` state machine, single-transfer-per-direction `BUSY` enforcement, cumulative `FLOW_CREDIT` accounting (`2 MiB` window / `4 MiB` max queue / `64 KiB` chunks), `bufferedAmount` watermarks (`1 MiB` / `256 KiB`), and epoch-rotating resume. |
| `client/src/persistence/` | Main Thread | Pre-evaluated File System Access API capability/estimate checks, synchronous `showSaveFilePicker()` invocation, sequential `FileSystemWritableFileStream` writes, and explicit unsupported-browser guidance. |
| `client/src/workers/` | Dedicated Web Worker | Off-main-thread `Blob.slice()`, AES-GCM chunk encrypt/decrypt, and binary framing/unframing using transferable `ArrayBuffer` zero-copy handoffs. |

### FF-1: Implement Room Key and E2EE Primitives

**Status:** Completed (`2026-11-27`) - implemented production HKDF room authorization (`client/src/crypto/room-auth.js`, `[43]`, `#112`), URL fragment key and tab-scoped `sessionStorage` lifecycle (`client/src/crypto/fragment-key.js`, `[44]`, `#112`), encrypted file-board metadata codec (`client/src/crypto/board-metadata.js`, `[45]`), authenticated `shipri-control-v1` AEAD control codec with monotonic `FLOW_CREDIT` tracker (`client/src/crypto/control-codec.js`, `[46]`), and epoch-safe 52-byte AAD binary chunk framing (`client/src/crypto/binary-framing.js`, `[47]`).

Implement fragment-key lifecycle, domain-separated board metadata encryption, authenticated control messages, and per-transfer epoch chunk encryption.

### FF-2: Implement Production Peer Connection

**Status:** Completed (`2026-11-27`) - extracted reusable production-safe `client/src/webrtc/ice-config.js` and `client/src/webrtc/peer-connection.js` modules (`[42]`, `#113`) isolated from `client/src/prototype/`, and composed them with room key/authorization and `shipri-control-v1` AEAD messaging in `client/src/webrtc/room-connection.js` (`createProductionRoomConnection`, `[48]`) with mutual `PEER_HELLO`, equal-peer control/binary channel initiation, and redacted path/state propagation.

Reuse production-safe signaling and WebRTC modules, enforce room authorization, create control/binary channels, and expose connection and relay state.

### FF-3: Implement Encrypted Shared File Board

**Status:** Completed (`2026-11-27`) - implemented owner-side encrypted local file registry (`client/src/board/local-board.js`, `[49]`) and peer-facing read-only remote board synchronization (`client/src/board/remote-board.js`, `[50]`) with `BOARD_SYNC`/`FILE_ADVERTISE`/`FILE_REMOVE` convergence, browser `File` handle isolation, active-transfer handle retention, and `60000ms` disconnect grace expiry.

Allow either peer to add and remove local file advertisements. Synchronize encrypted advertisements after connection and reconnection. Never send board state through the backend.

### FF-4: Implement Download Requests and Transfer Sessions

**Status:** Completed (`2026-11-27`) - implemented synchronous File System Access API preparation and capability/storage-estimate pre-evaluation (`client/src/persistence/file-persistence.js`) alongside equal-peer `DOWNLOAD_REQUEST`/`DOWNLOAD_ACCEPTED`/`DOWNLOAD_REJECTED` session negotiation and single-transfer-per-direction `BUSY` enforcement (`client/src/transfer/download-negotiator.js`, `[51]`).

Open persistence before requesting a remote file, validate request/accept/reject messages, and manage independent transfer identities and state.

### FF-5: Implement Bounded Bidirectional Transfer

**Status:** Completed (`2026-11-27`) - implemented dedicated chunk crypto worker offloading (`client/src/workers/chunk-crypto.worker.js`, `chunk-worker-client.js`), bounded owner chunk streaming (`client/src/transfer/owner-streamer.js`, `[52]`), bounded downloader persistence receiver (`client/src/transfer/downloader-receiver.js`, `[53]`), per-transfer progress/ETA tracking (`client/src/transfer/transfer-progress.js`), and simultaneous opposite-direction orchestration (`client/src/transfer/transfer-coordinator.js`, `[54]`).

Implement owner-side channel backpressure, downloader-side bounded write queues and flow control, encrypted binary framing, progress, pause, cancel, completion, and direct-to-disk writes. Prove simultaneous transfers in opposite directions.

### FF-6: Implement Reconnection and Safe Resume

**Status:** Completed (`2026-11-27`) - implemented bounded reconnect backoff and grace supervision (`client/src/webrtc/reconnect-supervisor.js`), generation-safe channel and connection disposal on `peer:left` and replacement negotiation (`client/src/webrtc/room-connection.js`), owner and downloader epoch-rotating resume (`client/src/transfer/owner-streamer.js`, `client/src/transfer/downloader-receiver.js`, `client/src/transfer/transfer-coordinator.js`), and controller wiring (`client/src/ui/room-board-controller.js`, `[56]`).

Restore board state, renegotiate WebRTC, authenticate resume state, rotate transfer epochs, and resume from the last fully persisted chunk.

### FF-7: Define Browser Support and Persistence Limits

**Status:** Completed (`2026-11-27`) - implemented runtime capability profiling, `256 TiB` protocol limit and available-storage eligibility checks, and frozen deferred-extension metadata (`client/src/persistence/capability-limits.js`, `client/src/persistence/file-persistence.js`), pre-picker/pre-request rejection (`client/src/transfer/download-negotiator.js`), and UI warning/limit feedback (`client/src/ui/room-board-controller.js`, `client/src/ui/RoomBoardApp.jsx`, `[57]`).

Detect the verified File System Access MVP path, document unsupported browsers, and show capability and size limits before a download request. Service Worker streaming and IndexedDB implementations remain separate future extensions until their browser behavior is approved.

### FF-8: Complete Product UX and Release Gate

**Status:** Completed (`2026-11-27`) - implemented the accessible responsive equal-peer room-board UX (`client/src/ui/RoomBoardApp.jsx`, `client/src/ui/room-board-controller.js`, `client/src/ui/qr-code.js`, mounted by `client/src/main.jsx` with `[55]`), Playwright dual-context peer-room harness (`client/e2e/helpers/` with `[58]`), shared-board, bidirectional transfer, reconnect/resume, forced-TURN, and privacy E2E suites (`client/e2e/shared-board-and-transfers.e2e.js`, `client/e2e/resilience-turn-and-privacy.e2e.js` with `[59]`), static `new Worker(...)` production bundling fix (`client/src/workers/chunk-worker-client.js`), and the compiled-bundle final release gate (`client/e2e/release-gate.e2e.js` with `[60]`).

Deliver accessible responsive room-board UX, Playwright coverage, direct and forced-TURN scenarios, bounded-memory measurements, and security verification.

---

## 4. Verification

At each stage:

* run frontend unit tests and `npm run build`;
* run relevant browser scenarios after Playwright approval;
* update security, P2P, UX, testing, and plan documents;
* verify that Socket.IO and backend logs contain no keys, plaintext metadata, board state, file requests, or file contents.
