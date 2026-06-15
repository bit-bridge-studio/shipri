# Frontend Ticket Backlog

These ticket drafts implement `frontend_prototype_plan.md` and `frontend_development_plan.md` in dependency order. They are drafted from the current documentation and the existing Backend POC ticket backlog.

Published GitHub issues: #20 through #52.

The frontend backlog is intentionally split into two phases:

1. **Frontend Prototype**: a diagnostic harness that starts only after the Backend POC acceptance gate passes.
2. **Final Frontend**: the production Shipri user experience that starts only after the full backend acceptance gate freezes room authorization, Socket.IO, ICE, deployment, and transfer contracts.

---

## Frontend Prototype Tickets

## 1. Documentation: Freeze the frontend prototype POC contract

When I build the diagnostic frontend prototype, I want the accepted Backend POC event contract mapped to frontend actions, so the prototype does not rely on mocks or undocumented signaling behavior.

## Acceptance Criteria

- The frontend prototype contract lists every consumed Backend POC event, payload shape, room error code, and lifecycle transition.
- The contract uses canonical `roomId` camelCase payload naming and `ship-[a-f0-9]{4}` room IDs.
- Prototype-only behavior is clearly separated from production room authorization, E2EE, TURN, file-transfer, and persistence behavior.
- `frontend_prototype_plan.md`, `signaling_protocol_spec.md`, and `testing_strategy.md` are synchronized with the accepted Backend POC contract.

## Notes

- Dependencies: Backend POC tickets 1 through 19 are complete and the POC event contract is frozen.
- Excluded scope: React implementation, WebRTC negotiation, final frontend UX, and E2EE file transfer.
- Context: This is the frontend counterpart to `backend_poc_tickets.md` ticket 19.

---

## 2. Chore: Add the frontend prototype test foundation

When I implement prototype behavior, I want frontend unit tests and a clean install workflow, so room state and diagnostic UI regressions are caught before WebRTC work begins.

## Acceptance Criteria

- The approved Vitest frontend dependency and `client` `test` script are configured.
- A client package lockfile is committed and `npm ci` succeeds from a clean checkout.
- Test utilities can render React components and mock Socket.IO client behavior without connecting to a live backend.
- A baseline frontend test suite runs successfully.
- `testing_strategy.md` documents the active frontend prototype test setup.

## Notes

- Dependencies: ticket 1.
- Excluded scope: Playwright, browser E2E tests, production file-transfer tests, and unapproved dependencies.
- Context: Adding Vitest requires explicit dependency approval before implementation.

---

## 3. Refactoring: Isolate the Socket.IO client from React rendering

The frontend Socket.IO connection lifecycle is isolated from React components so prototype screens can subscribe to stable connection, event, and error state without duplicating socket handlers.

## Acceptance Criteria

- Socket.IO client creation, connection, disconnection, event subscription, and cleanup live in a reusable client module or hook.
- The module supports the documented local and staging signaling URLs through environment configuration.
- Socket events are normalized into state transitions and event-log entries without logging secrets or file data.
- Unit tests cover connect, disconnect, event subscription, cleanup, and configuration behavior using mocked Socket.IO clients.
- Existing visible connection status behavior remains available in the app shell.

## Notes

- Dependencies: ticket 2.
- Excluded scope: Room lifecycle controls, WebRTC negotiation, and production authorization tokens.
- Context: The current `client/src/App.jsx` connects directly inside the component.

---

## 4. Feature: Build the diagnostic prototype shell and event log

When I use the prototype during backend development, I want a diagnostic UI with role, connection state, action controls, and an event log, so Socket.IO behavior is visible without browser developer tools.

## Acceptance Criteria

- The prototype UI displays signaling connection state, selected role, active room ID, peer state, and last error code.
- The UI includes a chronological event log for emitted and received Socket.IO events.
- Event-log entries include event names, direction, timestamps, and sanitized payload summaries.
- The event log avoids file contents, E2EE keys, plaintext metadata, TURN shared secrets, and unnecessary identifying data.
- Unit tests cover event-log append, clear, sanitization, and connection-state rendering.
- `frontend_prototype_plan.md` documents the diagnostic shell behavior.

## Notes

