# Backend POC Ticket Backlog

These ticket drafts implement `backend_poc_plan.md` in dependency order. Each ticket includes its relevant tests and documentation updates.

Existing GitHub issues targeted for synchronization: #1 through #19.

---

## 1. Documentation: Define the Backend POC Socket.IO event contract

When I build a client against the Backend POC, I want every supported Socket.IO event and payload to be documented, so I can integrate without relying on implementation assumptions.

## Acceptance Criteria

- The POC contract documents the direction and payload schema for every supported Socket.IO event.
- All payload fields use the canonical `roomId` camelCase naming.
- The contract distinguishes POC behavior from deferred production behavior.
- `signaling_protocol_spec.md`, `backend_poc_plan.md`, and `testing_strategy.md` are synchronized.

## Notes

- This ticket defines contracts only and does not implement event handlers.

---

## 2. Documentation: Define the Backend POC room lifecycle and error contract

When I test room behavior, I want stable lifecycle transitions and error codes, so I can reliably verify successful and failing scenarios.

## Acceptance Criteria

- The POC room lifecycle documents create, join, either-peer leave, either-peer disconnect, and empty-room cleanup behavior.
- The lifecycle documents that one socket may have at most one active Shipri room membership.
- Replacement-peer behavior is documented: after either peer leaves or disconnects, the remaining peer stays in the room, becomes the next `offerer`, and a future replacement peer joins as `answerer`.
- Repeated leave behavior is documented for both one-peer and two-peer cleanup paths.
- Stable POC error codes and their triggering conditions are documented.
- Error precedence is documented so malformed payloads, invalid `roomId`, missing rooms, membership failures, capacity, peer availability, and service configuration errors resolve predictably.
- Room capacity is documented as two equal peers; creator/joiner identities define negotiation duties only.
- Deferred TTL, rate-limit, production authorization, and production garbage-collection behavior is explicitly excluded from the Backend POC.
- Relevant protocol and testing documentation is updated.

---

## 3. Documentation: Define the Backend POC development ICE contract

When I create a WebRTC connection in the frontend prototype, I want a documented development ICE response, so I can initialize `RTCPeerConnection` consistently.

## Acceptance Criteria

- The `ice:get` request and `ice:credentials` response schemas are documented.
- The POC response contains only approved public STUN endpoints.
- The documentation clearly states that TURN credentials are deferred.
- Relevant signaling, NAT traversal, and testing documentation is updated.

---

## 4. Chore: Add the Backend POC test foundation

When I implement POC behavior, I want automated unit and Socket.IO integration tests, so regressions are detected before frontend prototype development begins.

## Acceptance Criteria

- The approved Vitest dependency and backend `test` script are configured.
- A package lockfile is committed and `npm ci` succeeds from a clean checkout.
- Test helpers can create and close Socket.IO clients without leaking handles.
- A baseline test suite runs successfully.
- `testing_strategy.md` documents the active Backend POC test setup.

## Notes

- Adding Vitest requires explicit dependency approval.

---

## 5. Refactoring: Separate backend server construction from process startup

The backend server construction and process startup are separated so integration tests can start isolated server instances without importing a listening production process.

## Acceptance Criteria

- Server construction returns the Express app, HTTP server, Socket.IO server, and required cleanup interface.
- Process startup remains available through the documented `start` and `dev` commands.
- Tests start the server on an isolated port and close it cleanly.
- Existing health and Socket.IO connectivity behavior remains available.

---

## 6. Feature: Add validated Backend POC runtime configuration

When I run the Backend POC locally or on staging, I want validated environment-driven configuration, so startup behavior is predictable and invalid settings fail clearly.

## Acceptance Criteria

- The server reads the listening port, allowed origins, and development STUN endpoints from a centralized configuration module.
- Invalid required configuration causes a clear startup failure.
- Local development defaults are documented.
- Configuration tests cover valid and invalid values.
- No production or placeholder secrets are introduced.

---

