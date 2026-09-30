import { expect, test } from './network-fixture';
import { openFixture } from './golden-helpers';
import { installOfflineBasemap, offlineStylePath } from './offline-basemap';

// Tiles are answered locally by page.route below; the hosts are declared so the guard allows them.
// USGS basemap tiles (T-316) and, from T-320, NAIP exportImage tiles (the US default provider).
test.use({ stubbedHosts: ['basemap.nationalmap.gov', 'imagery.nationalmap.gov'] });

// 1x1 PNG; any decodable raster tile works for MapLibre.
const TILE = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

test('Satellite switch loads USGS/NAIP raster tiles under COEP and shows the attribution [T-316, T-320]', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const tiles: string[] = [];
  await installOfflineBasemap(page);
  for (const host of ['https://basemap.nationalmap.gov/**', 'https://imagery.nationalmap.gov/**']) {
    await page.route(host, async (route) => {
      tiles.push(route.request().url());
      await route.fulfill({
        status: 200,
        contentType: 'image/png',
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Cross-Origin-Resource-Policy': 'cross-origin',
        },
        body: TILE,
      });
    });
  }
  await openFixture(page, 'tests/fixtures/generated/solid.png');
  await page.evaluate(
    async ({ styleUrl }) => {
      const settingsPath: string = '/src/io/settings.ts';
      const settings = await import(settingsPath);
      settings.updateBasemapSettings({
        enabled: false,
        styleUrl,
        lastCenter: [-78.395, 38.597],
        lastZoom: 14,
      });
    },
    { styleUrl: offlineStylePath },
  );
  await page.getByRole('button', { name: 'Enable basemap' }).click();
  await page.getByRole('button', { name: 'Show basemap' }).click();
  const pane = page.getByRole('region', { name: 'Basemap', exact: true });
  await expect(pane.locator('canvas.maplibregl-canvas')).toBeVisible();

  const satellite = pane.getByRole('button', { name: 'Satellite', exact: true });
  await satellite.click();
  await expect(satellite).toHaveAttribute('aria-pressed', 'true');
  await expect
    .poll(
      () =>
        tiles.filter(
          (u) =>
            /USGSImageryOnly\/MapServer\/tile\/\d+\/\d+\/\d+/.test(u) ||
            /USGSNAIPImagery\/ImageServer\/exportImage\?/.test(u),
        ).length,
      {
      timeout: 30_000,
    })
    .toBeGreaterThan(0);
  await expect(pane.locator('.maplibregl-ctrl-attrib')).toContainText('USGS');

  // The choice persists, and switching back returns to the vector map.
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const settingsPath: string = '/src/io/settings.ts';
        return (await import(settingsPath)).loadSettings().basemap.imagery;
      }),
    )
    .toBe('satellite');
  await pane.getByRole('button', { name: 'Map', exact: true }).click();
  await expect(pane.getByRole('button', { name: 'Map', exact: true })).toHaveAttribute('aria-pressed', 'true');
});
