# Docker & Deployment Specification (Shipri)

This document specifies the containerized deployment architecture for Project Shipri using Docker and Docker Compose. This setup allows deploying the frontend, signaling server, and TURN infrastructure onto a VPS-oriented environment.

---

## 1. Early POC Staging Deployment

Before production infrastructure is complete, the Backend POC is deployed to a dedicated, restricted staging environment (`poc.shipri.app`) so the team can validate real HTTPS/WSS, DNS, reverse-proxy, and remote-network behavior without exposing production services or secrets.

### 1.1. Environment Identity and Scope Boundary

* **Explicit POC Staging Identity**: `poc.shipri.app` is a pre-production test environment and is not production-ready. Staging reverse-proxy responses should identify the environment via headers:
  * `X-Shipri-Environment: poc-staging`
  * `X-Robots-Tag: noindex, nofollow`
* **Included Services**: the Node.js signaling server (`shipri-server`), `GET /health`, Socket.IO signaling over WSS (`/socket.io/*`), and, once frontend prototype foundation passes `BP-6`, the diagnostic prototype (`shipri-client`).
* **Excluded Scope and Zero-Secret Rule**: no production traffic, real user files, Coturn relay container, TURN credentials, `TURN_SHARED_SECRET`, or production secrets exist in the POC staging environment. `ice:get` returns configured public STUN endpoints only.

After the frontend prototype foundation is implemented, it is deployed to the approved staging origin and used to verify Socket.IO and direct WebRTC connectivity between devices on different networks.

POC staging environment boundaries, configuration, smoke checks, and operational procedures (deploy, update, rollback, and log inspection) are defined in Subsections 1.1 through 1.7 below before the Backend POC Acceptance Gate (`BP-6`). Full production deployment remains governed by Sections 2 through 6 below.

### 1.2. Hostname, Approved Origins, and Port Matrix

| Setting | Backend POC Staging Value / Rule | Production / Deferred Comparison |
| :--- | :--- | :--- |
| Staging hostname | `poc.shipri.app` | Isolated from production `shipri.app` and `turn.shipri.app`. |
| Approved CORS `ALLOWED_ORIGINS` | `https://poc.shipri.app,http://localhost:3000,http://127.0.0.1:3000,http://localhost:5173,http://127.0.0.1:5173` (or `https://poc.shipri.app` only for staging-only access) | `https://shipri.app` and wildcard `*` are prohibited on POC staging. |
| Public host ports | `80/tcp` (ACME HTTP-01 challenge / HTTPS redirect) and `443/tcp` (HTTPS `/health`, WSS `/socket.io/*`, prototype UI) | Served via external host proxy or standalone Caddy, never both simultaneously. |
| Internal container ports | `5001/tcp` (`shipri-server` on `shipri-network`), `80/tcp` (`shipri-client` on `shipri-network` / `nginx-proxy`) | `5001/tcp` must use internal network `expose` and must not be published directly on `0.0.0.0:5001`. |
| Excluded NAT traversal ports | `3478/udp`, `3478/tcp`, `5349/tcp`, `49152-65535/udp` | Coturn TURN/TURNS ports stay closed until full backend development. |

### 1.3. Reverse-Proxy Topology (Avoiding Port 80/443 Collisions)

The staging host must use exactly one reverse-proxy owner on public ports `80/tcp` and `443/tcp`:

* **Topology A - Host External `nginx-proxy` Network (`docker-compose.prod.yml`)**: used on multi-service VPS hosts (including the active deployment target) where an existing external reverse proxy already owns `80` and `443`.
  * Staging containers attach to the internal `shipri-network` and external `nginx-proxy` Docker networks without declaring host `ports` on `80` or `443`.
  * The host reverse proxy terminates TLS for `poc.shipri.app` and forwards `/health` and `/socket.io/*` (preserving `Upgrade` and `Connection` headers for WebSockets, plus `X-Shipri-Environment: poc-staging` and `X-Robots-Tag: noindex, nofollow`) to `shipri-server:5001`, and `/` to `shipri-client:80`.
* **Topology B - Standalone Bundled Caddy (`docker-compose.yml` + `Caddyfile`)**: used on a dedicated staging host where ports `80` and `443` are unoccupied.
  * The bundled `shipri-proxy` (Caddy) service binds `80:80` and `443:443`, terminates TLS for `poc.shipri.app`, sets `X-Shipri-Environment: poc-staging` and `X-Robots-Tag: noindex, nofollow`, and proxies `/health` and `/socket.io/*` to `server:5001`.

