import { readFile } from 'node:fs/promises';
import { expect, test } from './network-fixture';
import { unzipSync, strFromU8 } from 'fflate';
import type { FixtureTruth } from '../fixtures/truth';
import { parseKml } from '../metrics/xml';
import { clickFixturePixel, openFixture, placeFourAnchors } from './golden-helpers';

test('golden 2: PDF page 2, two-color auto-trace and KMZ with KML and image', async ({ page }) => {
  test.setTimeout(90_000);
  const truth = JSON.parse(await readFile('tests/fixtures/generated/solid.truth.json', 'utf8')) as FixtureTruth;
  await openFixture(page, 'tests/fixtures/generated/solid.pdf');
  await page.getByRole('combobox', { name: 'Page' }).selectOption('2');
  await expect.poll(() => page.evaluate(() => window.__trailmaker!.session.getSession()!.project.image.source)).toMatchObject({ kind: 'pdf', page: 2 });
  await placeFourAnchors(page, truth);
  const steps = page.getByRole('complementary', { name: 'Steps' });
  for (const id of ['red-ridge', 'blue-creek']) {
    const line = truth.polylines.find((item) => item.id === id)!;
    await steps.getByRole('button', { name: 'Pick color from map' }).click();
    await clickFixturePixel(page, truth, line.pts[Math.floor(line.pts.length / 2)]!);
    await expect.poll(() => page.evaluate(() => window.__trailmaker!.session.getSession()!.project.autoTrace.chips.length)).toBe(id === 'red-ridge' ? 1 : 2);
  }
  await steps.getByRole('button', { name: 'Find trails', exact: true }).click();
  await page.evaluate(() => window.__trailmaker!.idle());
  const found = page.getByRole('group', { name: 'Found lines' });
  await expect(found).toBeVisible();
  await expect(found.locator('input[type="checkbox"]')).toHaveCount(2);
  await found.getByRole('button', { name: 'Add 2 as trails' }).click();
  await expect.poll(() => page.evaluate(() => window.__trailmaker!.session.getSession()!.project.features.filter((f) => f.kind === 'trail').length)).toBe(2);
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    steps.getByRole('button', { name: 'Download KMZ with map overlay' }).click(),
  ]);
  const zip = unzipSync(new Uint8Array(await readFile(await download.path())));
  expect(Object.keys(zip)).toContain('doc.kml');
  const image = zip['files/map.jpg'];
  expect(image).toBeDefined();
  expect([...image!.slice(0, 2)]).toEqual([0xff, 0xd8]);
  const kml = strFromU8(zip['doc.kml']!);
  expect(kml).toContain('<GroundOverlay>');
  expect(kml).toContain('files/map.jpg');
  expect(parseKml(kml).filter((line) => line.length > 2).length).toBeGreaterThanOrEqual(2);
});
