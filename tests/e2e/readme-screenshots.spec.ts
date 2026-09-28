import { readFile } from 'node:fs/promises';
import { expect, test } from './network-fixture';
import type { Px } from '../../src/core/types';
import { openReadyApp } from './app-ready';

/**
 * README walkthrough screenshots (T-005). Not part of the gate: runs only with README_SHOTS=1.
 *   README_SHOTS=1 pnpm exec playwright test readme-screenshots
 * Writes docs/screenshots/*.png from a public-domain NPS map (README_FIXTURE, default dickey-ridge).
 */
interface RealTruth {
  readonly anchors: readonly { readonly px: Px; readonly ll: readonly [number, number] }[];
  readonly trace: { readonly pts: readonly Px[] };
}

const NAME = process.env.README_FIXTURE ?? 'dickey-ridge';
const FIXTURE = `tests/fixtures/real/${NAME}`;
const OUT = 'docs/screenshots';

test.skip(!process.env.README_SHOTS, 'README screenshots run only with README_SHOTS=1');

test('README walkthrough screenshots', async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const truth = JSON.parse(await readFile(`${FIXTURE}.truth.json`, 'utf8')) as RealTruth;
  const steps = page.getByRole('complementary', { name: 'Steps' });
  const click = async (px: Px) => {
    const point = await page.evaluate((p) => window.__trailmaker!.imageToClient(p), px);
    await page.mouse.click(point.x, point.y);
  };

  await openReadyApp(page);

  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    steps.getByRole('button', { name: 'Open image or PDF' }).click(),
  ]);
  await chooser.setFiles(`${FIXTURE}.png`);
  await expect
    .poll(() => page.evaluate(() => window.__trailmaker!.session.getSession()?.project.image.fileName))
    .toBe(NAME);
  await page.screenshot({ path: `${OUT}/1-open.png` });

  await page.getByRole('button', { name: 'Add anchor' }).click();
  for (const [i, anchor] of truth.anchors.slice(0, 4).entries()) {
    await click(anchor.px);
    const input = page.getByRole('textbox', { name: `Coordinates for anchor ${i + 1}` });
    await expect(input).toBeVisible();
    await input.fill(`${anchor.ll[0]}, ${anchor.ll[1]}`);
    await input.press('Enter');
  }
  await expect
    .poll(() => page.evaluate(() => window.__trailmaker!.session.getSession()!.project.anchors.filter((a) => a.ll).length))
    .toBe(4);
  await page.screenshot({ path: `${OUT}/2-anchors.png` });

  await steps.getByRole('checkbox', { name: "Follow the line's color while tracing" }).check();
  await page.getByRole('toolbar', { name: 'Map tools' }).getByRole('button', { name: 'Trail', exact: true }).click();
  const pts = truth.trace.pts;
  for (const index of [0, Math.floor(pts.length / 3), Math.floor((2 * pts.length) / 3), pts.length - 1]) {
    await click(pts[index]!);
    await page.evaluate(() => window.__trailmaker!.idle());
  }
  await page.getByRole('group', { name: 'Drawing' }).getByRole('button', { name: /Finish trail/ }).click();
  await expect
    .poll(() => page.evaluate(() => window.__trailmaker!.session.getSession()!.project.features.filter((f) => f.kind === 'trail').length))
    .toBe(1);
  await page.screenshot({ path: `${OUT}/3-trace.png` });

  const kmz = steps.getByRole('button', { name: 'Download KMZ with map overlay' });
  await kmz.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${OUT}/4-export.png` });
});
