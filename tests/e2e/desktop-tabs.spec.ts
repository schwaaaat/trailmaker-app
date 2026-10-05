import { readFile } from 'node:fs/promises';
import { pixelToLatLon, type FixtureTruth } from '../fixtures/truth';
import { expect, test } from './network-fixture';
import { openReadyApp } from './app-ready';
import { clickFixturePixel, openFixture } from './golden-helpers';
import { installOfflineBasemap, offlineStylePath } from './offline-basemap';

// T-325 acceptance (Integrator); gating since T-325 merged.

type Page = Parameters<typeof openFixture>[0];

const CENTER: readonly [lon: number, lat: number] = [-78.395, 38.597];
const ZOOM = 14;

async function openWithBasemap(page: Page) {
  await installOfflineBasemap(page);
  await openFixture(page, 'tests/fixtures/generated/solid.png');
  await page.evaluate(
    async ({ styleUrl, center, zoom }) => {
      const settingsPath: string = '/src/io/settings.ts';
      const settings = await import(settingsPath);
      settings.updateBasemapSettings({
        enabled: false,
        styleUrl,
        lastCenter: center,
        lastZoom: zoom,
      });
    },
    { styleUrl: offlineStylePath, center: CENTER, zoom: ZOOM },
  );
  await page.getByRole('button', { name: 'Enable basemap' }).click();
  await page.getByRole('button', { name: 'Show basemap' }).click();
  // In Tabs, Show basemap opens the Basemap tab (T-325 review 1); load it, then return to Map.
  const tabs = page.getByRole('tablist', { name: 'Map stage view' });
  await expect(tabs.getByRole('tab', { name: 'Basemap', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(
    page.getByRole('region', { name: 'Basemap', exact: true }).locator('canvas.maplibregl-canvas'),
  ).toBeVisible();
  await tabs.getByRole('tab', { name: 'Map', exact: true }).click();
}

const stageLayout = (page: Page) => page.getByRole('group', { name: 'Stage layout' });
const stageTabs = (page: Page) => page.getByRole('tablist', { name: 'Map stage view' });
const editorCanvas = (page: Page) =>
  page.getByRole('region', { name: 'Park map' }).locator('canvas').first();

async function canvasWidth(page: Page): Promise<number> {
  const box = await editorCanvas(page).boundingBox();
  if (!box) throw new Error('Editor canvas not laid out');
  return box.width;
}

for (const height of [1080, 1200]) {
  test(`fresh profile at 1920x${height}: Tabs by default, full-width canvas, collapsible steps [T-325]`, async ({
    page,
  }, testInfo) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: 1920, height });
    await openWithBasemap(page);

    await expect(stageLayout(page).getByRole('button', { name: 'Tabs' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(stageTabs(page).getByRole('tab', { name: 'Map', exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    );

    const header = await page.locator('.app-header').boundingBox();
    expect(header!.height).toBeLessThanOrEqual(48);

    await expect.poll(() => canvasWidth(page)).toBeGreaterThanOrEqual(1520);
    await page.screenshot({ path: testInfo.outputPath(`tabs-expanded-1920x${height}.png`) });

    await page.getByRole('button', { name: 'Collapse steps panel' }).click();
    await expect.poll(() => canvasWidth(page)).toBeGreaterThanOrEqual(1840);
    await page.screenshot({ path: testInfo.outputPath(`tabs-collapsed-1920x${height}.png`) });

    // Clicking a step on the rail expands the panel at that step.
    await page
      .getByRole('button', { name: /^Expand steps at / })
      .first()
      .click();
    await expect(page.getByRole('button', { name: 'Collapse steps panel' })).toBeVisible();

    // The keyboard shortcut toggles it too.
    await page.locator('body').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('Backslash');
    await expect(page.getByRole('button', { name: 'Collapse steps panel' })).toHaveCount(0);
    await page.keyboard.press('Backslash');
    await expect(page.getByRole('button', { name: 'Collapse steps panel' })).toBeVisible();
  });
}

test('mode and collapsed panel persist across reload [T-325]', async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1920, height: 1080 });
  await openWithBasemap(page);
  await page.getByRole('button', { name: 'Collapse steps panel' }).click();
  await stageLayout(page).getByRole('button', { name: 'Side by side' }).click();
  await expect(stageLayout(page).getByRole('button', { name: 'Side by side' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  await openReadyApp(page);
  const stored = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('trailmaker:splitLayout') ?? '{}'),
  );
  expect(stored).toMatchObject({ stageMode: 'side-by-side', stepsCollapsed: true });
  await expect(page.getByRole('button', { name: 'Collapse steps panel' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Expand steps at / }).first()).toBeVisible();
});

test('a saved layout from before T-325 loads as side by side [T-325]', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('t325-seeded')) {
      localStorage.setItem(
        'trailmaker:splitLayout',
        JSON.stringify({ show: true, mode: 'pair', frac: 0.55 }),
      );
      sessionStorage.setItem('t325-seeded', '1');
    }
  });
  await installOfflineBasemap(page);
  await openFixture(page, 'tests/fixtures/generated/solid.png');
  await expect(stageLayout(page).getByRole('button', { name: 'Side by side' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(stageTabs(page)).toHaveCount(0);
});

test('in Tabs, an anchor pair goes Map -> Basemap -> Map on its own and fits [T-325]', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1920, height: 1080 });
  const truth = JSON.parse(
    await readFile('tests/fixtures/generated/solid.truth.json', 'utf8'),
  ) as FixtureTruth;
  await openWithBasemap(page);
  const mapTab = stageTabs(page).getByRole('tab', { name: 'Map', exact: true });
  const basemapTab = stageTabs(page).getByRole('tab', { name: 'Basemap', exact: true });
  await expect(mapTab).toHaveAttribute('aria-selected', 'true');

  const toolbar = page.getByRole('toolbar', { name: 'Map tools' });
  const chosen = (
    [
      [120, 120],
      [500, 480],
    ] as const
  ).map((px) => ({ px, ll: pixelToLatLon(px, truth.transform) }));
  for (const [index, anchor] of chosen.entries()) {
    await toolbar.getByRole('button', { name: 'Anchor', exact: true }).click();
    await clickFixturePixel(page, truth, anchor.px);
    await expect(basemapTab).toHaveAttribute('aria-selected', 'true');
    const pane = page.getByRole('region', { name: 'Basemap', exact: true });
    await expect(pane.getByText('Now click the same spot on the basemap')).toBeVisible();
    const canvas = pane.locator('canvas.maplibregl-canvas');
    await expect(canvas).toBeVisible();
    // The basemap must have resized to the revealed tab before we project onto it.
    await expect.poll(async () => (await canvas.boundingBox())?.width ?? 0).toBeGreaterThan(1000);

    const point = await canvas.evaluate((el, ll) => {
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
      const rect = el.getBoundingClientRect();
      return {
        x: rect.left + rect.width / 2 + target.x - center.x,
        y: rect.top + rect.height / 2 + target.y - center.y,
      };
    }, anchor.ll);
    await page.mouse.click(point.x, point.y);
    await expect
      .poll(() =>
        page.evaluate((n) => {
          const anchors = window.__trailmaker!.session.getSession()!.project.anchors;
          return anchors.length === n && anchors[n - 1]?.source === 'basemap';
        }, index + 1),
      )
      .toBe(true);
    await expect(mapTab).toHaveAttribute('aria-selected', 'true');
  }
});
