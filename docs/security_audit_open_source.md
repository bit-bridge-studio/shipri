# Open-Source Security & Vulnerability Analysis (Shipri)

Since Project Shipri is open-source, the codebase is public and subject to security audits by developers, security researchers, and potential adversaries. This document provides a vulnerability analysis and security guidelines to ensure the project remains secure and robust.

---

## 1. Secrets Management & Repository Protection

### 1.1. Hardcoded Secrets in Config Files
* **Risk**: High. Committing credentials (like the Coturn `TURN_SHARED_SECRET`) to a public GitHub repository.
* **Mitigation**:
  * We created `.env.example` templates instead of placing keys in code.
  * A strict `.gitignore` must be placed in the project root to exclude all `.env` files and certificates.
  * **Mitigation Implementation**:
    ```text
    # .gitignore
    .env
    .env.local
    *.pem
    *.key
    *.crt
    node_modules/
    dist/
    caddy_data/
    caddy_config/
    ```

---

## 2. Cryptographic Architecture Vulnerability Review

Since the encryption logic executes entirely on the client, exposing the code in open-source allows anyone to audit the E2EE implementation. This prevents "security by obscurity" and forces mathematical rigor.

### 2.1. Randomness of Key Generation
* **Risk**: If the AES-256 keys are generated using predictable random number generators (like `Math.random()`), an attacker could brute-force the keys.
* **Mitigation**: We strictly use browser CSPRNG APIs for E2EE master secrets: `crypto.getRandomValues(new Uint8Array(32))` for the URL fragment master secret, followed by Web Crypto HKDF-derived AES-GCM keys for metadata and chunks.

### 2.2. IV (Initialization Vector) Reuse in AES-GCM
* **Risk**: High. In AES-GCM, reusing the same IV with the same key to encrypt two different payloads leaks information about the plaintext and allows an attacker to forge messages.
* **Mitigation**: We derive separate AES-GCM keys for metadata and file chunks. Metadata uses a random 12-byte IV generated with `crypto.getRandomValues`; file chunks use a deterministic 12-byte incrementing chunk counter with the chunk key. This prevents IV reuse within the same key domain.

### 2.3. Browser Cache and History Leakage
* **Risk**: The decryption key is passed in the URL hash fragment (`#key=...`). If the browser saves this in history or autocomplete lists, anyone with physical access to the device can access the file link.
* **Mitigation**: 
  * The frontend must actively clean up the key from the address bar immediately after extraction using:
    `window.history.replaceState(null, '', window.location.pathname);`
    This wipes the key from the active screen and address bar while keeping the connection running in RAM (with optional tab-scoped `sessionStorage` recovery wiped on leave/reset per `architectural_audit.md` Section `2.4`).

### 2.4. HKDF Domain Separation for Room Authorization vs. E2EE Keys
* **Risk**: If room authorization reuses the short public `roomId` (`ship-[a-f0-9]{4}`), attackers can enumerate rooms and block legitimate peers (slot-DoS). Conversely, if room authorization reuses E2EE key material or travels in HTTP paths/queries, the untrusted signaling server or HTTP proxy logs could compromise E2EE confidentiality.
* **Mitigation**:
  * Production clients derive `roomAuthToken` from the 256-bit `#key=` fragment master secret using one-way HKDF-SHA256 with constant domain `salt: "shipri-room-auth-salt-v1"` and `info: "shipri-room-auth-v1"` (`signaling_protocol_spec.md` Section `2.2.1`).
  * E2EE AES-GCM keys (`shipri-board-metadata-v1`, `shipri-control-v1`, `shipri-file-chunks-v1`) use per-room `salt: "shipri:${roomId}"` and separate `info` labels (`security_e2ee_spec.md` Section `2.2`).
  * Because HKDF-SHA256 is one-way and the salt/info domains are disjoint, presenting `authVerifier` (`room:create`) or `authToken` (`room:join`) to the signaling server reveals zero master-secret or E2EE key material and never puts authorization tokens in URL paths, query parameters, or `Referer` headers.

---

## 3. Server-Side Attack Surface (DoS, Authorization & Abuse)

The signaling server handles active WebSocket rooms in memory. In a public, open-source deployment, this is a prime target for abuse.

