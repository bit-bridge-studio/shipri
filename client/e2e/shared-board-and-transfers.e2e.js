import { expect, test } from '@playwright/test';
import { attachInputFile, dropVirtualFile } from './helpers/deterministic-files.js';
import { startPeerRoomHarness } from './helpers/peer-room-harness.js';
import {
  configurePersistenceStub,
  getStubClipboardText,
} from './helpers/persistence-stub.js';

async function connectTwoPeers(harness) {
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

test.describe('Secure shared room-board & bidirectional transfers E2E (ticket [59])', () => {
  test('supports equal-peer advertisements, #key= stripping, save cancel, click downloads with byte-for-byte integrity, and removal', async ({
    browser,
  }) => {
    const harness = await startPeerRoomHarness({ browser });
    try {
      const { peerA, peerB } = harness;
      const shareUrl = await connectTwoPeers(harness);
      expect(shareUrl).toContain('#key=');

      // Verify #key= fragment was stripped via history.replaceState on joiner
      const peerBHash = await peerB.page.evaluate(() => window.location.hash);
      expect(peerBHash).toBe('');

      // Both peers advertise deterministic files without switching modes
      const alphaFile = await dropVirtualFile(peerA.page, {
        name: 'alpha-report.bin',
        sizeBytes: 320 * 1024 + 53,
        seed: 101,
      });
      const zeroFile = await attachInputFile(peerA.page, {
        name: 'zero.txt',
        sizeBytes: 0,
        seed: 102,
        mimeType: 'text/plain',
      });
      const betaFile = await dropVirtualFile(peerB.page, {
        name: 'beta-dataset.bin',
        sizeBytes: 256 * 1024 + 19,
        seed: 202,
      });

      await expect(
        peerB.page.getByRole('button', { name: 'Download alpha-report.bin' }),
      ).toBeEnabled();
      await expect(
        peerB.page.getByRole('button', { name: 'Download zero.txt' }),
      ).toBeEnabled();
      await expect(
        peerA.page.getByRole('button', { name: 'Download beta-dataset.bin' }),
      ).toBeEnabled();

      // Cancelling the save dialog on Peer B leaves board unchanged with zero transfers
      await configurePersistenceStub(peerB.page, { cancelNextPick: true });
      await peerB.page.getByRole('button', { name: 'Download alpha-report.bin' }).click();
      await expect(peerB.page.getByText('No transfers started yet.')).toBeVisible();
      expect(await peerB.getSavedFiles()).toHaveLength(0);

      // Peer B downloads alpha-report.bin and zero.txt on click
      await peerB.page.getByRole('button', { name: 'Download alpha-report.bin' }).click();
      await expect(
        peerB.page.locator('li.transfer-row', { hasText: 'alpha-report.bin' }).getByText('Completed'),
      ).toBeVisible();

      await peerB.page.getByRole('button', { name: 'Download zero.txt' }).click();
      await expect(
        peerB.page.locator('li.transfer-row', { hasText: 'zero.txt' }).getByText('Completed'),
      ).toBeVisible();

      // Peer A downloads beta-dataset.bin on click from Peer B
      await peerA.page.getByRole('button', { name: 'Download beta-dataset.bin' }).click();
      await expect(
        peerA.page.locator('li.transfer-row', { hasText: 'beta-dataset.bin' }).getByText('Completed'),
      ).toBeVisible();

      const savedB = await peerB.getSavedFiles();
      expect(savedB).toHaveLength(2);
      expect(savedB[0].hadUserActivation).toBe(true);
      expect(savedB[0].sha256ChainHex).toBe(alphaFile.streamDigestHex);
      expect(Buffer.compare(savedB[0].bytes, alphaFile.bytes)).toBe(0);
      expect(savedB[1].hadUserActivation).toBe(true);
      expect(savedB[1].bytesWritten).toBe(0);
      expect(savedB[1].sha256ChainHex).toBe(zeroFile.streamDigestHex);
      expect(Buffer.compare(savedB[1].bytes, zeroFile.bytes)).toBe(0);

      const savedA = await peerA.getSavedFiles();
      expect(savedA).toHaveLength(1);
      expect(savedA[0].hadUserActivation).toBe(true);
      expect(savedA[0].sha256ChainHex).toBe(betaFile.streamDigestHex);
      expect(Buffer.compare(savedA[0].bytes, betaFile.bytes)).toBe(0);

      // Removing alpha-report.bin on Peer A removes it from both boards
      await peerA.page.getByRole('button', { name: 'Remove alpha-report.bin' }).click();
      await expect(
        peerA.page.getByRole('button', { name: 'Remove alpha-report.bin' }),
      ).toHaveCount(0);
      await expect(
        peerB.page.getByRole('button', { name: 'Download alpha-report.bin' }),
      ).toHaveCount(0);

      expect(peerA.pageErrors).toEqual([]);
      expect(peerB.pageErrors).toEqual([]);
    } finally {
      await harness.close();
    }
  });

  test('executes simultaneous opposite-direction transfers, independent pause/resume, and isolated cancellation', async ({
    browser,
  }) => {
    const harness = await startPeerRoomHarness({
      browser,
      peerAOptions: { writeDelayMs: 25 },
      peerBOptions: { writeDelayMs: 25 },
    });
    try {
      const { peerA, peerB } = harness;
      await connectTwoPeers(harness);

      const streamA = await dropVirtualFile(peerA.page, {
        name: 'stream-a.bin',
        sizeBytes: 48 * 65_536,
        seed: 301,
      });
      const cancelTarget = await dropVirtualFile(peerA.page, {
        name: 'cancel-me.bin',
        sizeBytes: 48 * 65_536,
        seed: 302,
      });
      const streamB = await dropVirtualFile(peerB.page, {
        name: 'stream-b.bin',
        sizeBytes: 16 * 65_536,
        seed: 401,
      });

      await expect(
        peerB.page.getByRole('button', { name: 'Download stream-a.bin' }),
      ).toBeEnabled();
      await expect(
        peerB.page.getByRole('button', { name: 'Download cancel-me.bin' }),
      ).toBeEnabled();
      await expect(
        peerA.page.getByRole('button', { name: 'Download stream-b.bin' }),
      ).toBeEnabled();

      // Start simultaneous transfers in opposite directions
      await Promise.all([
        peerB.page.getByRole('button', { name: 'Download stream-a.bin' }).click(),
        peerA.page.getByRole('button', { name: 'Download stream-b.bin' }).click(),
      ]);

      const rowAOnB = peerB.page.locator('li.transfer-row', { hasText: 'stream-a.bin' });
      const rowBOnA = peerA.page.locator('li.transfer-row', { hasText: 'stream-b.bin' });

      await expect(rowAOnB.getByRole('button', { name: 'Pause' })).toBeVisible();
      await expect(rowBOnA.getByRole('button', { name: 'Pause' })).toBeVisible();

      // Pause stream-a on Peer B while stream-b continues cleanly to completion on Peer A
      await rowAOnB.getByRole('button', { name: 'Pause' }).click();
      await expect(rowAOnB.locator('.transfer-state-label')).toHaveText('Paused');
      await expect(rowBOnA.locator('.transfer-state-label')).toHaveText('Completed');

      // Resume stream-a and wait for byte-for-byte completion
      await rowAOnB.getByRole('button', { name: 'Resume' }).click();
      await expect(rowAOnB.locator('.transfer-state-label')).toHaveText('Completed');

      const savedA1 = await peerA.getSavedFiles();
      const savedB1 = await peerB.getSavedFiles();
      expect(savedA1[0].sha256ChainHex).toBe(streamB.streamDigestHex);
      expect(Buffer.compare(savedA1[0].bytes, streamB.bytes)).toBe(0);
      expect(savedB1[0].sha256ChainHex).toBe(streamA.streamDigestHex);
      expect(Buffer.compare(savedB1[0].bytes, streamA.bytes)).toBe(0);

      // Start cancel-me.bin alongside a fresh opposite-direction transfer, then cancel only cancel-me.bin
      const streamB2 = await dropVirtualFile(peerB.page, {
        name: 'keep-opposite.bin',
        sizeBytes: 20 * 65_536,
        seed: 402,
      });
      await expect(
        peerA.page.getByRole('button', { name: 'Download keep-opposite.bin' }),
      ).toBeEnabled();

      await Promise.all([
        peerB.page.getByRole('button', { name: 'Download cancel-me.bin' }).click(),
        peerA.page.getByRole('button', { name: 'Download keep-opposite.bin' }).click(),
      ]);

      const cancelRowOnB = peerB.page.locator('li.transfer-row', {
        hasText: 'cancel-me.bin',
      });
      const keepRowOnA = peerA.page.locator('li.transfer-row', {
        hasText: 'keep-opposite.bin',
      });
      await expect(cancelRowOnB.getByRole('button', { name: 'Cancel' })).toBeVisible();

      await cancelRowOnB.getByRole('button', { name: 'Cancel' }).click();
      await expect(cancelRowOnB.locator('.transfer-state-label')).toHaveText('Cancelled');
      await expect(keepRowOnA.locator('.transfer-state-label')).toHaveText('Completed');

      // Board advertisement for cancel-me.bin remains intact on both boards
      await expect(
        peerB.page.getByRole('button', { name: 'Download cancel-me.bin' }),
      ).toBeEnabled();
      await expect(
        peerA.page.getByRole('button', { name: 'Remove cancel-me.bin' }),
      ).toBeVisible();

      const savedBAll = await peerB.getSavedFiles();
      expect(savedBAll[1].suggestedName).toBe(cancelTarget.name);
      expect(savedBAll[1].aborted).toBe(true);

      const savedAAll = await peerA.getSavedFiles();
      expect(savedAAll[1].sha256ChainHex).toBe(streamB2.streamDigestHex);
      expect(Buffer.compare(savedAAll[1].bytes, streamB2.bytes)).toBe(0);

      expect(peerA.pageErrors).toEqual([]);
      expect(peerB.pageErrors).toEqual([]);
    } finally {
      await harness.close();
    }
  });
});
