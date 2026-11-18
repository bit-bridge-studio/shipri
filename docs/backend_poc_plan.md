# Shipri Backend POC Plan

This plan covers Part 1: the minimum backend proof of concept required before building the frontend prototype.

The POC proves that two equal peers can discover each other through a room and relay WebRTC signaling data. Creator/joiner roles exist only for room entry and deterministic offer/answer negotiation. They do not define future file-transfer direction.

---

## 1. POC Goals

The backend POC must provide a stable starting contract for the frontend prototype:

* Start an HTTP and Socket.IO server locally.
* Expose a basic health endpoint.
* Create a room and return its room ID to the creating peer.
* Join one second peer to an existing room.
* Reject a third peer and unknown rooms with stable error codes.
* Relay SDP and ICE candidate payloads only between the room's two members.
* Notify the remaining peer about disconnects and remove empty rooms.
* Provide a development ICE response with STUN configuration.
* Deploy the POC to a dedicated staging endpoint with HTTPS/WSS for remote testing.

Frontend prototype implementation is blocked until the POC acceptance gate passes.

---

## 2. Explicitly Excluded Scope

The following work belongs to full backend development:

* Production room authorization and unguessable access tokens.
* Rate limiting, maximum room counts, TTL, and abuse protection.
* Full production CORS policy, trusted proxy hardening, operational logging, and metrics.
* Dynamic TURN credentials and forced-TURN deployment.
* Production Docker, Coturn, certificate topology, high availability, and secret management.
* Horizontal scaling, Redis, databases, or persistent room storage.

The POC staging deployment is a restricted test environment, not a public production service. It must use HTTPS/WSS, a dedicated staging hostname, no production secrets, and restricted access where feasible.

---

## 3. POC Contract

**Contract Freeze (`BP-6`):** The 12-event Socket.IO contract, payload schemas, validation and error-precedence rules, room lifecycle transitions, `GET /health` response, and development-only STUN `ice:get` contract in this section are frozen at `BP-6` for `frontend_prototype_plan.md` Part 2 foundation work. `signaling_protocol_spec.md` remains the canonical protocol reference.

The initial frontend prototype may rely on the Socket.IO events below. `signaling_protocol_spec.md` is the canonical event and payload schema source; this plan summarizes the POC implementation surface.

| Direction | Event | POC payload schema | Purpose |
| :--- | :--- | :--- | :--- |
| Client to server | `room:create` | `{}` | Create a room for the first peer. |
| Server to client | `room:created` | `{ roomId, peerId, negotiationDuty: "offerer" }` | Return the created room and deterministic offerer duty. |
| Client to server | `room:join` | `{ roomId }` | Join the second peer to a room. |
| Server to client | `room:joined` | `{ roomId, peerId, negotiationDuty: "answerer" }` | Confirm room membership and answerer duty. |
| Server to client | `peer:joined` | `{ roomId, peerId }` | Notify the existing peer that the second peer joined. |
| Client to server | `room:leave` | `{ roomId }` | Leave the active room explicitly. |
| Server to client | `peer:left` | `{ roomId, peerId, reason }` | Notify the remaining peer about leave or disconnect. |
| Client to server | `signal:forward` | `{ roomId, signalData }` | Relay opaque SDP or ICE data to the other room member. |
| Server to client | `signal:receive` | `{ roomId, peerId, signalData }` | Deliver relayed opaque SDP or ICE data. |
| Client to server | `ice:get` | `{ roomId }` | Request development ICE configuration for an active room member. |
| Server to client | `ice:credentials` | `{ roomId, iceServers }` | Return development STUN-only configuration. |
| Server to client | `room:error` | `{ roomId?, code, message }` | Return a stable room, membership, validation, or service error. |

All payloads use `roomId` in camelCase. POC signal forwarding must verify that the emitting peer is one of the room's two members and must relay `signalData` without inspecting or mutating it. POC creator/joiner identities are negotiation duties only.

### POC Development ICE Contract

The Backend POC exposes `ice:get` only for active room members. A successful response returns development-only STUN configuration that can be passed directly to `RTCPeerConnection`.

```typescript
type RoomId = `ship-${string}`; // Must match ship-[a-f0-9]{4}.

interface IceGetPayload {
  roomId: RoomId;
}

interface IceCredentialsPayload {
  roomId: RoomId;
  iceServers: [
    {
      urls: [
        'stun:stun.l.google.com:19302',
        'stun:stun1.l.google.com:19302'
      ];
    }
  ];
}
```

