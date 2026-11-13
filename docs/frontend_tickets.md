# Frontend Ticket Backlog

These atomic tickets implement `frontend_prototype_plan.md` and `frontend_development_plan.md` in dependency order.

Existing GitHub issues targeted for synchronization: #20 through #52. Ticket 1 maps to issue #20 and ticket 33 maps to issue #52.

The production architecture is a two-peer room with an encrypted shared file board. Creator/joiner and offerer/answerer duties never determine file-transfer direction.

---

## Frontend Prototype Tickets

## 1. Documentation: Freeze the frontend prototype POC contract

When I build the diagnostic prototype, I want the accepted two-peer POC contract mapped to frontend actions, so the prototype does not rely on mocks or transfer-role assumptions.

## Acceptance Criteria

- Every consumed Backend POC event, payload, error, lifecycle transition, and negotiation duty is documented.
- Both members are described as equal peers; offerer/answerer duties are signaling-only.
- Prototype-only behavior is separated from production authorization, E2EE, file-board, and transfer behavior.
- Relevant prototype, signaling, and testing documents are synchronized.

---

## 2. Chore: Add the frontend prototype test foundation

When I implement prototype behavior, I want frontend unit tests and clean installation, so room and diagnostic regressions are caught early.

## Acceptance Criteria

- The approved Vitest setup and `client` `test` script are configured.
- `npm ci`, baseline tests, and `npm run build` pass.
- Test utilities mock Socket.IO without a live backend.
- `testing_strategy.md` documents the setup.

---

## 3. Refactoring: Isolate the Socket.IO client from React rendering

The Socket.IO lifecycle is isolated so UI modules consume stable connection, event, and error state.

## Acceptance Criteria

- Connection, subscriptions, cleanup, and environment configuration live outside rendering components.
- Events are normalized without logging secrets or private transfer data.
- Unit tests cover connection, subscription, cleanup, and errors.

---

## 4. Feature: Build the diagnostic prototype shell and event log

When I test the backend, I want membership, negotiation, connection, and event state visible without developer tools.

## Acceptance Criteria

- The UI displays connection state, room ID, peer state, negotiation duty, and last error.
- The chronological event log sanitizes payloads and secrets.
- Unit tests cover rendering, append, clear, and sanitization.

---

## 5. Feature: Implement POC peer room lifecycle controls

When I test rooms, I want either browser to create, join, and leave, so equal-peer lifecycle behavior is visible.

## Acceptance Criteria

- A first peer creates a room and a second peer joins it.
- Either peer can leave while the remaining peer stays in the room.
- Creator/joiner and offerer/answerer duties are displayed without implying transfer roles.
- Unit tests cover create, join, either-peer leave, peer notifications, and reset.

---

## 6. Feature: Surface stable POC room errors and validation scenarios

When I validate failures, I want stable room errors and malformed-input cases visible in the prototype.

## Acceptance Criteria

- The UI handles unknown, full, malformed, unauthorized, unavailable-peer, and disconnect cases.
- The event log remains sanitized and recovery resets only relevant state.
- Unit tests cover known errors, fallback errors, malformed input, and recovery.

---

## 7. Feature: Add development ICE configuration diagnostics

When I initialize WebRTC, I want to inspect the accepted development ICE response without exposing credentials.

## Acceptance Criteria

- The prototype requests and validates `ice:credentials`.
- Sanitized ICE counts and schemes are visible.
- Unit tests cover success, malformed responses, and failures.

---

## 8. Feature: Implement the equal-peer WebRTC signaling harness

When two prototype peers connect, I want deterministic offer/answer and bidirectional ICE exchange, so signaling is validated independently from transfer direction.

## Acceptance Criteria

- The documented offerer creates the initial connection and the answerer responds.
- SDP offers and answers are forwarded after `setLocalDescription()` without waiting for ICE gathering to complete.
- Both peers trickle ICE candidates as they are produced.
- Candidates received before the matching remote description are queued and applied after `setRemoteDescription()` succeeds.
- The five-second ICE gathering bound surfaces stalled-gathering diagnostics and never delays an otherwise valid initial offer or answer.
- `peer:left` closes the current peer connection, invalidates its negotiation generation, and a later `peer:joined` starts a fresh negotiation.
- Inbound SDP and candidates are accepted only for the current remote `peerId` and ICE generation; late events from replaced negotiations are ignored.
- Connection and signaling states are visible, and unit tests cover delayed ICE gathering, early remote candidates, peer departure during negotiation, stale events, and replacement negotiation.
- Documentation defines trickle ICE behavior and states that negotiation duty never restricts application messages.

