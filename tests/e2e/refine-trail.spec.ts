import { expect, test } from './network-fixture';
import { IMAGERY_HOSTS, stubImagery } from './imagery-stubs';
import type { Px } from '../../src/core/types';

// T-327 acceptance (Integrator); gating since T-327 merged.
test.use({ stubbedHosts: IMAGERY_HOSTS });

type Page = Parameters<typeof stubImagery>[0];

const W = 600;
const H = 400;
/** The trail drawn into the synthetic map: a gentle wave from x=40 to x=560. */
const lineY = (x: number) => 200 + 18 * Math.sin(x / 70);
/** A shared junction vertex on the hand line, also the start of a second trail. */
const JUNCTION: Px = [300, Math.round(lineY(300)) + 5];

/** Opens a synthetic map with a dark wavy trail, a rough hand line 5 px off it, and a spur sharing a vertex. */
async function openSynthetic(page: Page, withFit: boolean) {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Trailmaker' })).toBeVisible();
  await page.waitForFunction(() => Boolean(window.__trailmaker));
  await page.evaluate(
    async ({ W, H, junction, withFit }) => {
      const lineY = (x: number) => 200 + 18 * Math.sin(x / 70);
      const canvas = document.createElement('canvas');
      canvas.width = W;
      canvas.height = H;
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = '#4f7a3a';
      ctx.fillRect(0, 0, W, H);
      ctx.strokeStyle = '#e8e0cc';
      ctx.lineWidth = 3;
      ctx.beginPath();
      for (let x = 40; x <= 560; x += 2)
        (x === 40 ? ctx.moveTo : ctx.lineTo).call(ctx, x, lineY(x));
      ctx.stroke();
      const hand: [number, number][] = [];
      for (let x = 40; x <= 560; x += 52) hand.push([x, Math.round(lineY(x)) + 5]);
      // Put the shared junction vertex into the hand line, in x order.
      const at = hand.findIndex((p) => p[0] > junction[0]);
      hand.splice(at, 0, [junction[0], junction[1]]);
      const meta = {
        fileName: 'refine.png',
        width: W,
        height: H,
        originalWidth: W,
        originalHeight: H,
        source: { kind: 'image' as const, mimeType: 'image/png' },
        sha256: '0'.repeat(64),
      };
      const anchors = withFit
        ? (
            [
              ['a1', [0, 0], [27.14, -80.18]],
              ['a2', [W, 0], [27.14, -80.174]],
              ['a3', [W, H], [27.1356, -80.174]],
              ['a4', [0, H], [27.1356, -80.18]],
            ] as const
          ).map(([id, px, ll]) => ({ id, px, ll, source: 'paste' as const }))
        : [];
      window.__trailmaker!.session.openSession({
        project: {
          version: 2,
          name: 'Refine',
          image: meta,
          anchors,
          fitMethod: 'auto',
          features: [
            {
              id: 't1',
              kind: 'trail',
              name: 'Rough trail',
              color: '#cc3030',
              notes: '',
              pts: hand,
              ink: null,
            },
            {
              id: 't2',
              kind: 'trail',
              name: 'Spur',
              color: '#3060cc',
              notes: '',
              pts: [
                [junction[0], junction[1]],
                [junction[0], 380],
              ],
              ink: null,
            },
          ],
          units: 'mi',
          trace: { smartFollow: false, tolerance: 60, ink: null },
          autoTrace: { chips: [], gapPx: 13, minLengthPct: 4 },
          seq: 3,
          updatedAt: '2026-10-04T00:00:00.000Z',
        },
        map: {
          meta,
          display: await createImageBitmap(canvas),
          raster: { width: W, height: H, data: ctx.getImageData(0, 0, W, H).data },
          original: new Blob([], { type: 'image/png' }),
          pdf: null,
        },
      } as never);
    },
    { W, H, junction: JUNCTION, withFit },
  );
}

const project = (page: Page) =>
  page.evaluate(() => window.__trailmaker!.session.getSession()!.project);
const trailPts = async (page: Page, id: string) =>
  ((await project(page)).features.find((f) => f.id === id) as unknown as { pts: Px[] }).pts;

async function selectTrail(page: Page, name: string) {
  await page
    .getByRole('list', { name: 'Traced features' })
    .getByText(name, { exact: true })
    .click();
  await expect(page.getByRole('group', { name: `Edit ${name}` })).toBeVisible();
}

async function refineSelected(page: Page) {
  await page
    .getByRole('group', { name: 'Edit Rough trail' })
    .getByRole('button', { name: 'Refine to map image' })
    .click();
  const preview = page.getByRole('region', { name: 'Refinement preview' });
  await expect(preview).toBeVisible({ timeout: 30_000 });
  return preview;
}

