# Project Shipri: Architectural Review Findings

This document records architecture and security findings discovered while reviewing the initial specifications. It is a decision-support document, not a protocol contract. Implementations must continue to follow the canonical specifications until the owning documentation ticket accepts a finding and synchronizes the affected contracts.

Finding dispositions:

* **Accepted**: incorporate into the owning ticket and canonical specification before implementation.
* **Existing control**: the risk is already covered by an approved plan or ticket; clarify it without creating a competing design.
* **Deferred**: valid follow-up work outside the current MVP or acceptance gate.
* **Rejected**: not a vulnerability under the documented threat model or cryptographic construction.

---

## 1. Signaling Server Performance & DoS Vulnerabilities

### 1.1. O(N) Linear Scan on Socket Disconnection — Accepted
* **Location / Component**: Signaling Server (`server/src/index.js` / `docs/signaling_protocol_spec.md`)
* **Finding**: In the current signaling implementation, a client disconnect scans all active rooms:
  ```javascript
  for (const [roomId, room] of activeRooms.entries()) {
    if (room.hostSocketId === socket.id) { ... }
  }
  ```
  Under load or connection abuse, repeated disconnects make cleanup work proportional to the total number of rooms and consume the single Node.js event loop.
* **Risk**: High CPU utilization and event loop starvation, leading to service unavailability.
* **Decision**:
  * Maintain an application-owned reverse index `socketToRoom: Map<SocketId, RoomId>`.
  * Keep the room record, Socket.IO membership, and reverse index consistent across successful create, join, leave, disconnect, and room-deletion transitions.
  * Failed operations must not partially update either index.
  * Resolve disconnect cleanup in O(1) without scanning unrelated rooms.
* **Owner**: Backend POC ticket 12 and its integration tests.

### 1.2. Short Room ID Collision and Slot Denial of Service — Existing Control
* **Location / Component**: Signaling Room Lifecycle (`docs/signaling_protocol_spec.md` / `docs/security_audit_open_source.md`)
* **Finding**: The Backend POC room ID uses `ship-[a-f0-9]{4}`, offering 65,536 values.
  * With 5,000 active rooms, one random allocation attempt has an approximately 7.6% chance of selecting an occupied ID.
  * An attacker can easily scan the room ID space (65k is very small) to discover active rooms.
* **Risk**: While the attacker cannot decrypt the transferred files (since the E2EE key remains client-side in the URL hash fragment), they can join an active room and occupy the second peer slot. Because the room capacity is exactly 2, this blocks the legitimate receiver from joining, causing a denial of service for that room.
* **Existing controls**:
  * Backend POC ticket 9 already requires retrying until the generated ID is unique among active rooms.
  * Production authorization is already required to be independent from the public room ID and must be validated before assigning the second peer slot.
  * The short POC identifier remains canonical until a separate contract decision changes it; increasing its length is not a substitute for authorization.

### 1.3. Production Room Authorization vs. Untrusted Signaling Boundary — Accepted
* **Location / Component**: Room Authorization & Key Distribution (`docs/security_e2ee_spec.md` / `docs/signaling_protocol_spec.md` / `docs/backend_development_plan.md`)
* **Finding**: Full backend development requires room authorization independent from the 65,536-value `roomId`, while the threat model deems the signaling server untrusted and keeps the URL fragment `#key=...` strictly client-side. Placing a join token in the URL path or query string would leak it to HTTP proxy logs and Referer headers, whereas sending the master secret to the server would break Zero-Knowledge E2EE.
* **Risk**: Either authorization tokens leak in URLs/logs or room authorization couples with E2EE key material.
* **Decision**:
  * Keep only the single 256-bit master secret in the URL fragment (`#key=...`) or derive an explicit HKDF domain token (`shipri-room-auth-v1`) on the client that is mathematically independent from the E2EE encryption keys (`shipri-board-metadata-v1`, `shipri-control-v1`, and chunk keys).
  * The creating peer registers the room authorization verifier with `room:create` (or receives a server-issued capability bound to the room), and the joining peer presents the derived room authorization token in the `room:join` Socket.IO payload.
  * Because HKDF is one-way, the signaling server can verify room authorization before assigning the second peer slot without ever learning the master secret or decrypting P2P traffic.