---

## 9. Feature: Add bidirectional diagnostic data-channel messaging

When the diagnostic channel opens, I want either peer to initiate ping/pong and text messages.

## Acceptance Criteria

- The offerer creates one reliable diagnostic channel and the answerer accepts it.
- Either peer can initiate ping/pong and short text exchange.
- Unit tests cover both directions, state, errors, and cleanup.

---

## 10. Infrastructure: Deploy the frontend prototype to POC staging

When the Backend POC is on staging, I want the diagnostic frontend deployed for remote HTTPS/WSS and WebRTC checks.

## Acceptance Criteria

- The documented build, deploy, rollback, and smoke checks work.
- Two remote peers create, join, negotiate, and exchange messages.
- `npm run build` passes and deployment documents are updated.

---

## 11. Chore: Complete the frontend prototype foundation gate

When the foundation is complete, I want every accepted POC behavior validated through the prototype.

## Acceptance Criteria

- Create, join, either-peer leave/disconnect, errors, ICE, signaling, and bidirectional messages pass locally and on staging.
- Unit tests and `npm run build` pass.
- Prototype limitations are documented.

---

## 12. Feature: Add NAT and forced-TURN diagnostics to the prototype

When production TURN is available, I want direct and relay modes visible and testable.

## Acceptance Criteria

- The prototype supports `iceTransportPolicy` values `all` and `relay`.
- Candidate and selected-path summaries avoid credential leakage.
- Bidirectional messages pass in direct and forced-relay modes.
- Unit tests and NAT/testing documents are updated.

---

## 13. Chore: Complete the prototype backend acceptance scenarios

When the full backend is ready, I want the prototype to exercise every required backend scenario.

## Acceptance Criteria

- Authorized equal-peer lifecycle, third-peer rejection, unauthorized signaling, cleanup, direct connectivity, and forced TURN pass.
- Tests, build, local evidence, and staging evidence are recorded.
- Prototype-only modules are identified.

---

## Final Frontend Tickets

## 14. Documentation: Freeze the encrypted peer-room architecture

When final frontend work begins, I want the shared file-board and transfer contracts frozen, so implementation does not inherit sender/receiver assumptions.

## Acceptance Criteria

- State machines cover room membership, board synchronization, file availability, and independent transfer sessions.
- Control messages, binary framing, authorization, flow control, resume epochs, and browser limits are documented.
- The execution model keeps `RTCPeerConnection` on the main thread and defines the supported `RTCDataChannel`, encryption, and persistence worker boundaries.
- Buffer ownership and transferable `ArrayBuffer` handoffs are documented together with a tested main-thread `RTCDataChannel` compatibility path.
- Worker-owned `RTCDataChannel` is treated as an optional optimization until the supported browser matrix verifies it.
- Receiver flow control uses cumulative `FLOW_CREDIT.maxPlaintextOffsetExclusive` limits and defines numeric limits for queued, granted, and in-flight bytes.
- Each `FLOW_CREDIT` message binds to the transfer, direction, and epoch and carries a monotonic `sequence`, so duplicate, stale, and reordered updates never expand the sender window.
- The receiver queue protocol replaces `FLOW_PAUSE` and `FLOW_RESUME` with `FLOW_CREDIT`; user-requested `TRANSFER_PAUSE` and `TRANSFER_RESUME` remain independent controls.
- Cross-channel ordering between control and binary channels is never assumed; credit, cancellation, and epoch messages fail safely when stale or reordered.
- Backend boundaries explicitly exclude board and transfer state.
- Security, P2P, UX, testing, and frontend plan documents are synchronized.

---

## 15. Refactoring: Isolate reusable production-safe peer connection modules

The frontend extracts production-safe signaling and WebRTC modules without diagnostic UI dependencies.

## Acceptance Criteria

- Modules consume equal-peer room, authorization, ICE, and negotiation contracts.
- Prototype logs and diagnostic controls are excluded from production routes.
- Disposing a connection closes its data channels and `RTCPeerConnection`, cancels pending timers and negotiations, removes subscriptions, and clears retained references.
- Reconnect hooks create a new connection generation and reject late events from disposed generations.
- Unit tests cover initialization, cleanup, repeated replacement-peer cycles, stale events, reconnect hooks, and error propagation.

---

## 16. Security: Implement production room authorization lifecycle

When either peer creates or joins a production room, I want room authorization handled independently from the short room ID.

## Acceptance Criteria

- Authorization tokens are received, stored only as required, attached to authorized Socket.IO actions, and cleared on leave.
- Share-link construction carries only the documented join authorization and fragment key.
- Invalid or expired authorization fails safely without logging tokens.
- Unit tests and security/signaling documentation are updated.