### 3.1. In-Memory Room Exhaustion (Memory DoS)
* **Risk**: A script could spam `room:create` thousands of times, filling the server's `activeRooms` Map and crashing the Node.js process due to memory exhaustion, or spoof `X-Forwarded-For` headers to bypass IP rate limits.
* **Mitigation**:
  * **Trusted Proxy Boundary (`TRUST_PROXY`)**: Rate-limit IP extraction must honor `TRUST_PROXY` (`false` by default for direct connections; explicitly configured hop/proxy rule when behind `nginx-proxy` or Caddy). Unconfigured direct servers must ignore client-supplied `X-Forwarded-For` headers so attackers cannot spoof IP addresses.
  * **Per-IP `room:create` Rate Limiting**: Enforce `ROOM_CREATE_RATE_LIMIT_MAX` (`10`) creations per resolved client IP within `ROOM_CREATE_RATE_LIMIT_WINDOW_MS` (`60000` ms), returning stable `room:error` (`code: 'RATE_LIMITED'`) without mutating `activeRooms`.
  * **Room TTL & Hard Lifetime**: Rooms expire automatically after `ROOM_IDLE_TTL_MS` (`1800000` ms / 30 minutes idle or waiting) and at most `ROOM_MAX_LIFETIME_MS` (`14400000` ms / 4 hours hard cap from creation). A periodic sweep (`ROOM_CLEANUP_INTERVAL_MS = 60000` ms) plus lazy expiry checks on lookup remove expired rooms, notify attached sockets with `ROOM_NOT_FOUND`, and purge `socketRooms`.
  * **Memory Limits (`MAX_ROOMS`)**: Restrict concurrent active rooms after expired-room cleanup:
    ```javascript
    const MAX_ROOMS = 5000;
    if (activeRooms.size >= MAX_ROOMS) {
      socket.emit('room:error', {
        code: 'SERVER_BUSY',
        message: 'Server capacity reached. Try again later.',
      });
      return;
    }
    ```
  * **CSPRNG Room & Peer IDs**: Generate the random suffix of `ship-[a-f0-9]{4}` with Node.js `crypto.randomBytes(2)` (checked unique against `activeRooms`) and opaque `peerId` values with `crypto.randomBytes(8)`, never `Math.random()`.

### 3.2. Socket Room Spoofing, Slot-DoS & Connection Injection
* **Risk**: Because `ship-[a-f0-9]{4}` has only 65,536 values, an attacker could scan room IDs to occupy the second peer slot (slot-DoS), probe room occupancy, or inject spoofed signaling messages.
* **Mitigation**:
  * **Independent Room Authorization (`REQUIRE_ROOM_AUTH = true`)**: Production startup must fail if `REQUIRE_ROOM_AUTH=false` while `NODE_ENV=production`. On `room:create`, the creator supplies `authVerifier` (43-char unpadded `base64url` SHA-256 digest of `authToken`), stored in `Room.authVerifierHash` as a 32-byte `Buffer`. On `room:join`, the server computes `SHA-256(utf8(authToken))` and verifies it via `crypto.timingSafeEqual(candidateHash, room.authVerifierHash)` before checking capacity (`ROOM_FULL`). Checking `authToken` first prevents unauthenticated attackers from probing whether a room has 1 or 2 peers, and storing only the SHA-256 hash of `authToken` prevents server-memory disclosure from revealing a valid `authToken`.
  * **Validation Precedence & Capacity**: Enforce the frozen validation precedence (`RATE_LIMITED` / payload / membership / `MAX_ROOMS` on `room:create`; payload shape -> canonical `/^ship-[a-f0-9]{4}$/` `roomId` -> active non-expired room -> `UNAUTHORIZED` -> `ROOM_FULL` / `PEER_UNAVAILABLE` -> `SERVER_BUSY` on room-targeted events). Room capacity is strictly `2`.
  * **O(1) Membership & Signal Relay**: Maintain a synchronized `socketRooms` reverse index. On `signal:forward`, verify active membership via `socketRooms` and `room.peers` (`UNAUTHORIZED`), require a second active peer (`PEER_UNAVAILABLE`), and relay `{ roomId, peerId, signalData }` via `io.to(targetPeer.socketId)` without inspecting, logging, or mutating `signalData`.

### 3.3. CORS Restrictions & Privacy-Safe Operational Logging
* **Risk**: Permissive CORS (`*`) lets arbitrary origins connect to signaling endpoints, while verbose operational logs can leak `socket.id` tracking correlations, client IP addresses, `authToken`, `TURN_SHARED_SECRET`, SDP payloads, or ICE candidates.
* **Mitigation**:
  * **Strict `ALLOWED_ORIGINS` Enforcement**: Both Express HTTP CORS and Socket.IO CORS enforce canonical `http://` or `https://` origins from `ALLOWED_ORIGINS`. Wildcards (`*`), paths, query strings, fragments, and embedded credentials fail startup validation.
  * **Zero-Secret & Zero-Payload Logging**: Production logs (implemented in `server/src/logger.js`) record minimal operational lifecycle events (`roomId`, error `code`, startup/shutdown status) only. Never log unnecessary `socket.id` identifiers in production logs, raw client IP addresses, `authToken`, `authVerifier`, `authVerifierHash`, `TURN_SHARED_SECRET`, TURN `username` or `credential`, SDP bodies, ICE candidates, `#key=` fragments, E2EE keys, file metadata, board state, file requests, or file contents.
  * **Transport Frame Bounds**: Socket.IO configures `maxHttpBufferSize = 65536` bytes (`SIGNAL_DATA_MAX_BYTES`) so oversized signaling payloads are dropped at the transport boundary without inspecting or mutating opaque `signalData`.

---

## 4. Coturn TURN Server Protection

Because the TURN server relays raw encrypted bytes when direct P2P connection fails, it can consume vast amounts of server network bandwidth.