test('refine snaps a rough line onto the trail, keeps the junction, and applies as one undoable edit [T-327]', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await openSynthetic(page, false);
  const before = await project(page);
  const hand = await trailPts(page, 't1');
  await selectTrail(page, 'Rough trail');

  // Long tasks on the UI thread while the worker refines.
  await page.evaluate(() => {
    const w = window as Window & { __longTasks?: number[] };
    w.__longTasks = [];
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) w.__longTasks!.push(e.duration);
    }).observe({ type: 'longtask', buffered: false });
  });
  const preview = await refineSelected(page);
  const longTasks = await page.evaluate(
    () => (window as Window & { __longTasks?: number[] }).__longTasks ?? [],
  );
  console.log(`T-327 refine long tasks (ms): ${JSON.stringify(longTasks)}`);
  expect(Math.max(0, ...longTasks)).toBeLessThanOrEqual(50);

  await expect(
    preview.getByRole('checkbox', { name: /Use image path for section 1 / }),
  ).toBeVisible();
  await preview.getByRole('button', { name: 'Apply refinement' }).click();
  await expect(preview).toHaveCount(0);

  const refined = await trailPts(page, 't1');
  expect(refined).not.toEqual(hand);
  // Interior refined points sit on the drawn line (within 2 px), unlike the 5 px-off hand line.
  // Points within 8 px of the pinned junction (5 px off the line by design) are its connector.
  const interior = refined.filter(([x]) => x > 60 && x < 540 && Math.abs(x - JUNCTION[0]) > 8);
  expect(interior.length).toBeGreaterThan(5);
  // Simplified like smart follow (Douglas-Peucker 0.9 px), not one vertex per pixel.
  expect(refined.length).toBeLessThan(80);
  for (const [x, y] of interior) expect(Math.abs(y - lineY(x))).toBeLessThanOrEqual(2);
  // The shared junction vertex didn't move, so the spur still meets the trail.
  expect(refined).toContainEqual(JUNCTION);
  expect(await trailPts(page, 't2')).toEqual([JUNCTION, [JUNCTION[0], 380]]);

  // One Apply is one undo step, restored exactly.
  const after = await project(page);
  await page.keyboard.press('Control+z');
  await expect.poll(() => trailPts(page, 't1')).toEqual(hand);
  expect(await project(page)).toEqual(before);
  await page.keyboard.press('Control+Shift+z');
  await expect.poll(() => trailPts(page, 't1')).toEqual(refined);
  expect(await project(page)).toEqual(after);
});

test('rejecting the preview leaves the project byte-identical [T-327]', async ({ page }) => {
  test.setTimeout(90_000);
  await openSynthetic(page, false);
  const before = JSON.stringify(await project(page));
  await selectTrail(page, 'Rough trail');
  const preview = await refineSelected(page);
  await preview.getByRole('button', { name: 'Reject' }).click();
  await expect(preview).toHaveCount(0);
  expect(JSON.stringify(await project(page))).toBe(before);
});

test('Refine all trails reviews every trail and applies once [T-327]', async ({ page }) => {
  test.setTimeout(90_000);
  await openSynthetic(page, false);
  const hand = await trailPts(page, 't1');
  await page.getByRole('button', { name: 'Refine all trails' }).click();
  const preview = page.getByRole('region', { name: 'Refinement preview' });
  await expect(preview).toBeVisible({ timeout: 30_000 });
  await expect(preview.getByRole('group', { name: 'Rough trail' })).toBeVisible();
  await expect(preview.getByRole('group', { name: 'Spur' })).toBeVisible();
  await preview.getByRole('button', { name: 'Apply refinement' }).click();
  await expect.poll(() => trailPts(page, 't1')).not.toEqual(hand);
  await page.keyboard.press('Control+z');
  await expect.poll(() => trailPts(page, 't1')).toEqual(hand);
});

test('with the Esri backdrop on, refine reads only the map image and makes no Esri requests [T-327]', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const seen: string[] = [];
  await stubImagery(page, seen);
  await openSynthetic(page, true);
  await page.evaluate(async () => {
    const settings = await import('/src/io/settings.ts' as string);
    settings.updateBasemapSettings({ esriApiKey: 'TEST_ARCGIS_KEY_327' });
  });
  const esri = page
    .getByRole('group', { name: 'Editor backdrop controls' })
    .getByRole('button', { name: 'Esri (live)' });
  await esri.click();
  await expect(esri).toHaveAttribute('aria-pressed', 'true');
  const isEsri = (u: string) => u.includes('ibasemaps-api.arcgis.com');
  await expect.poll(() => seen.filter(isEsri).length, { timeout: 30_000 }).toBeGreaterThan(0);
  await page.waitForLoadState('networkidle');
  const esriBefore = seen.filter(isEsri).length;

  await selectTrail(page, 'Rough trail');
  const preview = await refineSelected(page);
  await expect(preview.getByRole('note')).toContainText(
    'Refining against the map image, not Esri.',
  );
  await preview.getByRole('button', { name: 'Apply refinement' }).click();
  await expect(preview).toHaveCount(0);
  expect(seen.filter(isEsri).length).toBe(esriBefore);
});
