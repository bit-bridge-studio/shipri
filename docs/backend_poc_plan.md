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

The initial frontend prototype may rely on these Socket.IO events:

| Direction | Event | Purpose |
| :--- | :--- | :--- |
| Client to server | `room:create` | Create a room for the first peer. |
| Server to client | `room:created` | Return the created `roomId` and `offerer` negotiation duty. |
| Client to server | `room:join` | Join the second peer to a room. |
| Server to client | `room:joined` | Confirm room membership and `answerer` negotiation duty. |
| Server to client | `peer:joined` | Notify the existing peer that the second peer joined. |
| Server to client | `peer:left` | Notify the remaining peer about leave or disconnect. |
| Client to server | `signal:forward` | Relay SDP or ICE data to the other room member. |
| Server to client | `signal:receive` | Deliver relayed SDP or ICE data. |
| Client to server | `ice:get` | Request development ICE configuration. |
| Server to client | `ice:credentials` | Return development STUN configuration. |
| Client to server | `room:leave` | Leave the active room explicitly. |
| Server to client | `room:error` | Return a stable room or validation error. |

All payloads use `roomId` in camelCase. POC signal forwarding must verify that the emitting peer is one of the room's two members. POC creator/joiner identities are negotiation duties only.

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
* Return stable `ROOM_NOT_FOUND`, `ROOM_FULL`, and validation errors.
* Implement explicit leave and disconnect cleanup.
* Notify the remaining peer when the other peer leaves.

**Exit criteria:**

* Integration tests pass for create, join, third-peer rejection, leave, and disconnect cleanup.

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

* Define a dedicated staging hostname such as `poc.shipri.app`.
* Build and run the signaling server on the test server.
* Configure HTTPS/WSS termination and Socket.IO proxying through Caddy.
* Restrict CORS to the approved local and staging prototype origins.
* Expose the health endpoint for deployment verification.
* Keep TURN, production secrets, and production traffic out of the POC deployment.
* Document deploy, update, rollback, and log-inspection commands.

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

---

## 5. POC Verification

At the end of each POC stage, run:

* Backend unit and Socket.IO integration tests.
* `node --check src/index.js` or the applicable server check.
* The documented backend development startup command where relevant.
* Staging HTTPS health and WSS connection checks when deployment changes.