---

## 17. Security: Implement URL fragment key lifecycle

When peers share a room link, I want the master key generated, encoded, extracted, and removed safely.

## Acceptance Criteria

- The creating peer generates a 256-bit key and places its URL-safe encoding only in the fragment.
- The joining peer extracts and immediately removes the fragment.
- Missing or malformed keys fail safely and key material never enters requests or logs.
- Unit tests and security documentation are updated.

---

## 18. Security: Implement encrypted file-board metadata

When either peer advertises a local file, I want its metadata encrypted before it reaches the remote board.

## Acceptance Criteria

- Domain-separated HKDF and AES-GCM encrypt and decrypt file advertisements.
- Advertisement payload validation rejects malformed, tampered, and wrong-key data.
- Plaintext filename, size, and type never enter Socket.IO or logs.
- Unit tests cover round trips, tampering, validation, and metadata leakage.

---

## 19. Security: Implement authenticated transfer control messages

When peers request and control downloads, I want every control message validated and authenticated.

## Acceptance Criteria

- A documented codec handles file advertise/remove, download request/accept/reject, cumulative `FLOW_CREDIT`, transfer pause/resume, cancel, completion, error, and resume messages.
- `FLOW_CREDIT` carries `maxPlaintextOffsetExclusive`, binds to transfer, direction, and epoch, and uses a monotonic `sequence` so duplicate, stale, and reordered updates do not expand the sender window.
- Messages bind to room, file, transfer, direction, and epoch where applicable.
- Unknown, stale, forged, cross-transfer, and malformed messages fail closed.
- Unit tests and protocol/security documentation are updated.

---

## 20. Security: Implement epoch-safe encrypted binary framing

When either peer owns a requested file, I want chunks framed and encrypted without cross-transfer ambiguity or IV reuse.

## Acceptance Criteria

- Binary frames identify transfer, file, epoch, and chunk index.
- An unambiguous HKDF context schema binds chunk keys to the room, transfer, direction, and epoch.
- Per-transfer epoch keys and deterministic IVs never reuse a key/IV pair, including when separate transfers use the same chunk index.
- Invalid headers, tags, directions, epochs, or chunk order fail closed.
- Unit tests cover framing, round trips, tampering, boundaries, simultaneous transfers, repeated chunk indexes across transfers, and epoch separation.
- The key-derivation and IV construction schemas are synchronized across the security and P2P protocol documentation.

---

## 21. Feature: Build the production equal-peer WebRTC connection

When two authorized peers enter a room, I want production control and binary channels available to both directions.

## Acceptance Criteria

- Production signaling, authorization, ICE, negotiation, and channel lifecycle follow frozen contracts.
- Either peer can initiate authenticated control messages.
- Connection and relay states propagate without diagnostic payload exposure.
- Unit tests and frontend documentation are updated.

---

## 22. Feature: Publish and remove local file advertisements

When I add files to my room board, I want the remote peer to see encrypted advertisements without starting a transfer.

## Acceptance Criteria

- Either peer can add multiple local files and publish encrypted advertisements.
- Local file references remain only in the owner's browser.
- Removing an advertisement updates the remote board and does not implicitly cancel active transfers.
- Unit tests cover add, duplicate, remove, unavailable file, and cleanup.

---

## 23. Feature: Synchronize the remote file board

When peers connect or reconnect, I want each board to converge on currently available remote files.

## Acceptance Criteria

- Remote advertisements decrypt into validated read-only board entries.
- Snapshot/replay behavior converges without duplicate or stale entries.
- A disconnected owner's entries become unavailable and follow the reconnect expiry rule.
- Unit tests cover initial sync, updates, disconnect, reconnect, stale data, and decryption failure.

---

## 24. Feature: Request a remote file after persistence is ready

When I click a remote file, I want the save path prepared before requesting bytes from its owner.

## Acceptance Criteria

- Capability and size limits are checked before the request.
- Cancelling the save dialog sends no download request.
- A random transfer ID is created only after persistence is ready.
- Owners accept available files and reject missing, removed, busy, or invalid requests.
- Unit tests cover request, acceptance, rejection, cancellation, and duplicate requests.

---

## 25. Feature: Implement bounded owner-side encrypted chunk streaming

When a peer accepts a download request, I want the local file streamed with bounded memory.

## Acceptance Criteria

