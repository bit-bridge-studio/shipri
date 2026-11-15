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

POC staging configuration, smoke checks, deployment, update, rollback, and log-inspection procedures are completed in tickets 16 through 18 before the Backend POC Acceptance Gate (`BP-6`). Full production deployment remains governed by Sections 2 through 6 below.

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

* **Topology A (`docker-compose.prod.yml` + `client/nginx.conf`)**: builds `shipri-server` (`expose: 5001`) and `shipri-client` (`expose: 80`), attaches both to `shipri-network` and external `nginx-proxy` with zero host `ports:` bindings, and leaves `TURN_SHARED_SECRET` and `coturn` omitted. On the external host `nginx-proxy` (or Nginx Proxy Manager), terminate TLS for `poc.shipri.app` with WebSockets enabled and either proxy `/health` and `/socket.io/*` to `shipri-server:5001` and `/` to `shipri-client:80`, or proxy all paths for `poc.shipri.app` to `shipri-client:80` (where `client/nginx.conf` proxies `/health` and `/socket.io/` to `http://server:5001` over `shipri-network` and sets `X-Shipri-Environment: poc-staging` and `X-Robots-Tag: noindex, nofollow`).
* **Topology B (`docker-compose.yml` + `Caddyfile`)**: runs bundled `shipri-proxy` (`CADDY_SITE_ADDRESS=${CADDY_SITE_ADDRESS:-poc.shipri.app}`), `shipri-client`, and `shipri-server` without any TURN secrets, and isolates `coturn` behind Docker Compose profile `turn` (`profiles: ["turn"]`) so default staging runs omit TURN.

Validate rendered configurations locally or on the staging host before starting containers:

```bash
docker compose -f docker-compose.prod.yml config
docker compose -f docker-compose.yml config
```

Confirm neither output includes `TURN_SHARED_SECRET` or the `coturn` service.

Build and start the Backend POC staging stack for the active host topology:

```bash
# Topology A (VPS with external nginx-proxy)
docker compose -f docker-compose.prod.yml up -d --build

# Topology B (standalone host with unoccupied 80/443)
docker compose -f docker-compose.yml up -d --build
```

Run initial deployment smoke checks after startup (automated in ticket 17):

```bash
# 1. Verify HTTPS health payload and staging identity headers
curl -fsSI https://poc.shipri.app/health
curl -fsS https://poc.shipri.app/health

# 2. Verify CORS allows poc.shipri.app and rejects production shipri.app
curl -fsSI -H "Origin: https://poc.shipri.app" https://poc.shipri.app/health
curl -fsSI -H "Origin: https://shipri.app" https://poc.shipri.app/health

# 3. Verify Socket.IO Engine.IO handshake and WebSocket/WSS transport
curl -fsS -H "Origin: https://poc.shipri.app" "https://poc.shipri.app/socket.io/?EIO=4&transport=polling"
```

Expected results: `/health` returns `200 OK` with `Cache-Control: no-store`, JSON `{"status":"ok","roomsCount":...}`, and `X-Shipri-Environment: poc-staging`; `https://poc.shipri.app` receives `access-control-allow-origin: https://poc.shipri.app` while `https://shipri.app` omits `access-control-allow-origin`; Socket.IO polling returns an Engine.IO session handshake (`0{"sid":...}`) and full WSS connectivity is verified over `https://poc.shipri.app`.

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

Before running `docker compose up -d` on the server:
1. Point your domain (e.g., `shipri.app`) to your VPS IP address (A-record).
2. Set `TURN_SHARED_SECRET` through a deployment environment file or secret manager. Do not commit real secret values.
3. Ensure ports `80`, `443`, and `3478` (UDP/TCP) are open in your VPS firewall for the web endpoint and standard TURN endpoint.
4. If using TURNS on `turn.shipri.app:443`, allocate a non-conflicting endpoint as described in `nat_traversal_strategy.md`.
5. Configure the `coturn/turnserver.conf` file with the correct external IP and TLS certificate paths (as defined in `nat_traversal_strategy.md`).
