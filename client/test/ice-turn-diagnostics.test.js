import { describe, expect, test } from 'vitest';
import { validateIceCredentialsPayload } from '../src/prototype/ice-diagnostics.js';

describe('validateIceCredentialsPayload with production TURN support', () => {
  test('accepts STUN plus ephemeral TURN entries when allowTurn is enabled without exposing credentials in summary', () => {
    const payload = {
      roomId: 'ship-83a1',
      iceServers: [
        {
          urls: [
            'stun:stun.l.google.com:19302',
            'stun:stun1.l.google.com:19302',
          ],
        },
        {
          urls: [
            'turn:turn.shipri.app:3478?transport=udp',
            'turns:turn.shipri.app:443?transport=tcp',
          ],
          username: '1785239200:9f4c12a8e31b70d4',
          credential: 'ephemeral_hmac_sha1_credential_value',
        },
      ],
    };

    const result = validateIceCredentialsPayload(payload, {
      expectedRoomId: 'ship-83a1',
      allowTurn: true,
    });

    expect(result.ok).toBe(true);
    expect(result.iceServers).toHaveLength(2);
    expect(result.summary).toEqual({
      serverEntryCount: 2,
      endpointCount: 4,
      schemes: ['stun', 'turn', 'turns'],
      stunCount: 2,
      turnCount: 2,
      isStunOnly: false,
      endpointsRedacted: true,
    });

    const summaryText = JSON.stringify(result.summary);
    expect(summaryText).not.toContain('1785239200:9f4c12a8e31b70d4');
    expect(summaryText).not.toContain('ephemeral_hmac_sha1_credential_value');
    expect(summaryText).not.toContain('turn.shipri.app');
  });

  test('rejects TURN entries missing credentials or carrying unexpected secret fields', () => {
    const missingCreds = validateIceCredentialsPayload(
      {
        roomId: 'ship-83a1',
        iceServers: [
          {
            urls: ['turn:turn.shipri.app:3478?transport=udp'],
          },
        ],
      },
      { allowTurn: true },
    );
    expect(missingCreds.ok).toBe(false);
    expect(missingCreds.error.code).toBe('INVALID_ICE_CREDENTIALS');

    const leakedSecretField = validateIceCredentialsPayload(
      {
        roomId: 'ship-83a1',
        iceServers: [
          {
            urls: ['turn:turn.shipri.app:3478?transport=udp'],
            username: '1785239200:abc',
            credential: 'hmac_value',
            turnSharedSecret: 'must_never_be_present',
          },
        ],
      },
      { allowTurn: true },
    );
    expect(leakedSecretField.ok).toBe(false);
    expect(leakedSecretField.error.code).toBe('INVALID_ICE_CREDENTIALS');
  });
});
