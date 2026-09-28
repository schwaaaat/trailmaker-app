import { readFile } from 'node:fs/promises';
import type { BasemapHandle } from '../../src/ui/georef/types';
import type { FixtureTruth } from '../fixtures/truth';
import { expect, test } from './network-fixture';
import { clickFixturePixel, openFixture } from './golden-helpers';
import { installOfflineBasemap, offlineStylePath } from './offline-basemap';

const sampleGpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Trailmaker E2E" xmlns="http://www.topografix.com/GPX/1/1">
  <wpt lat="38.5971" lon="-78.3952"><name>Trailhead Marker</name></wpt>
  <wpt lat="38.6010" lon="-78.3900"><name>Summit Vista</name></wpt>
  <trk><name>Ridge Walk</name><trkseg>
    <trkpt lat="38.5971" lon="-78.3952" />
    <trkpt lat="38.6010" lon="-78.3900" />
  </trkseg></trk>
</gpx>`;

test('GPX import draws local points, pairs a selected point, and persists before and after pairing [T-312]', async ({ page }) => {
  test.setTimeout(90_000);
  const truth = JSON.parse(
    await readFile('tests/fixtures/generated/solid.truth.json', 'utf8'),
  ) as FixtureTruth;
  await installOfflineBasemap(page);
  await openFixture(page, 'tests/fixtures/generated/solid.png');
  await expect.poll(() => page.evaluate(async () => {
    const { readAutosave } = await import('/src/io/autosave.ts' as string);
    return Boolean(await readAutosave());
  })).toBe(true);

  await page.evaluate(async (styleUrl) => {
    const settings = await import('/src/io/settings.ts' as string);
    settings.updateBasemapSettings({
      enabled: false,
      styleUrl,
      lastCenter: [-78.395, 38.597],
      lastZoom: 14,
    });
    const host = document.createElement('div');
    host.id = 'test-gpx-pairing-host';
    host.style.cssText = 'position:fixed;inset:0 0 0 auto;width:48vw;z-index:9999;background:white';
    document.body.append(host);
    const handleRef: { current: BasemapHandle | null } = { current: null };
    (window as Window & { __gpxPairingRef?: typeof handleRef }).__gpxPairingRef = handleRef;
    const { mountBasemapPane } = await import('/src/ui/georef/testMount.ts' as string);
    mountBasemapPane(host, { overrideStyleUrl: styleUrl, handleRef });
  }, offlineStylePath);

  const host = page.locator('#test-gpx-pairing-host');
  await host.getByRole('button', { name: 'Enable basemap' }).click();
  await expect.poll(() => page.evaluate(() => (window as Window & {
    __gpxPairingRef?: { current: BasemapHandle | null };
  }).__gpxPairingRef?.current?.isReady() ?? false), { timeout: 30_000 }).toBe(true);
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    host.getByRole('button', { name: 'Import GPX file' }).click(),
  ]);
  await chooser.setFiles({
    name: 'survey.gpx',
    mimeType: 'application/gpx+xml',
    buffer: Buffer.from(sampleGpx),
  });

  const list = host.getByRole('dialog', { name: /GPX Points/ });
  await expect(list).toBeVisible();
  await expect(list.getByRole('button', { name: /Trailhead Marker/ })).toBeVisible();
  await expect.poll(() => page.evaluate(() => {
    const map = (window as Window & {
      __gpxPairingRef?: { current: BasemapHandle | null };
    }).__gpxPairingRef?.current?.getMap();
    return {
      hasMap: Boolean(map),
      styleLoaded: map?.isStyleLoaded() ?? false,
      hasSource: Boolean(map?.getSource('trailmaker-imported-gpx')),
      hasLayer: Boolean(map?.getLayer('trailmaker-gpx-points-layer')),
    };
  }), { timeout: 10_000 }).toMatchObject({ hasLayer: true });

  // Import itself is a project-associated change: autosave must retain it even before pairing.
  await expect.poll(() => page.evaluate(async () => {
    const { readAutosave } = await import('/src/io/autosave.ts' as string);
    return (await readAutosave())?.gpx?.fileName ?? null;
  }), { timeout: 5_000 }).toBe('survey.gpx');

  await list.getByRole('searchbox', { name: 'Filter points by name' }).fill('Trailhead');
  await expect(list.getByRole('button', { name: /Summit Vista/ })).toHaveCount(0);
  await host.evaluate((element) => { (element as HTMLElement).style.pointerEvents = 'none'; });
  await page.getByRole('toolbar', { name: 'Map tools' })
    .getByRole('button', { name: 'Anchor', exact: true }).click();
  await clickFixturePixel(page, truth, [120, 120]);
  await host.evaluate((element) => { (element as HTMLElement).style.pointerEvents = 'auto'; });
  await list.getByRole('button', { name: /Pair with Trailhead Marker/ }).click();
  await expect.poll(() => page.evaluate(() => {
    const anchor = window.__trailmaker!.session.getSession()?.project.anchors[0];
    return anchor?.source === 'basemap' ? anchor.ll : null;
  })).toEqual([38.5971, -78.3952]);
  await expect.poll(() => page.evaluate(async () => {
    const { readAutosave } = await import('/src/io/autosave.ts' as string);
    const saved = await readAutosave();
    return saved?.project.anchors.length === 1 && saved.gpx?.fileName === 'survey.gpx';
  })).toBe(true);
});
