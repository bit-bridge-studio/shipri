import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { dropVirtualFile } from './helpers/deterministic-files.js';
import { startPeerRoomHarness } from './helpers/peer-room-harness.js';
import { getStubClipboardText } from './helpers/persistence-stub.js';

async function connectCompiledPair(harness) {
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

async function readJsHeapUsedBytes(cdpSession) {
  const { metrics } = await cdpSession.send('Performance.getMetrics');
  return metrics.find((entry) => entry.name === 'JSHeapUsedSize')?.value ?? 0;
}

test.describe('Final frontend release gate against compiled production bundle (ticket [60])', () => {
  test('passes direct-P2P and forced-TURN bidirectional transfers on compiled bundle with prototype exclusion', async ({
    browser,
  }) => {
    const directHarness = await startPeerRoomHarness({
      browser,
      serveBuiltBundle: true,
    });
    try {
      const assetsDir = path.join(directHarness.builtOutDir, 'assets');
      const jsAssets = fs
        .readdirSync(assetsDir)
        .filter((name) => name.endsWith('.js'));
      expect(jsAssets.length).toBeGreaterThanOrEqual(2);
      const workerAssets = jsAssets.filter((name) =>
        name.startsWith('chunk-crypto.worker-'),
      );
      expect(workerAssets.length).toBe(1);
      for (const fileName of jsAssets) {
        const content = fs.readFileSync(path.join(assetsDir, fileName), 'utf8');
        expect(content).not.toContain('Diagnostic Prototype Shell');
        expect(content).not.toContain('Sender Mode');
        expect(content).not.toContain('Receiver Mode');
        expect(content).not.toContain('../crypto/');
      }

      const { peerA, peerB } = directHarness;
      await connectCompiledPair(directHarness);

      await expect(peerA.page.getByLabel('Direct peer connection')).toBeVisible();
      await expect(peerB.page.getByLabel('Direct peer connection')).toBeVisible();

      const fileA = await dropVirtualFile(peerA.page, {
        name: 'bundle-direct-a.bin',
        sizeBytes: 256 * 1024 + 91,
        seed: 701,
      });
      const fileB = await dropVirtualFile(peerB.page, {
        name: 'bundle-direct-b.bin',
        sizeBytes: 192 * 1024 + 47,
        seed: 702,
      });

      await expect(
        peerB.page.getByRole('button', { name: 'Download bundle-direct-a.bin' }),
      ).toBeEnabled();
      await expect(
        peerA.page.getByRole('button', { name: 'Download bundle-direct-b.bin' }),
      ).toBeEnabled();

      await Promise.all([
        peerB.page.getByRole('button', { name: 'Download bundle-direct-a.bin' }).click(),
        peerA.page.getByRole('button', { name: 'Download bundle-direct-b.bin' }).click(),
      ]);

      await expect(
        peerB.page.locator('li.transfer-row', { hasText: 'bundle-direct-a.bin' }).locator('.transfer-state-label'),
      ).toHaveText('Completed');
      await expect(
        peerA.page.locator('li.transfer-row', { hasText: 'bundle-direct-b.bin' }).locator('.transfer-state-label'),
      ).toHaveText('Completed');

      const savedB = await peerB.getSavedFiles();
      const savedA = await peerA.getSavedFiles();
      expect(savedB[0].sha256ChainHex).toBe(fileA.streamDigestHex);
      expect(Buffer.compare(savedB[0].bytes, fileA.bytes)).toBe(0);
      expect(savedA[0].sha256ChainHex).toBe(fileB.streamDigestHex);
      expect(Buffer.compare(savedA[0].bytes, fileB.bytes)).toBe(0);
    } finally {
      await directHarness.close();
    }

    const turnHarness = await startPeerRoomHarness({
      browser,
      serveBuiltBundle: true,
      requireTurn: true,
      peerAOptions: { forceTurnRelay: true },
      peerBOptions: { forceTurnRelay: true },
    });
    try {
      const { peerA, peerB, turnServer } = turnHarness;
      await connectCompiledPair(turnHarness);

      await expect(peerA.page.getByLabel('TURN relay active')).toBeVisible();
      await expect(peerB.page.getByLabel('TURN relay active')).toBeVisible();

      const relayFile = await dropVirtualFile(peerA.page, {
        name: 'bundle-turn-relay.bin',
        sizeBytes: 320 * 1024 + 13,
        seed: 703,
      });
      await expect(
        peerB.page.getByRole('button', { name: 'Download bundle-turn-relay.bin' }),
      ).toBeEnabled();
      await peerB.page.getByRole('button', { name: 'Download bundle-turn-relay.bin' }).click();
      await expect(
        peerB.page.locator('li.transfer-row', { hasText: 'bundle-turn-relay.bin' }).locator('.transfer-state-label'),
      ).toHaveText('Completed');

      const saved = await peerB.getSavedFiles();
      expect(saved[0].sha256ChainHex).toBe(relayFile.streamDigestHex);
      expect(Buffer.compare(saved[0].bytes, relayFile.bytes)).toBe(0);
      expect(turnServer.getStats().relayedBytesOut).toBeGreaterThan(0);
      expect(turnServer.getStats().relayedBytesIn).toBeGreaterThan(0);
    } finally {
      await turnHarness.close();
    }
  });

  test('verifies accessibility, keyboard navigation, focus restoration, and responsive viewports without horizontal overflow', async ({
    browser,
  }) => {
    const harness = await startPeerRoomHarness({
      browser,
      serveBuiltBundle: true,
    });
    try {
      const { peerA, peerB } = harness;
      await peerA.page.goto(harness.clientUrl);

      await expect(peerA.page.locator('main')).toBeVisible();
      await expect(peerA.page.getByRole('status')).toHaveAttribute('aria-live', 'polite');
      await expect(peerA.page.getByLabel('Room ID or invite link')).toBeVisible();

      await connectCompiledPair(harness);

      // QR toggle accessibility & Escape focus restoration
      const qrToggle = peerA.page.locator('button[aria-controls="room-qr-panel"]');
      await qrToggle.click();
      await expect(qrToggle).toHaveAttribute('aria-expanded', 'true');
      const qrPanel = peerA.page.locator('#room-qr-panel');
      await expect(qrPanel).toBeVisible();
      await expect(qrPanel.getByRole('img', { name: 'Room invite QR code' })).toBeVisible();
      await qrPanel.dispatchEvent('keydown', { key: 'Escape', bubbles: true });
      await expect(qrPanel).toHaveCount(0);
      await expect(qrToggle).toHaveAttribute('aria-expanded', 'false');
      const activeControlText = await peerA.page.evaluate(
        () => document.activeElement?.textContent ?? '',
      );
      expect(activeControlText).toContain('Show QR Code');

      // Keyboard Enter on dropzone opens native file chooser and adds deterministic file
      const dropzone = peerA.page.getByRole('button', {
        name: 'Drop local files here or press Enter to add files',
      });
      await dropzone.focus();
      const [fileChooser] = await Promise.all([
        peerA.page.waitForEvent('filechooser'),
        peerA.page.keyboard.press('Enter'),
      ]);
      await fileChooser.setFiles({
        name: 'keyboard-added.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from('keyboard dropzone file', 'utf8'),
      });
      await expect(
        peerB.page.getByRole('button', { name: 'Download keyboard-added.txt' }),
      ).toBeEnabled();
      await peerB.page.getByRole('button', { name: 'Download keyboard-added.txt' }).click();
      await expect(
        peerB.page.locator('li.transfer-row', { hasText: 'keyboard-added.txt' }).locator('.transfer-state-label'),
      ).toHaveText('Completed');

      // Check Desktop, Tablet, and Mobile layouts with rendered cards and transfer rows
      for (const viewport of [
        { width: 1280, height: 800 },
        { width: 768, height: 1024 },
        { width: 375, height: 667 },
      ]) {
        await peerB.page.setViewportSize(viewport);
        const overflow = await peerB.page.evaluate(() => ({
          scrollWidth: document.documentElement.scrollWidth,
          innerWidth: window.innerWidth,
        }));
        expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.innerWidth);
        await expect(peerB.page.getByRole('button', { name: 'Leave Room' })).toBeVisible();
        await expect(
          peerB.page.getByRole('button', { name: 'Download keyboard-added.txt' }),
        ).toBeVisible();
      }
    } finally {
      await harness.close();
    }
  });

  test('bounds JS heap growth and meets throughput targets on 16 MiB streaming while enforcing quota limits and session key wipe', async ({
    browser,
  }) => {
    const harness = await startPeerRoomHarness({
      browser,
      serveBuiltBundle: true,
      peerBOptions: { retainBytes: false },
    });
    try {
      const { peerA, peerB } = harness;
      const shareUrl = await connectCompiledPair(harness);
      const roomId = new URL(shareUrl).pathname.split('/').pop();

      const cdpA = await peerA.context.newCDPSession(peerA.page);
      const cdpB = await peerB.context.newCDPSession(peerB.page);
      await cdpA.send('Performance.enable');
      await cdpB.send('Performance.enable');

      const totalBytes = 16 * 1024 * 1024;
      const bigFile = await dropVirtualFile(peerA.page, {
        name: 'gate-16mb.bin',
        sizeBytes: totalBytes,
        seed: 808,
      });

      await expect(
        peerB.page.getByRole('button', { name: 'Download gate-16mb.bin' }),
      ).toBeEnabled();

      // Baseline after Peer A finishes constructing File reference
      const baselineHeapA = await readJsHeapUsedBytes(cdpA);
      const baselineHeapB = await readJsHeapUsedBytes(cdpB);
      let peakHeapA = baselineHeapA;
      let peakHeapB = baselineHeapB;

      const startMs = Date.now();
      await peerB.page.getByRole('button', { name: 'Download gate-16mb.bin' }).click();

      await expect
        .poll(
          async () => {
            peakHeapA = Math.max(peakHeapA, await readJsHeapUsedBytes(cdpA));
            peakHeapB = Math.max(peakHeapB, await readJsHeapUsedBytes(cdpB));
            const savedList = await peerB.page.evaluate(
              () => window.__shipriE2E?.savedFiles?.[0] ?? null,
            );
            return Boolean(savedList?.closed);
          },
          { timeout: 30_000, intervals: [100] },
        )
        .toBe(true);

      const endMs = Date.now();
      const postHeapA = Math.max(peakHeapA, await readJsHeapUsedBytes(cdpA));
      const postHeapB = Math.max(peakHeapB, await readJsHeapUsedBytes(cdpB));

      await expect(
        peerB.page.locator('li.transfer-row', { hasText: 'gate-16mb.bin' }).locator('.transfer-state-label'),
      ).toHaveText('Completed');

      const saved = await peerB.getSavedFiles();
      expect(saved).toHaveLength(1);
      expect(saved[0].bytesWritten).toBe(totalBytes);
      expect(saved[0].sha256ChainHex).toBe(bigFile.streamDigestHex);

      const elapsedSeconds = Math.max(0.001, (endMs - startMs) / 1000);
      const throughputMBps = 16 / elapsedSeconds;
      expect(throughputMBps).toBeGreaterThan(0.5);

      const heapDeltaA = postHeapA - baselineHeapA;
      const heapDeltaB = postHeapB - baselineHeapB;
      expect(heapDeltaA).toBeLessThan(32 * 1024 * 1024);
      expect(heapDeltaB).toBeLessThan(32 * 1024 * 1024);

      // Leaving room wipes sessionStorage room keys immediately
      expect(await peerB.page.evaluate(() => sessionStorage.length)).toBeGreaterThan(0);
      await peerB.page.getByRole('button', { name: 'Leave Room' }).click();
      const remainingRoomKeys = await peerB.page.evaluate(
        (id) => Object.keys(sessionStorage).filter((k) => k.includes(id)),
        roomId,
      );
      expect(remainingRoomKeys).toEqual([]);

      // Storage quota pre-evaluation blocks oversized downloads before picker & DOWNLOAD_REQUEST
      const quotaPeer = await harness.createPeerContext(browser, {
        storageQuotaBytes: 1024 * 1024,
      });
      await quotaPeer.page.goto(shareUrl);
      await expect(peerA.page.getByText('Encrypted peer session ready')).toBeVisible();

      await dropVirtualFile(peerA.page, {
        name: 'too-big-quota.bin',
        sizeBytes: 2 * 1024 * 1024,
        seed: 809,
      });
      await expect(
        quotaPeer.page.getByText('Estimated available storage: 1.0 MB.'),
      ).toBeVisible();
      await expect(
        quotaPeer.page
          .locator('li.file-card', { hasText: 'too-big-quota.bin' })
          .getByText(/exceeds estimated available local storage/),
      ).toBeVisible();
      await expect(
        quotaPeer.page.getByRole('button', { name: 'Download too-big-quota.bin' }),
      ).toBeDisabled();
      await expect(quotaPeer.page.getByText('No transfers started yet.')).toBeVisible();
    } finally {
      await harness.close();
    }
  });

  test('verifies privacy-safe /health, /ready, /metrics and zero backend leakage end-to-end', async ({
    browser,
  }) => {
    const harness = await startPeerRoomHarness({
      browser,
      serveBuiltBundle: true,
    });
    try {
      const { peerA, peerB, signalingUrl, backendAudit } = harness;
      const shareUrl = await connectCompiledPair(harness);
      const roomId = new URL(shareUrl).pathname.split('/').pop();
      const keyFragment = new URL(shareUrl).hash.slice('#key='.length);

      const secretDoc = await dropVirtualFile(peerA.page, {
        name: 'confidential-board.txt',
        sizeBytes: 128 * 1024 + 5,
        seed: 999,
      });
      await expect(
        peerB.page.getByRole('button', { name: 'Download confidential-board.txt' }),
      ).toBeEnabled();
      await peerB.page.getByRole('button', { name: 'Download confidential-board.txt' }).click();
      await expect(
        peerB.page.locator('li.transfer-row', { hasText: 'confidential-board.txt' }).locator('.transfer-state-label'),
      ).toHaveText('Completed');

      const healthDuring = await fetch(`${signalingUrl}/health`);
      expect(healthDuring.status).toBe(200);
      expect(healthDuring.headers.get('cache-control')).toBe('no-store');
      const healthBody = await healthDuring.json();
      expect(healthBody.status).toBe('ok');
      expect(healthBody.roomsCount).toBe(1);
      expect(JSON.stringify(healthBody)).not.toContain(roomId);
      expect(JSON.stringify(healthBody)).not.toContain('confidential-board.txt');

      const readyRes = await fetch(`${signalingUrl}/ready`);
      expect(readyRes.status).toBe(200);
      const readyBody = await readyRes.json();
      expect(readyBody.status).toBe('ready');
      expect(readyBody.roomsCount).toBe(1);

      const metricsRes = await fetch(`${signalingUrl}/metrics`);
      expect(metricsRes.status).toBe(200);
      const metricsBody = await metricsRes.json();
      expect(metricsBody.activeRoomsCount).toBe(1);
      expect(metricsBody.roomsCreatedTotal).toBeGreaterThanOrEqual(1);
      expect(JSON.stringify(metricsBody)).not.toContain(roomId);
      expect(JSON.stringify(metricsBody)).not.toContain(keyFragment);
      expect(JSON.stringify(metricsBody)).not.toContain('confidential-board.txt');

      // Both peers leave and server deletes room cleanly
      await peerB.page.getByRole('button', { name: 'Leave Room' }).click();
      await peerA.page.getByRole('button', { name: 'Leave Room' }).click();

      await expect
        .poll(async () => {
          const r = await fetch(`${signalingUrl}/health`);
          const b = await r.json();
          return b.roomsCount;
        })
        .toBe(0);

      backendAudit.assertZeroLeakage({
        forbiddenStrings: [
          keyFragment,
          'confidential-board.txt',
          secretDoc.sha256Hex,
          String(secretDoc.sizeBytes),
        ],
      });

      const allErrors = [
        ...peerA.consoleErrors,
        ...peerB.consoleErrors,
        ...peerA.pageErrors,
        ...peerB.pageErrors,
      ].join('\n');
      expect(allErrors).not.toContain(keyFragment);
      expect(allErrors).not.toContain('confidential-board.txt');
    } finally {
      await harness.close();
    }
  });
});
