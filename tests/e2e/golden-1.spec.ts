import { readFile } from 'node:fs/promises';
import { expect, test } from './network-fixture';
import type { LatLon } from '../../src/core/types';
import { pixelToLatLon, type FixtureTruth } from '../fixtures/truth';
import { hausdorffMeters } from '../metrics/geometry';
import { validateGpx } from '../metrics/xml';
import { clickFixturePixel, openFixture, placeFourAnchors } from './golden-helpers';

test('golden 1: PNG, four pasted anchors, smart trail, POI and XSD-valid GPX within 5 m', async ({ page }) => {
  test.setTimeout(60_000);
  const truth = JSON.parse(await readFile('tests/fixtures/generated/solid.truth.json', 'utf8')) as FixtureTruth;
  await openFixture(page, 'tests/fixtures/generated/solid.png');
  await placeFourAnchors(page, truth);
  const red = truth.polylines.find((line) => line.id === 'red-ridge')!;
  const steps = page.getByRole('complementary', { name: 'Steps' });
  await steps.getByRole('checkbox', { name: "Follow the line's color while tracing" }).check();
  await page.getByRole('toolbar', { name: 'Map tools' }).getByRole('button', { name: 'Trail', exact: true }).click();
  for (const index of [0, 21, 43, 65, red.pts.length - 1]) {
    await clickFixturePixel(page, truth, red.pts[index]!);
    await page.evaluate(() => window.__trailmaker!.idle());
  }
  await page.getByRole('group', { name: 'Drawing' }).getByRole('button', { name: /Finish trail/ }).click();
  await expect.poll(() => page.evaluate(() => window.__trailmaker!.session.getSession()!.project.features.filter((f) => f.kind === 'trail').length)).toBe(1);
  await page.getByRole('toolbar', { name: 'Map tools' }).getByRole('button', { name: 'Point' }).click();
  await clickFixturePixel(page, truth, truth.pois[0]!.px);
  await page.getByRole('group', { name: /Edit Point/ }).getByRole('combobox', { name: 'Type' }).selectOption('Trailhead');
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    steps.getByRole('button', { name: 'Download GPX' }).click(),
  ]);
  const xml = await readFile(await download.path(), 'utf8');
  expect(validateGpx(xml)).toBe(true);
  const track: LatLon[] = [...xml.matchAll(/<trkpt\s+lat="([^"]+)"\s+lon="([^"]+)"/g)].map((m) => [Number(m[1]), Number(m[2])]);
  expect(track.length).toBeGreaterThan(2);
  const expected = red.pts.map((px) => pixelToLatLon(px, truth.transform));
  const errorM = hausdorffMeters(track, expected, 0.25);
  console.info(`Golden 1 GPX Hausdorff: ${errorM.toFixed(2)} m`);
  expect(errorM + 0.125).toBeLessThanOrEqual(5);
  expect(xml).toMatch(/<wpt\s+lat="[^"]+"\s+lon="[^"]+"/);
  expect(xml).toContain('<sym>Trailhead</sym>');
});
