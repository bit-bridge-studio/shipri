import { describe, expect, test, vi } from 'vitest';
import { createRoomLifecycleActions } from '../src/prototype/diagnostic-state.js';
import {
  deriveRoomAuthCredentials,
  generatePrototypeRoomAuth,
} from '../src/prototype/room-auth.js';
import { sanitizeEventPayloadSummary } from '../src/signaling/socket-client.js';

describe('prototype room authorization helpers and redaction', () => {
  test('derives deterministic 43-char base64url authToken and SHA-256 authVerifier via Web Crypto HKDF', async () => {
    const masterSecret = new Uint8Array(32).fill(7);
    const first = await deriveRoomAuthCredentials(masterSecret);
    const second = await deriveRoomAuthCredentials(masterSecret);

    expect(first).toEqual(second);
    expect(first.authToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first.authVerifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first.authToken).not.toBe(first.authVerifier);

    const generated = await generatePrototypeRoomAuth();
    expect(generated.authToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(generated.authVerifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  test('redacts authVerifier and authToken from sanitized socket payload summaries', () => {
    const createSummary = sanitizeEventPayloadSummary('room:create', {
      authVerifier: 'secret_verifier_value_that_must_not_appear',
    });
    const joinSummary = sanitizeEventPayloadSummary('room:join', {
      roomId: 'ship-83a1',
      authToken: 'secret_token_value_that_must_not_appear',
    });
    const customSummary = sanitizeEventPayloadSummary('custom:auth', {
      authVerifier: 'secret_verifier_value_that_must_not_appear',
      authToken: 'secret_token_value_that_must_not_appear',
    });

    expect(createSummary).toBe('Create room');
    expect(createSummary).not.toContain('secret_verifier_value');
    expect(joinSummary).toBe('Join room ship-83a1');
    expect(joinSummary).not.toContain('secret_token_value');
    expect(customSummary).toContain('authVerifier=[REDACTED]');
    expect(customSummary).toContain('authToken=[REDACTED]');
    expect(customSummary).not.toContain('secret_verifier_value');
    expect(customSummary).not.toContain('secret_token_value');
  });

  test('supports optional authVerifier and authToken in createRoomLifecycleActions without breaking POC defaults', () => {
    const createRoom = vi.fn();
    const joinRoom = vi.fn();
    const leaveRoom = vi.fn();
    const client = { createRoom, joinRoom, leaveRoom };
    const setState = vi.fn();
    const actions = createRoomLifecycleActions(client, setState);

    actions.createRoom();
    expect(createRoom).toHaveBeenLastCalledWith();

    actions.createRoom({ authVerifier: 'A'.repeat(43) });
    expect(createRoom).toHaveBeenLastCalledWith({
      authVerifier: 'A'.repeat(43),
    });

    actions.joinRoom('ship-83a1');
    expect(joinRoom).toHaveBeenLastCalledWith('ship-83a1');

    actions.joinRoom('ship-83a1', { authToken: 'B'.repeat(43) });
    expect(joinRoom).toHaveBeenLastCalledWith({
      roomId: 'ship-83a1',
      authToken: 'B'.repeat(43),
    });
  });
});
