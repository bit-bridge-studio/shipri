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

The POC deliberately differs from production in these ways:

* Room membership is validated through active socket state, not production access tokens.
* ICE credentials are development-only STUN entries without TURN credentials.
* Waiting rooms remain until the final peer leaves, disconnects, or the process restarts. Room TTL, rate limits, maximum room counts, full production CORS, dynamic TURN credentials, persistent storage, and operational hardening are deferred.

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
