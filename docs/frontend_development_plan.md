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

Implement fragment-key lifecycle, domain-separated board metadata encryption, authenticated control messages, and per-transfer epoch chunk encryption.

### FF-2: Implement Production Peer Connection

**Progress:** Extracted reusable production-safe `client/src/webrtc/ice-config.js` and `client/src/webrtc/peer-connection.js` modules (`[42]`) isolated from `client/src/prototype/`, with generation-scoped disposal, `reconnect()` hooks, dual `shipri-control`/`shipri-binary` channel lifecycle, and unit tests (`client/test/production-peer-connection.test.js`).

Reuse production-safe signaling and WebRTC modules, enforce room authorization, create control/binary channels, and expose connection and relay state.

### FF-3: Implement Encrypted Shared File Board

Allow either peer to add and remove local file advertisements. Synchronize encrypted advertisements after connection and reconnection. Never send board state through the backend.

### FF-4: Implement Download Requests and Transfer Sessions

Open persistence before requesting a remote file, validate request/accept/reject messages, and manage independent transfer identities and state.

### FF-5: Implement Bounded Bidirectional Transfer

Implement owner-side channel backpressure, downloader-side bounded write queues and flow control, encrypted binary framing, progress, pause, cancel, completion, and direct-to-disk writes. Prove simultaneous transfers in opposite directions.

### FF-6: Implement Reconnection and Safe Resume

Restore board state, renegotiate WebRTC, authenticate resume state, rotate transfer epochs, and resume from the last fully persisted chunk.

### FF-7: Define Browser Support and Persistence Limits

Detect the verified File System Access MVP path, document unsupported browsers, and show capability and size limits before a download request. Service Worker streaming and IndexedDB implementations remain separate future extensions until their browser behavior is approved.

### FF-8: Complete Product UX and Release Gate

Deliver accessible responsive room-board UX, Playwright coverage, direct and forced-TURN scenarios, bounded-memory measurements, and security verification.

---

## 4. Verification

At each stage:

* run frontend unit tests and `npm run build`;
* run relevant browser scenarios after Playwright approval;
* update security, P2P, UX, testing, and plan documents;
* verify that Socket.IO and backend logs contain no keys, plaintext metadata, board state, file requests, or file contents.