Before deploying or changing reverse-proxy mode on a host, verify whether ports `80` and `443` are already bound:

```bash
ss -tulpn | grep -E ':(80|443)\s'
```

### 1.4. Access Restrictions and Secret Isolation

* **No Direct Backend Port Exposure**: the signaling container listens on internal port `5001` only; external clients reach it solely over TLS (`443/tcp`) through the reverse proxy.
* **Strict Origin Allowlist**: Express HTTP CORS and Socket.IO CORS enforce `ALLOWED_ORIGINS` without wildcards (`*`) and reject unapproved or production origins such as `https://shipri.app`.
* **Staging Crawler and Proxy Controls**: responses include `X-Robots-Tag: noindex, nofollow` and `X-Shipri-Environment: poc-staging`. When running closed remote tests, restrict access at the reverse-proxy layer (for example IP allowlisting or HTTP Basic Auth on non-health UI routes) without exposing production credentials.
* **Zero Secrets**: do not set `TURN_SHARED_SECRET` or commit `.env` files, private keys, or placeholder secrets in repository configs.

### 1.5. Required DNS and Server Prerequisites

Before deploying the Backend POC to staging:

1. **DNS Record**: configure an `A` (and optional `AAAA`) DNS record for `poc.shipri.app` pointing to the staging VPS public IP, and verify propagation before requesting TLS certificates:
   ```bash
   dig +short A poc.shipri.app
   ```
2. **Server Runtime**: Linux VPS with Docker Engine and Docker Compose v2 installed.
3. **Firewall**: permit inbound `22/tcp` (restricted SSH), `80/tcp`, and `443/tcp`; keep `5001/tcp` and Coturn ports (`3478`, `5349`, `49152-65535`) closed externally.
4. **Proxy Prerequisite**: confirm either the external `nginx-proxy` Docker network exists for Topology A (`docker network inspect nginx-proxy`) or host ports `80/tcp` and `443/tcp` are free for Topology B.
5. **Deployment Workspace and Runtime Env**: prepare the host deployment directory (for example `/root/containers/shipri`) with an uncommitted `.env` containing only non-secret POC staging settings (`PORT`, `ALLOWED_ORIGINS`, `STUN_URLS`).

### 1.6. Deployable POC Staging Configuration, Validation, and Smoke Checks

Both supported reverse-proxy topologies share the same secret-free signaling server runtime defaults and container health/WebSocket routing:

* **Topology A (`docker-compose.prod.yml` + `client/nginx.conf`)**: builds `shipri-server` (`expose: 5001`) and `shipri-client` (`expose: 80`, passing `VITE_SIGNALING_URL=${VITE_SIGNALING_URL:-https://poc.shipri.app}` as a Docker build arg), attaches both to `shipri-network` and external `nginx-proxy` with zero host `ports:` bindings, and leaves `TURN_SHARED_SECRET` and `coturn` omitted. On the external host `nginx-proxy` (or Nginx Proxy Manager), terminate TLS for `poc.shipri.app` with WebSockets enabled and either proxy `/health` and `/socket.io/*` to `shipri-server:5001` and `/` to `shipri-client:80`, or proxy all paths for `poc.shipri.app` to `shipri-client:80` (where `client/nginx.conf` proxies `/health` and `/socket.io/` to `http://server:5001` over `shipri-network` and sets `X-Shipri-Environment: poc-staging` and `X-Robots-Tag: noindex, nofollow`).
* **Topology B (`docker-compose.yml` + `Caddyfile`)**: runs bundled `shipri-proxy` (`CADDY_SITE_ADDRESS=${CADDY_SITE_ADDRESS:-poc.shipri.app}`), `shipri-client` (passing `VITE_SIGNALING_URL=${VITE_SIGNALING_URL:-https://poc.shipri.app}` as a Docker build arg), and `shipri-server` without any TURN secrets, and isolates `coturn` behind Docker Compose profile `turn` (`profiles: ["turn"]`) so default staging runs omit TURN.

