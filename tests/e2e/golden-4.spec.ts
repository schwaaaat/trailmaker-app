import { readFile } from 'node:fs/promises';
import { fitAnchors, forward } from '../../src/core/geo/fit';
import { haversine } from '../../src/core/geo/distance';
import { pixelToLatLon, type FixtureTruth } from '../fixtures/truth';
import { expect, test } from './network-fixture';
import { clickFixturePixel, openFixture } from './golden-helpers';
import { installOfflineBasemap, offlineStylePath } from './offline-basemap';

const CENTER: readonly [lon: number, lat: number] = [-78.395, 38.597];
const ZOOM = 14;

test('golden 4: four clicked park-map/basemap pairs fit within 5 m [T-306, T-307, T-212]', async ({ page }) => {
  test.setTimeout(90_000);
  const truth = JSON.parse(
    await readFile('tests/fixtures/generated/solid.truth.json', 'utf8'),
  ) as FixtureTruth;
  // The fixture's extreme top-left anchor sits under the editor toolbar after the split.
  const chosen = ([[120, 120], [500, 120], [500, 480], [120, 480]] as const).map((px) => ({
    px,
    ll: pixelToLatLon(px, truth.transform),
  }));
  await installOfflineBasemap(page);
  await openFixture(page, 'tests/fixtures/generated/solid.png');
  await page.evaluate(async ({ styleUrl, center, zoom }) => {
    const settingsPath: string = '/src/io/settings.ts';
    const settings = await import(settingsPath);
    settings.updateBasemapSettings({
      enabled: false,
      styleUrl,
      lastCenter: center,
      lastZoom: zoom,
    });
  }, { styleUrl: offlineStylePath, center: CENTER, zoom: ZOOM });

  await page.getByRole('button', { name: 'Enable basemap' }).click();
  await page.getByRole('button', { name: 'Show basemap' }).click();
  const pane = page.getByRole('region', { name: 'Basemap', exact: true });
  await expect(pane).toBeVisible();
  await expect(pane.locator('canvas.maplibregl-canvas')).toBeVisible();
  const toolbar = page.getByRole('toolbar', { name: 'Map tools' });

  for (const [index, anchor] of chosen.entries()) {
    await toolbar.getByRole('button', { name: 'Anchor', exact: true }).click();
    await clickFixturePixel(page, truth, anchor.px);
    await expect.poll(() => page.evaluate(() => window.__trailmaker!.session.getSession()!.project.anchors.length)).toBe(index + 1);
    await expect(pane.getByText('Now click the same spot on the basemap')).toBeVisible();

    const point = await pane.locator('canvas.maplibregl-canvas').evaluate((canvas, ll) => {
      const worldSize = 512 * 2 ** 14;
      const project = ([lat, lon]: readonly [number, number]) => {
        const sinLat = Math.sin((lat * Math.PI) / 180);
        return {
          x: ((lon + 180) / 360) * worldSize,
          y: (0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) * worldSize,
        };
      };
      const center = project([38.597, -78.395]);
      const target = project(ll);
      const rect = canvas.getBoundingClientRect();
      return {
        x: rect.left + rect.width / 2 + target.x - center.x,
        y: rect.top + rect.height / 2 + target.y - center.y,
      };
    }, anchor.ll);
    await page.mouse.click(point.x, point.y);
    await expect.poll(() => page.evaluate((n) => {
      const anchors = window.__trailmaker!.session.getSession()!.project.anchors;
      return anchors.length === n && anchors[n - 1]?.source === 'basemap';
    }, index + 1)).toBe(true);
  }

  const anchors = await page.evaluate(() => window.__trailmaker!.session.getSession()!.project.anchors);
  const fit = fitAnchors(anchors, truth.width, truth.height, 'auto');
  expect(fit.ok).toBe(true);
  if (!fit.ok) return;
  for (const px of [[180, 180], [440, 180], [440, 420], [180, 420]] as const) {
    expect(haversine(forward(fit, px), pixelToLatLon(px, truth.transform))).toBeLessThanOrEqual(5);
  }
});