- Dependencies: ticket 3.
- Excluded scope: Room create/join/leave behavior, WebRTC negotiation, production UI polish, and responsive release work.

---

## 5. Feature: Implement POC room lifecycle controls

When I test Backend POC rooms, I want controls for creating, joining, and leaving rooms, so two browser clients can exercise the accepted room lifecycle.

## Acceptance Criteria

- A host can emit `room:create` and display the returned `roomId`.
- A receiver can enter a canonical room ID and emit `room:join`.
- Either connected peer can emit `room:leave` and the UI returns to the documented prototype state.
- The host UI updates when `peer:joined` is received.
- The receiver UI updates when `room:joined` is received.
- Unit tests cover successful create, join, leave, peer-joined, and state reset behavior with mocked socket events.
- `frontend_prototype_plan.md` documents the implemented room lifecycle controls.

## Notes

- Dependencies: ticket 4.
- Excluded scope: Production share links, URL fragment keys, authorization tokens, and encrypted metadata.

---

## 6. Feature: Surface stable POC room errors and validation scenarios

When I validate Backend POC failures, I want room errors and malformed-input cases to be visible in the prototype, so stable error handling can be verified manually.

## Acceptance Criteria

- The UI displays `room:error` codes and messages for unknown rooms, full rooms, malformed room IDs, host disconnects, receiver disconnects, and validation failures.
- The event log records room errors without exposing private payload data.
- A clearly prototype-only validation panel can emit malformed or edge-case room IDs for manual backend validation.
- Successful recovery from an error resets only the relevant diagnostic state.
- Unit tests cover supported room error codes, unknown error fallback, malformed-input controls, and recovery behavior.
- `frontend_prototype_plan.md` and `testing_strategy.md` document the manual error scenarios.

## Notes

- Dependencies: ticket 5.
- Excluded scope: Production error copy, final accessibility review, and abuse-control scenarios that belong to full backend development.

---

## 7. Feature: Add development ICE configuration diagnostics

When I create a prototype WebRTC connection, I want to request and inspect development ICE configuration, so `RTCPeerConnection` initialization uses the accepted backend response.

## Acceptance Criteria

- The prototype can emit `ice:get` and store the received `ice:credentials` payload.
- The UI displays sanitized ICE server counts and URL schemes without exposing credentials in logs unnecessarily.
- Missing, malformed, or failed ICE responses produce visible diagnostic errors.
- The WebRTC setup path uses the received ICE configuration instead of hard-coded client values.
- Unit tests cover successful ICE response handling, malformed response handling, and diagnostic error rendering.
- `frontend_prototype_plan.md`, `nat_traversal_strategy.md`, and `testing_strategy.md` document the prototype ICE diagnostics.

## Notes

- Dependencies: tickets 3 and 4.
- Excluded scope: Production TURN credentials, forced relay mode, and final frontend relay warnings.

---

## 8. Feature: Implement the WebRTC signaling harness

When two prototype clients are in a room, I want native WebRTC offer, answer, and ICE candidate exchange through Socket.IO, so the prototype validates the backend signaling relay.

## Acceptance Criteria

- The host creates an `RTCPeerConnection` with the development ICE configuration and emits SDP offers through `signal:forward`.
- The receiver applies offers, creates answers, and emits answers through `signal:forward`.
- Both peers forward local ICE candidates and apply received remote candidates from `signal:receive`.
- The UI displays ICE gathering, signaling, peer connection, and ICE connection states.
- Signaling payloads are summarized in diagnostics without exposing unnecessary SDP details by default.
- Unit tests cover signaling state transitions and `signal:forward` payload construction with mocked WebRTC objects.
- `frontend_prototype_plan.md` and `signaling_protocol_spec.md` stay synchronized with the implemented harness.

## Notes

- Dependencies: tickets 5 and 7.
- Excluded scope: Data-channel messaging, production E2EE, file metadata exchange, and TURN-only diagnostics.

---

## 9. Feature: Add diagnostic data-channel ping and text exchange

When a WebRTC connection opens, I want a reliable diagnostic data channel with ping/pong and short text messages, so the prototype proves browser-to-browser data flow through the negotiated connection.

