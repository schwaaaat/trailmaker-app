import { readFile } from 'node:fs/promises';
import { expect, test } from './network-fixture';
import type { FixtureTruth } from '../fixtures/truth';
import { clickFixturePixel, openFixture, placeFourAnchors } from './golden-helpers';
import { IMAGERY_HOSTS, isEsriTile, stubImagery } from './imagery-stubs';

// T-324 acceptance (Integrator); gating since T-324 merged. No live network: every imagery host is stubbed.
test.use({ stubbedHosts: IMAGERY_HOSTS });

type Page = Parameters<typeof openFixture>[0];

const KEY = 'TEST_ARCGIS_KEY_324';
const ESRI_CREDIT = 'Esri, Vantor, Earthstar Geographics, and the GIS User Community';

async function setEsriKey(page: Page, esriApiKey: string) {
  await page.evaluate(async (esriApiKey) => {
    const settings = await import('/src/io/settings.ts' as string);
    settings.updateBasemapSettings({ esriApiKey });
  }, esriApiKey);
}

async function openGeoreferenced(page: Page, seen: string[]) {
  await stubImagery(page, seen);
  const truth = JSON.parse(
    await readFile('tests/fixtures/generated/solid.truth.json', 'utf8'),
  ) as FixtureTruth;
  await openFixture(page, 'tests/fixtures/generated/solid.png');
  await placeFourAnchors(page, truth);
  return truth;
}

const backdrop = (page: Page) => page.getByRole('group', { name: 'Editor backdrop controls' });

test('Esri backdrop: keyed tiles, credit, manual trace, and nothing Esri leaves the session [T-324]', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const seen: string[] = [];
  const truth = await openGeoreferenced(page, seen);
  await setEsriKey(page, KEY);

  const esri = backdrop(page).getByRole('button', { name: 'Esri (live)' });
  await expect(esri).toBeEnabled();
  await esri.click();
  await expect(esri).toHaveAttribute('aria-pressed', 'true');

  // Tiles go to the documented host with token=<key>, and the exact credit is on screen.
  await expect.poll(() => seen.filter(isEsriTile).length, { timeout: 30_000 }).toBeGreaterThan(0);
  for (const u of seen.filter(isEsriTile)) expect(new URL(u).searchParams.get('token')).toBe(KEY);
  await expect(page.getByRole('note').filter({ hasText: ESRI_CREDIT })).toBeVisible();
  await expect(
    backdrop(page).getByRole('slider', { name: 'Map image opacity over Esri' }),
  ).toBeVisible();

  // Render 64 actual decoded 256x256 tiles in one Editor frame and retain its CPU frame metric.
  const tilePath = new URL(seen.find(isEsriTile)!).pathname.match(/\/tile\/(\d+)\/(\d+)\/(\d+)$/)!;
  const tileCoord = { z: Number(tilePath[1]), y: Number(tilePath[2]), x: Number(tilePath[3]) };
  const frameMs = await page.evaluate(async ({ z, x, y }) => {
    const stagePath: string = '/src/ui/editor/EditorStage.tsx';
    const statePath: string = '/src/state/store.ts';
    const [{ currentEditor }, state] = await Promise.all([import(stagePath), import(statePath)]);
    const editor = currentEditor() as unknown as {
      renderNow(): void;
      lastFrameMs: number;
      drawEsri: (ctx: CanvasRenderingContext2D) => void;
      drawEsriTile: (...args: unknown[]) => void;
    } | null;
    const fit = state.selectFit(state.appStore.getState());
    if (!editor || !fit?.ok) throw new Error('Editor fit is unavailable for the tile render probe');
    const tileCanvas = new OffscreenCanvas(256, 256);
    const tileContext = tileCanvas.getContext('2d');
    if (!tileContext) throw new Error('OffscreenCanvas 2D context unavailable');
    tileContext.fillStyle = '#3684c6';
    tileContext.fillRect(0, 0, 256, 256);
    const bitmaps = await Promise.all(
      Array.from({ length: 64 }, () => createImageBitmap(tileCanvas)),
    );
    const previous = editor.drawEsri;
    editor.drawEsri = (ctx) => {
      for (const bitmap of bitmaps) editor.drawEsriTile(ctx, fit, { z, x, y }, bitmap);
    };
    try {
      editor.renderNow();
      return editor.lastFrameMs;
    } finally {
      editor.drawEsri = previous;
      bitmaps.forEach((bitmap) => bitmap.close());
    }
  }, tileCoord);
  console.log(`T-324 renderNow with 64 real 256px tiles: ${frameMs.toFixed(2)} ms`);
  expect(frameMs).toBeLessThan(16);

  // Pixel tools read the map image, so they are off over Esri (D-036 item 3).
  const steps = page.getByRole('complementary', { name: 'Steps' });
  await expect(
    steps.getByText(/switch the backdrop to Map to use smart follow or color pick/),
  ).toBeVisible();

  // Manual trail over Esri.
  await page
    .getByRole('toolbar', { name: 'Map tools' })
    .getByRole('button', { name: 'Trail', exact: true })
    .click();
  const red = truth.polylines.find((line) => line.id === 'red-ridge')!;
  const picks = [0, Math.floor(red.pts.length / 2), red.pts.length - 1].map((i) => red.pts[i]!);
  for (const px of [...picks, picks[2]!]) await clickFixturePixel(page, truth, px);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window
            .__trailmaker!.session.getSession()!
            .project.features.filter((f) => f.kind === 'trail').length,
      ),
    )
    .toBe(1);

  // Nothing Esri reaches the project or the exports.
  const projectJson = await page.evaluate(() =>
    JSON.stringify(window.__trailmaker!.session.getSession()!.project),
  );
  for (const needle of [KEY, 'arcgis', 'Esri']) expect(projectJson).not.toContain(needle);
  for (const name of ['Download GPX', 'Download KML', 'Download GeoJSON']) {
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      steps.getByRole('button', { name }).click(),
    ]);
    const text = await readFile((await download.path())!, 'utf8');
    expect(text, name).not.toContain(KEY);
    expect(text, name).not.toContain('arcgis');
  }

  // Tiles are never written to Cache Storage.
  const cached = await page.evaluate(async () => {
    const urls: string[] = [];
    for (const key of await caches.keys())
      for (const req of await (await caches.open(key)).keys()) urls.push(req.url);
    return urls;
  });
  expect(cached.filter((u) => u.includes('arcgis'))).toEqual([]);
});

test('Esri backdrop is disabled without a key and drops back to Map when the key is removed [T-324]', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const seen: string[] = [];
  await openGeoreferenced(page, seen);

  const esri = backdrop(page).getByRole('button', { name: 'Esri (live)' });
  await expect(esri).toBeDisabled();
  await expect(backdrop(page)).toContainText('Add an Esri API key');

  await setEsriKey(page, KEY);
  await expect(esri).toBeEnabled();
  await esri.click();
  await expect(esri).toHaveAttribute('aria-pressed', 'true');

  await setEsriKey(page, '');
  await expect(backdrop(page).getByRole('button', { name: 'Map', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.getByRole('note').filter({ hasText: ESRI_CREDIT })).toHaveCount(0);
});