`client/Dockerfile` defaults `ARG VITE_SIGNALING_URL=https://poc.shipri.app` and exports `ENV VITE_SIGNALING_URL=$VITE_SIGNALING_URL` before `RUN npm run build`, so containerized builds target `https://poc.shipri.app` by default without baking in secrets. In addition, `client/src/signaling/socket-client.js` includes a safe non-localhost `https:` same-origin fallback (`window.location.origin`) when `VITE_SIGNALING_URL` is omitted at build time.

Validate the standalone frontend prototype clean install and staging bundle build, plus the rendered Compose configurations, before starting containers:

```bash
npm --prefix client ci && VITE_SIGNALING_URL=https://poc.shipri.app npm --prefix client run build
docker compose -f docker-compose.prod.yml config
docker compose -f docker-compose.yml config
```

Confirm both Compose outputs include `VITE_SIGNALING_URL: https://poc.shipri.app` under `client.build.args` and neither output includes `TURN_SHARED_SECRET`, host port `5001` bindings, or the default `coturn` service.

Build and start the Backend POC staging stack for the active host topology:

```bash
# Topology A (VPS with external nginx-proxy)
docker compose -f docker-compose.prod.yml up -d --build

# Topology B (standalone host with unoccupied 80/443)
docker compose -f docker-compose.yml up -d --build
```

Run the repeatable, secret-free staging smoke checks after startup (and confirm exit code `0`):

```bash
# 1. Automated HTTPS /health, CORS, and WSS Socket.IO round-trip check
#    Requires no production secrets; returns exit code 1 and [FAIL] stderr on error.
npm --prefix server run smoke:staging

# Optional overrides (for example another staging hostname or longer timeout):
SMOKE_BASE_URL=https://poc.shipri.app SMOKE_ORIGIN=https://poc.shipri.app SMOKE_TIMEOUT_MS=5000 npm --prefix server run smoke:staging

# 2. Manual curl checks for prototype UI route, HTTPS health payload, headers, and CORS enforcement
curl -fsSI https://poc.shipri.app/
curl -fsSI https://poc.shipri.app/health
curl -fsS https://poc.shipri.app/health
curl -fsSI -H "Origin: https://poc.shipri.app" https://poc.shipri.app/health
curl -fsSI -H "Origin: https://shipri.app" https://poc.shipri.app/health
```

Expected results: `npm --prefix server run smoke:staging` prints `[PASS]` with exit code `0` after confirming HTTPS `200 OK`, `Cache-Control: no-store`, JSON `{"status":"ok","roomsCount":...}`, matching `access-control-allow-origin: https://poc.shipri.app`, and a WSS WebSocket `room:create` -> `room:created` -> `room:leave` probe; `curl -fsSI https://poc.shipri.app/` returns `200 OK` with `X-Shipri-Environment: poc-staging` and `X-Robots-Tag: noindex, nofollow`; `/health` omits `access-control-allow-origin` when requested from `https://shipri.app`; failed HTTP, CORS, schema, TLS, or WSS checks exit non-zero (`1`).

After DNS and TLS are active on `poc.shipri.app`, verify end-to-end frontend prototype WebRTC and diagnostic messaging between two remote peers:

1. Open `https://poc.shipri.app` in two browsers on separate networks (for example desktop broadband and mobile cellular) and confirm both show `Signaling server connected` over WSS without CORS or mixed-content errors.
2. Click **Create Room** on Peer A and verify `waiting_for_peer`, `entryRole: creator`, `negotiationDuty: offerer`, and a canonical `ship-xxxx` room ID.
3. Enter that `ship-xxxx` room ID on Peer B and click **Join Room**, verifying `connected`, `entryRole: joiner`, and `negotiationDuty: answerer`.
4. Confirm both peers validate STUN-only `ice:credentials` (`ICE Status: ready`, `Development STUN-only`), complete SDP offer/answer and trickle ICE negotiation (`Connection State: connected`), and open `"shipri-diagnostic"` (`Channel State: open`).
5. Click **Send Ping** and submit short **Text** messages from both Peer A and Peer B, confirming RTT measurement, message receipt in both directions, and sanitized Event Log entries with zero raw SDP strings, ICE candidate details, or secrets.
6. Click **Leave Room** on Peer B (confirming Peer A remains in `waiting_for_peer` as `offerer` with closed `RTCPeerConnection` and `RTCDataChannel`), then click **Leave Room** on Peer A to return cleanly to `unaffiliated`.

When to run staging smoke checks:

1. Immediately after the initial Backend POC or frontend prototype staging deployment.
2. After every staging container image rebuild, frontend/backend code update, or `.env` configuration change.
3. After any reverse-proxy (`nginx-proxy`, `Caddyfile`, `client/nginx.conf`), TLS certificate, DNS, or firewall rule change.
4. After executing any rollback procedure and before closing the Backend POC (`BP-6`) or Frontend Prototype (`FP-4`, `FP-G1`) acceptance checks.

### 1.7. POC Staging Operations: Deploy, Update, Rollback, and Log Inspection

> **Not Production-Ready:** The Backend POC staging environment (`poc.shipri.app`) is a restricted pre-production test environment and **is not production-ready**. It omits production room authorization tokens, rate limiting, room TTL and capacity limits, dynamic TURN credentials (`coturn` / `TURN_SHARED_SECRET`), and persistent room storage. Restarting or recreating `shipri-server` clears all in-memory rooms (`activeRooms`).

Choose `<compose-file>` according to the host reverse-proxy topology from Subsection `1.3`:

* **Topology A (VPS with external `nginx-proxy`)**: `docker-compose.prod.yml`
* **Topology B (standalone host with unoccupied ports `80/443`)**: `docker-compose.yml`

#### 1.7.1. Initial Deployment

1. Confirm DNS, host port ownership, and proxy prerequisites from Subsection `1.5`:
   ```bash
   dig +short A poc.shipri.app
   ss -tulpn | grep -E ':(80|443)\s'
   # Topology A only:
   docker network inspect nginx-proxy
   ```
2. Clone the repository into the host deployment workspace (for example `/root/containers/shipri`), check out the target Backend POC revision, and record the deployed commit for rollback tracking:
   ```bash
   cd /root/containers/shipri
   git checkout <branch-or-commit>
   git rev-parse --short HEAD
   ```
3. Create an uncommitted host `.env` containing only non-secret POC staging settings (`PORT=5001`, approved `ALLOWED_ORIGINS`, and `STUN_URLS` as documented in `server/.env.example`). Do not set `TURN_SHARED_SECRET` or any production credentials.
4. Render and inspect the Compose configuration before starting containers, confirming `VITE_SIGNALING_URL: https://poc.shipri.app` is set on `client` and neither `TURN_SHARED_SECRET` nor `coturn` is present:
   ```bash
   # Topology A:
   docker compose -f docker-compose.prod.yml config

   # Topology B:
   docker compose -f docker-compose.yml config
   ```
5. Build and start the staging containers, then verify their status:
   ```bash
   # Topology A:
   docker compose -f docker-compose.prod.yml up -d --build
   docker compose -f docker-compose.prod.yml ps

   # Topology B:
   docker compose -f docker-compose.yml up -d --build
   docker compose -f docker-compose.yml ps
   ```
6. Run the staging smoke checks from Subsection `1.6` (`npm --prefix server run smoke:staging`, `curl -fsSI https://poc.shipri.app/`, plus the manual `curl` HTTPS `/health` and CORS checks) and require exit code `0`, then complete the manual two-peer remote WebRTC/diagnostic check from Subsection `1.6`.

#### 1.7.2. Routine Updates

1. Record the currently running working Git revision before making changes:
   ```bash
   cd /root/containers/shipri
   PREV_REV=$(git rev-parse --short HEAD)
   echo "Previous working revision: ${PREV_REV}"
   ```
2. Fetch and check out the updated revision (use `git pull --ff-only` when advancing a tracked branch, or `git checkout <target-commit>`), and re-validate the Compose configuration:
   ```bash
   git fetch origin
   git checkout <branch-or-commit>
   # When on a branch:
   git pull --ff-only origin <branch>
   docker compose -f <compose-file> config
   ```
3. Rebuild and recreate the containers (recreating `shipri-server` resets active in-memory rooms, so notify active remote testers beforehand):
   ```bash
   # Topology A:
   docker compose -f docker-compose.prod.yml up -d --build --remove-orphans

   # Topology B:
   docker compose -f docker-compose.yml up -d --build --remove-orphans
   ```
4. Check container state (`docker compose -f <compose-file> ps`) and run the staging smoke checks from Subsection `1.6`:
   ```bash
   npm --prefix server run smoke:staging
   curl -fsSI https://poc.shipri.app/
   curl -fsSI -H "Origin: https://poc.shipri.app" https://poc.shipri.app/health
   curl -fsSI -H "Origin: https://shipri.app" https://poc.shipri.app/health
   ```
   If any smoke check fails (returns non-zero exit code `1`), execute the rollback procedure in Subsection `1.7.3` immediately.

