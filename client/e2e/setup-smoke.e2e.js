import { expect, test } from '@playwright/test';
import { dropVirtualFile } from './helpers/deterministic-files.js';
import { startPeerRoomHarness } from './helpers/peer-room-harness.js';
import { getStubClipboardText } from './helpers/persistence-stub.js';

test.describe('Approved Playwright peer-room E2E setup (ticket [58])', () => {
  test('launches two isolated peer contexts, generates deterministic files, and downloads via persistence stub without private fixtures', async ({
    browser,
  }) => {
    const harness = await startPeerRoomHarness({ browser });
    try {
      const { peerA, peerB, clientUrl, turnServer } = harness;
      expect(turnServer.port).toBeGreaterThan(0);

      await Promise.all([
        peerA.page.goto(clientUrl),
        peerB.page.goto(clientUrl),
      ]);

      await expect(
        peerA.page.getByRole('button', { name: 'Create Room' }),
      ).toBeEnabled();
      await expect(
        peerB.page.getByRole('button', { name: 'Create Room' }),
      ).toBeEnabled();

      // Peer A creates encrypted room and copies share link into isolated stub clipboard
      await peerA.page.getByRole('button', { name: 'Create Room' }).click();
      await expect(
        peerA.page.getByRole('button', { name: 'Copy Share Link' }),
      ).toBeVisible();
      await peerA.page.getByRole('button', { name: 'Copy Share Link' }).click();

      const shareUrl = await getStubClipboardText(peerA.page);
      expect(shareUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/room\/ship-[a-f0-9]{4}#key=/);

      // Context isolation check: Peer B has empty stub clipboard & separate sessionStorage
      expect(await getStubClipboardText(peerB.page)).toBe('');
      const bStorageCount = await peerB.page.evaluate(() => sessionStorage.length);
      expect(bStorageCount).toBe(0);

      // Peer B opens invite URL and establishes encrypted peer session
      await peerB.page.goto(shareUrl);
      await expect(peerA.page.getByText('Encrypted peer session ready')).toBeVisible();
      await expect(peerB.page.getByText('Encrypted peer session ready')).toBeVisible();

      // Add deterministic virtual file on Peer A with zero committed fixture files
      const virtualFile = await dropVirtualFile(peerA.page, {
        name: 'setup-smoke.bin',
        sizeBytes: 192 * 1024 + 137,
        seed: 2026,
      });

      await expect(
        peerB.page.getByRole('button', { name: 'Download setup-smoke.bin' }),
      ).toBeEnabled();

      // Peer B downloads via mocked File System Access persistence stub preserving user activation
      await peerB.page.getByRole('button', { name: 'Download setup-smoke.bin' }).click();
      await expect(peerB.page.getByText('Completed').first()).toBeVisible();

      const savedFiles = await peerB.getSavedFiles();
      expect(savedFiles).toHaveLength(1);
      expect(savedFiles[0].suggestedName).toBe('setup-smoke.bin');
      expect(savedFiles[0].hadUserActivation).toBe(true);
      expect(savedFiles[0].closed).toBe(true);
      expect(savedFiles[0].bytesWritten).toBe(virtualFile.sizeBytes);
      expect(savedFiles[0].sha256ChainHex).toBe(virtualFile.streamDigestHex);
      expect(Buffer.compare(savedFiles[0].bytes, virtualFile.bytes)).toBe(0);

      expect(peerA.pageErrors).toEqual([]);
      expect(peerB.pageErrors).toEqual([]);
    } finally {
      await harness.close();
    }
  });
});
