# Backend POC Ticket Backlog

These ticket drafts implement `backend_poc_plan.md` in dependency order. Each ticket includes its relevant tests and documentation updates.

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

- The POC room lifecycle documents create, join, leave, receiver disconnect, and host disconnect behavior.
- Stable POC error codes and their triggering conditions are documented.
- Room capacity is documented as one host and one receiver.
- Deferred TTL, rate-limit, and production authorization behavior is explicitly excluded.
- Relevant protocol and testing documentation is updated.

## Notes

- Depends on ticket 1.

---

## 3. Documentation: Define the Backend POC development ICE contract

When I create a WebRTC connection in the frontend prototype, I want a documented development ICE response, so I can initialize `RTCPeerConnection` consistently.

## Acceptance Criteria

- The `ice:get` request and `ice:credentials` response schemas are documented.
- The POC response contains only approved public STUN endpoints.
- The documentation clearly states that TURN credentials are deferred.
- Relevant signaling, NAT traversal, and testing documentation is updated.

## Notes

- Depends on ticket 1.

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
- Depends on tickets 1 through 3.

---

## 5. Refactoring: Separate backend server construction from process startup

The backend server construction and process startup are separated so integration tests can start isolated server instances without importing a listening production process.

## Acceptance Criteria

- Server construction returns the Express app, HTTP server, Socket.IO server, and required cleanup interface.
- Process startup remains available through the documented `start` and `dev` commands.
- Tests start the server on an isolated port and close it cleanly.
- Existing health and Socket.IO connectivity behavior remains available.

## Notes

- Depends on ticket 4.

---

## 6. Feature: Add validated Backend POC runtime configuration

When I run the Backend POC locally or on staging, I want validated environment-driven configuration, so startup behavior is predictable and invalid settings fail clearly.

## Acceptance Criteria

- The server reads the listening port, allowed origins, and development STUN endpoints from a centralized configuration module.
- Invalid required configuration causes a clear startup failure.
- Local development defaults are documented.
- Configuration tests cover valid and invalid values.
- No production or placeholder secrets are introduced.

## Notes

- Depends on ticket 5.

---

## 7. Feature: Add a verifiable Backend POC health endpoint

When I run or deploy the Backend POC, I want a stable health endpoint, so local checks and staging automation can verify availability.

## Acceptance Criteria

- `GET /health` returns a successful JSON response with POC service status.
- The endpoint does not expose secrets or private transfer data.
- Integration tests verify the health response and status code.
- The health contract is documented for local and staging checks.

## Notes

- Depends on tickets 5 and 6.

---

## 8. Fix: Generate and validate canonical POC room IDs

When rooms are created or joined, I want canonical validated room IDs, so malformed channel names and predictable allocation behavior are rejected.

## Acceptance Criteria

- Generated room IDs match `ship-[a-f0-9]{4}`.
- Room ID generation uses Node.js cryptographic randomness instead of `Math.random()`.
- Join and signaling payloads reject malformed room IDs with the documented validation error.
- Unit tests cover valid IDs, malformed IDs, and generation format.
- Relevant signaling documentation is updated.

## Notes

- Depends on tickets 2, 4, and 5.

---

## 9. Feature: Implement Backend POC room creation

When I act as a host, I want to create a room, so a receiver can later join the signaling session.

## Acceptance Criteria

- `room:create` creates an in-memory room with the requesting socket as host.
- The host joins the corresponding Socket.IO room.
- `room:created` returns the documented POC payload.
- Generated room IDs are unique among active rooms.
- Integration tests verify successful room creation.

## Notes

- Depends on ticket 8.

---

## 10. Feature: Implement receiver join and room capacity behavior

When I act as a receiver, I want to join an available room and receive stable errors for invalid attempts, so room capacity behavior is predictable.

## Acceptance Criteria

- `room:join` connects one receiver to an existing room.
- The receiver receives `room:joined` and the host receives `peer:joined`.
- Unknown rooms return `ROOM_NOT_FOUND`.
- A third peer receives `ROOM_FULL`.
- Integration tests cover successful join, unknown room, malformed room ID, and third-peer rejection.

## Notes

- Depends on ticket 9.