## Acceptance Criteria

- The host creates one reliable diagnostic data channel after room join.
- The receiver accepts the diagnostic data channel and reports its open, close, and error states.
- Either peer can send a ping and receive a pong with visible latency timing.
- Either peer can send a short text payload that appears in the peer's diagnostic log.
- Data-channel diagnostics do not send real user files, plaintext metadata, E2EE keys, or production transfer messages.
- Unit tests cover data-channel state handling, ping/pong timing, text-message logging, and cleanup on disconnect.
- `frontend_prototype_plan.md` and `testing_strategy.md` document the two-tab data-channel scenario.

## Notes

- Dependencies: ticket 8.
- Excluded scope: `shipri-control`, `shipri-binary`, encrypted metadata, file chunks, pause, resume, and persistence.

---

## 10. Infrastructure: Deploy the frontend prototype to POC staging

When the Backend POC is available on staging, I want the diagnostic frontend deployed to the approved staging origin, so remote devices can validate HTTPS, WSS, and direct WebRTC behavior.

## Acceptance Criteria

- The prototype build can be deployed to the approved POC staging origin using documented commands.
- The deployed prototype connects to the staging Backend POC through WSS using environment-driven configuration.
- CORS and origin expectations match the Backend POC staging documentation.
- Two remote devices can create, join, negotiate, and exchange diagnostic ping/pong messages through staging.
- Deployment, update, rollback, and smoke-check steps are documented.
- `npm run build` succeeds for the deployed client.
- `deployment_docker_spec.md`, `frontend_prototype_plan.md`, and `testing_strategy.md` document the staging prototype workflow.

## Notes

- Dependencies: ticket 9 and Backend POC staging tickets 15 through 19.
- Excluded scope: Production deployment, Coturn, production secrets, production frontend route, and final UI polish.
- Context: External DNS and server access must be available before implementation.

---

## 11. Chore: Complete the frontend prototype foundation gate

When the prototype foundation is complete, I want every accepted Backend POC event validated through the UI, so full backend development can begin with a real browser harness.

## Acceptance Criteria

- The prototype validates room creation, join, leave, disconnect notifications, stable errors, development ICE, signaling relay, and data-channel ping/pong.
- Local two-tab checks pass against the accepted Backend POC.
- Staging two-device checks pass through HTTPS/WSS and direct WebRTC where the network allows it.
- Frontend unit tests and `npm run build` pass.
- The documented prototype limitations clearly state that E2EE, real file transfer, persistence, production authorization, and final UX are not implemented.
- `frontend_prototype_plan.md` records the completed acceptance evidence.

## Notes

- Dependencies: tickets 1 through 10.
- Excluded scope: Full backend forced-TURN validation and final frontend development.
- Context: Completing this ticket allows `backend_development_plan.md` Part 3 to begin.

---

## 12. Feature: Add NAT and forced-TURN diagnostics to the prototype

When full backend TURN credentials are available, I want selectable direct and relay ICE modes, so the prototype can validate both direct and forced-TURN connectivity.

## Acceptance Criteria

- The prototype supports `iceTransportPolicy` modes `all` and `relay`.
- The UI displays gathered candidate types and the selected connection candidate pair where the browser exposes it.
- The UI clearly reports whether the active connection is direct or relayed.
- TURN credential or connectivity failures produce visible diagnostic errors without exposing `TURN_SHARED_SECRET`.
- Local and staging checks verify data-channel ping/pong in normal and forced-relay modes.
- Unit tests cover ICE mode selection, candidate summary rendering, and TURN error states with mocked WebRTC stats.
- `frontend_prototype_plan.md`, `nat_traversal_strategy.md`, and `testing_strategy.md` document the NAT diagnostics.

## Notes

- Dependencies: ticket 11 and full backend stages `BE-4` and `BE-6`.
- Excluded scope: Production transfer UI, file chunks, E2EE, and release Playwright coverage.

---

## 13. Chore: Complete the prototype backend acceptance scenarios

When the full backend is ready for acceptance, I want the prototype to exercise every required backend scenario, so the final frontend can start from a frozen contract.

## Acceptance Criteria