## 7. Feature: Add a verifiable Backend POC health endpoint

When I run or deploy the Backend POC, I want a stable health endpoint, so local checks and staging automation can verify availability.

## Acceptance Criteria

- `GET /health` returns a successful JSON response with POC service status.
- The endpoint does not expose secrets or private transfer data.
- Integration tests verify the health response and status code.
- The health contract is documented for local and staging checks.

---

## 8. Fix: Generate and validate canonical POC room IDs

When rooms are created or joined, I want canonical validated room IDs, so malformed channel names and predictable allocation behavior are rejected.

## Acceptance Criteria

- Generated room IDs match `ship-[a-f0-9]{4}`.
- Room ID generation uses Node.js cryptographic randomness instead of `Math.random()`.
- Join and signaling payloads reject malformed room IDs with the documented validation error.
- Unit tests cover valid IDs, malformed IDs, and generation format.
- Relevant signaling documentation is updated.

---

## 9. Feature: Implement Backend POC room creation for the first peer

When I am the first peer, I want to create a room, so a second equal peer can join the signaling session.

## Acceptance Criteria

- `room:create` creates an in-memory room with the requesting socket as its first peer.
- `room:create` rejects a socket that already has an active Shipri room membership with the documented membership error.
- The creating peer joins the corresponding Socket.IO room and receives the `offerer` negotiation duty.
- `room:created` returns the documented POC payload.
- Generated room IDs are unique among active rooms.
- Integration tests verify successful room creation and duplicate active membership rejection.

---

## 10. Feature: Implement second-peer join and room capacity behavior

When I open an available room, I want to join as an equal second peer and receive stable errors for invalid attempts, so room capacity behavior is predictable.

## Acceptance Criteria

- `room:join` connects one eligible peer to an existing one-peer room, including a replacement join after a previous peer leaves or disconnects.
- The joining peer receives `room:joined` with `answerer` negotiation duty and the existing peer receives `peer:joined`.
- After a leave or disconnect, the remaining peer is treated as the next `offerer` and the replacement peer joins as `answerer`.
- Creator/joiner and offerer/answerer duties do not imply file owner/downloader roles.
- Unknown rooms return `ROOM_NOT_FOUND`.
- A third peer receives `ROOM_FULL`.
- A socket with an existing active Shipri room membership cannot join another room.
- Integration tests cover successful join, replacement join, unknown room, malformed room ID, duplicate active membership, and third-peer rejection.

---

## 11. Feature: Implement explicit room leave behavior

When a connected peer intentionally leaves a room, I want the backend to update room state immediately, so the remaining peer does not wait for a socket disconnect.

## Acceptance Criteria

- `room:leave` removes the requesting socket from its active room.
- Either peer leave keeps the room available for the remaining peer and emits `peer:left`.
- The remaining peer becomes the next `offerer` for a future replacement peer.
- The room is deleted immediately after the final peer leaves.
- Repeated or unauthorized leave requests follow documented error precedence and return the documented error behavior.
- Integration tests cover either-peer leave, remaining-peer state, replacement join after leave, repeated leave, and empty-room cleanup.

---

## 12. Fix: Clean up POC rooms and notify peers on disconnect

When a peer disconnects unexpectedly, I want room state and peer notifications to remain correct, so stale rooms do not block later testing.

## Acceptance Criteria

- Either peer disconnect removes only that peer and preserves the room for the remaining member.
- The remaining peer receives the documented `peer:left` disconnect notification.
- The remaining peer becomes the next `offerer` for a future replacement peer.
- The room is removed immediately when the final peer disconnects.
- Disconnected sockets are removed from the Socket.IO room.
- Integration tests verify cleanup, notifications for both peer positions, replacement join after disconnect, and empty-room cleanup.

---

## 13. Security: Restrict signaling relay to active room members

When SDP or ICE data is forwarded, I want only active room members to relay signals, so unrelated sockets cannot inject signaling messages.

## Acceptance Criteria

