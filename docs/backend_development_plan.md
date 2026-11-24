# Shipri Full Backend Development Plan

This plan covers Part 3: complete development of `server/` and the deployment/networking files after the Backend POC Acceptance Gate and frontend prototype foundation establish the basic signaling workflow.

---

## 1. Backend Goals and Boundaries

The backend is an ephemeral connection coordinator. It must:

* Never receive, store, inspect, or log file contents, plaintext file metadata, or E2EE keys.
* Enforce room authorization, membership, capacity, expiry, and message validation.
* Generate short-lived TURN credentials without exposing `TURN_SHARED_SECRET`.
* Remain operable under malformed input, room-creation abuse, disconnects, and stale connections.
* Provide reproducible local and production deployment configurations.

The backend uses two complementary verification paths:

* Automated unit and Socket.IO integration tests for deterministic protocol behavior.
* The frontend prototype for browser WebRTC, ICE, direct-connectivity, and forced-TURN acceptance scenarios.

Backend completion freezes the contracts consumed by final frontend development.

Full backend development begins only after:

* `backend_poc_plan.md` stage `BP-6` has passed.
* `frontend_prototype_plan.md` stage `FP-G1` has validated the POC through a direct WebRTC data channel.

---

## 2. Backend Stages

### BE-0: Finalize Contracts and Prototype Scenarios

**Status:** Completed (`2026-11-23`) - synchronized full backend contracts across `signaling_protocol_spec.md`, `security_audit_open_source.md`, `nat_traversal_strategy.md`, `deployment_docker_spec.md`, and `frontend_prototype_plan.md` (`FP-5` / `FP-6`) without runtime code edits.

**Work:**

* Define the room authorization model independently from the short public room ID (`shipri-room-auth-v1` HKDF-SHA256 domain separation from `#key=...` with `authVerifier` / `authToken` SHA-256 verification).
* Migrate the accepted POC contract via `REQUIRE_ROOM_AUTH` / `REQUIRE_TURN` without breaking the frontend prototype (`FP-G1`) unless a documented security correction requires it.
* Freeze Socket.IO event schemas, validation precedence, stable error codes (adding `RATE_LIMITED`), and O(1) disconnect/cleanup behavior.
* Define room TTL (`ROOM_IDLE_TTL_MS = 1800000`), maximum lifetime (`ROOM_MAX_LIFETIME_MS = 14400000`), cleanup interval (`ROOM_CLEANUP_INTERVAL_MS = 60000`), capacity (`2` peers per room), rate limits (`ROOM_CREATE_RATE_LIMIT_MAX = 10` / `ROOM_CREATE_RATE_LIMIT_WINDOW_MS = 60000` under `TRUST_PROXY`), and maximum active room count (`MAX_ROOMS = 5000`).
* Define environment-driven ICE server (`STUN_URLS`, `TURN_URLS`, `TURN_SHARED_SECRET`, `TURN_CREDENTIAL_TTL_SECONDS = 7200`, `REQUIRE_TURN`) and TURN credential response contracts.
* Confirm that every backend acceptance scenario is exposed by `frontend_prototype_plan.md` (`FP-5` and `FP-6`).
* Synchronize `signaling_protocol_spec.md`, `security_audit_open_source.md`, `nat_traversal_strategy.md`, and `deployment_docker_spec.md`.

**Synchronized Contract Traceability (`BE-1` through `BE-7`):**

| Stage | Primary Canonical Contracts | Prototype Verification Coverage |
| :--- | :--- | :--- |
| `BE-1` | `deployment_docker_spec.md` (Section `6`), `signaling_protocol_spec.md` (`2.2`, `3.6`) | `FP-G1` health/CORS baseline & live server harness |
| `BE-2` | `signaling_protocol_spec.md` (`2.1`, `2.2`, `3.1` - `3.6`, `4`), `security_audit_open_source.md` (`2.4`, `3.1`, `3.2`) | `FP-6` authorized create/join, rejection matrix, TTL/cleanup |
| `BE-3` | `security_audit_open_source.md` (`3.1` - `3.3`), `signaling_protocol_spec.md` (`2.2`, `3.6`, `5`) | `FP-6` `RATE_LIMITED` / `SERVER_BUSY` & redacted log inspection |
| `BE-4` | `nat_traversal_strategy.md` (`3`), `signaling_protocol_spec.md` (`3.5`), `security_audit_open_source.md` (`4.1`) | `FP-5` dynamic TURN `ice:get` & `SERVER_BUSY` fail-closed check |
| `BE-5` / `BE-6` | `deployment_docker_spec.md` (`2` - `6`), `nat_traversal_strategy.md` (`2`, `4`, `5`) | `FP-5` forced `iceTransportPolicy: "relay"` & direct P2P check |
| `BE-7` | All specifications above plus `architectural_audit.md` | `FP-6` full Backend Acceptance Gate scenario matrix |

