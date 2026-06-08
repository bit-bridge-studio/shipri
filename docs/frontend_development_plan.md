# Shipri Final Frontend Development Plan

This plan covers Part 4: turning the accepted diagnostic flow into the complete Shipri browser product after backend development passes its acceptance gate.

The production frontend may reuse well-isolated Socket.IO and WebRTC modules from the prototype. Prototype diagnostics and insecure shortcuts must not leak into the user-facing product.

---

## 1. Entry Criteria

Final frontend development begins only when:

* Backend unit and integration tests pass.
* Room authorization and Socket.IO contracts are frozen.
* Direct and forced-TURN WebRTC connections pass through the prototype.
* Production ICE and deployment configuration are documented.
* Transfer-control, backpressure, resume encryption, and browser-support decisions are resolved.

---

## 2. Production Frontend Goals

The frontend owns all user file data and cryptographic key material. It must:

* Keep keys, plaintext metadata, and file contents out of the backend.
* Keep memory usage bounded for supported large-file transfer paths.
* Use native browser APIs for WebRTC, Web Crypto, and persistence.
* Provide accurate browser capability and file-size limitations.
* Replace diagnostics with a complete, accessible, responsive product experience.

The initial production target is one-file Chromium-to-Chromium transfer with direct-to-disk writing through the File System Access API.

---

## 3. Final Frontend Stages

### FF-0: Establish Production Application Architecture

**Work:**

* Decide which isolated signaling and WebRTC prototype modules are safe to retain.
* Remove or isolate prototype diagnostics from the production route.
* Define the production client state machine and route behavior.
* Confirm the transfer-control protocol and browser support matrix.
* Synchronize security, P2P, UX, and testing specifications.

**Exit criteria:**

* Production modules have clear ownership boundaries.
* Every frontend network message and state transition is documented.

### FF-1: Implement Key Lifecycle and E2EE Primitives

**Work:**

* Generate the 256-bit master key and encode/decode URL-safe Base64.
* Extract and immediately remove the fragment key from the visible URL.
* Derive metadata and transfer-epoch chunk keys with HKDF.
* Implement metadata encryption/decryption and deterministic chunk IV generation.
* Add tests for round trips, invalid tags, domain separation, IV boundaries, and epoch separation.

**Exit criteria:**

* No key or plaintext metadata enters Socket.IO payloads or logs.
* Tests prove that retry and resume epochs do not reuse an AES-GCM key/IV pair.

### FF-2: Build the Secure WebRTC Control Plane

**Work:**

* Integrate the accepted room and signaling contracts.
* Create `shipri-control` and `shipri-binary` data channels.
* Exchange encrypted metadata.
* Implement accept, decline, cancel, connection status, and relay warnings.
* Replace diagnostic controls with production state transitions.

**Exit criteria:**

* The receiver decrypts metadata and accepts or declines without plaintext metadata reaching the backend.

### FF-3: Implement MVP Encrypted File Transfer

**Work:**

* Slice files sequentially without loading the whole file into memory.
* Encrypt and send chunks through `shipri-binary`.
* Apply sender `bufferedAmount` backpressure.
* Write decrypted chunks directly through the File System Access API.
* Apply receiver write-queue limits and control-channel flow control.
* Implement progress, speed, ETA, pause, cancel, completion, and authentication failure.

**Exit criteria:**

* A representative large file transfers byte-for-byte with bounded memory.
* Pause, cancel, final partial chunk, and tampered chunk paths pass tests.

### FF-4: Implement Complete Product UX

**Work:**

* Build file selection and drag-and-drop.
* Build waiting/share-link, receiver acceptance, active transfer, completion, and error states.
* Implement copy-link feedback and the approved QR approach.
* Add responsive layouts and accessible keyboard, focus, status, and error behavior.

**Exit criteria:**

* Sender and receiver complete the production flow without diagnostic controls or developer tools.
* Responsive and accessibility checks pass.

### FF-5: Implement Reconnection and Safe Resume

**Work:**

* Add bounded reconnect attempts and WebRTC renegotiation.
* Authenticate resume state and track the last fully written chunk.
* Derive a new chunk key for each transfer epoch.
* Resume from the last acknowledged chunk without corruption.

**Exit criteria:**

* Mid-transfer interruption recovers successfully.
* Tests prove output integrity and absence of AES-GCM key/IV reuse.

### FF-6: Expand Browser Persistence Support

**Work:**

* Implement Service Worker streaming only for verified browser paths.
* Implement a size-limited IndexedDB fallback.
* Detect capabilities before transfer acceptance.
* Display accurate unsupported-browser and size-limit messages.

**Exit criteria:**

* Every supported browser has a documented and tested persistence path.
* The UI never claims unlimited file support on a limited fallback path.

### FF-7: Final Polish and Release Gate

**Work:**

* Add the approved Playwright setup.
* Cover secure transfer, room errors, cancel, interruption/resume, and forced TURN.
* Complete visual consistency, responsive behavior, accessibility, and error-copy review.
* Measure memory usage and transfer performance with representative files.
* Verify that keys and plaintext metadata are absent from network requests and logs.

**Exit criteria:**

* Supported browsers pass direct-P2P and forced-TURN release scenarios.
* Production frontend behavior and limitations match the documentation.

---

## 4. Final Frontend Verification

At the end of each stage, run:

* Frontend unit tests.
* `npm run build`.
* Relevant Playwright tests once approved and configured.
* Manual responsive and accessibility checks when UI behavior changes.
