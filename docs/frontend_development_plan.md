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

Define peer-room state, encrypted board synchronization, transfer-session identity, control messages, binary framing, persistence limits, and module boundaries.

### FF-1: Implement Room Key and E2EE Primitives

Implement fragment-key lifecycle, domain-separated board metadata encryption, authenticated control messages, and per-transfer epoch chunk encryption.

### FF-2: Implement Production Peer Connection

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