- `signal:forward` accepts messages only from either active peer of the specified room.
- Valid signals are delivered only to the other active room member.
- Unknown rooms, malformed payloads, missing peers, and non-member senders follow documented error behavior.
- Validation follows documented error precedence before any signal is relayed.
- The backend does not inspect or mutate valid `signalData`.
- Integration tests verify bidirectional relay independent of transfer direction and unauthorized-peer rejection.
- Security and signaling documentation is updated.

---

## 14. Feature: Implement the Backend POC development ICE response

When the frontend prototype requests ICE configuration, I want the Backend POC to return approved STUN servers, so direct WebRTC testing can begin.

## Acceptance Criteria

- `ice:get` returns the documented `ice:credentials` payload.
- The response contains configured public STUN endpoints and no TURN credentials.
- Invalid ICE configuration produces the documented configuration error.
- Only active room members can request ICE configuration for their room.
- Tests verify successful responses, unauthorized requests, and invalid configuration responses.
- The response is documented as development-only.

---

## 15. Infrastructure: Define the Backend POC staging environment

When the POC is ready for remote testing, I want a dedicated restricted staging environment, so testing does not expose production services or secrets.

## Acceptance Criteria

- The staging hostname, approved origins, required ports, and access restrictions are documented.
- The staging environment uses no production secrets or production traffic.
- Required DNS and server prerequisites are documented.
- The environment clearly identifies itself as POC staging.
- Deployment documentation is updated.

## Notes

- External DNS and server access must be available before implementation.

---

## 16. Infrastructure: Add a deployable Backend POC staging configuration

When I deploy the Backend POC, I want reproducible server and reverse-proxy configuration, so HTTPS/WSS behavior can be tested consistently.

## Acceptance Criteria

- The Backend POC can be built and started on the staging server using documented commands.
- Caddy terminates HTTPS and proxies `/health` and Socket.IO WSS traffic to the signaling server.
- CORS permits only approved local and staging origins.
- TURN and production secrets are absent from the POC staging configuration.
- Configuration validation and deployment smoke checks are documented.

---

## 17. Infrastructure: Add Backend POC staging smoke checks

When the POC staging deployment changes, I want repeatable smoke checks, so broken HTTPS or WSS routing is detected immediately.

## Acceptance Criteria

- A documented check verifies the HTTPS health endpoint.
- A documented check verifies a remote Socket.IO connection through WSS.
- Failed checks return clear non-zero results or failure output.
- Smoke checks do not require production secrets.
- Deployment documentation explains when to run the checks.

---

## 18. Documentation: Define Backend POC deployment operations

When I operate the POC staging environment, I want documented deploy, update, rollback, and log-inspection procedures, so failures can be diagnosed and reversed safely.

## Acceptance Criteria

- Deployment documentation describes initial deployment and routine updates.
- Rollback steps restore the previous working POC version.
- Log-inspection steps avoid exposing secrets or private payloads.
- The procedure references the staging smoke checks.
- The documentation clearly states that the environment is not production-ready.

---

## 19. Chore: Complete the Backend POC acceptance gate

When frontend prototype development is ready to begin, I want the Backend POC acceptance gate completed, so the prototype integrates against a tested and frozen minimum contract.

## Acceptance Criteria

- All Backend POC unit and Socket.IO integration tests pass.
- Local startup, syntax, HTTPS health, and remote WSS checks pass.
- POC limitations and excluded production behavior are documented, including that transfer roles are never derived from room-entry order.
- Acceptance evidence covers single active membership, replacement-peer joins, next-`offerer` behavior after leave or disconnect, repeated leave behavior, error precedence, and immediate empty-room cleanup.
- Local and staging frontend prototype connection instructions are documented.
- The POC event contract is frozen for frontend prototype foundation work.
- `backend_poc_plan.md` records the completed acceptance evidence.

## Notes

- Completing this ticket allows `frontend_prototype_plan.md` implementation to begin.