- The prototype verifies authorized room lifecycle, stable validation errors, third-peer rejection, unauthorized signaling rejection, disconnect cleanup, direct connectivity, and forced-TURN connectivity.
- The prototype exposes backend acceptance scenarios without requiring browser developer tools.
- Frontend unit tests and `npm run build` pass.
- Manual local and staging scenario results are documented.
- Prototype-only modules and controls are clearly identified for later removal or isolation from the production route.
- `frontend_prototype_plan.md` records the completed `FP-6` acceptance evidence.

## Notes

- Dependencies: ticket 12 and full backend stages `BE-2` through `BE-6`.
- Excluded scope: Production E2EE, production file transfer, final UX, and Playwright release tests.
- Context: Completing this ticket unblocks full backend `BE-7` and later final frontend work.

---

## Final Frontend Tickets

## 14. Documentation: Freeze the production frontend architecture

When final frontend development begins, I want the production state machine, module boundaries, and transfer contracts frozen, so implementation does not inherit prototype-only shortcuts.

## Acceptance Criteria

- The production frontend state machine covers file selection, waiting/share link, receiver acceptance, connecting, transferring, reconnecting, completed, cancelled, and failed states.
- Production module boundaries are documented for signaling, WebRTC, crypto, transfer control, persistence, UI state, and diagnostics.
- Every production network message and data-channel message is documented.
- The browser support matrix, transfer-control protocol, backpressure rules, and resume encryption epochs are resolved before implementation starts.
- Prototype diagnostics are explicitly removed from or isolated outside the production user route.
- `frontend_development_plan.md`, `p2p_data_protocol_spec.md`, `security_e2ee_spec.md`, `ui_ux_flow_spec.md`, and `testing_strategy.md` are synchronized.

## Notes

- Dependencies: full backend `BE-7` passes and contracts are frozen.
- Excluded scope: React implementation, crypto implementation, file transfer, and Playwright setup.

---

## 15. Refactoring: Isolate reusable production-safe prototype modules

The frontend extracts only production-safe signaling and WebRTC code from the prototype so final product screens do not depend on diagnostic UI state or insecure shortcuts.

## Acceptance Criteria

- Reusable signaling code consumes the frozen production room authorization and Socket.IO contracts.
- Reusable WebRTC code supports the documented production ICE configuration and connection-state reporting.
- Prototype-only event logs, malformed-input controls, ping/pong controls, and raw diagnostic payload views are excluded from the production route.
- Unit tests cover production module initialization, cleanup, and error propagation without diagnostic UI dependencies.
- Documentation identifies which prototype modules are retained, changed, or discarded.

## Notes

- Dependencies: ticket 14.
- Excluded scope: E2EE, file transfer, final visual implementation, and browser E2E tests.

---

## 16. Security: Implement URL fragment key lifecycle

When a sender creates a production room and a receiver opens a share link, I want the frontend to generate, encode, extract, and remove the master key safely, so the key never reaches the backend or remains visible in the address bar.

## Acceptance Criteria

- The sender generates a 256-bit master key with `crypto.getRandomValues`.
- The generated share URL uses URL-safe Base64 key encoding in the fragment.
- The receiver extracts the key from `window.location.hash` and removes the fragment with `window.history.replaceState`.
- Invalid, missing, or malformed keys produce a safe user-visible error state.
- No key material is sent in HTTP requests, Socket.IO payloads, logs, event logs, or UI diagnostics.
- Unit tests cover key generation length, URL-safe encoding and decoding, hash extraction, hash cleanup, and malformed key handling.
- `security_e2ee_spec.md` and `security_audit_open_source.md` stay synchronized with the implementation.

## Notes

- Dependencies: ticket 15.
- Excluded scope: HKDF derivation, metadata encryption, chunk encryption, and QR generation.

---

## 17. Security: Implement HKDF and AES-GCM metadata encryption

When file metadata is exchanged, I want it encrypted with a metadata-specific AES-GCM key, so filenames, file sizes, MIME types, and optional checksums never reach the backend or peers without the fragment key.

## Acceptance Criteria