**Exit criteria:**

* Every backend event handler has a documented authorization and validation rule.
* The backend contract contains no file data or plaintext metadata.

### BE-1: Establish Backend Test and Server Foundation

**Status:** Completed (`2026-11-23`) - evolved `server/src/config.js`, `server/src/room-store.js`, `server/src/server.js`, and isolated test helpers while preserving the Vitest setup, `server/package-lock.json`, and all Backend POC regression tests.

**Work:**

* Reuse and expand the accepted Backend POC Vitest setup and `test` script.
* Preserve the POC package lockfile and clean `npm ci` workflow.
* Evolve the POC server, room storage, validation, and configuration modules without breaking accepted behavior.
* Expand baseline health and configuration tests for production requirements.

**Exit criteria:**

* Backend tests and syntax checks pass from a clean install.
* Tests can start and stop an isolated signaling server.

### BE-2: Secure Room Lifecycle

**Status:** Completed (`2026-11-24`) - implemented `shipri-room-auth-v1` HKDF-separated verifier/token authorization (`server/src/room-auth.js`), strict payload and 64 KiB `signalData` validation, constant-time `authToken` verification before `ROOM_FULL`, idle TTL / hard lifetime / periodic GC cleanup, and prototype room-auth diagnostic helpers (`client/src/prototype/room-auth.js`).

**Work:**

* Replace `Math.random()` with Node.js CSPRNG.
* Implement room authorization tokens according to the shared contract.
* Strictly validate all event payloads and reject malformed room IDs.
* Enforce a maximum of two authorized, equal room peers.
* Prevent unauthorized sockets from relaying signals into a room.
* Implement `room:leave`, peer disconnect behavior, empty-room teardown, idle TTL, maximum lifetime, and garbage collection.

**Exit criteria:**

* Integration tests pass for creation, joining, third-peer rejection, malformed input, unauthorized signal injection, either-peer leave, either-peer disconnect, TTL, and cleanup.
* The frontend prototype visibly confirms the expected room lifecycle and stable errors.

### BE-3: Implement Abuse Controls and Safe Logging

**Status:** Completed (`2026-11-24`) - implemented `TRUST_PROXY`-aware IP extraction and per-IP `room:create` rate limiting (`server/src/rate-limit.js`), `MAX_ROOMS` capacity enforcement (`SERVER_BUSY`), privacy-safe operational logging omitting `socket.id`, client IPs, tokens, secrets, and SDP (`server/src/logger.js`), and integration tests (`server/test/abuse-controls.test.js`).

**Work:**

* Add room-creation rate limits and maximum active room count.
* Define trusted proxy behavior before applying IP-based limits.
* Restrict Socket.IO and HTTP CORS through environment configuration.
* Remove unnecessary socket identifiers and sensitive payloads from logs.
* Return stable `SERVER_BUSY`, rate-limit, authorization, and validation errors.

**Exit criteria:**

* Abuse-control integration tests pass.
* Logs contain operational events without secrets or private transfer data.

### BE-4: Implement ICE and TURN Credential Service

**Status:** Completed (`2026-11-24`) - implemented `server/src/ice-service.js` with environment-driven STUN plus Coturn REST HMAC-SHA1 ephemeral TURN credentials, fail-closed `SERVER_BUSY` handling for missing/invalid TURN configuration, secret-free `config` and logs, and prototype STUN+TURN validation (`client/src/prototype/ice-diagnostics.js`).

**Work:**

* Implement `ice:get` for authorized room members.
* Generate time-limited Coturn REST credentials with HMAC-SHA1.
* Read TURN endpoints, credential TTL, and secret from validated environment configuration.
* Fail safely when production TURN configuration is missing or invalid.

**Exit criteria:**

