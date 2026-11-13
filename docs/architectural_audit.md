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
  * Construct IVs deterministically from the chunk index only within that unique key domain.
  * Rotate the epoch before a resumed transfer reuses a chunk index under a new transfer attempt.
* **Owner**: Final frontend architecture ticket 14, encrypted framing ticket 20, and synchronized security/P2P schemas.

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
* **Owner**: Final frontend architecture ticket 14, control codec ticket 19, and transfer tickets 25–26.

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

---

## 6. Primary References

* [RFC 5869: HKDF](https://www.rfc-editor.org/rfc/rfc5869.html)
* [RFC 8829: JavaScript Session Establishment Protocol](https://www.rfc-editor.org/rfc/rfc8829.html)
* [RFC 8831: WebRTC Data Channels](https://www.rfc-editor.org/rfc/rfc8831.html)
* [RFC 8838: Trickle ICE](https://www.rfc-editor.org/rfc/rfc8838.html)
* [W3C WebRTC](https://www.w3.org/TR/webrtc/)
* [WebKit Storage Policy](https://webkit.org/blog/14403/updates-to-storage-policy/)
