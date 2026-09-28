import { readFile } from 'node:fs/promises';
import type { BasemapHandle } from '../../src/ui/georef/types';
import { pixelToLatLon, type FixtureTruth } from '../fixtures/truth';
import { expect, test } from './network-fixture';
import { openReadyApp } from './app-ready';
import { installOfflineBasemap, offlineStylePath } from './offline-basemap';

test('TPS overlay places a known trail pixel within 5 m of truth on the offline basemap [T-309]', async ({ page }) => {
  test.setTimeout(90_000);
  const truth = JSON.parse(await readFile('tests/fixtures/generated/warped.truth.json', 'utf8')) as FixtureTruth;
  await installOfflineBasemap(page);
  await openReadyApp(page);

  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByRole('complementary', { name: 'Steps' }).getByRole('button', { name: 'Open image or PDF' }).click(),
  ]);
  await chooser.setFiles('tests/fixtures/generated/warped.png');
  await expect.poll(() => page.evaluate(() => window.__trailmaker!.session.getSession()?.project.image.fileName)).toBe('warped');

  await page.evaluate(async ({ anchors, styleUrl }) => {
    const current = window.__trailmaker!.session.getSession()!;
    window.__trailmaker!.session.openSession({
      ...current,
      project: { ...current.project, anchors, fitMethod: 'tps' },
    });
    const host = document.createElement('div');
    host.id = 'test-overlay-preview-host';
    host.style.cssText = 'position:fixed;inset:0 0 0 auto;width:60vw;z-index:9999;background:white';
    document.body.append(host);
    const handleRef: { current: BasemapHandle | null } = { current: null };
    (window as Window & { __overlayPreviewRef?: typeof handleRef }).__overlayPreviewRef = handleRef;
    const settingsPath: string = '/src/io/settings.ts';
    const settings = await import(settingsPath);
    settings.updateBasemapSettings({ enabled: true, styleUrl, opacity: 0.6 });
    const mountPath: string = '/src/ui/georef/testMount.ts';
    const { mountOverlayPreview } = await import(mountPath);
    mountOverlayPreview(host, { overrideStyleUrl: styleUrl, handleRef });
  }, { anchors: truth.anchors, styleUrl: offlineStylePath });

  const preview = page.getByRole('region', { name: 'Overlay preview' });
  await expect(preview.getByRole('slider', { name: 'Map opacity' })).toHaveValue('60');
  await expect.poll(() => page.evaluate(() => {
    const map = (window as Window & { __overlayPreviewRef?: { current: BasemapHandle | null } }).__overlayPreviewRef?.current?.getMap();
    return Boolean(map?.isStyleLoaded() && map?.getLayer('trailmaker-overlay-layer'));
  }), { timeout: 30_000 }).toBe(true);

  const trailPixel = truth.polylines.find((line) => line.id === 'red-ridge')!.pts[40]!;
  const [lat, lon] = pixelToLatLon(trailPixel, truth.transform);
  const sample = await page.evaluate(({ sampleLat, sampleLon, metersPerDegreeLng }) => {
    const map = (window as Window & { __overlayPreviewRef?: { current: BasemapHandle | null } }).__overlayPreviewRef?.current?.getMap();
    if (!map) throw new Error('Overlay map is not ready');
    const expected = map.project([sampleLon, sampleLat]);
    const fiveMetersEast = map.project([sampleLon + 5 / metersPerDegreeLng, sampleLat]);
    const rect = map.getContainer().getBoundingClientRect();
    return {
      x: rect.left + expected.x,
      y: rect.top + expected.y,
      radius: Math.max(3, Math.ceil(Math.abs(fiveMetersEast.x - expected.x))),
    };
  }, { sampleLat: lat, sampleLon: lon, metersPerDegreeLng: truth.transform.metersPerDegree[0] });

  const screenshot = await page.screenshot();
  const foundTrail = await page.evaluate(async ({ pngBase64, sample }) => {
    const image = await createImageBitmap(await (await fetch(`data:image/png;base64,${pngBase64}`)).blob());
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(image, 0, 0);
    const pixels = ctx.getImageData(0, 0, image.width, image.height).data;
    for (let y = Math.max(0, Math.floor(sample.y - sample.radius)); y <= Math.min(image.height - 1, Math.ceil(sample.y + sample.radius)); y++) {
      for (let x = Math.max(0, Math.floor(sample.x - sample.radius)); x <= Math.min(image.width - 1, Math.ceil(sample.x + sample.radius)); x++) {
        if ((x - sample.x) ** 2 + (y - sample.y) ** 2 > sample.radius ** 2) continue;
        const offset = (y * image.width + x) * 4;
        const red = pixels[offset]!;
        const green = pixels[offset + 1]!;
        const blue = pixels[offset + 2]!;
        if (red > green + 35 && red > blue + 35) return true;
      }
    }
    return false;
  }, { pngBase64: screenshot.toString('base64'), sample });
  expect(foundTrail, `No red trail pixel within 5 m of (${lat}, ${lon})`).toBe(true);
});