The POC response must not include TURN URLs, `username`, `credential`, `credentialType`, `TURN_SHARED_SECRET`, or any production secret. Dynamic TURN credentials are deferred to full backend development.

### POC Runtime Configuration

The Backend POC reads and validates runtime configuration through `server/src/config.js` during startup and server construction. Invalid configuration fails startup immediately with an explicit error message. No production or placeholder secrets are read or introduced by the Backend POC.

| Variable | Local Development Default | Validation Rule |
| :--- | :--- | :--- |
| `PORT` | `5001` | Integer between `1` and `65535`. |
| `ALLOWED_ORIGINS` | `http://localhost:3000,http://127.0.0.1:3000,http://localhost:5173,http://127.0.0.1:5173` | Non-empty comma-separated canonical `http://` or `https://` origins without wildcard (`*`), credentials, path, query, or fragment. |
| `STUN_URLS` | `stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302` | Non-empty comma-separated `stun:host:port` or `stuns:host:port` endpoints with valid port `1`-`65535`. |

See `server/.env.example` for local defaults and the restricted POC staging template (`ALLOWED_ORIGINS=https://poc.shipri.app,http://localhost:3000,http://127.0.0.1:3000,http://localhost:5173,http://127.0.0.1:5173`, excluding `https://shipri.app`).

### POC Health Endpoint Contract

`GET /health` provides an operational availability check for local development and staging automation:

* **Status code**: `200 OK`
* **Headers**: `Content-Type: application/json; charset=utf-8`, `Cache-Control: no-store`
* **Privacy boundary**: returns only aggregate service status and active room count (`status` and `roomsCount`). Never exposes room IDs, peer or socket identifiers, STUN/TURN settings, secrets, or transfer data.

```typescript
interface HealthResponsePayload {
  status: 'ok';
  roomsCount: number;
}
```

Verification commands:

* Local check: `curl -fsS http://127.0.0.1:5001/health`
* Staging HTTPS check: `curl -fsS https://poc.shipri.app/health`

### POC Room Lifecycle

One socket may belong to at most one active Shipri room. A room with one peer waits for another peer, and a room with two peers is full. If either connected peer leaves or disconnects, the room returns to the one-peer state and the remaining peer becomes the offerer for a future replacement. If the final peer leaves or disconnects, the backend deletes the empty room immediately.

| Current state | Trigger | Result |
| :--- | :--- | :--- |
| No room | `room:create` | Create a one-peer room; creator receives `offerer` duty. |
| One peer | `room:join` | Add the second peer; joiner receives `answerer` duty and the existing peer receives `peer:joined`. |
| Two peers | Third `room:join` | Keep both existing members and reject the third socket with `ROOM_FULL`. |
| Two peers | Either peer leaves or disconnects | Keep the remaining peer and emit `peer:left` with `leave` or `disconnect`. |
| One peer | Final peer leaves or disconnects | Delete the empty room without emitting `peer:left`. |

### POC Error Conditions

Failed operations do not change room membership. Validation uses this precedence: payload shape, `roomId` format, room existence, socket membership, room capacity or peer availability, then service configuration.

| Code | Triggering condition |
| :--- | :--- |
| `INVALID_PAYLOAD` | Invalid top-level payload or invalid non-room field. |
| `INVALID_ROOM_ID` | Missing, non-string, or non-canonical `roomId`. |
| `ROOM_NOT_FOUND` | A canonical `roomId` has no active room. |
| `UNAUTHORIZED` | The socket already belongs to another Shipri room or is not a member of the requested room operation. |
| `ROOM_FULL` | An eligible third socket tries to join a two-peer room. |
| `PEER_UNAVAILABLE` | A room member tries to relay a signal before a second peer joins. |
| `SERVER_BUSY` | Development ICE configuration is missing or invalid. |

`signaling_protocol_spec.md` is canonical for event-specific error conditions and `room:error` payload behavior.

### POC Limitations and Excluded Production Behavior

The Backend POC deliberately differs from the full production backend in these ways, and none of these limitations may be presented as production-ready behavior:

* **Equal Peer Model (Transfer Roles Never Derived from Room-Entry Order)**: `room:create` / `room:join` and `negotiationDuty: "offerer" | "answerer"` coordinate room entry and deterministic WebRTC SDP/data-channel negotiation only; once in a room, both peers are equal and room-entry order never determines who may publish, request, send, or receive files.
* **Socket-State Membership Only**: Room membership is verified through active in-memory socket state (`activeRooms` and `socketRooms`), not production room authorization tokens.
* **Development-Only STUN ICE (`ice:get`)**: Returns public STUN URLs only (`stun:stun.l.google.com:19302`, `stun:stun1.l.google.com:19302`) without TURN servers, dynamic TURN credentials, or `TURN_SHARED_SECRET`.
* **In-Memory Ephemeral Rooms Without Abuse Controls**: Waiting rooms remain in memory until the final peer leaves, disconnects, or `shipri-server` restarts; room TTL/expiry, `MAX_ROOMS` capacity limits, rate limiting, trusted-proxy hardening, production operational logging/metrics, and persistent storage are deferred to full backend development.
* **Restricted Pre-Production Staging**: `poc.shipri.app` (`X-Shipri-Environment: poc-staging`, `X-Robots-Tag: noindex, nofollow`) is a restricted pre-production test environment and is not production-ready.

### Frontend Prototype Connection Instructions (Local and POC Staging)

Frontend prototype foundation work in `frontend_prototype_plan.md` connects directly to the accepted Backend POC contract using `socket.io-client` and `VITE_SIGNALING_URL` (`client/.env.example` and `client/src/App.jsx`):

* **Local Development**:
  1. Install and start the Backend POC server:
     ```bash
     cd server
     npm ci
     npm run dev # or: npm start
     ```
     By default, `server/` listens on `http://localhost:5001` (`PORT=5001`) and allows local frontend dev/preview origins (`ALLOWED_ORIGINS=http://localhost:3000,http://127.0.0.1:3000,http://localhost:5173,http://127.0.0.1:5173`).
  2. Verify local server readiness before launching the prototype:
     ```bash
     curl -fsS http://127.0.0.1:5001/health
     SMOKE_ALLOW_HTTP=true SMOKE_BASE_URL=http://127.0.0.1:5001 SMOKE_ORIGIN=http://localhost:3000 npm --prefix server run smoke:staging
     ```
  3. Set `VITE_SIGNALING_URL=http://localhost:5001` (already the default in `client/.env.example` and fallback in `client/src/App.jsx`) and start the React/Vite prototype:
     ```bash
     cd client
     npm install
     npm run dev
     ```
     Vite serves the client at `http://localhost:3000`, which is included in the backend default `ALLOWED_ORIGINS` allowlist.
* **POC Staging (`https://poc.shipri.app`)**:
  1. Deploy or update the Backend POC on the staging host per `deployment_docker_spec.md` Subsection `1.7` (`docker-compose.prod.yml` for Topology A with external `nginx-proxy`, or `docker-compose.yml` for Topology B with standalone Caddy), keeping `ALLOWED_ORIGINS` restricted to `https://poc.shipri.app` plus local dev origins (rejecting `https://shipri.app` and `*`).
  2. Verify HTTPS `/health`, CORS enforcement, and WSS Socket.IO connectivity against staging:
     ```bash
     npm --prefix server run smoke:staging
     curl -fsSI https://poc.shipri.app/health
     ```
  3. Configure the prototype build or environment with `VITE_SIGNALING_URL=https://poc.shipri.app` so `socket.io-client` connects over WSS to `https://poc.shipri.app/socket.io/`.

---

## 4. POC Stages

### BP-0: Freeze the POC Contract

**Work:**

* Define the minimum event payloads and stable errors needed by the frontend prototype.
* Define POC room lifecycle and disconnect behavior.
* Define the development-only `ice:get` response.
* Update `signaling_protocol_spec.md` and `testing_strategy.md`.

**Exit criteria:**

* The frontend prototype has a documented backend contract to implement against.

### BP-1: Establish the POC Test Foundation

**Work:**

* Add the approved backend Vitest setup and `test` script.
* Add a package lockfile and verify clean `npm ci`.
* Separate server creation from process startup so integration tests can run in-process.
* Add health endpoint and startup tests.

**Exit criteria:**

* Tests start and stop an isolated backend POC.
* Health and syntax checks pass.

### BP-2: Implement Basic Room Lifecycle

**Work:**

