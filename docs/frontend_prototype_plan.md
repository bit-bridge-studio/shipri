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

## 4. Frozen Frontend Prototype POC Contract (`FP-0`)

This section freezes the Backend POC Socket.IO contract and client state boundary for Part 2 prototype foundation stages (`FP-1` through `FP-G1`). `signaling_protocol_spec.md` and `backend_poc_plan.md` Sections `3` and `6` remain canonical. Prototype modules must consume this contract directly without mocking room or signaling behavior in live backend runs.

### 4.1. Equal-Peer Model and Signaling-Only Negotiation Duties

* Both connected members in a Shipri room are **equal peers**.
* `creator` (`room:create`) and `joiner` (`room:join`) describe room-entry history only.
* `negotiationDuty: 'offerer' | 'answerer'` is strictly a **signaling-only duty** for WebRTC connection setup:
  * The peer with `negotiationDuty: 'offerer'` creates the `RTCPeerConnection`, opens the single reliable diagnostic `RTCDataChannel` (`"shipri-diagnostic"`), creates the initial SDP offer, and forwards it via `signal:forward`.
  * The peer with `negotiationDuty: 'answerer'` creates its `RTCPeerConnection`, listens for `ondatachannel` (`"shipri-diagnostic"`), applies the remote SDP offer, creates the SDP answer, and forwards it via `signal:forward`.
* Once `"shipri-diagnostic"` reaches `open`, **either peer** may initiate `ping`, `pong`, or short `text` messages. Room-entry order and `negotiationDuty` never restrict diagnostic messages in the prototype and never determine file-transfer roles or direction in the final product.
* When the other peer leaves (`room:leave`) or disconnects (`disconnect`), the server emits `peer:left` (`reason: 'leave' | 'disconnect'`) to the remaining peer. The remaining peer stays in the room (`waiting_for_peer`), closes its stale `RTCPeerConnection` and `RTCDataChannel`, and acts as the `offerer` when a replacement peer joins and triggers `peer:joined`.

### 4.2. Consumed Backend POC Events, Payloads, and Frontend Action Mapping

| Frontend Action / Driver Event | Socket.IO Event & Direction | Consumed / Emitted Payload Shape | Frontend State & Diagnostic Effect |
| :--- | :--- | :--- | :--- |
| Connect socket | `connect` / `disconnect` / `connect_error` (Socket.IO lifecycle) | Connection status against `VITE_SIGNALING_URL` (`http://localhost:5001` or `https://poc.shipri.app`) | Updates socket status (`connecting`, `connected`, `disconnected`, `error`); local `disconnect` clears active room/peer state and tears down WebRTC. |
| Create room | `room:create` (client -> server), `room:created` (server -> creator) | Emit `{}`; receive `{ roomId, peerId, negotiationDuty: 'offerer' }` | Enters `waiting_for_peer`, stores `roomId` (`ship-[a-f0-9]{4}`), opaque `selfPeerId`, `entryRole: 'creator'`, and `negotiationDuty: 'offerer'`. |
| Join room | `room:join` (client -> server), `room:joined` (server -> joiner) | Emit `{ roomId }`; receive `{ roomId, peerId, negotiationDuty: 'answerer' }` | Enters `connected`, stores `roomId`, `selfPeerId`, `entryRole: 'joiner'`, and `negotiationDuty: 'answerer'`; peer may now request `ice:get` and await SDP offer. |
| Receive peer join | `peer:joined` (server -> existing waiting peer) | Receive `{ roomId, peerId }` | Transitions `waiting_for_peer` -> `connected` with `negotiationDuty: 'offerer'`, stores `remotePeerId`, and starts `ice:get` -> `RTCPeerConnection` offerer flow. |
| Leave room | `room:leave` (client -> server) | Emit `{ roomId }` | Closes local `RTCDataChannel` and `RTCPeerConnection`, clears local room membership back to `unaffiliated` (`negotiationDuty: null`), and appends sanitized log entry. |
| Handle peer departure | `peer:left` (server -> remaining peer) | Receive `{ roomId, peerId, reason: 'leave' \| 'disconnect' }` | Closes stale `RTCDataChannel` and `RTCPeerConnection`, clears `remotePeerId`, returns to `waiting_for_peer`, and sets `negotiationDuty: 'offerer'` for any future replacement peer. |
| Request ICE config | `ice:get` (client -> server), `ice:credentials` (server -> requesting peer) | Emit `{ roomId }`; receive `{ roomId, iceServers }` | Validates non-empty STUN-only `iceServers` before constructing `RTCPeerConnection`; logs only ICE entry count and scheme summary (`stun`), never raw credentials. |
| Forward SDP/ICE signal | `signal:forward` (client -> server) | Emit `{ roomId, signalData }` | Sends local SDP (`offer` / `answer`) or trickle ICE candidate payload transparently when in `connected` room state; logs metadata summary (`sdp` / `candidate` type), never raw SDP/ICE secrets. |
| Receive SDP/ICE signal | `signal:receive` (server -> other active peer) | Receive `{ roomId, peerId, signalData }` | Applies remote SDP description or ICE candidate from `signalData` to active `RTCPeerConnection` for the matching `roomId`; records sanitized event summary. |
| Handle room error | `room:error` (server -> requesting socket) | Receive `{ roomId?, code, message }` | Branches solely on `code`, sets `lastError`, appends sanitized error log entry, and preserves current room/peer state because failed requests do not mutate server state. |
| Malformed-input test action | Invalid `room:join`, `room:leave`, `signal:forward`, or `ice:get` emit | Deliberately malformed `roomId` or invalid top-level payload test input | Exercises backend validation precedence (`INVALID_PAYLOAD`, `INVALID_ROOM_ID`, `ROOM_NOT_FOUND`, `UNAUTHORIZED`, `PEER_UNAVAILABLE`) without corrupting UI state. |