#### 1.7.3. Rollback Procedure (Restoring the Previous Working POC Version)

1. Confirm the previous known-working Git revision (`PREV_REV` saved before the update, or locate it with `git log --oneline -n 5`):
   ```bash
   cd /root/containers/shipri
   git log --oneline -n 5
   ```
2. Check out the previous working POC revision, restore any non-secret `.env` overrides (`PORT`, `ALLOWED_ORIGINS`, `STUN_URLS`) if they changed during the failed update, and re-validate the Compose config:
   ```bash
   git checkout "${PREV_REV}"
   docker compose -f <compose-file> config
   ```
3. Rebuild and restart the containers from the restored revision:
   ```bash
   # Topology A:
   docker compose -f docker-compose.prod.yml up -d --build --remove-orphans

   # Topology B:
   docker compose -f docker-compose.yml up -d --build --remove-orphans
   ```
4. Verify container health and re-run the staging smoke checks from Subsection `1.6` to confirm prototype UI serving, HTTPS `/health`, CORS, and WSS Socket.IO connectivity are restored (exit code `0`):
   ```bash
   docker compose -f <compose-file> ps
   npm --prefix server run smoke:staging
   curl -fsSI https://poc.shipri.app/
   curl -fsS https://poc.shipri.app/health
   ```

#### 1.7.4. Privacy-Safe Log Inspection

* **What `shipri-server` Logs in the POC**: stdout records lifecycle events only (`Signaling server listening on port <port>`, `Socket connected: <socketId>`, `Room created: <roomId>`, `Peer joined room: <roomId>`, `Room closed after <leave|disconnect>: <roomId>`, `Socket disconnected: <socketId>`). It never logs `signalData` SDP/ICE blobs, E2EE keys, URL hash fragments (`#key=...`), file metadata, or file contents.
* **Bounded Log-Inspection Commands**:
  ```bash
  # Topology A (external nginx-proxy + shipri-server + shipri-client):
  docker compose -f docker-compose.prod.yml ps
  docker compose -f docker-compose.prod.yml logs --tail=100 --timestamps server
  docker compose -f docker-compose.prod.yml logs --tail=100 --timestamps client

  # Topology B (bundled Caddy + shipri-server + shipri-client):
  docker compose -f docker-compose.yml ps
  docker compose -f docker-compose.yml logs --tail=100 --timestamps server
  docker compose -f docker-compose.yml logs --tail=100 --timestamps reverse-proxy
  ```
* **Secret and Payload Protection Rules**:
  * Never print or paste `.env` files, `printenv`, `env`, or raw `docker inspect` environment blocks into terminal recordings, issues, or support threads.
  * Never enable reverse-proxy request-body logging or WebSocket frame payload logging that could capture `signalData` SDP/ICE payloads.
  * When sharing proxy access logs for debugging HTTPS/WSS routing failures, inspect only recent bounded lines (`--tail=100`) and redact client IP addresses.

---

## 2. Production System Architecture in Docker

```mermaid
graph TD
    User([User Browser]) -->|HTTPS Port 443| Proxy[Caddy / Reverse Proxy]
    Proxy -->|Serve Static Files| ClientApp[Client Container (Nginx Static)]
    Proxy -->|WS/WSS Proxy| SignalServer[Signaling Server Container (Node.js)]
    User -->|WebRTC Traffic 3478 UDP/TCP or turn.shipri.app:443 TCP/TLS| Coturn[Coturn TURN Container]
```