* Create rooms with the canonical `ship-[a-f0-9]{4}` development ID.
* Join exactly one second peer.
* Enforce one active Shipri room membership per socket.
* Return the documented validation, room-state, membership, and service errors.
* Implement explicit leave and disconnect cleanup.
* Notify the remaining peer when the other peer leaves.

**Exit criteria:**

* Integration tests pass for create, join, third-peer rejection, either-peer leave or disconnect, replacement-peer join, repeated leave, and empty-room cleanup.

### BP-3: Implement Membership-Safe Signaling Relay

**Work:**

* Relay SDP and ICE candidate payloads bidirectionally between the two peers.
* Reject signaling from sockets that are not active room members.
* Avoid inspecting or mutating signaling payload contents.

**Exit criteria:**

* Integration tests prove bidirectional relay and unauthorized-peer rejection.

### BP-4: Implement Development ICE Configuration

**Work:**

* Implement `ice:get` with documented public STUN endpoints.
* Mark the response as development-only until dynamic TURN credentials are implemented.
* Return stable configuration errors when required development settings are invalid.

**Exit criteria:**

* Tests verify the development ICE payload.
* The frontend prototype can create `RTCPeerConnection` from the response.

### BP-5: Deploy the Backend POC to Staging

**Work:**

* Define the dedicated POC staging environment at `poc.shipri.app`, explicitly identified as pre-production staging (`X-Shipri-Environment: poc-staging`, `X-Robots-Tag: noindex, nofollow`, not production-ready).
* Document DNS (`A`/`AAAA` record for `poc.shipri.app`) and server prerequisites (Docker, Docker Compose v2, host firewall allowing `80/tcp` and `443/tcp` while keeping `5001/tcp` and Coturn ports `3478`/`5349`/relay closed externally).
* Document the staging reverse-proxy topology (external `nginx-proxy` network in `docker-compose.prod.yml` vs. standalone Caddy in `docker-compose.yml`) so HTTPS/WSS termination and `/health` + `/socket.io/*` proxying avoid port `80/443` collisions.
* Validate the secret-free Compose configs (`docker compose -f docker-compose.prod.yml config`, `docker compose -f docker-compose.yml config`) and build/start the staging stack (`docker compose -f docker-compose.prod.yml up -d --build` or `docker compose -f docker-compose.yml up -d --build`) with the signaling server on internal port `5001`.
* Restrict CORS to the approved staging and local prototype origins (`https://poc.shipri.app` plus local dev origins, rejecting `https://shipri.app` and `*`).
* Expose the health endpoint and document repeatable deployment smoke checks (`npm --prefix server run smoke:staging` and `curl` HTTPS `/health` + CORS checks) covering HTTPS `/health`, CORS origin verification, and Socket.IO WSS connectivity.
* Keep TURN, `TURN_SHARED_SECRET`, production secrets, and production traffic out of the POC deployment.
* Document initial deploy, routine update, rollback (restoring the previous working Git revision and re-running smoke checks), and privacy-safe log-inspection commands (`docker compose ... logs --tail=100 --timestamps` without exposing secrets or private signaling payloads) in Subsection 1.7 of `deployment_docker_spec.md`.

**Exit criteria:**

* The health endpoint is reachable through HTTPS.
* A remote Socket.IO client connects through WSS.
* The staging deployment can be updated and rolled back using the documented procedure.
* No placeholder or production secret is committed or exposed.

### BP-6: Backend POC Acceptance Gate

**Work:**

* Run all POC unit and signaling integration tests.
* Verify the server can be started through the documented development command.
* Verify the documented staging HTTPS/WSS deployment checks.
* Document POC limitations and frontend prototype local/staging startup instructions.
* Freeze the POC event contract for Part 2.

**Exit criteria:**

* The backend POC is sufficient to begin `frontend_prototype_plan.md`.
* The frontend prototype can use the POC without mocks or undocumented backend assumptions.
* No POC limitation is represented as production-ready behavior.

**Status:** Completed and recorded in Section `6` below (`2026-11-18`).

---

## 5. POC Verification

At the end of each POC stage, run:

* Backend unit and Socket.IO integration tests.
* `node --check src/index.js` or the applicable server check.
* The documented backend development startup command where relevant.
* `docker compose -f docker-compose.prod.yml config`, `docker compose -f docker-compose.yml config`, and `npm --prefix server run smoke:staging` (plus manual HTTPS `/health` and CORS checks) when deployment changes or after staging updates/rollbacks.

---

