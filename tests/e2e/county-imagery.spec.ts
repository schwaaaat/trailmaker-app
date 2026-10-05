import { readFile } from 'node:fs/promises';
import { expect, test } from './network-fixture';
import { installOfflineBasemap, offlineStylePath } from './offline-basemap';
import { openReadyApp } from './app-ready';
import {
  IMAGERY_HOSTS,
  TEXTURED_PNG,
  isMartinExport,
  isNaipExport,
  stubImagery,
  stubMartinCounty,
} from './imagery-stubs';

// T-326 acceptance (Integrator); gating since T-326 merged.

const PASTED_HOST = 'imagery.example.test';
const PASTED_URL = `https://${PASTED_HOST}/arcgis/rest/services/FDOT/Aerial_2018/ImageServer`;
test.use({ stubbedHosts: [...IMAGERY_HOSTS, PASTED_HOST] });

type Page = Parameters<typeof openReadyApp>[0];

const SEABRANCH: readonly [lon: number, lat: number] = [-80.1705, 27.1375];
const SHENANDOAH: readonly [lon: number, lat: number] = [-78.395, 38.597];

async function openCapture(page: Page, center: readonly [number, number]) {
  await installOfflineBasemap(page);
  await openReadyApp(page);
  await page.evaluate(
    async ({ styleUrl, center }) => {
      const settings = await import('/src/io/settings.ts' as string);
      settings.updateBasemapSettings({
        enabled: true,
        imagery: 'satellite',
        styleUrl,
        lastCenter: center,
        lastZoom: 17,
      });
    },
    { styleUrl: offlineStylePath, center: [...center] },
  );
  await page.getByRole('button', { name: 'Start from satellite' }).first().click();
  const overlay = page.getByRole('dialog', { name: 'Capture satellite map' });
  await expect(overlay).toBeVisible();
  return overlay;
}

const project = (page: Page) =>
  page.evaluate(() => window.__trailmaker!.session.getSession()?.project ?? null);

async function waitForCapture(page: Page) {
  await expect
    .poll(
      () => page.evaluate(() => window.__trailmaker?.session.getSession()?.project.anchors.length),
      { timeout: 60_000 },
    )
    .toBe(9);
}

test('inside Martin County the county source is preselected, captured, and credited in the project and KML [T-326]', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const seen: string[] = [];
  await stubImagery(page, seen);
  const overlay = await openCapture(page, SEABRANCH);
  const source = overlay.getByLabel('Capture imagery source');
  await expect(source).toHaveValue('martin-county');
  await overlay.getByRole('button', { name: 'Capture map' }).click();
  await waitForCapture(page);

  const exports = seen.filter(isMartinExport);
  expect(exports.length).toBeGreaterThan(0);
  for (const u of exports) {
    const q = new URL(u).searchParams;
    expect(q.get('bboxSR')).toBe('3857');
    expect(q.get('imageSR')).toBe('3857');
    const [w, h] = q.get('size')!.split(',').map(Number);
    expect(Math.max(w!, h!)).toBeLessThanOrEqual(2048);
  }
  // (The NAIP satellite basemap also calls exportImage, so the source is checked by its credit.)
  const image = (await project(page))!.image;
  expect(image.attribution).toContain('Martin County');
  expect(image.attribution).toContain('GPI Geospatial');
  expect(image.acquisitionYear).toBe(2026);

  // KML carries the county credit, never the service URL.
  const steps = page.getByRole('complementary', { name: 'Steps' });
  const p = (await project(page))!;
  await page.evaluate((p) => {
    const t = window.__trailmaker!;
    const cur = t.session.getSession()!;
    t.session.openSession({
      project: {
        ...p,
        features: [
          {
            id: 't1',
            kind: 'trail',
            name: 'Test trail',
            color: '#cc3030',
            notes: '',
            pts: [
              [10, 10],
              [40, 40],
            ],
            ink: null,
          },
        ],
      },
      map: cur.map,
    });
  }, p);
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    steps.getByRole('button', { name: 'Download KML' }).click(),
  ]);
  const kml = await readFile(await download.path(), 'utf8');
  expect(kml).toContain('Martin County');
  expect(kml).not.toContain('geoweb.martin.fl.us');
});