### 2.1. Container Services:
1. **`reverse-proxy` (Caddy)**: Serves as the SSL-terminating entry point. Caddy is chosen over Nginx because it handles SSL certificate generation and auto-renewal (via Let's Encrypt / ZeroSSL) out-of-the-box with zero-config.
2. **`client` (Nginx/Node)**: A multi-stage build container. React app built using Vite, served by a lightweight Nginx container.
3. **`server` (Node.js)**: Runs the Socket.IO signaling process.
4. **`coturn` (Coturn)**: Runs the TURN/STUN daemon in host network mode when relay ports are exposed directly. If TURNS uses port `443`, it must bind a separate public endpoint from Caddy, such as `turn.shipri.app:443` on a separate IP.

---

## 3. Docker Compose Configuration (`docker-compose.yml`)

The standalone Compose file orchestrates `reverse-proxy`, `client`, and `server` by default (Backend POC staging mode), while gating `coturn` behind the `turn` profile for full backend NAT traversal (`docker compose --profile turn up -d`). Multi-service hosts with an existing external proxy use `docker-compose.prod.yml` instead (see Section 1.3 and 1.6):

```yaml
services:
  reverse-proxy:
    image: caddy:2.7-alpine
    container_name: shipri-proxy
    restart: unless-stopped
    environment:
      - CADDY_SITE_ADDRESS=${CADDY_SITE_ADDRESS:-poc.shipri.app}
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile
      - caddy_data:/data
      - caddy_config:/config
    depends_on:
      - client
      - server

  client:
    build:
      context: ./client
      dockerfile: Dockerfile
      args:
        - VITE_SIGNALING_URL=${VITE_SIGNALING_URL:-https://poc.shipri.app}
    container_name: shipri-client
    restart: unless-stopped
    expose:
      - "80"
    depends_on:
      - server

  server:
    build:
      context: ./server
      dockerfile: Dockerfile
    container_name: shipri-server
    restart: unless-stopped
    environment:
      - PORT=${PORT:-5001}
      - NODE_ENV=${NODE_ENV:-production}
      - ALLOWED_ORIGINS=${ALLOWED_ORIGINS:-https://poc.shipri.app,http://localhost:3000,http://127.0.0.1:3000,http://localhost:5173,http://127.0.0.1:5173}
      - STUN_URLS=${STUN_URLS:-stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302}
      # Full-backend runtime variables (Section 6) inject REQUIRE_ROOM_AUTH, TRUST_PROXY,
      # MAX_ROOMS, TTL/rate limits, TURN_URLS, TURN_SHARED_SECRET, TURN_CREDENTIAL_TTL_SECONDS,
      # and REQUIRE_TURN via uncommitted deployment environment configuration without committed secrets.
    expose:
      - "5001"

  coturn:
    image: coturn/coturn:4.6-alpine
    container_name: shipri-turn
    restart: unless-stopped
    profiles:
      - turn
    network_mode: "host" # Host mode is critical for dynamic port allocations in WebRTC
    volumes:
      - ./coturn/turnserver.conf:/etc/coturn/turnserver.conf
    # Note: Coturn uses port 3478 (UDP/TCP) and optionally turn.shipri.app:443 (TCP/TLS).
    # Do not bind Coturn and Caddy to the same public IP:443.

volumes:
  caddy_data:
  caddy_config:
```

---

## 4. Container-Specific Dockerfiles

### 4.1. Client Dockerfile (`client/Dockerfile`)
Uses a multi-stage build to keep production image size under 30MB.

```dockerfile
# Stage 1: Build
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
ARG VITE_SIGNALING_URL=https://poc.shipri.app
ENV VITE_SIGNALING_URL=$VITE_SIGNALING_URL
RUN npm run build

# Stage 2: Serve
FROM nginx:1.25-alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
```

### 4.2. Server Dockerfile (`server/Dockerfile`)
```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
EXPOSE 5001
CMD ["node", "src/index.js"]
```

---

## 5. Reverse Proxy Setup (`Caddyfile`)

Caddy handles TLS termination automatically for the web app, `/health`, and Socket.IO endpoint in standalone deployments. `Caddyfile` defaults `CADDY_SITE_ADDRESS` to `poc.shipri.app` with staging headers (set `CADDY_SITE_ADDRESS=shipri.app` in production full-backend deployments; external `nginx-proxy` deployments rely on the host proxy and `client/nginx.conf` for `/health` and `/socket.io/` proxying):

```caddy
{$CADDY_SITE_ADDRESS:poc.shipri.app} {
    header {
        X-Shipri-Environment "poc-staging"
        X-Robots-Tag "noindex, nofollow"
    }

    # 1. Route Socket.IO HTTP polling and WSS WebSocket traffic
    reverse_proxy /socket.io/* server:5001

    # 2. Route HTTP health checks
    reverse_proxy /health server:5001

    # 3. Route all other requests to the static SPA client
    reverse_proxy * client:80
}
```

---

## 6. Deployment Environment Configuration

Full backend production deployments (`BE-1` through `BE-7`) configure behavior strictly through runtime environment variables (`server/.env`, host secret injection, or container orchestration env vars) with zero committed secrets or hardcoded TURN credentials:

```typescript
interface FullBackendDeploymentEnv {
  // HTTP/Socket.IO listen port inside shipri-server container (default 5001).
  PORT: number;

  // Deployment environment ('production' forbids REQUIRE_ROOM_AUTH=false and unsafe overrides).
  NODE_ENV: 'development' | 'production' | 'test';

  // Strict comma-separated HTTP(S) allowlist for Express and Socket.IO CORS (no wildcards).
  ALLOWED_ORIGINS: string;

  // Proxy trust setting for IP rate limiting (false direct, 1 or subnet behind nginx-proxy/Caddy).
  TRUST_PROXY: boolean | number | string;

  // Requires roomAuthVerifier/roomAuthToken checks (true in production; false only in POC/non-prod).
  REQUIRE_ROOM_AUTH: boolean;

  // Maximum active concurrent rooms in memory before returning SERVER_BUSY (default 5000).
  MAX_ROOMS: number;

  // Idle/waiting room TTL in milliseconds (default 1800000 = 30m).
  ROOM_IDLE_TTL_MS: number;

  // Absolute room maximum lifetime in milliseconds (default 14400000 = 4h).
  ROOM_MAX_LIFETIME_MS: number;

  // Periodic room expiration sweep interval in milliseconds (default 60000 = 60s).
  ROOM_CLEANUP_INTERVAL_MS: number;

  // Per-IP room:create limit and window in milliseconds before RATE_LIMITED (default 10 per 60000ms).
  ROOM_CREATE_RATE_LIMIT_MAX: number;
  ROOM_CREATE_RATE_LIMIT_WINDOW_MS: number;

  // Comma-separated STUN and TURN/TURNS URLs consumed by ice:get.
  STUN_URLS: string;
  TURN_URLS: string;

  // Long-term Coturn HMAC-SHA1 static-auth-secret. Required when REQUIRE_TURN=true; never logged or exposed.
  TURN_SHARED_SECRET: string;

  // Ephemeral TURN credential TTL in seconds (default 7200 = 2h).
  TURN_CREDENTIAL_TTL_SECONDS: number;

  // Fails ice:get closed with SERVER_BUSY when TURN config is invalid/missing (true in production).
  REQUIRE_TURN: boolean;

  // Public Caddy site address (e.g., shipri.app for production vs poc.shipri.app for POC staging).
  CADDY_SITE_ADDRESS: string;

  // Build-time signaling origin baked into static Vite client assets (no secrets).
  VITE_SIGNALING_URL: string;
}
```

### 6.1. Pre-Startup Production Checklist and Privacy Boundaries

Before running `docker compose up -d` (or `docker compose --profile turn up -d`) on the production server:
1. Point your domain (e.g., `shipri.app`) to your VPS IP address (`A`/`AAAA` record), and point `turn.shipri.app` to its dedicated non-conflicting endpoint if using TURNS on port `443`.
2. Inject `TURN_SHARED_SECRET` through an uncommitted host `.env` file or secret manager matching Coturn `static-auth-secret`. Never commit `.env` files, placeholder secrets, or private keys.
3. Configure `TRUST_PROXY` (`1` or explicit proxy subnet when behind Caddy or external `nginx-proxy`, `false` otherwise) and restrict `ALLOWED_ORIGINS` strictly to production `https://shipri.app` origins (no wildcards `*`).
4. Ensure firewall rules open `80/tcp` and `443/tcp` for Caddy/`nginx-proxy`, `3478` (UDP/TCP) and configured Coturn relay ports (plus `443/tcp` on `turn.shipri.app` if enabled), while keeping internal `5001/tcp` (`shipri-server`) unexposed externally.
5. Configure `coturn/turnserver.conf` with the external IP, realm (`turn.shipri.app`), TLS certificate paths, and bandwidth quotas defined in `nat_traversal_strategy.md` Section `4`.
6. Confirm `GET /health` exposes only `{ status, roomsCount }` (`Cache-Control: no-store`), and ensure proxy/container logs never record `authToken`, `authVerifier`, `TURN_SHARED_SECRET`, TURN credentials, `#key=` URL fragments, client IPs in app logs, unnecessary `socket.id` values, or WebRTC `signalData`.