### 4.1. Unauthorized Proxy Usage & Safe Credential Failure
* **Risk**: Attacking bots can scan and find the TURN server and use it to proxy illegal traffic, incurring high costs for the owner, or misconfigured servers could leak `TURN_SHARED_SECRET` in error output.
* **Mitigation**:
  * **REST API Authentication (Time-Limited Tokens)**: Never expose static TURN login/password pairs. `shipri-server` derives ephemeral credentials (`TURN_CREDENTIAL_TTL_SECONDS = 7200`, username `${expiresAt}:${opaqueRoomPeerTag}`, credential `HMAC-SHA1(TURN_SHARED_SECRET, username)` in base64) from validated environment variables (`STUN_URLS`, `TURN_URLS`, `TURN_SHARED_SECRET`).
  * **Fail-Closed Validation**: Missing or invalid `TURN_URLS` or `TURN_SHARED_SECRET` in production fails startup validation or returns `room:error` (`code: 'SERVER_BUSY'`) on `ice:get` without exposing `TURN_SHARED_SECRET` or stack details in client responses or logs.
  * **Port & Certificate Isolation**: Coturn rejects expired or invalid HMAC credentials and binds `turn.shipri.app:443` separately from Caddy (`shipri.app:443`) per `nat_traversal_strategy.md` and `deployment_docker_spec.md`.

---

## 5. Backend Security Audit Checklist (`BE-7` Sign-Off)

Audited against the full backend implementation on `2026-11-24`:

| Audit Control | Verification Status | Implementation & Test Evidence |
| :--- | :--- | :--- |
| Zero committed secrets or placeholder TURN credentials | Verified | `coturn/turnserver.conf` omits active `static-auth-secret`; runtime env injection in `docker-compose.yml`; checked by `server/test/deployment-config.test.js` and `server/test/coturn-hardening.test.js`. |
| `TURN_SHARED_SECRET` isolated from logs, responses, and config serialization | Verified | Stored in module-scoped `WeakMap` (`getTurnSharedSecret` in `server/src/config.js`); absent from `JSON.stringify(config)`, `ice:credentials`, `/health`, `/ready`, `/metrics`, and logger outputs (`server/test/ice-turn.test.js`, `server/test/backend-acceptance-gate.test.js`). |
| CSPRNG room and peer identifiers | Verified | `crypto.randomBytes` in `server/src/room-id.js`; zero `Math.random()` usage (`server/test/room-create.test.js`). |
| Production room authorization (`REQUIRE_ROOM_AUTH=true`) & constant-time verification | Verified | `NODE_ENV=production` rejects `REQUIRE_ROOM_AUTH=false` (`server/src/config.js`); `SHA-256` + `crypto.timingSafeEqual` in `server/src/room-auth.js` enforced before `ROOM_FULL` (`server/test/room-lifecycle-security.test.js`). |
| Strict payload schemas, canonical room IDs, and 64 KiB frame limit | Verified | Exact-field validators in `server/src/room-id.js`; opaque `signalData` untouched; `maxHttpBufferSize: 65536` in `server/src/server.js` (`server/test/room-id.test.js`, `server/test/signal-forward.test.js`). |
| Non-member signaling, ICE, and leave isolation | Verified | O(1) `socketRooms` membership checks return `UNAUTHORIZED` with zero spoofed `signal:receive` events (`server/test/signal-forward.test.js`, `server/test/backend-acceptance-gate.test.js`). |
| Abuse controls: `TRUST_PROXY`, per-IP `room:create` rate limiting, `MAX_ROOMS`, TTL/GC | Verified | `server/src/rate-limit.js`, `server/src/room-store.js`, `server/src/server.js`; tested in `server/test/abuse-controls.test.js` and `server/test/room-lifecycle-security.test.js`. |
| Strict HTTP and Socket.IO CORS allowlist (no wildcard `*`) | Verified | Canonical origin parser in `server/src/config.js` applied to Express and Socket.IO (`server/test/config.test.js`, `server/test/abuse-controls.test.js`). |
| Privacy-safe operational logging and non-tracking metrics | Verified | `server/src/logger.js` and `GET /metrics` omit `socket.id`, client IPs, `authToken`, `authVerifier`, TURN secrets/credentials, SDP, ICE candidates, and user file data (`server/test/abuse-controls.test.js`, `server/test/backend-acceptance-gate.test.js`). |
| Hardened Coturn relay SSRF/quota/TLS controls | Verified | `coturn/turnserver.conf` enforces relay ports `49152-65535`, quotas, `stale-nonce`, `no-cli`, `no-loopback-peers`, `no-multicast-peers`, RFC1918/IPv6 `denied-peer-ip`, and modern TLS (`server/test/coturn-hardening.test.js`). |
| Non-root container execution and lockfile-pinned builds | Verified | `server/Dockerfile` runs `npm ci --omit=dev` and `USER node`; `client/Dockerfile` runs `npm ci` (`server/test/deployment-config.test.js`). |
| Graceful shutdown and in-memory state cleanup | Verified | `SIGTERM`/`SIGINT` in `server/src/index.js` call idempotent `close()`, flipping `/ready` to `503` and clearing `activeRooms`, `socketRooms`, and `rateLimiter` (`server/test/backend-acceptance-gate.test.js`). |