TypeScript contract definitions consumed and emitted by the frontend prototype (TypeScript notation is for documentation readability only; the frontend codebase remains JavaScript):

```typescript
type RoomId = `ship-${string}`; // Canonical ship-[a-f0-9]{4}
type PeerId = string; // Opaque backend identifier
type NegotiationDuty = 'offerer' | 'answerer';
type PeerLeftReason = 'leave' | 'disconnect';
type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };
type SignalData = { [key: string]: JsonValue };

interface IceServer {
  urls: string | string[];
  username?: string; // Omitted in Backend POC STUN-only responses
  credential?: string; // Omitted in Backend POC STUN-only responses
}

type RoomCreatePayload = Record<string, never>;
interface RoomCreatedPayload {
  roomId: RoomId;
  peerId: PeerId;
  negotiationDuty: 'offerer';
}

interface RoomJoinPayload {
  roomId: RoomId;
}
interface RoomJoinedPayload {
  roomId: RoomId;
  peerId: PeerId;
  negotiationDuty: 'answerer';
}
interface PeerJoinedPayload {
  roomId: RoomId;
  peerId: PeerId;
}

interface RoomLeavePayload {
  roomId: RoomId;
}
interface PeerLeftPayload {
  roomId: RoomId;
  peerId: PeerId;
  reason: PeerLeftReason;
}

interface IceGetPayload {
  roomId: RoomId;
}
interface IceCredentialsPayload {
  roomId: RoomId;
  iceServers: IceServer[];
}

interface SignalForwardPayload {
  roomId: RoomId;
  signalData: SignalData;
}
interface SignalReceivePayload {
  roomId: RoomId;
  peerId: PeerId;
  signalData: SignalData;
}

type RoomErrorCode =
  | 'INVALID_PAYLOAD'
  | 'INVALID_ROOM_ID'
  | 'ROOM_NOT_FOUND'
  | 'UNAUTHORIZED'
  | 'ROOM_FULL'
  | 'PEER_UNAVAILABLE'
  | 'SERVER_BUSY';

interface RoomErrorPayload {
  roomId?: RoomId;
  code: RoomErrorCode;
  message: string;
}

// Sanitized UI event-log record stored by prototype state
interface PrototypeEventLogEntry {
  timestamp: string;
  direction: 'outbound' | 'inbound' | 'local';
  event: string;
  roomId?: RoomId;
  code?: RoomErrorCode;
  summary: string; // Never includes raw SDP strings, ICE credentials, TURN secrets, or E2EE keys
}

// Prototype-only plaintext messages exchanged over the "shipri-diagnostic" RTCDataChannel
type DiagnosticDataMessage =
  | { type: 'ping'; id: string; sentAt: number }
  | { type: 'pong'; id: string; sentAt: number; repliedAt: number }
  | { type: 'text'; id: string; sentAt: number; body: string };
```

### 4.3. Client Room and Negotiation Lifecycle Transitions

The prototype tracks deterministic room and signaling state per connected client:

| Client Membership State | Trigger | Next Membership State | Resulting Negotiation Duty & Local Action |
| :--- | :--- | :--- | :--- |
| `unaffiliated` | `room:created` received | `waiting_for_peer` | `offerer` duty (`entryRole: 'creator'`); display room ID for second peer; may pre-fetch `ice:get` or await `peer:joined`. |
| `unaffiliated` | `room:joined` received | `connected` | `answerer` duty (`entryRole: 'joiner'`); fetch `ice:get`, initialize `RTCPeerConnection`, wait for `"shipri-diagnostic"` data channel and remote offer. |
| `waiting_for_peer` | `peer:joined` received | `connected` | `offerer` duty retained; fetch `ice:get`, open `"shipri-diagnostic"` channel, create SDP offer, emit `signal:forward`. |
| `connected` | `peer:left` (`reason: 'leave' \| 'disconnect'`) received | `waiting_for_peer` | Close stale `RTCDataChannel` and `RTCPeerConnection`, promote local peer to `offerer` for replacement peer, clear `remotePeerId`. |
| `waiting_for_peer` or `connected` | Local `room:leave` emitted | `unaffiliated` | Close local `RTCDataChannel` and `RTCPeerConnection`; clear `roomId`, `selfPeerId`, `remotePeerId`, `entryRole`, and `negotiationDuty`. |
| `waiting_for_peer` or `connected` | Socket `disconnect` | `unaffiliated` | Server removes socket from room; client closes local WebRTC objects and resets transient room/peer state. |

### 4.4. Stable Error Handling and Precedence in the Prototype

The Backend POC validates requests in exact precedence order and returns the first matching `room:error` code:

1. `INVALID_PAYLOAD`: malformed top-level payload or invalid non-room field (including missing or non-object `signalData` on `signal:forward`) on any client-to-server event.
2. `INVALID_ROOM_ID`: missing, non-string, or non-canonical `roomId` (`^ship-[a-f0-9]{4}$`) on `room:join`, `room:leave`, `signal:forward`, or `ice:get`.
3. `ROOM_NOT_FOUND`: valid canonical `roomId` has no active in-memory room.
4. `UNAUTHORIZED`: socket already belongs to another Shipri room (`room:create`, `room:join`), or socket is not an active member of `roomId` (`room:leave`, `signal:forward`, `ice:get`).
5. `ROOM_FULL` / `PEER_UNAVAILABLE`: third socket attempts `room:join` on a two-peer room (`ROOM_FULL`), or single remaining member emits `signal:forward` while `waiting_for_peer` (`PEER_UNAVAILABLE`).
6. `SERVER_BUSY`: backend development STUN configuration is invalid or unavailable during `ice:get`.

Prototype error-handling rules:

* Always branch UI recovery and diagnostics on `error.code`, never on `error.message`.
* Do not reset active valid room membership on failed `room:error` responses, because rejected server operations are atomic no-ops (`ROOM_FULL` on third tab, `UNAUTHORIZED` on cross-room check, `INVALID_PAYLOAD` / `INVALID_ROOM_ID` from the malformed-input panel, or repeated `room:leave` already in `unaffiliated` state).
* Wait for `CONNECTED` state (both peers present) before sending WebRTC signals; treat `PEER_UNAVAILABLE` as feedback that the remote peer has not joined or has left.

### 4.5. Scope Boundary: Prototype Foundation vs. Part 3 Full Backend vs. Part 4 Production Frontend

| Capability Area | Part 2 Prototype Foundation (`FP-0` to `FP-G1`) | Part 3 Prototype Expansion (`FP-5` to `FP-6`) | Part 4 Final Product Frontend (`frontend_development_plan.md`) |
| :--- | :--- | :--- | :--- |
| Room discovery & auth | Canonical `ship-[a-f0-9]{4}` IDs and active socket-state membership only | Production room authorization tokens and TTL / rate-limit errors | Shareable room URL + `#key=...` fragment security and unauthorized-room flows |
| ICE & NAT traversal | Development STUN-only `ice:credentials` (`urls` only, no TURN) | Dynamic TURN credentials, `iceTransportPolicy: 'all' \| 'relay'`, candidate-pair diagnostics | Automatic direct + TURN fallback for real user file transfers |
| Data channel usage | One `"shipri-diagnostic"` channel for plaintext `ping`, `pong`, and short `text` | Same diagnostic channel exercised over direct and forced-TURN paths | Dual-channel or framed E2EE control board + chunked binary streams with backpressure |
| Cryptography & privacy | Sanitized event log and zero secret logging | Sanitized ICE scheme/relay status (no TURN `credential` / `username` logging) | URL-hash CSPRNG master secret, HKDF keys, AES-GCM metadata and file chunks |
| User files & persistence | Prohibited (diagnostic strings only; never real user files) | Prohibited (diagnostic messages only) | Encrypted shared file board, explicit download requests, Chrome/Safari disk persistence |