- The frontend imports the master key and derives a `shipri-metadata-v1` AES-GCM key with HKDF, SHA-256, and the documented room salt.
- Metadata encryption uses a random 12-byte IV generated with Web Crypto.
- Metadata decryption rejects invalid tags, malformed payloads, missing fields, and wrong keys.
- The wire payload uses `META_ENCRYPTED` and never sends plaintext `META`.
- Unit tests cover encryption/decryption round trips, invalid tags, wrong keys, IV length, payload validation, and absence of plaintext metadata in serialized messages.
- `security_e2ee_spec.md` and `p2p_data_protocol_spec.md` stay synchronized with the metadata wire format.

## Notes

- Dependencies: ticket 16.
- Excluded scope: Binary chunk encryption, file slicing, receiver acceptance UI, and persistence.

---

## 18. Security: Implement epoch-safe chunk crypto primitives

When encrypted file chunks are sent or resumed, I want deterministic IVs and transfer-epoch keys, so AES-GCM never reuses a key and IV pair.

## Acceptance Criteria

- The frontend derives chunk encryption keys with the documented `shipri-file-chunks-v1` domain and transfer epoch separation.
- The chunk IV generator returns the documented 12-byte big-endian counter IV for each chunk index.
- Chunk encryption and decryption authenticate every chunk and fail closed on tag mismatch.
- Resume or retry epochs derive a new chunk key before reusing any chunk index.
- Unit tests cover IV boundaries, chunk round trips, tampered chunks, wrong epochs, domain separation from metadata keys, and resumed index behavior.
- `security_e2ee_spec.md` and `p2p_data_protocol_spec.md` document the final epoch and IV behavior.

## Notes

- Dependencies: ticket 17 and the resolved transfer-control/resume contract from ticket 14.
- Excluded scope: Data-channel integration, file slicing, persistence, and UI progress.

---

## 19. Feature: Build the secure production WebRTC control plane

When two production clients connect, I want dedicated control and binary channels plus encrypted metadata exchange, so the receiver can accept or decline without exposing plaintext metadata to the backend.

## Acceptance Criteria

- The frontend creates reliable `shipri-control` and `shipri-binary` data channels according to the P2P protocol.
- The sender sends encrypted metadata over the control channel after WebRTC opens.
- The receiver decrypts metadata locally and can accept, decline, or cancel through documented control messages.
- Relay warnings, connection status, and cancellation events propagate through production state transitions.
- Plaintext metadata, file chunks, and keys do not enter Socket.IO payloads or logs.
- Unit tests cover control-channel open, encrypted metadata handling, accept, decline, cancel, relay warning, and error states with mocked data channels.
- `frontend_development_plan.md`, `p2p_data_protocol_spec.md`, and `ui_ux_flow_spec.md` stay synchronized.

## Notes

- Dependencies: tickets 15 through 18.
- Excluded scope: Sending binary file chunks, disk persistence, final polished screens, and resume.

---

## 20. Feature: Implement bounded sender-side encrypted chunk streaming

When a sender starts a transfer, I want the frontend to read, encrypt, and send file chunks sequentially with WebRTC backpressure, so large files do not exhaust browser memory.

## Acceptance Criteria

- The sender slices the selected file sequentially with the documented 64 KB chunk size unless the frozen contract changes it.
- The sender encrypts each chunk before sending it on `shipri-binary`.
- The sender respects `RTCDataChannel.bufferedAmount`, `bufferedAmountLowThreshold`, `BUFFER_THRESHOLD`, and `BUFFER_MAX` backpressure rules.
- Pause, resume, cancel, final partial chunk, and sender-side transfer-complete paths are implemented.
- Unit tests cover slice boundaries, final partial chunk, backpressure pause/resume, cancel, transfer-complete signaling, and encryption failure.
- `p2p_data_protocol_spec.md` stays synchronized with the implemented sender mechanics.

## Notes

- Dependencies: tickets 18 and 19.
- Excluded scope: Receiver disk writes, browser persistence fallbacks, reconnection, and final UX polish.

---

## 21. Feature: Implement File System Access receiver persistence

When a Chromium-family receiver accepts a transfer, I want decrypted chunks written directly through the File System Access API, so the MVP path can handle large files without accumulating them in memory.

## Acceptance Criteria

