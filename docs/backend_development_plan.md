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

**Work:**

* Define the room authorization model independently from the short public room ID.
* Migrate the accepted POC contract without breaking the frontend prototype unless a documented security correction requires it.
* Freeze Socket.IO event schemas, validation rules, stable error codes, and disconnect behavior.
* Define room TTL, maximum lifetime, capacity, rate limits, and maximum active room count.
* Define environment-driven ICE server and TURN credential responses.
* Confirm that every backend acceptance scenario is exposed by `frontend_prototype_plan.md`.
* Synchronize `signaling_protocol_spec.md`, `security_audit_open_source.md`, `nat_traversal_strategy.md`, and `deployment_docker_spec.md`.

**Exit criteria:**

* Every backend event handler has a documented authorization and validation rule.
* The backend contract contains no file data or plaintext metadata.

### BE-1: Establish Backend Test and Server Foundation

**Work:**

* Reuse and expand the accepted Backend POC Vitest setup and `test` script.
* Preserve the POC package lockfile and clean `npm ci` workflow.
* Evolve the POC server, room storage, validation, and configuration modules without breaking accepted behavior.
* Expand baseline health and configuration tests for production requirements.

**Exit criteria:**

* Backend tests and syntax checks pass from a clean install.
* Tests can start and stop an isolated signaling server.

### BE-2: Secure Room Lifecycle

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