---

## 5. Prototype Foundation Stages

### FP-0: Freeze the Prototype Backend Contract

**Work:**

* Import the accepted room, signaling, leave, error, and development ICE payloads from `backend_poc_plan.md`.
* Record the additional full-backend scenarios that will be added during Part 3.
* Update `signaling_protocol_spec.md` and `testing_strategy.md`.

**Exit criteria:**

* Every initial prototype action maps to the accepted POC contract.
* Later full-backend diagnostic actions are documented separately.

**Status:** Completed and frozen in Section `4` above (`2026-11-15`); `signaling_protocol_spec.md` Subsection `3.7` and `testing_strategy.md` Subsection `1.3` are synchronized.

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

* Build and deploy the diagnostic frontend to the approved staging origin (`https://poc.shipri.app`).
* Configure the frontend to connect to the staging backend through WSS (`VITE_SIGNALING_URL=https://poc.shipri.app` build arg default in `client/Dockerfile`, `docker-compose.prod.yml`, and `docker-compose.yml`, plus safe non-localhost `https:` `window.location.origin` fallback in `client/src/signaling/socket-client.js`).
* Validate room creation, joining, signaling, and data-channel ping/pong from two devices.
* Repeat the direct WebRTC check from two different networks.
* Keep prototype diagnostics and staging access separate from the future production route (`X-Shipri-Environment: poc-staging`, `X-Robots-Tag: noindex, nofollow`, zero secrets, no `coturn`).

**Staging Configuration and Verification Evidence:**

* **Container & Compose Wiring**: `client/Dockerfile` defines `ARG VITE_SIGNALING_URL=https://poc.shipri.app` and `ENV VITE_SIGNALING_URL=$VITE_SIGNALING_URL` before `RUN npm run build`; both `docker-compose.prod.yml` and `docker-compose.yml` pass `VITE_SIGNALING_URL=${VITE_SIGNALING_URL:-https://poc.shipri.app}` under `client.build.args` without exposing host port `5001`, `TURN_SHARED_SECRET`, or default `coturn` containers.
* **Build Verification**: `VITE_SIGNALING_URL=https://poc.shipri.app npm --prefix client run build` builds the Vite bundle cleanly, and `docker compose -f docker-compose.prod.yml config` / `docker compose -f docker-compose.yml config` validate the secret-free staging service topologies.
* **Automated Staging Integration Verification**: `client/test/staging-prototype.test.js` verifies `resolveSignalingUrl` non-localhost `https:` fallback and explicit `VITE_SIGNALING_URL` precedence, Docker/Compose build-arg configuration, and a full two-remote-peer prototype integration run configured for `https://poc.shipri.app` (`room:create`, `room:join`, STUN-only `ice:credentials`, offer/answer + trickle ICE, `"shipri-diagnostic"` bidirectional `ping`/`pong` + short `text`, sanitized `eventLog` redaction, and `room:leave` teardown) using deterministic Socket.IO and `RTCPeerConnection` test harnesses.
* **Post-DNS Host Verification (`https://poc.shipri.app`)**: Once `poc.shipri.app` DNS and VPS containers (`docker compose -f docker-compose.prod.yml up -d --build` or `docker compose -f docker-compose.yml up -d --build`) are running, follow `deployment_docker_spec.md` Subsections `1.6` and `1.7` on the host to run `npm --prefix server run smoke:staging`, `curl -fsSI https://poc.shipri.app/`, `curl -fsS https://poc.shipri.app/health`, and the manual two-device cross-network browser WebRTC and `"shipri-diagnostic"` ping/pong/text check.

**Exit criteria:**

* The deployed prototype connects to the deployed Backend POC through WSS.
* Two remote devices establish a direct WebRTC data channel through staging signaling.
* Deployment and rollback steps are documented (`deployment_docker_spec.md` Subsections `1.6` and `1.7`).

### FP-G1: Prototype Foundation Gate

**Work:**

* Validate every accepted Backend POC event through the prototype.
* Confirm direct WebRTC data-channel connectivity locally and through staging.
* Document how to run and deploy the POC and frontend prototype together.

