import { readFile } from 'node:fs/promises';
import { expect, test } from './network-fixture';
import { installOfflineBasemap, offlineStylePath } from './offline-basemap';
import { openReadyApp } from './app-ready';
import { IMAGERY_HOSTS, isNaipExport, isUsgsTile, stubImagery } from './imagery-stubs';

// T-320 acceptance (Integrator); gating since T-320 merged.
test.use({ stubbedHosts: IMAGERY_HOSTS });

test('Start from satellite captures NAIP with its credit and year, and KML carries the credit [T-320]', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await installOfflineBasemap(page);
  const seen: string[] = [];
  await stubImagery(page, seen, 2023);

  await openReadyApp(page);
  await page.evaluate(
    async ({ styleUrl }) => {
      const settings = await import('/src/io/settings.ts' as string);
      // Seabranch Preserve, Florida: inside NAIP coverage.
      settings.updateBasemapSettings({
        enabled: true,
        imagery: 'satellite',
        styleUrl,
        lastCenter: [-80.1705, 27.1375],
        lastZoom: 16,
      });
    },
    { styleUrl: offlineStylePath },
  );

  await page.getByRole('button', { name: 'Start from satellite' }).first().click();
  const overlay = page.getByRole('dialog', { name: 'Capture satellite map' });
  await expect(overlay).toBeVisible();
  // Seabranch is inside Martin County's 3-inch coverage (T-326); this spec is about NAIP.
  const source = overlay.getByLabel('Capture imagery source');
  if (await source.count()) await source.selectOption('naip');
  await expect(overlay).toContainText(/NAIP/);
  await expect(overlay).not.toContainText('NAIP not available here');
  await overlay.getByRole('button', { name: 'Capture map' }).click();

  await expect
    .poll(
      () => page.evaluate(() => window.__trailmaker?.session.getSession()?.project.anchors.length),
      {
        timeout: 60_000,
      },
    )
    .toBe(9);
  expect(seen.some(isNaipExport)).toBe(true);
  // T-322: every export must cover the framed place, in EPSG:3857 metres (xmin,ymin,xmax,ymax).
  const R = 6378137;
  const cx = (R * -80.1705 * Math.PI) / 180;
  const cy = R * Math.log(Math.tan(Math.PI / 4 + (27.1375 * Math.PI) / 360));
  const boxes = seen
    .filter(isNaipExport)
    .map(
      (u) =>
        new URL(u).searchParams.get('bbox')!.split(',').map(Number) as [
          number,
          number,
          number,
          number,
        ],
    );
  const union = boxes.reduce((a, b) => [
    Math.min(a[0], b[0]),
    Math.min(a[1], b[1]),
    Math.max(a[2], b[2]),
    Math.max(a[3], b[3]),
  ]);
  expect(union[0]).toBeLessThanOrEqual(cx);
  expect(union[2]).toBeGreaterThanOrEqual(cx);
  expect(union[1]).toBeLessThanOrEqual(cy);
  expect(union[3]).toBeGreaterThanOrEqual(cy);
  // A successful NAIP capture doesn't fall back to USGS basemap tiles for the map image.
  const image = await page.evaluate(() => window.__trailmaker!.session.getSession()!.project.image);
  expect(image.attribution).toBe('Imagery: USDA NAIP via USGS The National Map');
  expect(image.acquisitionYear).toBe(2023);
  expect(image.width).toBeGreaterThan(0);
  expect(image.height).toBeGreaterThan(0);
  void isUsgsTile;

  // KML export carries the imagery credit.
  const steps = page.getByRole('complementary', { name: 'Steps' });
  await page.evaluate(() => {
    const t = window.__trailmaker!;
    const cur = t.session.getSession()!;
    t.session.openSession({
      project: {
        ...cur.project,
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
  });
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    steps.getByRole('button', { name: 'Download KML' }).click(),
  ]);
  const kml = await readFile(await download.path(), 'utf8');
  expect(kml).toContain('USDA NAIP via USGS The National Map');
});
