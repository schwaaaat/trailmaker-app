import { readFile } from 'node:fs/promises';
import { unzipSync } from 'fflate';
import { expect, test } from './network-fixture';
import { openReadyApp } from './app-ready';
import { installOfflineBasemap, offlineStylePath } from './offline-basemap';
import { IMAGERY_HOSTS, TILE_PNG, stubImagery } from './imagery-stubs';

// T-332 acceptance: all imagery requests use deterministic local stubs.
test.use({ stubbedHosts: IMAGERY_HOSTS });

type Page = Parameters<typeof openReadyApp>[0];
const MARTIN = 'https://geoweb.martin.fl.us/arcgis/rest/services/Imagery/MC_Imagery/MapServer';
const SEABRANCH: readonly [lon: number, lat: number] = [-80.1705, 27.1375];
const MERCATOR_WORLD_METERS = 40_075_016.68557849;
const Z21_EXPORT_METERS = (MERCATOR_WORLD_METERS / (256 * 2 ** 21)) * 2048;
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Cross-Origin-Resource-Policy': 'cross-origin',
};

async function stubMartin(page: Page, exportsSeen: string[]) {
  // A real 2048×2048 JPEG exercises decode, 64-way slicing, and IndexedDB writes.
  const dataUrl = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 2048;
    canvas.height = 2048;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Could not create the deterministic export JPEG');
    context.fillStyle = '#b65b40';
    context.fillRect(0, 0, 2048, 2048);
    return canvas.toDataURL('image/jpeg', 0.75);
  });
  const jpeg = Buffer.from(dataUrl.split(',')[1]!, 'base64');
  await stubImagery(page, []);
  await page.route('https://geoweb.martin.fl.us/**', async (route) => {
    const url = route.request().url();
    const parsed = new URL(url);
    if (parsed.pathname.endsWith('/MapServer') && parsed.searchParams.get('f') === 'json') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: cors,
        body: JSON.stringify({
          name: 'MC_Imagery',
          layers: [{ id: 0 }],
          copyrightText: 'GPI Geospatial, Inc.',
          documentInfo: { Title: '2021 Imagery' },
          singleFusedMapCache: true,
          fullExtent: {
            xmin: -8983106.559,
            ymin: 3116499.117,
            xmax: -8912756.247,
            ymax: 3158127.232,
            spatialReference: { wkid: 102100, latestWkid: 3857 },
          },
          tileInfo: {
            rows: 256,
            cols: 256,
            origin: { x: -20037508.342789244, y: 20037508.342789244 },
            spatialReference: { wkid: 102100, latestWkid: 3857 },
            lods: [
              { level: 20, resolution: 0.149291070823808 },
              { level: 21, resolution: 0.0746455354119042 },
            ],
          },
        }),
      });
      return;
    }
    if (parsed.pathname.endsWith('/MapServer/0') && parsed.searchParams.get('f') === 'json') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: cors,
        body: JSON.stringify({
          description: '3-inch orthoimagery flown January 27, 2026 through February 2, 2026.',
          copyrightText: 'GPI Geospatial, Inc.',
        }),
      });
      return;
    }
    if (parsed.pathname.endsWith('/MapServer/export')) {
      exportsSeen.push(url);
      await route.fulfill({ status: 200, contentType: 'image/jpeg', headers: cors, body: jpeg });
      return;
    }
    if (/\/MapServer\/tile\/21\/\d+\/\d+$/.test(parsed.pathname)) {
      await route.fulfill({ status: 404, headers: cors, body: '' });
      return;
    }
    if (/\/MapServer\/tile\/\d+\/\d+\/\d+$/.test(parsed.pathname)) {
      await route.fulfill({ status: 200, contentType: 'image/png', headers: cors, body: TILE_PNG });
      return;
    }
    throw new Error(`Unexpected Martin County request: ${url}`);
  });
}

async function captureTiledMap(page: Page) {
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
    { styleUrl: offlineStylePath, center: [...SEABRANCH] },
  );
  await page.getByRole('button', { name: 'Start from satellite' }).first().click();
  const overlay = page.getByRole('dialog', { name: 'Capture satellite map' });
  await expect(overlay).toBeVisible();
  await overlay.getByRole('button', { name: 'Draw tiled boundary' }).click();
  const canvas = page.locator('canvas.maplibregl-canvas').last();
  const box = await canvas.boundingBox();
  if (!box) throw new Error('Basemap canvas has no bounds');
  for (const [dx, dy] of [
    [-32, -32],
    [32, -32],
    [32, 32],
    [-32, 32],
  ] as const) {
    await canvas.click({ position: { x: box.width / 2 + dx, y: box.height / 2 + dy } });
  }
  await overlay.getByRole('button', { name: 'Close boundary' }).click();
  await overlay.getByRole('button', { name: 'Estimate download' }).click();
  await overlay.getByRole('button', { name: 'Download offline tiles', exact: true }).click();
  await expect
    .poll(
      () =>
        page.evaluate(
          () => window.__trailmaker?.session.getSession()?.project.image.source.kind ?? null,
        ),
      {
        timeout: 60_000,
      },
    )
    .toBe('tiles');
}

