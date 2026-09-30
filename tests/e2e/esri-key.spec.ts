import { expect, test } from './network-fixture';
import { openFixture } from './golden-helpers';
import { installOfflineBasemap, offlineStylePath } from './offline-basemap';
import { IMAGERY_HOSTS, isEsriTile, stubImagery } from './imagery-stubs';

type Page = Parameters<typeof openFixture>[0];

// T-319 acceptance (Integrator); gating since T-319 merged. No live network: every imagery host is stubbed.
test.use({ stubbedHosts: IMAGERY_HOSTS });

const KEY = 'TEST_ARCGIS_KEY_123';
const ESRI_CREDIT = 'Esri, Vantor, Earthstar Geographics, and the GIS User Community';

async function openWithBasemap(page: Page, seen: string[], patch: Record<string, unknown>) {
  await installOfflineBasemap(page);
  await stubImagery(page, seen);
  await openFixture(page, 'tests/fixtures/generated/solid.png');
  await page.evaluate(
    async ({ styleUrl, patch }) => {
      const settings = await import('/src/io/settings.ts' as string);
      settings.updateBasemapSettings({
        enabled: true,
        imagery: 'satellite',
        styleUrl,
        lastCenter: [-78.395, 38.597],
        lastZoom: 14,
        ...patch,
      });
    },
    { styleUrl: offlineStylePath, patch },
  );
  await page.getByRole('button', { name: 'Show basemap' }).click();
  const pane = page.getByRole('region', { name: 'Basemap', exact: true });
  await expect(pane.locator('canvas.maplibregl-canvas')).toBeVisible();
  return pane;
}

test('with a key, Esri tiles use the documented URL with token=<key> and the exact credit [T-319]', async ({ page }) => {
  test.setTimeout(90_000);
  const seen: string[] = [];
  const pane = await openWithBasemap(page, seen, { satelliteProvider: 'esri', esriApiKey: KEY });
  await expect.poll(() => seen.filter(isEsriTile).length, { timeout: 30_000 }).toBeGreaterThan(0);
  for (const u of seen.filter(isEsriTile)) {
    expect(new URL(u).searchParams.get('token')).toBe(KEY);
  }
  await expect(pane.locator('.maplibregl-ctrl-attrib')).toContainText(ESRI_CREDIT);
  // The key stays in this browser: it isn't written into the project.
  const projectJson = await page.evaluate(() => JSON.stringify(window.__trailmaker!.session.getSession()!.project));
  expect(projectJson).not.toContain(KEY);
});

test('without a key, Esri is disabled and never requested, even if chosen [T-319]', async ({ page }) => {
  test.setTimeout(90_000);
  const seen: string[] = [];
  const pane = await openWithBasemap(page, seen, { satelliteProvider: 'esri' });
  await pane.getByRole('button', { name: 'Basemap settings' }).click();
  await expect(page.locator('option[value="esri"]')).toBeDisabled();
  await page.waitForTimeout(2000);
  expect(seen.filter((u) => u.includes('ibasemaps-api.arcgis.com'))).toEqual([]);
});
