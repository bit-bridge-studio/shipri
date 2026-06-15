# Shipri Frontend Prototype Plan

This plan covers Part 2: a minimal React/Vite diagnostic client built after the backend POC passes its acceptance gate. It is a test harness for full backend development, not the production Shipri user experience.

---

## 1. Mandatory Entry Gate

Frontend prototype implementation starts only when:

* `backend_poc_plan.md` stage `BP-6` has passed.
* Backend POC unit and signaling integration tests are green.
* The POC server starts locally and is reachable through the documented staging HTTPS/WSS endpoint.
* The minimum room, signaling, disconnect, error, and development ICE contract is frozen.

Mocks may be used in frontend unit tests, but they must not replace the accepted Backend POC for prototype integration behavior.

---

## 2. Prototype Goals

The prototype must make backend and network behavior easy to exercise and inspect:

* Create and join rooms as separate, equal browser peers.
* Display Socket.IO connection state, emitted events, received events, payloads, and stable error codes.
* Negotiate a native WebRTC connection through the backend.
* Open a diagnostic data channel and exchange ping/pong or short text messages.
* Display ICE gathering, connection states, selected candidate type, and direct-versus-relay status.
* Expand later with forced TURN through `iceTransportPolicy: "relay"` for full-backend deployment validation.

The prototype must not send real user files or claim production security.

The starting backend contract is defined and accepted by `backend_poc_plan.md`. The prototype first implements that POC contract, then expands as full backend capabilities are added.

---

## 3. Explicitly Excluded Scope

The following work belongs to final frontend development:

* Production E2EE and key distribution.
* Encrypted metadata or file chunks.
* Large-file slicing, backpressure, disk persistence, and resume.
* Production transfer state machine and polished UX.
* QR codes, responsive polish, accessibility release work, and cross-browser persistence.

---

## 4. Prototype Foundation Stages

### FP-0: Freeze the Prototype Backend Contract

**Work:**

* Import the accepted room, signaling, leave, error, and development ICE payloads from `backend_poc_plan.md`.
* Record the additional full-backend scenarios that will be added during Part 3.
* Update `signaling_protocol_spec.md` and `testing_strategy.md`.

**Exit criteria:**

* Every initial prototype action maps to the accepted POC contract.
* Later full-backend diagnostic actions are documented separately.

### FP-1: Establish Test and Diagnostic UI Foundation

**Work:**

* Add the approved frontend Vitest setup and `test` script.
* Add a package lockfile and verify clean `npm ci` and build workflows.
* Create a simple diagnostic layout with membership state, negotiation duty, connection state, action controls, and event log.
* Isolate Socket.IO client code from React rendering.
* Add tests for state transitions and event-log behavior.

**Exit criteria:**

* Tests and production build pass.
* Socket connection and disconnect behavior are visible in the UI.

### FP-2: Implement Room Lifecycle Harness

**Work:**

* Add controls for room creation, joining, and leaving.
* Handle the accepted POC room membership contract.
* Display room ID, membership state, offerer/answerer duty, peer state, and all stable room errors.
* Add an optional malformed-input panel for manual validation testing.

**Exit criteria:**

* Two browser tabs can exercise successful and failing room lifecycle scenarios.

### FP-3: Implement WebRTC Signaling Harness

**Work:**

* Request ICE credentials from the backend.
* Negotiate native `RTCPeerConnection` through `signal:forward` and `signal:receive`.
* Create one diagnostic reliable data channel using the deterministic offerer peer.
* Prove that either peer can initiate ping/pong and short text payloads.
* Display SDP, ICE, peer connection, and data-channel states without exposing backend secrets.

**Exit criteria:**

* Two browser tabs establish a data channel through the backend and exchange diagnostic messages.

### FP-4: Deploy the Prototype to POC Staging

**Work:**

* Build and deploy the diagnostic frontend to the approved staging origin.
* Configure the frontend to connect to the staging backend through WSS.
* Validate room creation, joining, signaling, and data-channel ping/pong from two devices.
* Repeat the direct WebRTC check from two different networks.
* Keep prototype diagnostics and staging access separate from the future production route.

**Exit criteria:**

* The deployed prototype connects to the deployed Backend POC through WSS.
* Two remote devices establish a direct WebRTC data channel through staging signaling.
* Deployment and rollback steps are documented.

### FP-G1: Prototype Foundation Gate

**Work:**

* Validate every accepted Backend POC event through the prototype.
* Confirm direct WebRTC data-channel connectivity locally and through staging.
* Document how to run and deploy the POC and frontend prototype together.

**Exit criteria:**

* The frontend prototype foundation validates the Backend POC without mocks.
* Full backend development may begin.

---

## 5. Prototype Expansion During Full Backend Development

### FP-5: Add NAT and TURN Diagnostics

**Dependency:** full backend stages `BE-4` and `BE-6`.

**Work:**

* Add selectable `iceTransportPolicy` modes: `all` and `relay`.
* Display gathered candidate types and the selected connection candidate pair where supported.
* Show whether the final connection is direct or relayed.
* Surface credential and connectivity errors clearly.

**Exit criteria:**

* The prototype validates both direct and forced-TURN connections.

### FP-6: Prototype Acceptance Gate

**Dependency:** full backend stages `BE-2` through `BE-6`.

**Work:**

* Verify all documented Socket.IO events and error codes manually.
* Verify room teardown, reconnect, and unauthorized-action behavior.
* Document how to use the prototype during backend development.
* Mark prototype-only modules and controls clearly.

**Exit criteria:**

* The prototype can exercise every backend acceptance scenario required by `backend_development_plan.md`.
* Full backend stage `BE-7` may begin.

---

## 6. Prototype Verification

At the end of each stage, run:

* Frontend unit tests.
* `npm run build`.
* Manual two-tab room and WebRTC scenarios.
* Direct and forced-TURN checks when ICE behavior changes.
