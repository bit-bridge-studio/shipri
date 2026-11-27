import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

function readRepoFile(relativePath) {
  return readFileSync(new URL(`../../${relativePath}`, import.meta.url), 'utf8');
}

describe('BE-5 reproducible Docker and deployment configuration', () => {
  test('removes committed placeholder secrets from Coturn and Compose configurations', () => {
    const turnConf = readRepoFile('coturn/turnserver.conf');
    const standaloneCompose = readRepoFile('docker-compose.yml');
    const prodCompose = readRepoFile('docker-compose.prod.yml');
    const envExample = readRepoFile('server/.env.example');

    for (const content of [turnConf, standaloneCompose, prodCompose, envExample]) {
      expect(content).not.toContain('your_super_secret_here');
      expect(content).not.toMatch(/^\s*static-auth-secret\s*=/m);
      expect(content).not.toMatch(/TURN_SHARED_SECRET\s*=\s*[A-Za-z0-9+/=_-]{8,}/);
    }

    expect(standaloneCompose).toMatch(/--static-auth-secret=\$\{TURN_SHARED_SECRET/);
  });

  test('omits obsolete Compose version field and defines service healthchecks and dependency readiness', () => {
    const standaloneCompose = readRepoFile('docker-compose.yml');
    const prodCompose = readRepoFile('docker-compose.prod.yml');

    expect(standaloneCompose).not.toMatch(/^\s*version:/m);
    expect(prodCompose).not.toMatch(/^\s*version:/m);

    for (const composeText of [standaloneCompose, prodCompose]) {
      expect(composeText).toContain('healthcheck:');
      expect(composeText).toContain('/health');
      expect(composeText).toContain('condition: service_healthy');
      expect(composeText).toContain('TRUST_PROXY=');
      expect(composeText).toContain('REQUIRE_ROOM_AUTH=');
      expect(composeText).toContain('MAX_ROOMS=');
      expect(composeText).toContain('ROOM_IDLE_TTL_MS=');
      expect(composeText).toContain('ROOM_MAX_LIFETIME_MS=');
      expect(composeText).toContain('ROOM_CREATE_RATE_LIMIT_MAX=');
      expect(composeText).toContain('TURN_SHARED_SECRET=${TURN_SHARED_SECRET:-}');
    }
  });

  test('builds server and client images reproducibly from package lockfiles with non-root server runtime', () => {
    const serverDockerfile = readRepoFile('server/Dockerfile');
    const clientDockerfile = readRepoFile('client/Dockerfile');

    expect(serverDockerfile).toContain('COPY package.json package-lock.json ./');
    expect(serverDockerfile).toContain('RUN npm ci --omit=dev');
    expect(serverDockerfile).toContain('USER node');
    expect(serverDockerfile).not.toContain('--only=production');

    expect(clientDockerfile).toContain('COPY package.json package-lock.json ./');
    expect(clientDockerfile).toContain('RUN npm ci');
  });

  test('synchronizes server/.env.example and Caddyfile headers for staging and production', () => {
    const envExample = readRepoFile('server/.env.example');
    const caddyfile = readRepoFile('Caddyfile');

    expect(envExample).toContain('TRUST_PROXY=');
    expect(envExample).toContain('REQUIRE_ROOM_AUTH=');
    expect(envExample).toContain('MAX_ROOMS=');
    expect(envExample).toContain('ROOM_IDLE_TTL_MS=');
    expect(envExample).toContain('ROOM_MAX_LIFETIME_MS=');
    expect(envExample).toContain('ROOM_CLEANUP_INTERVAL_MS=');
    expect(envExample).toContain('ROOM_CREATE_RATE_LIMIT_MAX=');
    expect(envExample).toContain('ROOM_CREATE_RATE_LIMIT_WINDOW_MS=');
    expect(envExample).toContain('TURN_CREDENTIAL_TTL_SECONDS=');
    expect(envExample).toContain('REQUIRE_TURN=');

    expect(caddyfile).toContain('{$CADDY_SITE_ADDRESS:poc.shipri.app}');
    expect(caddyfile).toContain('{$SHIPRI_ENV_HEADER:poc-staging}');
    expect(caddyfile).toContain('{$SHIPRI_ROBOTS_HEADER:noindex, nofollow}');
    expect(caddyfile).toContain('reverse_proxy /socket.io/* server:5001');
    expect(caddyfile).toContain('reverse_proxy /health server:5001');
    expect(caddyfile).toContain('reverse_proxy /ready server:5001');
    expect(caddyfile).toContain('respond /metrics 404');
  });

  test('synchronizes /ready routing, /metrics isolation, and environment headers across Nginx, Dockerfile, and docker-compose.prod.yml', () => {
    const caddyfile = readRepoFile('Caddyfile');
    const nginxConf = readRepoFile('client/nginx.conf');
    const clientDockerfile = readRepoFile('client/Dockerfile');
    const prodCompose = readRepoFile('docker-compose.prod.yml');

    expect(caddyfile).toContain('reverse_proxy /ready server:5001');
    expect(caddyfile).toContain('respond /metrics 404');

    expect(nginxConf).toContain('location = /ready');
    expect(nginxConf).toContain('proxy_pass http://server:5001/ready;');
    expect(nginxConf).toContain('location = /metrics');
    expect(nginxConf).toContain('return 404;');
    expect(nginxConf).toContain('${SHIPRI_ENV_HEADER}');
    expect(nginxConf).toContain('${SHIPRI_ROBOTS_HEADER}');

    expect(clientDockerfile).toContain('ENV SHIPRI_ENV_HEADER=poc-staging');
    expect(clientDockerfile).toContain(
      'ENV SHIPRI_ROBOTS_HEADER="noindex, nofollow"',
    );
    expect(clientDockerfile).toContain('ENV NGINX_ENVSUBST_FILTER=^SHIPRI_');
    expect(clientDockerfile).toContain(
      'COPY nginx.conf /etc/nginx/templates/default.conf.template',
    );

    expect(prodCompose).toContain(
      'SHIPRI_ENV_HEADER=${SHIPRI_ENV_HEADER:-poc-staging}',
    );
    expect(prodCompose).toContain(
      'SHIPRI_ROBOTS_HEADER=${SHIPRI_ROBOTS_HEADER:-noindex, nofollow}',
    );
  });
});