- Capability detection gates the File System Access path before transfer acceptance.
- The receiver calls `showSaveFilePicker` before acknowledging readiness.
- The receiver decrypts chunks in order and writes them directly to `FileSystemWritableFileStream`.
- Decryption failure aborts the transfer, closes or cleans up the writable stream safely, and sends `TRANSFER_ERROR` with `DECRYPTION_FAILED`.
- Successful completion closes the writable stream and verifies the expected chunk count.
- Unit tests cover capability detection, save cancellation, ordered writes, final close, decryption failure, and cleanup behavior with mocked browser APIs.
- `p2p_data_protocol_spec.md`, `frontend_development_plan.md`, and `ui_ux_flow_spec.md` document the MVP persistence path.

## Notes

- Dependencies: tickets 18 through 20.
- Excluded scope: Service Worker streaming, IndexedDB fallback, full cross-browser persistence, and resume.

---

## 22. Feature: Implement production transfer progress and controls

When a transfer is active, I want progress, speed, ETA, pause, resume, cancel, completion, and authentication failure states, so users understand and control the transfer safely.

## Acceptance Criteria

- The UI displays percentage, bytes sent or received, current speed, moving-average ETA, connection status, and relay warning when applicable.
- Pause, resume, and cancel controls send the documented control messages and update both peers consistently.
- Completion, cancellation, peer disconnect, authentication failure, and transfer error states are visible and recoverable according to the production state machine.
- Progress never resets incorrectly during pause or transient connection-state changes.
- Unit tests cover progress calculations, moving-average ETA, control-state transitions, cancel behavior, completion, and authentication failure rendering.
- `ui_ux_flow_spec.md` and `p2p_data_protocol_spec.md` stay synchronized with the implemented controls.

## Notes

- Dependencies: tickets 19 through 21.
- Excluded scope: Reconnection/resume after transport interruption and alternate persistence paths.

---

## 23. Feature: Build production file selection and share-link UX

When a sender opens Shipri, I want to select or drop one file and receive a secure share link, so I can start the production transfer flow without diagnostic controls.

## Acceptance Criteria

- The sender screen supports click-to-select and drag-and-drop for the MVP one-file transfer.
- File name, type, and human-readable size are displayed only in the sender UI before encrypted metadata exchange.
- Room creation, master-key generation, and share-link creation run in the documented order.
- Copy-link feedback is implemented without exposing keys outside the intended URL fragment.
- The UI uses vanilla React/Vite and project-local CSS with no unapproved UI or animation dependencies.
- Unit tests cover file selection, drag-over state, room creation ordering, share-link construction, copy feedback, and room creation failure.
- `ui_ux_flow_spec.md` and `security_e2ee_spec.md` stay synchronized with the production sender flow.

## Notes

- Dependencies: tickets 16, 19, and the frozen production room contract.
- Excluded scope: QR generation, receiver acceptance screen, active transfer screen, multiple-file support, and prototype diagnostics.

---

## 24. Feature: Build receiver acceptance and transfer screens

When a receiver opens a valid share link, I want to review encrypted metadata after local decryption and accept or decline the transfer, so the file is saved only after explicit consent.

## Acceptance Criteria

- The receiver route extracts room ID and fragment key, joins the room, and removes the key from the visible URL.
- The receiver displays decrypted file name, type, size, and sender connection status only after metadata decrypts successfully.
- Accept starts the supported persistence path and sends `META_ACK` only when the receiver is ready.
- Decline and cancel notify the sender and return both clients to documented states.
- Active transfer and completion screens match the production state machine and exclude diagnostic controls.
- Unit tests cover valid link flow, missing key, invalid room, metadata decryption failure, accept, decline, cancel, and completion rendering.
- `ui_ux_flow_spec.md`, `security_e2ee_spec.md`, and `frontend_development_plan.md` stay synchronized.

## Notes

- Dependencies: tickets 17, 21, 22, and 23.
- Excluded scope: QR generation, alternate persistence paths, reconnection/resume, and final Playwright coverage.

---

## 25. Feature: Add approved QR sharing to the sender flow

When a sender waits for a receiver, I want an approved QR code for the full room URL, so a receiver can join from another device without manual link entry.

## Acceptance Criteria

