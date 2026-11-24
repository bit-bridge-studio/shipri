import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { loadConfig } from '../src/config.js';
import {
  generateTurnCredentials,
  verifyTurnCredential,
} from '../src/ice-service.js';

function readRepoFile(relativePath) {
  return readFileSync(new URL(`../../${relativePath}`, import.meta.url), 'utf8');
}

describe('BE-6 Coturn hardening and NAT traversal validation', () => {
  test('configures Coturn relay port range, quotas, realm, SSRF peer blocks, and modern TLS without committed secrets', () => {
    const turnConf = readRepoFile('coturn/turnserver.conf');

    expect(turnConf).not.toContain('your_super_secret_here');
    expect(turnConf).not.toMatch(/^\s*static-auth-secret\s*=/m);

    expect(turnConf).toMatch(/^\s*listening-port=3478\s*$/m);
    expect(turnConf).toMatch(/^\s*tls-listening-port=443\s*$/m);
    expect(turnConf).toMatch(/^\s*min-port=49152\s*$/m);
    expect(turnConf).toMatch(/^\s*max-port=65535\s*$/m);
    expect(turnConf).toMatch(/^\s*realm=turn\.shipri\.app\s*$/m);
    expect(turnConf).toMatch(/^\s*use-auth-secret\s*$/m);
    expect(turnConf).toMatch(/^\s*lt-cred-mech\s*$/m);
    expect(turnConf).toMatch(/^\s*fingerprint\s*$/m);
    expect(turnConf).toMatch(/^\s*total-quota=1200\s*$/m);
    expect(turnConf).toMatch(/^\s*user-quota=2\s*$/m);
    expect(turnConf).toMatch(/^\s*stale-nonce=600\s*$/m);
    expect(turnConf).toMatch(/^\s*no-cli\s*$/m);
    expect(turnConf).toMatch(/^\s*no-multicast-peers\s*$/m);
    expect(turnConf).toMatch(/^\s*no-loopback-peers\s*$/m);
    expect(turnConf).toMatch(/^\s*no-sslv3\s*$/m);
    expect(turnConf).toMatch(/^\s*no-tlsv1\s*$/m);
    expect(turnConf).toMatch(/^\s*no-tlsv1_1\s*$/m);

    // Block SSRF and internal-network proxying through Coturn
    expect(turnConf).toContain('denied-peer-ip=127.0.0.0-127.255.255.255');
    expect(turnConf).toContain('denied-peer-ip=10.0.0.0-10.255.255.255');
    expect(turnConf).toContain('denied-peer-ip=169.254.0.0-169.254.255.255');
    expect(turnConf).toContain('denied-peer-ip=172.16.0.0-172.31.255.255');
    expect(turnConf).toContain('denied-peer-ip=192.168.0.0-192.168.255.255');
    expect(turnConf).toContain('denied-peer-ip=::1');
  });

  test('injects dedicated Coturn listening/external IP, TLS cert paths, and runtime secret in docker-compose.yml turn profile', () => {
    const compose = readRepoFile('docker-compose.yml');

    expect(compose).toContain('--listening-ip=${TURN_LISTENING_IP:-0.0.0.0}');
    expect(compose).toContain('--external-ip=${TURN_EXTERNAL_IP:-}');
    expect(compose).toContain(
      '--cert=${TURN_TLS_CERT_PATH:-/etc/coturn/certs/fullchain.pem}',
    );
    expect(compose).toContain(
      '--pkey=${TURN_TLS_KEY_PATH:-/etc/coturn/certs/privkey.pem}',
    );
    expect(compose).toContain('--static-auth-secret=${TURN_SHARED_SECRET:-}');
    expect(compose).toContain('/etc/coturn/certs:ro');
  });

  test('validates UDP/TCP TURN and TLS TURNS URLs and rejects expired or invalid HMAC-SHA1 credentials', () => {
    const config = loadConfig({
      NODE_ENV: 'production',
      REQUIRE_ROOM_AUTH: 'true',
      ALLOWED_ORIGINS: 'https://shipri.app',
      TURN_URLS:
        'turn:turn.shipri.app:3478?transport=udp,turn:turn.shipri.app:3478?transport=tcp,turns:turn.shipri.app:443?transport=tcp',
      TURN_SHARED_SECRET: 'coturn_prod_secret_rotation_v1',
      TURN_CREDENTIAL_TTL_SECONDS: '7200',
      REQUIRE_TURN: 'true',
    });

    expect(config.turnUrls).toEqual([
      'turn:turn.shipri.app:3478?transport=udp',
      'turn:turn.shipri.app:3478?transport=tcp',
      'turns:turn.shipri.app:443?transport=tcp',
    ]);

    const baseNow = 1_785_232_000_000;
    const creds = generateTurnCredentials({
      turnSharedSecret: 'coturn_prod_secret_rotation_v1',
      ttlSeconds: 7_200,
      now: () => baseNow,
    });

    // Valid before expiry
    expect(
      verifyTurnCredential({
        username: creds.username,
        credential: creds.credential,
        turnSharedSecret: 'coturn_prod_secret_rotation_v1',
        now: () => baseNow + 3_600_000,
      }),
    ).toBe(true);

    // Rejected at or after expiry
    expect(
      verifyTurnCredential({
        username: creds.username,
        credential: creds.credential,
        turnSharedSecret: 'coturn_prod_secret_rotation_v1',
        now: () => baseNow + 7_200_000,
      }),
    ).toBe(false);

    // Rejected with wrong secret (for example after secret rotation)
    expect(
      verifyTurnCredential({
        username: creds.username,
        credential: creds.credential,
        turnSharedSecret: 'coturn_prod_secret_rotation_v2',
        now: () => baseNow + 1_000,
      }),
    ).toBe(false);

    // Rejected with tampered username or malformed credential
    expect(
      verifyTurnCredential({
        username: `${creds.expiresAt + 60}:tampered`,
        credential: creds.credential,
        turnSharedSecret: 'coturn_prod_secret_rotation_v1',
        now: () => baseNow + 1_000,
      }),
    ).toBe(false);
    expect(
      verifyTurnCredential({
        username: 'invalid-no-colon',
        credential: creds.credential,
        turnSharedSecret: 'coturn_prod_secret_rotation_v1',
        now: () => baseNow + 1_000,
      }),
    ).toBe(false);
  });
});