test('outside Martin County the county source is not offered [T-326]', async ({ page }) => {
  test.setTimeout(90_000);
  await stubImagery(page, []);
  const overlay = await openCapture(page, SHENANDOAH);
  const source = overlay.getByLabel('Capture imagery source');
  await expect(source).toHaveValue('naip');
  await expect(source.locator('option[value="martin-county"]')).toHaveCount(0);
});

test('a blank county export falls back to NAIP [T-326]', async ({ page }) => {
  test.setTimeout(120_000);
  const seen: string[] = [];
  await stubImagery(page, seen);
  await stubMartinCounty(page, seen, { blank: true });
  const overlay = await openCapture(page, SEABRANCH);
  await expect(overlay.getByLabel('Capture imagery source')).toHaveValue('martin-county');
  await overlay.getByRole('button', { name: 'Capture map' }).click();
  await waitForCapture(page);
  expect(seen.some(isMartinExport)).toBe(true);
  expect(seen.some(isNaipExport)).toBe(true);
  expect((await project(page))!.image.attribution).toBe(
    'Imagery: USDA NAIP via USGS The National Map',
  );
});

test('a pasted ArcGIS service needs the rights box, captures, and stays out of the project [T-326]', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const seen: string[] = [];
  await stubImagery(page, seen);
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Cross-Origin-Resource-Policy': 'cross-origin',
  };
  await page.route(`https://${PASTED_HOST}/**`, async (route) => {
    const url = route.request().url();
    seen.push(url);
    if (/ImageServer\?f=json/.test(url)) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers,
        body: JSON.stringify({
          name: 'FDOT_Yearly_Aerials/Aerial_Imagery_2018',
          description: '2018 aerial imagery',
          copyrightText: 'FDEP',
          fullExtent: {
            xmin: 328952.287,
            ymin: 58482.538,
            xmax: 792824.296,
            ymax: 743538.596,
            spatialReference: { wkid: 3087 },
          },
          spatialReference: { wkid: 3087 },
          maxImageWidth: 15000,
          maxImageHeight: 4100,
          pixelSizeX: 0.0762,
          pixelSizeY: 0.0762,
        }),
      });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'image/png', headers, body: TEXTURED_PNG });
  });

  const overlay = await openCapture(page, SEABRANCH);
  await overlay.getByLabel('Use another imagery service (ArcGIS REST URL)').fill(PASTED_URL);
  await overlay.getByRole('button', { name: 'Check service' }).click();
  await expect(overlay).toContainText('FDEP');
  const capture = overlay.getByRole('button', { name: 'Capture map' });
  await expect(capture).toBeDisabled();
  await overlay.getByLabel('I have the right to use this imagery.').check();
  await expect(capture).toBeEnabled();
  await capture.click();
  await waitForCapture(page);

  expect(seen.some((u) => u.includes(`${PASTED_HOST}`) && /exportImage\?/.test(u))).toBe(true);
  const p = (await project(page))!;
  expect(p.image.attribution).toContain('FDEP');
  expect(p.image.acquisitionYear).toBe(2018);
  expect(JSON.stringify(p)).not.toContain(PASTED_HOST);
});

test('a token-protected service is rejected with the reason [T-326]', async ({ page }) => {
  test.setTimeout(90_000);
  await stubImagery(page, []);
  await page.route(`https://${PASTED_HOST}/**`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: { code: 499, message: 'Token Required', details: [] } }),
    }),
  );
  const overlay = await openCapture(page, SEABRANCH);
  await overlay.getByLabel('Use another imagery service (ArcGIS REST URL)').fill(PASTED_URL);
  await overlay.getByRole('button', { name: 'Check service' }).click();
  await expect(overlay).toContainText('requires a token or login');
  await expect(overlay.getByLabel('I have the right to use this imagery.')).toHaveCount(0);
});