- QR generation uses an approved dependency or an approved local implementation.
- The QR code encodes the full share URL including the fragment key.
- The QR module is high contrast and remains readable in responsive sender layouts.
- The QR code is never sent to the backend or logged.
- Unit tests cover QR input generation, missing URL state, and copy-link coexistence.
- `ui_ux_flow_spec.md` documents the selected QR approach and any dependency approval.

## Notes

- Dependencies: ticket 23.
- Excluded scope: Adding an unapproved QR dependency, receiver flow changes, and visual release polish beyond the QR module.

---

## 26. Feature: Implement bounded reconnection and WebRTC renegotiation

When the network drops during a transfer, I want bounded reconnect attempts and renegotiation, so recoverable interruptions do not always fail the transfer.

## Acceptance Criteria

- The frontend attempts reconnection up to the documented limit and exposes the current attempt count in UI state.
- WebRTC renegotiation uses the frozen signaling contract after Socket.IO reconnects.
- The transfer pauses while reconnecting and resumes only after channels reopen and resume state is authenticated.
- Failure after the retry limit transitions to the documented failed state and notifies both peers when possible.
- Unit tests cover reconnect start, attempt limits, successful renegotiation, retry exhaustion, peer cancellation, and UI overlay state.
- `ui_ux_flow_spec.md`, `p2p_data_protocol_spec.md`, and `testing_strategy.md` document reconnection behavior.

## Notes

- Dependencies: tickets 19 through 22 and the frozen resume contract.
- Excluded scope: Resume key epoch implementation and browser E2E interruption tests.

---

## 27. Security: Implement safe resume with transfer epoch rotation

When a transfer resumes, I want the sender and receiver to authenticate resume state and rotate chunk keys by epoch, so resumed chunks do not corrupt output or reuse AES-GCM key/IV pairs.

## Acceptance Criteria

- The receiver tracks the last fully written chunk and sends an authenticated `RESUME_REQUEST`.
- The sender resumes from the next required chunk only after validating resume state.
- Each resumed transfer epoch derives a fresh chunk key before reusing any chunk index.
- Output integrity is preserved across interruption and resume.
- Unit tests cover last-written tracking, authenticated resume validation, stale or forged resume rejection, epoch rotation, duplicate chunk handling, and output integrity.
- `security_e2ee_spec.md` and `p2p_data_protocol_spec.md` document the final resume and epoch behavior.

## Notes

- Dependencies: tickets 18, 21, 22, and 26.
- Excluded scope: Service Worker streaming, IndexedDB fallback, and Playwright interruption tests.

---

## 28. Feature: Add browser capability detection and persistence limits

When a user starts or accepts a transfer, I want the frontend to detect supported browser capabilities and file-size limits, so it never promises unsupported unlimited transfers.

## Acceptance Criteria

- The frontend detects File System Access API, Service Worker streaming prerequisites, IndexedDB fallback support, secure context availability, and relevant storage limitations.
- The receiver sees accurate unsupported-browser or size-limit messaging before accepting a transfer.
- The sender sees accurate limitation messaging when the current browser cannot support the selected transfer path.
- Capability results are documented in the browser support matrix.
- Unit tests cover supported Chromium, missing secure context, missing File System Access, Service Worker candidate, IndexedDB fallback candidate, and unsupported paths.
- `frontend_development_plan.md`, `p2p_data_protocol_spec.md`, and `ui_ux_flow_spec.md` stay synchronized.

## Notes

- Dependencies: tickets 21 through 24.
- Excluded scope: Implementing Service Worker streaming, IndexedDB fallback storage, and Playwright cross-browser tests.

---

## 29. Feature: Implement Service Worker streaming persistence

When a supported non-File-System-Access browser receives a file, I want the frontend to stream decrypted chunks through a Service Worker download path, so compatible browsers can save files without accumulating them in memory.

## Acceptance Criteria

- The Service Worker path is enabled only for verified supported browsers and secure contexts.
- The main thread creates a streaming download session before sending `META_ACK`.
- Decrypted chunks are forwarded to the Service Worker stream in order.
- Completion closes the stream and cancellation or errors abort the download path cleanly.
- Unit tests cover registration, stream session creation, chunk forwarding, completion, cancellation, and unsupported-browser fallback.
- Browser-specific limitations are documented in `p2p_data_protocol_spec.md`, `frontend_development_plan.md`, and `testing_strategy.md`.

