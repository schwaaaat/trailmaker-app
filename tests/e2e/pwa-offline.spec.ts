import { readFile } from 'node:fs/promises';
import { expect, test } from './network-fixture';
import { clickFixturePixel, openFixture, placeFourAnchors } from './golden-helpers';
import type { FixtureTruth } from '../fixtures/truth';
import { validateGpx } from '../metrics/xml';

test('production app reloads offline and can trace and export a PNG project', async ({ page, context }) => {
  test.setTimeout(90_000);
  const external: string[] = [];
  context.on('request', (request) => {
    const url = new URL(request.url());
    if (/^https?:$/.test(url.protocol) && url.hostname !== '127.0.0.1') external.push(request.url());
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Trailmaker', exact: true })).toBeVisible();
  await page.waitForFunction(() => navigator.serviceWorker?.controller !== null);
  await expect.poll(() => page.evaluate(() => crossOriginIsolated)).toBe(true);

  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Trailmaker', exact: true })).toBeVisible();
  await page.waitForFunction(() => Boolean(window.__trailmaker));
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
  expect(await page.evaluate(() => typeof SharedArrayBuffer)).toBe('function');
  await expect.poll(() => page.workers().some((worker) => worker.url().includes('worker'))).toBe(true);

  const truth = JSON.parse(await readFile('tests/fixtures/generated/solid.truth.json', 'utf8')) as FixtureTruth;
  await openFixture(page, 'tests/fixtures/generated/solid.png');
  await placeFourAnchors(page, truth);
  const red = truth.polylines.find((line) => line.id === 'red-ridge')!;
  const steps = page.getByRole('complementary', { name: 'Steps' });
  await page.getByRole('toolbar', { name: 'Map tools' }).getByRole('button', { name: 'Trail', exact: true }).click();
  for (const index of [0, 32, red.pts.length - 1]) {
    await clickFixturePixel(page, truth, red.pts[index]!);
  }
  await page.getByRole('group', { name: 'Drawing' }).getByRole('button', { name: /Finish trail/ }).click();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    steps.getByRole('button', { name: 'Download GPX' }).click(),
  ]);
  expect(validateGpx(await readFile(await download.path(), 'utf8'))).toBe(true);
  expect(external).toEqual([]);
});