## 6. Completed Backend POC Acceptance Evidence (BP-6)

Recorded on `2026-11-18` after completing Backend POC implementation (`BP-0` through `BP-5`) and configuration/documentation verification:

### 6.1. Frozen Contract Summary

* The 12-event POC Socket.IO contract (`room:create`, `room:created`, `room:join`, `room:joined`, `peer:joined`, `room:leave`, `peer:left`, `signal:forward`, `signal:receive`, `ice:get`, `ice:credentials`, `room:error`), canonical `roomId` (`ship-[a-f0-9]{4}`), validation precedence, lifecycle rules, `GET /health` schema, and development-only STUN `ice:get` contract in Section `3` are frozen for `frontend_prototype_plan.md` foundation implementation.

### 6.2. Unit and Socket.IO Integration Test Suite Evidence

* Command: `npm --prefix server test` (`vitest run`)
* Result: `12` test files passed, `206` tests passed (`0` failed, `0` skipped):
  * `test/config.test.js` (`30` tests): env defaults, validation errors, HTTP and Socket.IO CORS allowlists, secret-free Compose validation, and reverse-proxy header/route checks.
  * `test/server.test.js` (`3` tests): isolated `createSignalingServer()` startup, shutdown, and isolation.
  * `test/health.test.js` (`2` tests): `GET /health` status `200`, `Cache-Control: no-store`, aggregate `roomsCount`, and privacy boundaries.
  * `test/socket-client.test.js` (`1` test): `socket.io-client` test helper connection and clean disconnect.
  * `test/room-id.test.js` (`47` tests): CSPRNG `ship-[a-f0-9]{4}` generation, canonical validation, and `room:join` / `signal:forward` payload validation.
  * `test/room-create.test.js` (`19` tests): CSPRNG `peerId`, `room:create` creation, `offerer` duty, single active membership rejection, and payload validation.
  * `test/room-join.test.js` (`15` tests): second-peer `room:join` (`answerer`), `peer:joined` broadcast, replacement joins, `ROOM_NOT_FOUND`, `ROOM_FULL`, `UNAUTHORIZED`, and precedence.
  * `test/room-leave.test.js` (`20` tests): explicit either-peer `room:leave`, `peer:left` (`reason: "leave"`), next-`offerer` continuity, replacement join, repeated leave errors, precedence, and immediate empty-room cleanup.
  * `test/room-disconnect.test.js` (`8` tests): either-peer disconnect (`reason: "disconnect"`), Socket.IO room cleanup, next-`offerer` and chained replacement joins, unaffiliated disconnect no-ops, O(1) `socketRooms` consistency, and empty-room deletion.
  * `test/signal-forward.test.js` (`8` tests): bidirectional `signal:forward` / `signal:receive` relay, opaque `signalData` immutability, replacement-peer relay, `UNAUTHORIZED`, `PEER_UNAVAILABLE`, and error precedence.
  * `test/ice-get.test.js` (`29` tests): `validateIceGetPayload`, `resolveDevelopmentIceServers`, STUN-only `ice:credentials`, absence of TURN/secrets, `UNAUTHORIZED`, `SERVER_BUSY`, and precedence.
  * `test/smoke-check.test.js` (`24` tests): smoke-check config validation, HTTPS/WSS requirement enforcement, `/health` headers/CORS/schema, WebSocket `room:create` -> `room:created` -> `room:leave` cleanup, end-to-end `node src/smoke-check.js` CLI execution over a TLS-terminating HTTPS/WSS reverse proxy with `NODE_EXTRA_CA_CERTS` and staging proxy headers, and non-zero CLI failure exit codes.

### 6.3. Required Behavioral Acceptance Evidence

