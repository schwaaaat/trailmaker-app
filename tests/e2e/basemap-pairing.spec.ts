import { readFile } from 'node:fs/promises';
import type { BasemapHandle } from '../../src/ui/georef/types';
import { fitAnchors, forward } from '../../src/core/geo/fit';
import { haversine } from '../../src/core/geo/distance';
import type { FixtureTruth } from '../fixtures/truth';
import { expect, test } from './network-fixture';
import { clickFixturePixel, openFixture } from './golden-helpers';
import { installOfflineBasemap, offlineStylePath } from './offline-basemap';

test('four park-map and offline basemap clicks create accurate paired anchors [T-307]', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const truth = JSON.parse(
    await readFile('tests/fixtures/generated/solid.truth.json', 'utf8'),
  ) as FixtureTruth;
  await installOfflineBasemap(page);
  await openFixture(page, 'tests/fixtures/generated/solid.png');
  await page.evaluate(async (styleUrl) => {
    const settingsPath: string = '/src/io/settings.ts';
    const settings = await import(settingsPath);
    settings.updateBasemapSettings({
      enabled: false,
      styleUrl,
      lastCenter: [-78.395, 38.597],
      lastZoom: 15,
    });
    const host = document.createElement('div');
    host.id = 'test-basemap-pairing-host';
    host.style.cssText = 'position:fixed;inset:0 0 0 auto;width:48vw;z-index:9999;background:white';
    document.body.append(host);
    const handleRef: { current: BasemapHandle | null } = { current: null };
    (window as Window & { __basemapPairingRef?: typeof handleRef }).__basemapPairingRef = handleRef;
    const mountPath: string = '/src/ui/georef/testMount.ts';
    const { mountBasemapPane } = await import(mountPath);
    mountBasemapPane(host, { overrideStyleUrl: styleUrl, handleRef });
  }, offlineStylePath);

  const pane = page.getByRole('region', { name: 'Basemap' });
  await pane.getByRole('button', { name: 'Enable basemap' }).click();
  await expect.poll(() => page.evaluate(() =>
    (window as Window & { __basemapPairingRef?: { current: BasemapHandle | null } })
      .__basemapPairingRef?.current?.getMap()?.isStyleLoaded(),
  ), { timeout: 30_000 }).toBe(true);

  const toolbar = page.getByRole('toolbar', { name: 'Map tools' });
  for (const [index, anchor] of truth.anchors.slice(0, 4).entries()) {
    await page.locator('#test-basemap-pairing-host').evaluate((host) => {
      (host as HTMLElement).style.pointerEvents = 'none';
    });
    await toolbar.getByRole('button', { name: 'Anchor', exact: true }).click();
    await clickFixturePixel(page, truth, anchor.px);
    await expect(pane.getByText('Now click the same spot on the basemap')).toBeVisible();
    await page.locator('#test-basemap-pairing-host').evaluate((host) => {
      (host as HTMLElement).style.pointerEvents = 'auto';
    });
    const point = await page.evaluate(([lat, lon]) => {
      const map = (window as Window & {
        __basemapPairingRef?: { current: BasemapHandle | null };
      }).__basemapPairingRef?.current?.getMap();
      if (!map) throw new Error('Basemap not ready');
      const pixel = map.project([lon, lat]);
      const rect = map.getContainer().getBoundingClientRect();
      return { x: rect.left + pixel.x, y: rect.top + pixel.y };
    }, anchor.ll!);
    await page.mouse.click(point.x, point.y);
    await expect.poll(() => page.evaluate((n) => {
      const anchors = window.__trailmaker!.session.getSession()!.project.anchors;
      return anchors.length === n && anchors[n - 1]?.source === 'basemap';
    }, index + 1)).toBe(true);
    await expect(pane.getByRole('button', { name: `Anchor ${index + 1}` })).toBeVisible();
  }

  const anchors = await page.evaluate(() => window.__trailmaker!.session.getSession()!.project.anchors);
  const fit = fitAnchors(anchors, truth.width, truth.height, 'auto');
  expect(fit.ok).toBe(true);
  if (!fit.ok) return;
  for (const anchor of truth.anchors.slice(0, 4)) {
    expect(haversine(forward(fit, anchor.px), anchor.ll!)).toBeLessThanOrEqual(5);
  }
});