* Tests verify credential format, signature, expiry, authorization, and missing-secret behavior.
* The shared TURN secret never appears in client responses or logs.
* The frontend prototype receives valid ICE configuration without exposing the shared secret.

### BE-5: Make Runtime and Docker Deployment Reproducible

**Status:** Completed (`2026-11-24`) - removed placeholder secrets from `coturn/turnserver.conf` in favor of runtime env substitution, added container `healthcheck` and `service_healthy` dependencies across `docker-compose.yml` and `docker-compose.prod.yml`, locked `server/Dockerfile` (`npm ci --omit=dev`, `USER node`) and `client/Dockerfile` onto `package-lock.json`, parameterized `Caddyfile`, updated `server/.env.example`, and added `server/test/deployment-config.test.js`.

**Work:**

* Remove committed placeholder secrets from Compose and Coturn configuration.
* Use environment substitution or generated deployment configuration for secrets.
* Remove the obsolete Compose `version` field.
* Add health/readiness checks for relevant services.
* Finalize development and production Caddy routing and CORS settings.
* Verify clean Docker image builds using package lockfiles.

**Exit criteria:**

* `docker compose config` contains no committed secret value.
* Clean client and server images build reproducibly.
* HTTPS/WSS routing works in the documented deployment topology.

### BE-6: Harden Coturn and NAT Traversal

**Status:** Completed (`2026-11-24`) - hardened `coturn/turnserver.conf` (relay port range `49152-65535`, quotas, realm, `stale-nonce`, `no-cli`, `no-loopback-peers`, `no-multicast-peers`, RFC1918/IPv6 `denied-peer-ip` SSRF blocks, modern TLS), wired runtime IP/cert/secret injection in `docker-compose.yml` (`turn` profile), added `verifyTurnCredential` and `server/test/coturn-hardening.test.js`, and documented secret rotation and TLS certificate renewal in `docs/nat_traversal_strategy.md`.

**Work:**

* Configure external IP, relay port range, quotas, realm, certificates, and allowed protocols.
* Document and enforce a separate endpoint for `turn.shipri.app:443`.
* Validate UDP/TCP TURN and TURNS behavior.
* Add an operational procedure for secret rotation and certificate renewal.

**Exit criteria:**

* A forced `iceTransportPolicy: "relay"` prototype connection and data-channel exchange succeeds.
* Coturn rejects expired or invalid credentials.
* Caddy and Coturn do not compete for the same public `IP:443`.

### BE-7: Backend Acceptance Gate

**Status:** Completed (`2026-11-24`) - added readiness (`GET /ready`), non-tracking aggregate operational metrics (`GET /metrics` and `getOperationalMetrics()`), idempotent graceful `SIGTERM`/`SIGINT` shutdown and room cleanup, integrated acceptance suite (`server/test/backend-acceptance-gate.test.js`), completed backend security audit checklist (`docs/security_audit_open_source.md` Section `5`), verified deployment config validation and rollback procedures (`docs/deployment_docker_spec.md` Subsection `6.2`), and froze all full-backend contracts for Part 4 (`frontend_development_plan.md`) in Section `4` below.

**Dependency:** frontend prototype stage `FP-6`.

**Work:**

* Validate graceful shutdown and room cleanup behavior.
* Define health, readiness, capacity, and error metrics without user tracking.
* Verify deployment rollback and configuration validation procedures.
* Complete the backend security audit checklist against the implementation.
* Run every documented frontend prototype acceptance scenario.
* Freeze the Socket.IO, room authorization, ICE, and deployment contracts for final frontend development.

**Exit criteria:**

* Signaling integration, abuse, prototype direct-connectivity, forced-TURN, and deployment checks pass.
* Production documentation matches the released configuration.
* Final frontend development can proceed without unresolved backend contract changes.

---

## 3. Backend Verification

At the end of each backend stage, run:

* Backend unit and Socket.IO integration tests.
* `node --check src/index.js` or the applicable server check.
* `docker compose config` when deployment configuration changes.
* Frontend prototype room, WebRTC, and forced-TURN scenarios where relevant.
* Clean Docker builds and forced-TURN validation for deployment stages.

---

## 4. Full Backend Acceptance Gate Sign-Off (`BE-7`)

Recorded on `2026-11-24` as the contract freeze before Part 4 (`frontend_development_plan.md`) begins:

