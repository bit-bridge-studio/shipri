import { expect, test } from '@playwright/test';
import { generateMasterKey } from '../src/crypto/fragment-key.js';
import { dropVirtualFile } from './helpers/deterministic-files.js';
import { startPeerRoomHarness } from './helpers/peer-room-harness.js';
import { getStubClipboardText } from './helpers/persistence-stub.js';

async function connectPair(harness) {
  const { peerA, peerB, clientUrl } = harness;
  await Promise.all([
    peerA.page.goto(clientUrl),
    peerB.page.goto(clientUrl),
  ]);
  await expect(peerA.page.getByRole('button', { name: 'Create Room' })).toBeEnabled();
  await expect(peerB.page.getByRole('button', { name: 'Create Room' })).toBeEnabled();

  await peerA.page.getByRole('button', { name: 'Create Room' }).click();
  await expect(peerA.page.getByRole('button', { name: 'Copy Share Link' })).toBeVisible();
  await peerA.page.getByRole('button', { name: 'Copy Share Link' }).click();

  const shareUrl = await getStubClipboardText(peerA.page);
  await peerB.page.goto(shareUrl);

  await expect(peerA.page.getByText('Encrypted peer session ready')).toBeVisible();
  await expect(peerB.page.getByText('Encrypted peer session ready')).toBeVisible();
  return shareUrl;
}