* **Owner**: Full backend contract ticket 1 (GitHub issue #53), security ticket 3 (GitHub issue #55), and final frontend ticket 16 (GitHub issue #35).

---

## 2. End-to-End Encryption (E2EE) & Web Worker Constraints

### 2.1. Browser Execution and Worker Boundaries — Accepted with Compatibility Gate
* **Location / Component**: Client E2EE & Streaming (`docs/security_e2ee_spec.md` / `docs/p2p_data_protocol_spec.md`)
* **Finding**: `RTCPeerConnection` remains a Window API. Current WebRTC specification work exposes `RTCDataChannel` to dedicated workers as a transferable object, but supported browser behavior must be verified before Shipri relies on it.
* **Risk**: Treating the entire WebRTC stack as worker-safe can break supported browsers. Copying chunk buffers between the main thread and workers can also defeat the bounded-memory design.
* **Decision**:
  * Keep `RTCPeerConnection` ownership, signaling, and a compatible `RTCDataChannel` path on the main thread.
  * Define explicit worker boundaries for file reads, AES-GCM operations, and persistence.
  * Transfer `ArrayBuffer` ownership with transfer lists instead of copying buffers.
  * Treat worker-owned `RTCDataChannel` as an optional optimized path only after browser acceptance tests; retain the main-thread path as the compatibility baseline.
* **Owner**: Final frontend architecture ticket 14 and browser-support acceptance tests.

### 2.2. Public HKDF Salt Entropy — Rejected
* **Location / Component**: Cryptographic Model (`docs/security_e2ee_spec.md`)
* **Finding**: The specification derives AES-GCM domain keys using HKDF with a public salt bound to the room ID:
  ```javascript
  salt: encoder.encode(`shipri:${roomId}`)
  ```
* **Decision**: This is not a vulnerability under the documented construction. HKDF salt is non-secret and may be reused; Shipri's input key material is already a uniformly random 256-bit master secret. A separate random salt would not protect a disclosed master secret.
* **Action**: Keep the room-bound salt unless another protocol requirement changes it. Do not add a second URL-fragment secret for this finding.

### 2.3. AES-GCM Nonce Domains Across Transfers — Accepted

* **Finding**: The current security specification derives one `shipri-file-chunks-v1` key and constructs each IV from `chunkIndex`. Separate transfers can therefore reuse the same key/IV pair when they both encrypt chunk 0, chunk 1, and so on.
* **Risk**: AES-GCM nonce reuse with the same key breaks the required confidentiality and integrity guarantees.
* **Decision**:
  * Derive each chunk key from an unambiguous context containing `roomId`, `transferId`, a protocol-stable owner-to-downloader direction, and `epoch`.
  * Define direction using stable P2P transfer identities (such as the file owner's persistent room-session peer/member identity and `transferId`) rather than ephemeral Socket.IO `socket.id` values or `offerer`/`answerer` negotiation duties, which can flip across reconnects.
  * Construct IVs deterministically from the chunk index only within that unique key domain.
  * Rotate the epoch before a resumed transfer reuses a chunk index under a new transfer attempt.
* **Owner**: Final frontend architecture ticket 14, encrypted framing ticket 20, and synchronized security/P2P schemas.

### 2.4. Fragment Key Cleanup vs. Page Reload Reconnection — Accepted
* **Location / Component**: URL Fragment Key Lifecycle (`docs/security_e2ee_spec.md` / `docs/ui_ux_flow_spec.md`)
* **Finding**: The joining peer immediately strips `#key=...` from the address bar via `window.history.replaceState` to prevent history and shoulder-surfing leakage. However, if either peer reloads the tab (F5) or recovers from a transient navigation while remaining in the room, an in-memory-only key is lost and the peer can no longer decrypt the shared board or resume transfers.
* **Risk**: Broken reconnection UX after a page reload or accidental re-exposure of the key in the visible URL.
* **Decision**:
  * Immediately strip `#key=...` from the visible URL with `window.history.replaceState`.
  * Cache the room master secret in tab-scoped `sessionStorage` keyed by `roomId` for the lifetime of the active room session so same-tab reloads can recover E2EE state.
  * Explicitly wipe the `sessionStorage` entry on intentional `room:leave`, terminal room error, or session reset.
* **Owner**: Final frontend tickets 17 (GitHub issue #36) and 29 (GitHub issue #48).

### 2.5. Canonical Schema Alignment for Control Envelope and `FILE_ADVERTISE` — Accepted
* **Location / Component**: P2P Control Channel & Metadata Schemas (`docs/security_e2ee_spec.md` / `docs/p2p_data_protocol_spec.md`)
* **Finding**: `security_e2ee_spec.md` illustrates `FILE_ADVERTISE` with top-level `{ fileId, iv, ciphertext }` in standard Base64, whereas `p2p_data_protocol_spec.md` nests `{ fileId, encryptedMetadata: { iv, ciphertext } }` in `base64url` and shows control messages as plaintext JSON despite defining the `shipri-control-v1` AES-GCM key.
* **Risk**: Incompatible codec implementations and unauthenticated control frames on `shipri-control`.
* **Decision**:
  * Standardize all binary-to-text fields in JSON schemas on `base64url` without padding.
  * Define one canonical authenticated `shipri-control-v1` AEAD envelope (with unique 12-byte IV and room/session context) or canonical nested `encryptedMetadata` schema across both documents before implementation.
  * Specify the exact binary header layout (`transferId`, `fileId`, `epoch`, `chunkIndex`) on `shipri-binary` and pass that header as AES-GCM `additionalData` (AAD) so header fields are cryptographically authenticated alongside each chunk.
* **Owner**: Final frontend tickets 14, 18, 19, and 20 (GitHub issues #33, #37, #38, and #39).

---

## 3. WebRTC Connection State & Reconnection Race Conditions

### 3.1. Reconnection Duty and Stale Negotiation State — Accepted
* **Location / Component**: Client Connection Handling (`docs/signaling_protocol_spec.md`)
* **Finding**: When a peer disconnects, the remaining peer receives a `peer:left` event with `reason: "disconnect"`. The spec indicates that the remaining peer becomes the next `offerer`.
  * If the disconnected peer refreshes the page or recovers their network connection, they will attempt to rejoin the room.
  * If the remaining peer has not cleanly torn down the previous `RTCPeerConnection` instance, the client will have active data channels and event listeners bound to the stale connection.
* **Risk**: State conflicts, failed WebRTC handshakes, and memory leaks.
* **Decision**:
  * On `peer:left`, close every current data channel and `RTCPeerConnection`, cancel timers and pending negotiation work, remove subscriptions, and clear retained references.
  * Treat a later `peer:joined` as a new negotiation generation bound to the current remote `peerId` and ICE session.
  * Queue candidates that arrive before the matching remote description is set.
  * Ignore delayed SDP and ICE events that do not belong to the current peer and ICE generation.
* **Owner**: Frontend prototype ticket 8 and final frontend tickets 15 and 29.

### 3.2. ICE Candidate Gathering Stalls — Accepted with Trickle ICE Correction
* **Location / Component**: NAT Traversal (`docs/nat_traversal_strategy.md`)
* **Finding**: ICE candidate gathering can stall or delay connection establishment if the browser spends too much time looking for inactive network interfaces.
* **Risk**: High connection latency or timeouts during room join.
* **Decision**:
  * Send the initial SDP offer or answer after `setLocalDescription()` without waiting for ICE gathering to complete.
  * Trickle candidates as `icecandidate` events produce them.
  * Use the five-second bound to surface stalled-gathering diagnostics; it must not delay an otherwise valid initial offer or answer.
  * Correlate candidates with the active ICE generation so delayed candidates from a replaced connection are ignored.
* **Owner**: Frontend prototype ticket 8 and synchronized NAT/signaling documentation.

---

## 4. Flow Control & Backpressure Challenges

### 4.1. Separate Control and Binary Channel Ordering — Accepted
* **Location / Component**: P2P Data Protocol (`docs/p2p_data_protocol_spec.md`)
* **Finding**: The backpressure mechanism uses application-level `FLOW_PAUSE` and `FLOW_RESUME` messages sent over the `shipri-control` channel, while binary data is streamed over the `shipri-binary` channel.
* **Risk**: Due to network latency (round-trip time), by the time the owner receives `FLOW_PAUSE` on the control channel, they may have already queued megabytes of encrypted binary chunks on the binary channel. This can result in receiver queue growth and browser memory exhaustion.
* **Decision**:
  * Replace receiver `FLOW_PAUSE` and `FLOW_RESUME` messages with cumulative, byte-denominated `FLOW_CREDIT`.
  * Define credit as an absolute plaintext file offset, `maxPlaintextOffsetExclusive`. The owner may send a chunk only when the chunk's ending plaintext offset is less than or equal to that limit.
  * Bind every credit to `transferId`, `direction`, and `epoch`, and include a monotonic `sequence` value. Duplicate, stale, or reordered credit updates never expand the sender window.
  * Grant the initial receive window only after persistence is ready. Advance it from the last persisted plaintext offset so queued plus in-flight data remains bounded.
  * Continue enforcing `RTCDataChannel.bufferedAmount` high/low watermarks independently from application credit.
  * Never assume relative ordering between the control and binary data channels. An over-credit binary frame fails the affected transfer safely.
  * Keep user-requested `TRANSFER_PAUSE` and `TRANSFER_RESUME` independent from receiver flow credit.
  * Define concurrency semantics for one active transfer per direction: while a transfer in a given direction is active or paused, additional download requests in that same direction are either rejected with a deterministic `BUSY` reason or explicitly queued in the UI without interleaving uncredited frames.
* **Owner**: Final frontend architecture ticket 14, control codec ticket 19, and transfer tickets 24–27.

---

## 5. Storage Persistence Edge Cases

### 5.1. Safari Storage Quotas and Eviction — Deferred
* **Location / Component**: Persistence Layer (`docs/p2p_data_protocol_spec.md`)
* **Finding**: Browser-managed storage remains quota-bound and may be evicted. `navigator.storage.estimate()` reports an estimate, not a reservation or guarantee that the transfer will finish.
* **Current scope**: The MVP supports only the verified File System Access direct-write path. Service Worker streaming and IndexedDB buffering remain future extensions and must not be implied as current fallbacks.
* **Deferred requirements**:
  * Build a current browser/version support matrix before approving another persistence path.
  * Check estimated capacity and persistence state before sending `DOWNLOAD_REQUEST`.
  * Handle `QuotaExceededError`, eviction, cancellation, and partial-output cleanup during writes.
  * Show accurate capability and size guidance before a transfer begins.
* **Owner**: Frontend browser-capability ticket 30 or a separately approved persistence-extension ticket.

### 5.2. Transient User Activation Before `showSaveFilePicker()` — Accepted
* **Location / Component**: Download Request Lifecycle (`docs/p2p_data_protocol_spec.md` / `docs/ui_ux_flow_spec.md`)
* **Finding**: Browser File System Access API (`window.showSaveFilePicker()`) requires transient user activation from the user's click event. Running asynchronous work (such as `await navigator.storage.estimate()` or network round-trips) before invoking `showSaveFilePicker()` can expire user activation and throw `SecurityError`.
* **Risk**: Save dialog fails to open when clicking `Download` on a remote file card.
* **Decision**:
  * Evaluate browser capability and pre-compute or cache storage estimates when remote file advertisements arrive on the board, not asynchronously inside the click handler before opening the file picker.
  * Invoke `window.showSaveFilePicker()` synchronously within the user click gesture before awaiting any asynchronous persistence setup or sending `DOWNLOAD_REQUEST`.
* **Owner**: Final frontend tickets 24 and 30 (GitHub issues #43 and #49).

---

## 6. Deployment & Reverse-Proxy Topology Alignment

### 6.1. External Reverse Proxy (`nginx-proxy`) vs. Bundled Caddy — Accepted
* **Location / Component**: Deployment Architecture (`docker-compose.yml` / `docker-compose.prod.yml` / `docs/deployment_docker_spec.md`)
* **Finding**: The specification documents a bundled Caddy `reverse-proxy` container binding host ports `80` and `443`, whereas the active CI/CD pipeline (`docker-compose.prod.yml` and `.github/workflows/deploy.yml`) deploys to a VPS that already runs an external `nginx-proxy` network. Starting a second proxy on ports `80/443` on that host would fail with a port conflict.
* **Risk**: Staging and production deployments fail or diverge from documented reverse-proxy assumptions.
* **Decision**:
  * Support two explicitly documented deployment modes:
    1. **Self-contained stack (`docker-compose.yml`)**: bundled Caddy reverse proxy owning `80/443` for standalone VPS or local deployments.
    2. **External proxy integration (`docker-compose.prod.yml`)**: `client` and `server` attached to the external reverse-proxy network (`nginx-proxy`) or dedicated staging proxy, with HTTPS/WSS termination and `/socket.io/*` + `/health` routing configured on the host proxy.
  * Align Backend POC staging tickets (15–18) and full backend deployment ticket (GitHub issue #58) with the active VPS proxy topology so `/health` and WSS routing work without host port collisions.
* **Owner**: Backend POC tickets 15–18 (GitHub issues #15–#18) and full backend ticket 6 (GitHub issue #58).

---

## 7. Primary References

* [RFC 5869: HKDF](https://www.rfc-editor.org/rfc/rfc5869.html)
* [RFC 8829: JavaScript Session Establishment Protocol](https://www.rfc-editor.org/rfc/rfc8829.html)
* [RFC 8831: WebRTC Data Channels](https://www.rfc-editor.org/rfc/rfc8831.html)
* [RFC 8838: Trickle ICE](https://www.rfc-editor.org/rfc/rfc8838.html)
* [W3C WebRTC](https://www.w3.org/TR/webrtc/)
* [WebKit Storage Policy](https://webkit.org/blog/14403/updates-to-storage-policy/)