---

## 11. Feature: Implement explicit room leave behavior

When a connected peer intentionally leaves a room, I want the backend to update room state immediately, so the remaining peer does not wait for a socket disconnect.

## Acceptance Criteria

- `room:leave` removes the requesting socket from its active room.
- A receiver leave keeps the host room available and notifies the host.
- A host leave closes the room and notifies the receiver.
- Repeated or unauthorized leave requests return the documented error behavior.
- Integration tests cover host and receiver leave scenarios.

## Notes

- Depends on tickets 9 and 10.

---

## 12. Fix: Clean up POC rooms and notify peers on disconnect

When a peer disconnects unexpectedly, I want room state and peer notifications to remain correct, so stale rooms do not block later testing.

## Acceptance Criteria

- A host disconnect closes and removes its room.
- A receiver disconnect clears the receiver slot while preserving the host room.
- The remaining peer receives the documented stable disconnect error.
- Disconnected sockets are removed from the Socket.IO room.
- Integration tests verify cleanup and notifications for both roles.

## Notes

- Depends on tickets 9 and 10.

---

## 13. Security: Restrict signaling relay to active room members

When SDP or ICE data is forwarded, I want only active room members to relay signals, so unrelated sockets cannot inject signaling messages.

## Acceptance Criteria

- `signal:forward` accepts messages only from the active host or receiver of the specified room.
- Valid signals are delivered only to the other active room member.
- Unknown rooms, malformed payloads, missing peers, and non-member senders follow documented error behavior.
- The backend does not inspect or mutate valid `signalData`.
- Integration tests verify bidirectional relay and unauthorized-sender rejection.
- Security and signaling documentation is updated.

## Notes

- Depends on tickets 8 through 10.

---

## 14. Feature: Implement the Backend POC development ICE response

When the frontend prototype requests ICE configuration, I want the Backend POC to return approved STUN servers, so direct WebRTC testing can begin.

## Acceptance Criteria

- `ice:get` returns the documented `ice:credentials` payload.
- The response contains configured public STUN endpoints and no TURN credentials.
- Invalid ICE configuration produces the documented configuration error.
- Tests verify successful and invalid configuration responses.
- The response is documented as development-only.

## Notes

- Depends on tickets 3 and 6.

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

- Depends on tickets 6 and 7.
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

## Notes

- Depends on ticket 15 and completed POC server behavior.

---

## 17. Infrastructure: Add Backend POC staging smoke checks

When the POC staging deployment changes, I want repeatable smoke checks, so broken HTTPS or WSS routing is detected immediately.

## Acceptance Criteria

- A documented check verifies the HTTPS health endpoint.
- A documented check verifies a remote Socket.IO connection through WSS.
- Failed checks return clear non-zero results or failure output.
- Smoke checks do not require production secrets.
- Deployment documentation explains when to run the checks.

## Notes

- Depends on ticket 16.

---

## 18. Documentation: Define Backend POC deployment operations

When I operate the POC staging environment, I want documented deploy, update, rollback, and log-inspection procedures, so failures can be diagnosed and reversed safely.

## Acceptance Criteria

- Deployment documentation describes initial deployment and routine updates.
- Rollback steps restore the previous working POC version.
- Log-inspection steps avoid exposing secrets or private payloads.
- The procedure references the staging smoke checks.
- The documentation clearly states that the environment is not production-ready.

## Notes

- Depends on tickets 16 and 17.

---

## 19. Chore: Complete the Backend POC acceptance gate

When frontend prototype development is ready to begin, I want the Backend POC acceptance gate completed, so the prototype integrates against a tested and frozen minimum contract.

## Acceptance Criteria

- All Backend POC unit and Socket.IO integration tests pass.
- Local startup, syntax, HTTPS health, and remote WSS checks pass.
- POC limitations and excluded production behavior are documented.
- Local and staging frontend prototype connection instructions are documented.
- The POC event contract is frozen for frontend prototype foundation work.
- `backend_poc_plan.md` records the completed acceptance evidence.

## Notes

- Depends on tickets 1 through 18.
- Completing this ticket allows `frontend_prototype_plan.md` implementation to begin.