- The owner slices, encrypts, frames, and sends sequential chunks for the requested transfer.
- The owner sends a chunk only when its ending plaintext offset is less than or equal to the downloader's latest valid `maxPlaintextOffsetExclusive`.
- `bufferedAmount` high/low watermarks stop and resume reads.
- Receiver credits and `bufferedAmount` limits are enforced independently.
- Missing or changed local files fail only the affected transfer.
- Unit tests cover boundaries, exhausted credits, delayed credit messages, backpressure, cancellation, completion, and read/encryption failure.

---

## 26. Feature: Implement bounded downloader flow control and direct persistence

When I download a remote file, I want encrypted chunks written to disk without an unbounded receive queue.

## Acceptance Criteria

- A byte-bounded decrypt/write queue grants an initial `maxPlaintextOffsetExclusive` only after persistence is ready and advances it from the last persisted plaintext offset.
- The documented queue and in-flight byte limits remain bounded when persistence is slower than network delivery.
- Valid chunks are written in order through File System Access API for the MVP path.
- Duplicate, stale, or reordered credit messages are ignored without expanding the sender window.
- Invalid, duplicate, cross-transfer, out-of-order, or over-credit binary frames fail the affected transfer safely.
- Completion closes the target only after all chunks are persisted.
- Unit tests cover queue watermarks, slow persistence, maximum in-flight bytes, delayed control messages, writes, cancellation, completion, and failures.

---

## 27. Feature: Implement independent transfer progress and controls

When files move in either direction, I want each transfer controlled and displayed independently.

## Acceptance Criteria

- Progress, speed, ETA, direction, pause/resume, cancel, completion, and failure are tracked per transfer ID.
- Simultaneous opposite-direction transfers do not share state or controls.
- Cancelling or failing one transfer does not affect another or remove its advertisement.
- Unit tests and UX documentation are updated.

---

## 28. Feature: Build the accessible shared room-board UX

When I enter a production room, I want to share local files and download remote files from one responsive board.

## Acceptance Criteria

- Create/join, share link, QR, waiting, local files, remote files, availability, and transfer rows are implemented.
- Either peer can add files and click remote files without sender/receiver screens.
- Keyboard, focus, status announcements, responsive layouts, and error copy are included.
- Unit tests and UX/security documentation are updated.

---

## 29. Feature: Implement board reconnection and safe transfer resume

When connectivity returns, I want board state restored and eligible transfers resumed safely.

## Acceptance Criteria

- Reconnection attempts are bounded and WebRTC renegotiation follows the frozen contract.
- The previous data channels, peer connection, listeners, timers, and negotiation generation are disposed before replacement negotiation starts.
- Late events from the disposed connection cannot mutate current room, board, or transfer state.
- Board state converges after reconnect.
- Resume authenticates transfer state, uses the last persisted chunk, and rotates epoch keys.
- Unit tests cover reconnect success/exhaustion, repeated replacement cycles, stale connection events, stale resume, duplicate chunks, and output integrity.

---

## 30. Feature: Add browser capability detection and persistence limits

When I click a remote file, I want an accurate supported persistence path and size limit before requesting it.

## Acceptance Criteria

- Capability detection selects the verified File System Access MVP path or an unsupported state.
- Unsupported browsers receive accurate guidance before any download request is sent.
- Service Worker streaming and IndexedDB remain documented future extensions until separately approved.
- Unit tests and browser-support documentation are updated.

---

## 31. Chore: Add approved Playwright peer-room E2E setup

When the production board is testable, I want separate browser contexts and deterministic files for peer-room E2E tests.

## Acceptance Criteria

- The approved Playwright setup launches two isolated peer contexts.
- Tests can provide deterministic files and persistence stubs without private fixtures or production secrets.
- Local instructions and browser limitations are documented.

---

## 32. Chore: Cover secure bidirectional room release scenarios

When the frontend nears release, I want browser coverage for the shared board and independent transfers.

## Acceptance Criteria

- E2E scenarios cover both peers advertising files, downloading on click, byte-for-byte output, removal, cancellation, and simultaneous opposite-direction transfers.
- Separate scenarios cover errors, reconnect/resume, forced TURN, and absence of keys/plaintext metadata in backend-visible traffic.
- Frontend tests, E2E tests, build, and testing documentation pass.

---

## 33. Chore: Complete final frontend release gate

When all frontend features are implemented, I want a release gate proving that the peer-room product matches its specifications.

## Acceptance Criteria

- Supported browsers pass direct and forced-TURN shared-board and bidirectional transfer scenarios.
- Accessibility, responsiveness, memory bounds, transfer performance, browser limits, and security checks pass.
- The backend is verified to receive no board state, file requests, plaintext metadata, file contents, or E2EE keys.
- Tests, build, release evidence, and all relevant documentation are synchronized.
