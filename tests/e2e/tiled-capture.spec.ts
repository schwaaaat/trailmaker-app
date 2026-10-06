import { readFile } from 'node:fs/promises';
import { unzipSync } from 'fflate';
import { expect, test } from './network-fixture';
import { openReadyApp } from './app-ready';
import { installOfflineBasemap, offlineStylePath } from './offline-basemap';
import { IMAGERY_HOSTS, TILE_PNG, stubImagery } from './imagery-stubs';

// T-329 acceptance (Integrator): all imagery requests use local stubs.
test.use({ stubbedHosts: IMAGERY_HOSTS });

type Page = Parameters<typeof openReadyApp>[0];
const MARTIN = 'https://geoweb.martin.fl.us/arcgis/rest/services/Imagery/MC_Imagery/MapServer';
const SEABRANCH: readonly [lon: number, lat: number] = [-80.1705, 27.1375];
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Cross-Origin-Resource-Policy': 'cross-origin',
};

async function stubTiledService(page: Page, seen: string[]) {
  await stubImagery(page, seen);
  await page.route('https://geoweb.martin.fl.us/**', async (route) => {
    const url = route.request().url();
    seen.push(url);
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
    if (/\/MapServer\/tile\/21\/(?:884239)\/(?:581540|581541)$/.test(parsed.pathname)) {
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

async function openTiledCapture(page: Page) {
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
  return overlay;
}

async function drawBoundary(page: Page) {
  const overlay = await openTiledCapture(page);
  await overlay.getByRole('button', { name: 'Draw tiled boundary' }).click();
  await expect(overlay.getByRole('heading', { name: 'Draw park boundary' })).toBeVisible();
  const canvas = page.locator('canvas.maplibregl-canvas').last();
  await expect(canvas).toBeVisible();
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
  await expect(
    overlay.getByRole('group', { name: 'Park boundary points' }).getByRole('button', { name: /^Point \d/ }),
  ).toHaveCount(4);
  await overlay.getByRole('button', { name: 'Close boundary' }).click();
  await expect(overlay.getByLabel('Tile detail')).toHaveValue('20');
  await expect(overlay.getByText(/\d+ tiles/)).toBeVisible();
  await overlay.getByRole('button', { name: 'Estimate download' }).click();
  await expect(overlay.getByRole('status').filter({ hasText: /About .* MB/ })).toBeVisible();
  return overlay;
}

const tileUrls = (seen: string[]) => seen.filter((url) => url.startsWith(`${MARTIN}/tile/`));

test('draw, estimate, download, save, and reopen a tiled map offline [T-329]', async ({ page }) => {
  test.setTimeout(120_000);
  const seen: string[] = [];
  await stubTiledService(page, seen);
  const overlay = await drawBoundary(page);
  await overlay.getByRole('button', { name: 'Download offline tiles' }).click();
  await expect.poll(() => page.evaluate(() => window.__trailmaker?.session.getSession()?.project.image.source.kind ?? null), { timeout: 60_000 }).toBe('tiles');
  const before = await page.evaluate(() => {
    const session = window.__trailmaker!.session.getSession()!;
    return { project: session.project, levels: session.map.tiles?.levels.length ?? 0 };
  });
  expect(before.project.image.source.kind).toBe('tiles');
  expect(before.levels).toBeGreaterThan(0);
  expect(before.project.image.acquisitionYear).toBe(2026);
  expect(before.project.image.attribution).toContain('GPI Geospatial');
  expect(tileUrls(seen).length).toBeGreaterThan(0);

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Save project' }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/\.trailmaker$/);
  const archive = unzipSync(new Uint8Array(await readFile(await download.path())));
  expect(Object.keys(archive)).toContain('project.json');
  expect(Object.keys(archive).some((path) => path.startsWith('tiles/'))).toBe(true);
  expect(JSON.parse(new TextDecoder().decode(archive['project.json']!)).version).toBe(4);

  await expect.poll(() => page.evaluate(async () => {
    const { readAutosave } = await import('/src/io/autosave.ts' as string);
    return (await readAutosave())?.project.image.source.kind ?? null;
  })).toBe('tiles');
  const fetchedBeforeReload = tileUrls(seen).length;
  await openReadyApp(page);
  await page.getByRole('button', { name: /^Resume / }).click();
  await expect.poll(() => page.evaluate(() => window.__trailmaker?.session.getSession()?.project.image.source.kind ?? null)).toBe('tiles');
  expect(await page.evaluate(() => window.__trailmaker!.session.getSession()!.map.tiles?.levels.length ?? 0)).toBeGreaterThan(0);
  expect(tileUrls(seen).length).toBe(fetchedBeforeReload);
});

test('a paused tile download resumes after reload without refetching saved tiles [T-329]', async ({ page }) => {
  test.setTimeout(120_000);
  const seen: string[] = [];
  await stubTiledService(page, seen);
  const overlay = await drawBoundary(page);
  await overlay.getByRole('button', { name: 'Download offline tiles' }).click();
  await overlay.getByRole('button', { name: 'Pause download' }).click();
  await expect(overlay.getByRole('button', { name: 'Resume download' })).toBeVisible();
  const completedKeys = await page.evaluate(async () => {
    const { listResumableTileDownloads } = await import('/src/io/tile-store.ts' as string);
    return (await listResumableTileDownloads())[0]?.completedKeys ?? [];
  });
  expect(completedKeys.length).toBeGreaterThan(0);
  const fetchedBeforeReload = tileUrls(seen).length;
  await openReadyApp(page);
  await page.getByRole('button', { name: 'Start from satellite' }).first().click();
  const resumed = page.getByRole('dialog', { name: 'Capture satellite map' });
  await resumed.getByRole('button', { name: /Resume saved z20 download/ }).click();
  await resumed.getByRole('button', { name: 'Download offline tiles' }).click();
  await expect.poll(() => page.evaluate(() => window.__trailmaker?.session.getSession()?.project.image.source.kind ?? null), { timeout: 60_000 }).toBe('tiles');
  const later = tileUrls(seen).slice(fetchedBeforeReload);
  for (const key of completedKeys) {
    const [z, x, y] = key.split('/');
    expect(later.some((url) => url.endsWith(`/tile/${z}/${y}/${x}`))).toBe(false);
  }
});

test('deleting and re-downloading tiles keeps the edited project [T-329]', async ({ page }) => {
  test.setTimeout(120_000);
  const seen: string[] = [];
  await stubTiledService(page, seen);
  const initialOverlay = await drawBoundary(page);
  await initialOverlay.getByRole('button', { name: 'Download offline tiles' }).click();
  await expect.poll(() => page.evaluate(() => window.__trailmaker?.session.getSession()?.map.tiles?.levels.length ?? 0), { timeout: 60_000 }).toBeGreaterThan(0);

  const before = await page.evaluate(() => {
    const bridge = window.__trailmaker!.session;
    const current = bridge.getSession()!;
    bridge.openSession({
      ...current,
      project: {
        ...current.project,
        name: 'Edited tiled project',
        units: 'km',
        features: [
          ...current.project.features,
          {
            id: 'saved-test-trail',
            kind: 'trail' as const,
            name: 'Saved trail',
            color: '#D9480F',
            notes: 'Keep across tile refresh',
            pts: [[100, 100], [200, 200]] as const,
            ink: null,
          },
        ],
      },
    });
    return bridge.getSession()!.project;
  });

  await page.getByRole('button', { name: 'Start from satellite' }).first().click();
  const overlay = page.getByRole('dialog', { name: 'Capture satellite map' });
  await expect(overlay).toBeVisible();
  await overlay.getByRole('button', { name: 'Delete downloaded imagery' }).click();
  await expect(overlay.getByRole('button', { name: 'Re-download offline tiles' })).toBeVisible();
  await overlay.getByRole('button', { name: 'Re-download offline tiles' }).click();
  await expect(overlay.getByRole('button', { name: 'Download offline tiles', exact: true })).toBeVisible();
  await overlay.getByRole('button', { name: 'Download offline tiles', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__trailmaker?.session.getSession()?.map.tiles?.levels.length ?? 0), { timeout: 60_000 }).toBeGreaterThan(0);
  const after = await page.evaluate(() => window.__trailmaker!.session.getSession()!.project);
  expect(after).toEqual(before);
});