function expectGlobalZ21Export(url: string): void {
  const parsed = new URL(url);
  expect(`${parsed.origin}${parsed.pathname}`).toBe(`${MARTIN}/export`);
  for (const [key, expected] of Object.entries({
    bboxSR: '3857',
    imageSR: '3857',
    size: '2048,2048',
    format: 'jpg',
    f: 'image',
  })) {
    expect(parsed.searchParams.get(key), key).toBe(expected);
  }
  const bbox = parsed.searchParams.get('bbox')?.split(',').map(Number);
  expect(bbox, 'Web Mercator bbox has four finite numbers').toHaveLength(4);
  const [xmin, ymin, xmax, ymax] = bbox!;
  expect(bbox!.every(Number.isFinite)).toBe(true);
  expect(xmax! - xmin!).toBeCloseTo(Z21_EXPORT_METERS, 4);
  expect(ymax! - ymin!).toBeCloseTo(Z21_EXPORT_METERS, 4);
  const col = (xmin! + MERCATOR_WORLD_METERS / 2) / Z21_EXPORT_METERS;
  const row = (MERCATOR_WORLD_METERS / 2 - ymax!) / Z21_EXPORT_METERS;
  expect(col).toBeCloseTo(Math.round(col), 5);
  expect(row).toBeCloseTo(Math.round(row), 5);
}

test('small-area maximum detail uses aligned z21 exports, saves tiles, and deletes detail only [T-332]', async ({
  page,
}) => {
  test.setTimeout(150_000);
  const exportsSeen: string[] = [];
  await stubMartin(page, exportsSeen);
  await captureTiledMap(page);

  await page.getByRole('tab', { name: 'Basemap' }).click();
  const detailSummary = page.locator('details.trailmaker-max-detail-details > summary');
  await expect(detailSummary).toBeVisible({ timeout: 10_000 });
  await detailSummary.click();
  const detail = page.getByRole('region', { name: 'Maximum-detail imagery' });
  await expect(detail).toBeVisible();
  await detail.getByRole('button', { name: 'Draw detail boundary' }).click();
  // Capturing the base map creates georeference pins over this deliberately tiny test area.
  await page.addStyleTag({ content: '.georef-marker { pointer-events: none !important; }' });
  const canvas = page.locator('canvas.maplibregl-canvas').last();
  const box = await canvas.boundingBox();
  if (!box) throw new Error('Basemap canvas has no bounds');
  for (const [dx, dy] of [
    [-3, -3],
    [3, -3],
    [0, 3],
  ] as const) {
    await canvas.click({ position: { x: box.width / 2 + dx, y: box.height / 2 + dy } });
  }
  await detail.getByRole('button', { name: 'Finish boundary' }).click();
  const planText = await detail
    .getByRole('status')
    .filter({ hasText: /exports · approx/ })
    .textContent();
  const planned = Number((planText?.match(/([\d,]+) exports/)?.[1] ?? '').replaceAll(',', ''));
  expect(planned).toBeGreaterThan(0);
  expect(planned).toBeLessThanOrEqual(8);
  expect(exportsSeen).toHaveLength(0);

  await detail.getByRole('button', { name: 'Download maximum detail' }).click();
  await expect(
    detail.getByRole('status').filter({ hasText: `Exports: ${planned}/${planned}; missing: 0` }),
  ).toBeVisible({
    timeout: 75_000,
  });
  expect(exportsSeen).toHaveLength(planned);
  for (const url of exportsSeen) expectGlobalZ21Export(url);
  await expect(
    detail.getByRole('status').filter({ hasText: /detail tiles stored on this device/ }),
  ).not.toContainText('0 detail tiles');

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Save project' }).click(),
  ]);
  const archive = unzipSync(new Uint8Array(await readFile(await download.path())));
  expect(Object.keys(archive).some((path) => path.startsWith('tiles/-1/'))).toBe(true);
  expect(Object.keys(archive).some((path) => path.startsWith('tiles/0/'))).toBe(true);

  const compactDetail = page.locator('details.trailmaker-max-detail-details');
  if ((await compactDetail.getAttribute('open')) === null) {
    await compactDetail.locator('summary').click();
  }
  const after = page.getByRole('region', { name: 'Maximum-detail imagery' });
  await after.getByRole('button', { name: 'Delete detail imagery' }).click();
  await expect(
    after.getByRole('status').filter({ hasText: '0 detail tiles stored on this device.' }),
  ).toBeVisible();
  const remainingBaseTiles = await page.evaluate(async () => {
    const store = await import('/src/io/tile-store.ts' as string);
    const source = window.__trailmaker!.session.getSession()!.project.image.source;
    return (await store.listTileRecords(store.tiledMapStorageId(source))).filter(
      (record: { level: number }) => record.level === 0,
    ).length;
  });
  expect(remainingBaseTiles).toBeGreaterThan(0);
});