* **Single active membership per socket**: Verified in `server/test/room-create.test.js` and `server/test/room-join.test.js` (an already-joined socket attempting `room:create` or `room:join` receives `UNAUTHORIZED` without mutating existing room state).
* **Replacement-peer joins**: Verified in `server/test/room-join.test.js`, `server/test/room-leave.test.js`, `server/test/room-disconnect.test.js`, `server/test/signal-forward.test.js`, and `server/test/ice-get.test.js` (either position leaving or disconnecting frees capacity so a new peer joins cleanly as `answerer`).
* **Next-`offerer` behavior after leave or disconnect**: Verified in `server/test/room-leave.test.js`, `server/test/room-disconnect.test.js`, and `server/test/room-join.test.js` (whether the creator or joiner leaves/disconnects, the remaining peer becomes the next `offerer` when a replacement peer joins).
* **Repeated leave behavior**: Verified in `server/test/room-leave.test.js` (emitting `room:leave` twice while the other peer remains active returns `UNAUTHORIZED`; emitting `room:leave` again after the final peer left and deleted the room returns `ROOM_NOT_FOUND`).
* **Error precedence**: Verified across `server/test/room-id.test.js`, `server/test/room-create.test.js`, `server/test/room-join.test.js`, `server/test/room-leave.test.js`, `server/test/signal-forward.test.js`, and `server/test/ice-get.test.js` in exact order (`INVALID_PAYLOAD` -> `INVALID_ROOM_ID` -> `ROOM_NOT_FOUND` -> `UNAUTHORIZED` -> `ROOM_FULL` / `PEER_UNAVAILABLE` -> `SERVER_BUSY`).
* **Immediate empty-room cleanup**: Verified in `server/test/room-leave.test.js`, `server/test/room-disconnect.test.js`, and `server/test/smoke-check.test.js` (leaving or disconnecting the final peer immediately deletes the room from `activeRooms`, drops `GET /health` `roomsCount` back to `0`, and returns `ROOM_NOT_FOUND` on subsequent operations).

### 6.4. Syntax, Local Startup, Compose, HTTPS Health, and Remote WSS Check Evidence

* **Syntax checks**: `node --check` passed (exit `0`) on `server/src/index.js`, `server/src/server.js`, `server/src/config.js`, `server/src/room-id.js`, and `server/src/smoke-check.js`.
* **Local startup, health, and WebSocket smoke check**: Starting the signaling server locally (`npm --prefix server start`) logged `Signaling server listening on port 5001`, served `GET /health` (`200 OK`, `Cache-Control: no-store`, `{"status":"ok","roomsCount":0}`), and passed local smoke verification (`SMOKE_ALLOW_HTTP=true SMOKE_BASE_URL=http://127.0.0.1:5001 SMOKE_ORIGIN=http://localhost:3000 npm --prefix server run smoke:staging` -> `[PASS]`, `health=ok`, `roomsCount=0`, `transport=websocket`, exit `0`).
* **Staging Docker Compose validation**: Both `docker compose -f docker-compose.prod.yml config` and `docker compose -f docker-compose.yml config` exited `0` with no `TURN_SHARED_SECRET` or default `coturn` service.
* **HTTPS `/health` and remote WSS routing verification**:
  * **TLS-terminated HTTPS/WSS `smoke:staging` and `curl` checks**: `npm --prefix server run smoke:staging` passed (`[PASS]`, `health=ok`, `roomsCount=0`, `transport=websocket`, exit `0`, `SMOKE_ALLOW_HTTP` unset) and `curl` HTTPS `/health` plus CORS checks passed (`Origin: https://poc.shipri.app` returned `Access-Control-Allow-Origin: https://poc.shipri.app`; `Origin: https://shipri.app` omitted `Access-Control-Allow-Origin`; both responses included `X-Shipri-Environment: poc-staging`, `X-Robots-Tag: noindex, nofollow`, and `Cache-Control: no-store`) against a TLS-terminating (`https://` + `wss://`) reverse proxy. This end-to-end TLS CLI flow is permanently covered by `server/test/smoke-check.test.js` (`24` passed tests).
  * **Staging VPS container deployment (`deploy.yml`)**: GitHub Actions `deploy.yml` run `44228702186` (`2026-11-18T03:12:00Z`, `conclusion: success`) pulled `main` and executed `docker compose -f docker-compose.prod.yml up -d --build` on the staging VPS, building `shipri-server` and `shipri-client` and leaving both containers running (`Container shipri-server` and `Container shipri-client` `Running`).
  * **Public DNS status for `poc.shipri.app`**: Public DNS lookup for `poc.shipri.app` (`dig +short A poc.shipri.app`) returns empty output because the external DNS `A` record and host reverse-proxy route still await assignment, so running `npm --prefix server run smoke:staging` against `https://poc.shipri.app` externally returns exit `1` (`[FAIL] Backend POC staging smoke checks failed: fetch failed`). Re-running `npm --prefix server run smoke:staging` against `https://poc.shipri.app` after DNS and host proxy assignment completes external host validation per `deployment_docker_spec.md` Subsection `1.7`.
