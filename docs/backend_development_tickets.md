# Full Backend Development Ticket Backlog

These atomic tickets implement `backend_development_plan.md` in dependency order. They bridge the accepted Backend POC and frontend prototype foundation to the final frontend work.

Existing GitHub issues targeted for synchronization: #53 through #60. Ticket 1 maps to issue #53 and ticket 8 maps to issue #60.

---

## 1. Documentation: Finalize full backend contracts and prototype scenarios

When full backend development begins, I want room authorization, lifecycle, validation, ICE, TURN, and prototype acceptance scenarios frozen, so implementation does not break frontend prototype or final frontend assumptions.

## Acceptance Criteria

- The room authorization model is defined independently from the short public room ID.
- The accepted Backend POC contract is migrated without breaking the frontend prototype unless a documented security correction requires it.
- Socket.IO event schemas, validation rules, stable error codes, disconnect behavior, TTL, capacity, rate limits, and maximum active room count are documented.
- Environment-driven ICE server and TURN credential response contracts are documented.
- Every backend acceptance scenario is exposed by the frontend prototype plan.
- `signaling_protocol_spec.md`, `security_audit_open_source.md`, `nat_traversal_strategy.md`, and `deployment_docker_spec.md` are synchronized.

## Notes

- Excluded scope: Runtime implementation, Docker deployment, Coturn hardening, and final frontend implementation.

---

## 2. Refactoring: Establish the full backend server and test foundation

The backend evolves the accepted POC server, room storage, validation, and configuration modules into a production-ready testable foundation without breaking accepted behavior.

## Acceptance Criteria

- The accepted Backend POC Vitest setup, `test` script, package lockfile, and clean `npm ci` workflow are preserved.
- Server construction and cleanup remain testable through isolated in-process integration tests.
- Configuration and health tests cover production requirements introduced by the full backend contract.
- Existing POC lifecycle, signaling, and health behavior remains covered by regression tests.
- Backend tests and syntax checks pass from a clean install.

## Notes

- Excluded scope: Production authorization logic, abuse controls, TURN credentials, Docker, and Coturn hardening.

---

## 3. Security: Implement the secure full backend room lifecycle

When peers create, join, leave, disconnect, or expire from rooms, I want the backend to enforce authorization, membership, capacity, TTL, and cleanup rules, so only valid equal peers can use a room.

## Acceptance Criteria

- Room authorization tokens are implemented according to the frozen contract and are independent from short room IDs.
- All event payloads are strictly validated and malformed room IDs are rejected.
- Exactly two authorized equal room peers are allowed.
- Unauthorized sockets cannot join rooms or relay signaling.
- `room:leave`, either-peer disconnect, empty-room teardown, idle TTL, maximum lifetime, and garbage collection behave as documented.
- Integration tests cover creation, joining, third-peer rejection, malformed input, unauthorized signal injection, either-peer leave, either-peer disconnect, TTL, and cleanup.
- The frontend prototype visibly confirms lifecycle and stable error behavior.

## Notes

- Excluded scope: Rate limiting, TURN credential generation, Docker deployment, and Coturn hardening.

---

## 4. Security: Implement backend abuse controls and safe logging

When the backend receives malformed, excessive, or unauthorized traffic, I want it to fail predictably without logging secrets or private transfer data.

## Acceptance Criteria

- Room-creation rate limits and maximum active room count are implemented.
- Trusted proxy behavior is defined before applying IP-based limits.
- Socket.IO and HTTP CORS are restricted through validated environment configuration.
- Logs contain operational events without secrets, tokens, SDP bodies, ICE credentials, E2EE keys, file metadata, board state, file requests, or file contents.
- Stable `SERVER_BUSY`, rate-limit, authorization, and validation errors are returned.
- Abuse-control integration tests pass.
- Security and signaling documentation are synchronized.

## Notes

- Excluded scope: TURN credential generation, Docker deployment, and Coturn operational hardening.

---

## 5. Feature: Implement authorized ICE and TURN credential service

When an authorized peer requests ICE configuration, I want the backend to return configured STUN and short-lived TURN credentials without exposing the shared TURN secret.

## Acceptance Criteria

- `ice:get` is authorized for active room members according to the frozen contract.
- Coturn REST credentials are generated with HMAC-SHA1 and a documented TTL.
- TURN endpoints, credential TTL, and `TURN_SHARED_SECRET` are read from validated environment configuration.
- Missing or invalid production TURN configuration fails safely.
- Client responses and logs never expose `TURN_SHARED_SECRET`.
- Tests verify credential format, signature, expiry, authorization, and missing-secret behavior.
- The frontend prototype receives valid ICE configuration without exposing credentials unnecessarily.

## Notes

- Excluded scope: Coturn server hardening, Docker deployment, and frontend forced-TURN diagnostics.

---

## 6. Infrastructure: Make backend runtime and Docker deployment reproducible

When Shipri is deployed, I want server, client, proxy, and environment configuration to be reproducible and secret-safe.

## Acceptance Criteria

- Committed placeholder secrets are removed from Compose and Coturn configuration.
- Secrets use environment substitution or generated deployment configuration.
- The obsolete Compose `version` field is removed.
- Health and readiness checks are added for relevant services.
- Development and production Caddy routing and CORS settings are finalized.
- Clean client and server Docker images build reproducibly using package lockfiles.
- `docker compose config` contains no committed secret value.
- Deployment documentation is synchronized.

## Notes

- Excluded scope: Coturn relay hardening, forced-TURN validation, and final frontend deployment.

---

## 7. Infrastructure: Harden Coturn and NAT traversal

When direct P2P fails, I want Coturn and NAT traversal configured securely, so forced relay connections work without port conflicts or credential leakage.

## Acceptance Criteria

- Coturn external IP, relay port range, quotas, realm, certificates, and allowed protocols are configured.
- `turn.shipri.app:443` or an equivalent separate endpoint is documented and does not conflict with Caddy on `shipri.app:443`.
- UDP/TCP TURN and TURNS behavior is validated.
- Expired or invalid TURN credentials are rejected.
- Secret rotation and certificate renewal procedures are documented.
- A forced `iceTransportPolicy: "relay"` prototype connection and data-channel exchange succeeds.

## Notes

- Excluded scope: Final frontend file transfer and release E2E coverage.

---

## 8. Chore: Complete the full backend acceptance gate

When full backend implementation is complete, I want every backend and prototype acceptance scenario verified, so final frontend development can start from frozen contracts.

## Acceptance Criteria

- Signaling integration, abuse-control, direct-connectivity, forced-TURN, and deployment checks pass.
- Graceful shutdown and room cleanup behavior are validated.
- Health, readiness, capacity, and error metrics are defined without user tracking.
- Deployment rollback and configuration validation procedures are verified.
- The backend security audit checklist is completed against the implementation.
- Every documented frontend prototype acceptance scenario passes.
- Socket.IO, room authorization, ICE, TURN, and deployment contracts are frozen for final frontend development.
- Production documentation matches the released configuration.

## Notes

- Excluded scope: Final frontend implementation.