test.describe('Resilience, forced TURN, errors, and backend privacy E2E (ticket [59])', () => {
  test('surfaces signaling/auth/capacity errors and enforces unsupported-browser limits before DOWNLOAD_REQUEST', async ({
    browser,
  }) => {
    const harness = await startPeerRoomHarness({ browser });
    try {
      const { peerA, peerB, clientUrl } = harness;
      await peerB.page.goto(clientUrl);
      await expect(peerB.page.getByRole('button', { name: 'Join Room' })).toBeVisible();

      // 1. Invalid room ID input
      await peerB.page.getByLabel('Room ID or invite link').fill('invalid-input');
      await peerB.page.getByRole('button', { name: 'Join Room' }).click();
      await expect(peerB.page.getByRole('alert')).toContainText('Invalid room identifier');
      await peerB.page.getByRole('button', { name: 'Dismiss' }).click();

      // 2. Non-existent room -> ROOM_NOT_FOUND
      const randomKey = generateMasterKey().masterKeyBase64Url;
      await peerB.page.goto(`${clientUrl}/room/ship-ffff#key=${randomKey}`);
      await expect(peerB.page.getByRole('alert')).toContainText('Room not found or expired');
      await peerB.page.getByRole('button', { name: 'Dismiss' }).click();

      // 3. Peer A creates real room -> wrong key triggers UNAUTHORIZED
      await peerA.page.goto(clientUrl);
      await peerA.page.getByRole('button', { name: 'Create Room' }).click();
      await expect(peerA.page.getByRole('button', { name: 'Copy Share Link' })).toBeVisible();
      await peerA.page.getByRole('button', { name: 'Copy Share Link' }).click();
      const validShareUrl = await getStubClipboardText(peerA.page);
      const realRoomId = new URL(validShareUrl).pathname.split('/').pop();
      const wrongKey = generateMasterKey().masterKeyBase64Url;

      await peerB.page.goto(`${clientUrl}/room/${realRoomId}#key=${wrongKey}`);
      await expect(peerB.page.getByRole('alert')).toContainText('Invalid room key');

      // 4. Unsupported browser context (no window.showSaveFilePicker) sees guidance & blocks downloads
      const unsupportedPeer = await harness.createPeerContext(browser, {
        unsupportedMode: 'missing-picker',
      });
      await unsupportedPeer.page.goto(validShareUrl);
      await expect(peerA.page.getByText('Encrypted peer session ready')).toBeVisible();
      await expect(
        unsupportedPeer.page.getByText('Direct file saving unavailable:'),
      ).toBeVisible();
      await expect(
        unsupportedPeer.page.getByText('window.showSaveFilePicker()'),
      ).toBeVisible();

      await dropVirtualFile(peerA.page, {
        name: 'unsupported-check.txt',
        sizeBytes: 128,
        seed: 77,
      });
      const blockedBtn = unsupportedPeer.page.getByRole('button', {
        name: 'Download unsupported-check.txt',
      });
      await expect(blockedBtn).toBeDisabled();
      await expect(
        unsupportedPeer.page.getByText('No transfers started yet.'),
      ).toBeVisible();

      // 5. Third peer joining full room sees ROOM_FULL without disrupting active session
      const peerC = await harness.createPeerContext(browser);
      await peerC.page.goto(validShareUrl);
      await expect(peerC.page.getByRole('alert')).toContainText('Room is already full');
      await expect(peerA.page.getByText('Encrypted peer session ready')).toBeVisible();

      expect(peerA.pageErrors).toEqual([]);
      expect(unsupportedPeer.pageErrors).toEqual([]);
      expect(peerC.pageErrors).toEqual([]);
    } finally {
      await harness.close();
    }
  });

  test('recovers board convergence and safely resumes mid-stream across rotated epoch after network drop', async ({
    browser,
  }) => {
    const harness = await startPeerRoomHarness({
      browser,
      peerBOptions: { writeDelayMs: 45 },
    });
    try {
      const { peerA, peerB } = harness;
      await connectPair(harness);

      const resumable = await dropVirtualFile(peerA.page, {
        name: 'resumable.bin',
        sizeBytes: 24 * 65_536 + 111,
        seed: 901,
      });
      await dropVirtualFile(peerA.page, {
        name: 'ephemeral-offline.txt',
        sizeBytes: 64,
        seed: 902,
      });

      await expect(
        peerB.page.getByRole('button', { name: 'Download resumable.bin' }),
      ).toBeEnabled();
      await expect(
        peerB.page.getByRole('button', { name: 'Download ephemeral-offline.txt' }),
      ).toBeEnabled();

      await peerB.page.getByRole('button', { name: 'Download resumable.bin' }).click();

      // Wait until at least 3 chunks are persisted before interrupting connectivity
      await expect
        .poll(
          async () =>
            peerB.page.evaluate(() => window.__shipriE2E?.savedFiles?.[0]?.chunkCount ?? 0),
          { timeout: 15_000 },
        )
        .toBeGreaterThanOrEqual(3);

      const chunksBeforeDrop = await peerB.page.evaluate(
        () => window.__shipriE2E?.savedFiles?.[0]?.chunkCount ?? 0,
      );
      expect(chunksBeforeDrop).toBeLessThan(22);

      // Simulate offline drop on Peer B and drop its loopback Engine.IO transport
      await peerB.context.setOffline(true);
      expect(harness.dropActiveRoomPeerTransport({ peerIndex: 1 })).toBe(true);

      await expect(
        peerB.page.locator('li.transfer-row', { hasText: 'resumable.bin' }).locator('.transfer-state-label'),
      ).toHaveText('Paused (reconnecting)');
      await expect(
        peerA.page.locator('li.transfer-row', { hasText: 'resumable.bin' }).locator('.transfer-state-label'),
      ).toHaveText('Paused (reconnecting)');

      // Mutate owner board while Peer B is offline: remove one file, add a fresh one
      await peerA.page.getByRole('button', { name: 'Remove ephemeral-offline.txt' }).click();
      await dropVirtualFile(peerA.page, {
        name: 'added-offline.txt',
        sizeBytes: 96,
        seed: 903,
      });

      // Bring Peer B back online -> board converges and transfer resumes across rotated epoch
      await peerB.context.setOffline(false);

      await expect(
        peerB.page.getByRole('button', { name: 'Download ephemeral-offline.txt' }),
      ).toHaveCount(0);
      await expect(
        peerB.page.getByRole('button', { name: 'Download added-offline.txt' }),
      ).toBeEnabled();

      await expect(
        peerB.page.locator('li.transfer-row', { hasText: 'resumable.bin' }).locator('.transfer-state-label'),
      ).toHaveText('Completed', { timeout: 25_000 });
      await expect(
        peerA.page.locator('li.transfer-row', { hasText: 'resumable.bin' }).locator('.transfer-state-label'),
      ).toHaveText('Completed', { timeout: 25_000 });

      const saved = await peerB.getSavedFiles();
      expect(saved).toHaveLength(1);
      expect(saved[0].closed).toBe(true);
      expect(saved[0].aborted).toBe(false);
      expect(saved[0].bytesWritten).toBe(resumable.sizeBytes);
      expect(saved[0].sha256ChainHex).toBe(resumable.streamDigestHex);
      expect(Buffer.compare(saved[0].bytes, resumable.bytes)).toBe(0);

      expect(peerA.pageErrors).toEqual([]);
      expect(peerB.pageErrors).toEqual([]);
    } finally {
      await harness.close();
    }
  });

  test('completes forced-TURN (iceTransportPolicy=relay) bidirectional transfers with zero leaked metadata or keys on backend', async ({
    browser,
  }) => {
    const harness = await startPeerRoomHarness({
      browser,
      requireTurn: true,
      peerAOptions: { forceTurnRelay: true },
      peerBOptions: { forceTurnRelay: true },
    });
    try {
      const { peerA, peerB, turnServer, backendAudit } = harness;
      const shareUrl = await connectPair(harness);
      const keyFragment = new URL(shareUrl).hash.slice('#key='.length);

      await expect(peerA.page.getByLabel('TURN relay active')).toBeVisible();
      await expect(peerB.page.getByLabel('TURN relay active')).toBeVisible();

      const fileFromA = await dropVirtualFile(peerA.page, {
        name: 'secret-relay-a.bin',
        sizeBytes: 256 * 1024 + 41,
        seed: 511,
      });
      const fileFromB = await dropVirtualFile(peerB.page, {
        name: 'secret-relay-b.bin',
        sizeBytes: 192 * 1024 + 17,
        seed: 512,
      });

      await expect(
        peerB.page.getByRole('button', { name: 'Download secret-relay-a.bin' }),
      ).toBeEnabled();
      await expect(
        peerA.page.getByRole('button', { name: 'Download secret-relay-b.bin' }),
      ).toBeEnabled();

      await Promise.all([
        peerB.page.getByRole('button', { name: 'Download secret-relay-a.bin' }).click(),
        peerA.page.getByRole('button', { name: 'Download secret-relay-b.bin' }).click(),
      ]);

      await expect(
        peerB.page.locator('li.transfer-row', { hasText: 'secret-relay-a.bin' }).locator('.transfer-state-label'),
      ).toHaveText('Completed');
      await expect(
        peerA.page.locator('li.transfer-row', { hasText: 'secret-relay-b.bin' }).locator('.transfer-state-label'),
      ).toHaveText('Completed');

      const savedOnB = await peerB.getSavedFiles();
      const savedOnA = await peerA.getSavedFiles();
      expect(savedOnB[0].sha256ChainHex).toBe(fileFromA.streamDigestHex);
      expect(Buffer.compare(savedOnB[0].bytes, fileFromA.bytes)).toBe(0);
      expect(savedOnA[0].sha256ChainHex).toBe(fileFromB.streamDigestHex);
      expect(Buffer.compare(savedOnA[0].bytes, fileFromB.bytes)).toBe(0);

      const turnStats = turnServer.getStats();
      expect(turnStats.allocationsCreated).toBeGreaterThanOrEqual(2);
      expect(turnStats.relayedBytesOut).toBeGreaterThan(0);
      expect(turnStats.relayedBytesIn).toBeGreaterThan(0);

      backendAudit.assertZeroLeakage({
        forbiddenStrings: [
          keyFragment,
          'secret-relay-a.bin',
          'secret-relay-b.bin',
          fileFromA.sha256Hex,
          fileFromB.sha256Hex,
          String(fileFromA.sizeBytes),
          String(fileFromB.sizeBytes),
        ],
      });

      expect(peerA.pageErrors).toEqual([]);
      expect(peerB.pageErrors).toEqual([]);
    } finally {
      await harness.close();
    }
  });
});