### 4.1. Frozen Backend Contracts for Part 4

* **Socket.IO Signaling & Validation (`signaling_protocol_spec.md`)**: `room:create`, `room:created`, `room:join`, `room:joined`, `peer:joined`, `room:leave`, `peer:left`, `signal:forward`, `signal:receive`, `ice:get`, `ice:credentials`, and `room:error` (`INVALID_PAYLOAD`, `INVALID_ROOM_ID`, `ROOM_NOT_FOUND`, `UNAUTHORIZED`, `ROOM_FULL`, `PEER_UNAVAILABLE`, `RATE_LIMITED`, `SERVER_BUSY`), opaque `signalData` bounded at `65536` bytes (`maxHttpBufferSize`), equal-peer `offerer`/`answerer` signaling-only duties, and atomic no-op error handling.
* **Room Authorization (`server/src/room-auth.js`)**: `REQUIRE_ROOM_AUTH=true` mandatory in production; HKDF-SHA256 (`salt: "shipri-room-auth-salt-v1"`, `info: "shipri-room-auth-v1"`) derived `authToken` and 43-char base64url `SHA-256` `authVerifier` verified in constant time before `ROOM_FULL`; idle TTL (`ROOM_IDLE_TTL_MS`), hard max lifetime (`ROOM_MAX_LIFETIME_MS`), periodic GC, and O(1) disconnect cleanup.
* **ICE & Ephemeral TURN (`server/src/ice-service.js`, `coturn/turnserver.conf`)**: Authorized `ice:get` returning environment-driven STUN plus HMAC-SHA1 ephemeral TURN credentials (`TURN_CREDENTIAL_TTL_SECONDS = 7200`), fail-closed `SERVER_BUSY` when `REQUIRE_TURN=true` lacks valid configuration, `TURN_SHARED_SECRET` kept strictly non-enumerable in `WeakMap` and never exposed to clients or logs, and hardened `coturn` SSRF/quota/TLS profile.
* **Operational Endpoints & Graceful Shutdown (`server/src/server.js`, `server/src/index.js`)**:
  * `GET /health` (`Cache-Control: no-store`): `{ status: "ok", roomsCount }`
  * `GET /ready` (`Cache-Control: no-store`): `200` `{ status: "ready", roomsCount, maxRooms }` when accepting traffic with valid ICE/TURN configuration; `503` `{ status: "not_ready" }` during shutdown or missing required TURN config.
  * `GET /metrics` (`Cache-Control: no-store`): privacy-safe aggregate operational metrics (`status`, `uptimeSeconds`, `activeRoomsCount`, `maxRooms`, `roomsCreatedTotal`, `roomsExpiredTotal`, `errorsByCode`) with zero user tracking, zero room/peer/socket IDs, zero client IPs, and zero secrets.
  * `SIGTERM` / `SIGINT` invoke idempotent `close()`, flipping readiness to `not_ready`, stopping timers, disconnecting active sockets, and clearing `roomStore` and `rateLimiter`.

### 4.2. Acceptance Gate Verification Summary

* `npm --prefix server run check`: passed across all `server/src/*.js` modules.
* `npm --prefix server test`: `19` test files passed, `249` tests passed (`0` failed, `0` skipped), including `server/test/backend-acceptance-gate.test.js`, `server/test/coturn-hardening.test.js`, `server/test/deployment-config.test.js`, `server/test/ice-turn.test.js`, `server/test/abuse-controls.test.js`, and `server/test/room-lifecycle-security.test.js`.
* `npm --prefix client test`: `14` test files passed, `87` tests passed (`0` failed, `0` skipped), including `client/test/prototype-backend-acceptance.test.js` (`FP-6`) and `client/test/nat-turn-diagnostics.test.js` (`FP-5`).
* `npm --prefix client run build`: passed (`vite v5.4.21`, `67` modules transformed).
* `docker compose config -q` across `docker-compose.yml`, `docker-compose.yml --profile turn`, and `docker-compose.prod.yml`: exited `0` with zero committed secrets.
* External pre-DNS staging note: live remote HTTPS/WSS and two-network forced-TURN staging checks against `https://poc.shipri.app` and `turn.shipri.app` remain pending external DNS assignment and host `coturn` deployment; local live Socket.IO full-backend integration and all automated gates are verified.