## Notes

- Dependencies: ticket 28.
- Excluded scope: IndexedDB fallback, release Playwright coverage, and claiming arbitrary file-size support for unverified browsers.

---

## 30. Feature: Implement size-limited IndexedDB persistence fallback

When no streaming persistence path is available, I want a clearly size-limited IndexedDB fallback, so smaller transfers can complete without pretending to support arbitrary file sizes.

## Acceptance Criteria

- The fallback is available only when capability detection and quota checks indicate the selected file size is safe.
- Chunks are stored in IndexedDB without constructing the full output Blob until completion.
- Completion creates the final downloadable Blob and releases temporary records.
- Cancellation, failure, and tab cleanup remove temporary IndexedDB records.
- The UI clearly communicates fallback size limits before receiver acceptance.
- Unit tests cover quota rejection, ordered chunk storage, completion, cleanup, cancellation, and error handling with mocked IndexedDB.
- `p2p_data_protocol_spec.md` and `ui_ux_flow_spec.md` document fallback limitations.

## Notes

- Dependencies: ticket 28.
- Excluded scope: Service Worker streaming, unlimited file-size claims, and resume across browser restarts.

---

## 31. Chore: Add approved Playwright release E2E setup

When the production transfer flow is ready for browser validation, I want an approved Playwright setup, so secure transfer scenarios can run across browser contexts.

## Acceptance Criteria

- The approved Playwright dependency and frontend E2E script are configured.
- E2E configuration can launch separate sender and receiver browser contexts.
- Tests can create deterministic virtual files without committing fixtures with private data.
- Local test instructions and any required browser flags are documented.
- The setup does not require production secrets or external SaaS.
- `testing_strategy.md` documents the active Playwright setup.

## Notes

- Dependencies: tickets 23 and 24 are implemented enough to drive the production flow.
- Excluded scope: Writing every release scenario, adding Playwright without explicit dependency approval, and CI setup unless approved separately.

---

## 32. Chore: Cover secure transfer release scenarios

When the final frontend nears release, I want browser E2E coverage for secure direct and relay transfers, so production behavior is verified through real browser APIs.

## Acceptance Criteria

- E2E tests cover sender-to-receiver secure transfer with byte-for-byte output verification.
- E2E tests cover room errors, decline, cancel, authentication failure, and completion states.
- E2E tests cover forced TURN with `iceTransportPolicy: "relay"` after production TURN is available.
- E2E tests cover network interruption and safe resume after resume support is implemented.
- Tests verify keys and plaintext metadata are absent from captured network requests and visible diagnostics.
- Frontend unit tests, E2E tests, and `npm run build` pass.
- `testing_strategy.md` documents the release scenario coverage.

## Notes

- Dependencies: tickets 21 through 31 and production TURN availability.
- Excluded scope: Load testing, third-party analytics, and unapproved external test services.

---

## 33. Chore: Complete final frontend release gate

When all final frontend features are implemented, I want a release gate that verifies documentation, security, accessibility, responsiveness, performance, and browser limitations, so Shipri ships with behavior matching its specifications.

## Acceptance Criteria

- Supported browsers complete documented direct-P2P and forced-TURN transfer scenarios.
- Responsive layouts, keyboard navigation, focus management, status messaging, and error copy are reviewed and corrected.
- Representative memory usage stays bounded for the supported transfer paths.
- Transfer performance is measured with representative files and documented.
- Security checks confirm no E2EE keys, plaintext metadata, or file contents appear in backend payloads, logs, or diagnostic UI.
- `npm run build`, frontend unit tests, and approved Playwright scenarios pass.
- `frontend_development_plan.md`, `ui_ux_flow_spec.md`, `p2p_data_protocol_spec.md`, `security_e2ee_spec.md`, `security_audit_open_source.md`, and `testing_strategy.md` match the released behavior and limitations.

## Notes

- Dependencies: tickets 14 through 32.
- Excluded scope: New product features beyond the documented one-file MVP.
