# Docker & Deployment Specification (Shipri)

This document specifies the containerized deployment architecture for Project Shipri using Docker and Docker Compose. This setup allows deploying the frontend, signaling server, and TURN infrastructure onto a VPS-oriented environment.

---

## 1. System Architecture in Docker

```mermaid
graph TD
    User([User Browser]) -->|HTTPS Port 443| Proxy[Caddy / Reverse Proxy]
    Proxy -->|Serve Static Files| ClientApp[Client Container (Nginx Static)]
    Proxy -->|WS/WSS Proxy| SignalServer[Signaling Server Container (Node.js)]
    User -->|WebRTC Traffic 3478 UDP/TCP or turn.shipri.app:443 TCP/TLS| Coturn[Coturn TURN Container]
```

### 1.1. Container Services:
1. **`reverse-proxy` (Caddy)**: Serves as the SSL-terminating entry point. Caddy is chosen over Nginx because it handles SSL certificate generation and auto-renewal (via Let's Encrypt / ZeroSSL) out-of-the-box with zero-config.
2. **`client` (Nginx/Node)**: A multi-stage build container. React app built using Vite, served by a lightweight Nginx container.
3. **`server` (Node.js)**: Runs the Socket.IO signaling process.
4. **`coturn` (Coturn)**: Runs the TURN/STUN daemon in host network mode when relay ports are exposed directly. If TURNS uses port `443`, it must bind a separate public endpoint from Caddy, such as `turn.shipri.app:443` on a separate IP.

---

## 2. Docker Compose Configuration (`docker-compose.yml`)

The compose file orchestrates the services in the production environment:

```yaml
version: '3.8'

services:
  reverse-proxy:
    image: caddy:2.7-alpine
    container_name: shipri-proxy
    restart: unless-stopped
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

  server:
    build:
      context: ./server
      dockerfile: Dockerfile
    container_name: shipri-server
    restart: unless-stopped
    environment:
      - PORT=5001
      - NODE_ENV=production
      - TURN_SHARED_SECRET=${TURN_SHARED_SECRET}
    expose:
      - "5001"

  coturn:
    image: coturn/coturn:4.6-alpine
    container_name: shipri-turn
    restart: unless-stopped
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

## 3. Container-Specific Dockerfiles

### 3.1. Client Dockerfile (`client/Dockerfile`)
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

### 3.2. Server Dockerfile (`server/Dockerfile`)
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

## 4. Reverse Proxy Setup (`Caddyfile`)

Caddy handles SSL termination automatically for the web app and Socket.IO endpoint. Below is the production `Caddyfile` schema:

```caddy
# Replace with your actual domain name
shipri.app {
    # 1. Route API & WebSocket calls to the signaling server
    reverse_proxy /socket.io/* server:5001
    reverse_proxy /health server:5001

    # 2. Route all other traffic to the static client container
    reverse_proxy * client:80
}
```

---

## 5. Deployment Environment Configuration

Before running `docker compose up -d` on the server:
1. Point your domain (e.g., `shipri.app`) to your VPS IP address (A-record).
2. Set `TURN_SHARED_SECRET` through a deployment environment file or secret manager. Do not commit real secret values.
3. Ensure ports `80`, `443`, and `3478` (UDP/TCP) are open in your VPS firewall for the web endpoint and standard TURN endpoint.
4. If using TURNS on `turn.shipri.app:443`, allocate a non-conflicting endpoint as described in `nat_traversal_strategy.md`.
5. Configure the `coturn/turnserver.conf` file with the correct external IP and TLS certificate paths (as defined in `nat_traversal_strategy.md`).