**Exit criteria:**

* The frontend prototype foundation validates the Backend POC without mocks.
* Full backend development may begin.

**Status:** Foundation test suite, Vite/Compose staging build checks, local live Backend POC Socket.IO integration, and prototype limitations are verified and recorded in Section `8` below (`2026-11-23`); external `https://poc.shipri.app` smoke and two-network browser checks remain gated on public DNS `A`-record assignment for `poc.shipri.app`.

---

## 6. Prototype Expansion During Full Backend Development

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

## 7. Prototype Verification

At the end of each stage, run:

* Frontend unit tests.
* `npm run build`.
* Manual two-tab room and WebRTC scenarios.
* Direct and forced-TURN checks when ICE behavior changes.

---

## 8. Prototype Foundation Acceptance Evidence & Limitations (FP-G1)

Recorded on `2026-11-23` after completing prototype foundation implementation (`FP-0` through `FP-4`) and integrated `FP-G1` acceptance verification:

### 8.1. Automated Frontend and Backend Test & Build Evidence

* **Frontend unit and gate suite (`npm --prefix client test`)**: `10` test files passed, `75` tests passed (`0` failed, `0` skipped), runnable standalone via `cd client && npm ci && npm test` without importing `server/` modules.
  * `client/test/prototype-foundation-gate.test.js` (`4` integrated `FP-G1` gate tests): validates canonical `ship-[a-f0-9]{4}` room creation, second-peer join, third-peer rejection (`ROOM_FULL`), creator and joiner explicit `room:leave` plus unexpected `disconnect` with remaining-peer `offerer` promotion, replacement-peer joins with incremented negotiation generations and stale `peerId`/generation filtering, all `7` stable `room:error` codes (`ROOM_NOT_FOUND`, `ROOM_FULL`, `INVALID_ROOM_ID`, `INVALID_PAYLOAD`, `UNAUTHORIZED`, `PEER_UNAVAILABLE`, `SERVER_BUSY`), `UNKNOWN_ERROR` fallback, `MALFORMED_TEST_SCENARIOS` presets, `INVALID_ICE_CREDENTIALS`, selective error recovery preserving active room state and sanitized logs, STUN-only `ice:credentials` validation, early trickle ICE queuing and ordered flush after `setRemoteDescription()`, `5000ms` non-blocking ICE gathering bound, bidirectional `"shipri-diagnostic"` `ping`/`pong` and short `text` exchange initiated by both `offerer` and `answerer`, and zero leaked SDP strings, ICE candidates, TURN secrets, `#key=` fragments, tokens, or file metadata across UI markup and sanitized logs.
* **Backend POC suite (`npm --prefix server test`)**: `12` test files passed, `205` tests passed (`0` failed, `0` skipped).
* **Frontend production builds**:
  * `npm --prefix client run build`: passed (`66` modules transformed).
  * `VITE_SIGNALING_URL=https://poc.shipri.app npm --prefix client run build`: passed (`66` modules transformed).

### 8.2. Local Live Backend POC Integration Verification

* Started the live Backend POC signaling server locally (`npm --prefix server start` on `http://127.0.0.1:5001`) and confirmed `GET /health` returned `200 OK` (`{"status":"ok","roomsCount":0}`).
* Connected real `createSignalingClient` (`socket.io-client`) instances from `client/src/signaling/socket-client.js` paired with `bindSignalingClient`, `createRoomLifecycleActions`, `createWebRtcHarness`, and `createDiagnosticChannelController` over live localhost Socket.IO (`http://127.0.0.1:5001`, using `createMockPeerConnectionFactory` in headless Node.js for the `RTCPeerConnection` engine):
  * Verified room creation (`roomId: "ship-7bfb"`), `GET /health` (`roomsCount: 1`), second-peer join, third-peer rejection (`ROOM_FULL`), STUN-only `ice:credentials` validation (`serverEntryCount: 1`, `endpointCount: 2`, `schemes: ["stun"]`, `isStunOnly: true`), live Socket.IO offer/answer and trickle ICE relay (`Gen 1`), bidirectional `"shipri-diagnostic"` `ping`/`pong` (`11 ms` / `15 ms`) and `text` exchange, explicit creator `room:leave` with joiner promotion to `offerer`, replacement-peer join with `Gen 3` re-negotiation and bidirectional `ping`/`pong`/`text` (`11 ms` / `15 ms`), unexpected disconnect (`peer:left` with `reason: "disconnect"`), final-peer leave, empty-room deletion (`GET /health` `roomsCount: 0`), and zero sensitive tokens across client `eventLog` and server stdout.

