import { readFile } from 'node:fs/promises';
import { expect, test } from './network-fixture';
import { installOfflineBasemap, offlineStylePath } from './offline-basemap';
import { openReadyApp } from './app-ready';
import { validateGpx } from '../metrics/xml';
import { IMAGERY_HOSTS, isNaipExport, isUsgsTile, stubImagery } from './imagery-stubs';

// T-318 acceptance (Integrator); gating since T-318 merged. From T-320 the US default capture
// source is NAIP (exportImage), with USGS basemap tiles as the fallback; either counts here.
test.use({ stubbedHosts: IMAGERY_HOSTS });

test('Make map from scratch via satellite capture, trace, and export GPX [T-318]', async ({ page }) => {
  test.setTimeout(90_000);
  await installOfflineBasemap(page);
  const tiles: string[] = [];
  await stubImagery(page, tiles);

  await openReadyApp(page);
  await page.evaluate(
    async ({ styleUrl }) => {
      const settingsPath: string = '/src/io/settings.ts';
      const settings = await import(settingsPath);
      settings.updateBasemapSettings({
        enabled: true,
        imagery: 'satellite',
        styleUrl,
        lastCenter: [-80.145, 27.135],
        lastZoom: 15,
      });
    },
    { styleUrl: offlineStylePath },
  );

  // Click "Start from satellite" button in Step 1 (or EmptyState)
  const startBtn = page.getByRole('button', { name: 'Start from satellite' }).first();
  await expect(startBtn).toBeVisible();
  await startBtn.click();

  // Framing overlay opens
  const overlay = page.getByRole('dialog', { name: 'Capture satellite map' });
  await expect(overlay).toBeVisible();
  await expect(overlay.getByText(/per pixel/)).toBeVisible();

  // Capture
  const captureBtn = overlay.getByRole('button', { name: 'Capture map' });
  await captureBtn.click();

  // Project opens with 9 anchors and satellite name
  await expect.poll(() => page.evaluate(() => window.__trailmaker?.session.getSession()?.project.anchors.length)).toBe(9);
  const projectName = await page.evaluate(() => window.__trailmaker?.session.getSession()?.project.name);
  expect(projectName).toMatch(/^Satellite /);
  expect(tiles.some((u) => isUsgsTile(u) || isNaipExport(u))).toBe(true);
  // Every auto-anchor has real coordinates, all inside the framed area.
  const anchors = await page.evaluate(() => window.__trailmaker!.session.getSession()!.project.anchors.map((a) => a.ll));
  for (const ll of anchors) {
    expect(ll).not.toBeNull();
    expect(Math.abs(ll![0] - 27.135)).toBeLessThan(0.1);
    expect(Math.abs(ll![1] + 80.145)).toBeLessThan(0.1);
  }

  // Trace one trail and finish
  await page.getByRole('toolbar', { name: 'Map tools' }).getByRole('button', { name: 'Trail', exact: true }).click();
  const canvas = page.locator('.stage-editor canvas').first();
  const box = (await canvas.boundingBox())!;
  expect(box, 'editor canvas is on screen').toBeTruthy();
  await page.mouse.click(box.x + box.width * 0.4, box.y + box.height * 0.4);
  await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5);
  await page.mouse.click(box.x + box.width * 0.6, box.y + box.height * 0.6);
  await page.getByRole('group', { name: 'Drawing' }).getByRole('button', { name: /Finish trail/ }).click();
  await expect.poll(() => page.evaluate(() => window.__trailmaker?.session.getSession()?.project.features.filter((f) => f.kind === 'trail').length)).toBe(1);

  // Export GPX
  const steps = page.getByRole('complementary', { name: 'Steps' });
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    steps.getByRole('button', { name: 'Download GPX' }).click(),
  ]);
  const xml = await readFile(await download.path(), 'utf8');
  expect(validateGpx(xml)).toBe(true);
  expect(xml).toContain('<trk>');
});