### 8.3. Staging Bundle Configuration & Host DNS Status

* **Docker & Compose Topology Validation**: `docker compose -f docker-compose.prod.yml config` and `docker compose -f docker-compose.yml config` exited `0`, confirming `VITE_SIGNALING_URL: https://poc.shipri.app` under `client.build.args` with zero `TURN_SHARED_SECRET`, zero host `5001` bindings, and no default `coturn` service.
* **Staging VPS Container Build (`deploy.yml`)**: GitHub Actions `deploy.yml` run `44228702186` (`2026-11-18T03:12:00Z`, `conclusion: success`) pulled `main` and executed `docker compose -f docker-compose.prod.yml up -d --build` on the staging VPS, leaving `shipri-server` and `shipri-client` running.
* **Public DNS & Live Staging Endpoint Status (`https://poc.shipri.app`)**: Running `dig +short A poc.shipri.app` currently returns empty output, and `npm --prefix server run smoke:staging` fails with exit `1` (`[FAIL] Backend POC staging smoke checks failed: fetch failed`). Remote HTTPS/WSS validation (`npm --prefix server run smoke:staging`, `curl -fsSI https://poc.shipri.app/`, `curl -fsS https://poc.shipri.app/health`, and two-network manual browser WebRTC + `"shipri-diagnostic"` ping/pong/text checks per `deployment_docker_spec.md` Subsections `1.6` and `1.7`) remains pending external DNS `A`-record and host proxy assignment for `poc.shipri.app`.

### 8.4. Prototype Limitations

* **Plaintext diagnostic channel only**: `"shipri-diagnostic"` exchanges unencrypted JSON `ping`, `pong`, and short `text` payloads (`MAX_DIAGNOSTIC_TEXT_LENGTH = 200`); URL `#key=` CSPRNG secrets, HKDF key derivation, and AES-GCM encryption belong to Part 4 (`frontend_development_plan.md`).
* **No user files or persistence**: The prototype prohibits real user files, encrypted shared file boards, chunked backpressure transfers, and Chrome/Safari disk persistence; active rooms reside only in `shipri-server` memory and reset on server restart.
* **Development STUN-only ICE without TURN**: `ice:get` returns configured public STUN URLs only; `coturn`, dynamic HMAC-SHA1 TURN credentials, selectable `iceTransportPolicy: "relay"`, and candidate-pair direct-versus-relay diagnostics are deferred to Part 3 (`BE-4` and `FP-5`).
* **No production room authorization, TTL, or abuse controls**: Room membership relies solely on active Socket.IO connection state for canonical `ship-[a-f0-9]{4}` IDs, omitting production room authorization tokens, idle TTL/max lifetime, rate limiting, trusted-proxy limits, and room caps until Part 3 (`BE-2`, `BE-3`, and `FP-6`).
* **Pre-DNS remote staging verification boundary**: While local live Backend POC integration, Vite staging builds, and Docker Compose configurations are verified, live public-network browser verification over `https://poc.shipri.app` awaits external DNS pointing `poc.shipri.app` to the staging VPS.

### 8.5. Running Locally and Deploying to Staging

1. **Local Development Run**:
   * Terminal 1 (Backend POC): `cd server && npm ci && npm start` (listens on `http://127.0.0.1:5001`).
   * Terminal 2 (Frontend Prototype): `cd client && npm ci && npm run dev` (serves on `http://localhost:5173`, connecting to `http://localhost:5001` via `resolveSignalingUrl`).
   * Open two browser tabs at `http://localhost:5173` to exercise room creation, joining, third-tab `ROOM_FULL`, `Validation & Error Scenarios`, STUN-only `ice:get`, WebRTC negotiation, `"shipri-diagnostic"` bidirectional `ping`/`pong`/`text`, and leave/disconnect recovery.
2. **Staging Deployment and Post-DNS Verification**:
   * Follow `deployment_docker_spec.md` Subsections `1.6` and `1.7` on the staging host (`docker compose -f docker-compose.prod.yml up -d --build` for Topology A or `docker compose -f docker-compose.yml up -d --build` for Topology B), then run `npm --prefix server run smoke:staging` and the two-network browser verification checklist once `dig +short A poc.shipri.app` resolves to the staging VPS.
