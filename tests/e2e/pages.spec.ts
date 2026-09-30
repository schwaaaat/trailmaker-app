import { readFile } from 'node:fs/promises';
import { expect, test } from './network-fixture';
import { clickFixturePixel } from './golden-helpers';
import type { FixtureTruth } from '../fixtures/truth';
import { validateGpx } from '../metrics/xml';

test('GitHub Pages subpath installs, isolates, works offline, and exports GPX', async ({
  page,
  context,
}) => {
  test.setTimeout(90_000);
  const base = '/trailmaker-app/';
  await page.goto(base);
  await expect(page.getByRole('heading', { name: 'Trailmaker', exact: true })).toBeVisible();
  await page.waitForFunction(
    () => crossOriginIsolated && Boolean(navigator.serviceWorker.controller),
  );
  const pwa = await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    return { scope: registration.scope, controller: Boolean(navigator.serviceWorker.controller) };
  });
  if (!pwa) throw new Error('PWA service worker did not control an isolated Pages build');
  expect(new URL(pwa.scope).pathname).toBe(base);
  expect(pwa.controller).toBe(true);

  const manifest = await page.evaluate(async () => {
    const link = document.querySelector<HTMLLinkElement>('link[rel="manifest"]');
    if (!link) return null;
    const response = await fetch(link.href);
    const value = (await response.json()) as {
      start_url: string;
      scope: string;
      icons: Array<{ src: string }>;
    };
    return {
      href: new URL(link.href).pathname,
      start_url: value.start_url,
      scope: value.scope,
      icons: value.icons,
    };
  });
  expect(manifest?.href.startsWith(base)).toBe(true);
  expect(manifest?.start_url).toBe(base);
  expect(manifest?.scope).toBe(base);
  expect(manifest?.icons.every((icon) => icon.src.startsWith(base))).toBe(true);

  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Trailmaker', exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => crossOriginIsolated)).toBe(true);
  expect(await page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);

  const truth = JSON.parse(
    await readFile('tests/fixtures/generated/solid.truth.json', 'utf8'),
  ) as FixtureTruth;
  const openButton = page
    .getByRole('complementary', { name: 'Steps' })
    .getByRole('button', { name: 'Open image or PDF' });
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), openButton.click()]);
  await chooser.setFiles('tests/fixtures/generated/solid.png');
  await expect
    .poll(() =>
      page.evaluate(() => window.__trailmaker!.session.getSession()?.project.image.fileName),
    )
    .toBe('solid');
  await page.getByRole('button', { name: 'Add anchor' }).click();
  for (const [index, anchor] of truth.anchors.slice(0, 4).entries()) {
    await clickFixturePixel(page, truth, anchor.px);
    const input = page.getByRole('textbox', { name: `Coordinates for anchor ${index + 1}` });
    await input.fill(`${anchor.ll![0]}, ${anchor.ll![1]}`);
    await input.press('Enter');
  }
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.__trailmaker!.session.getSession()!.project.anchors.filter((anchor) => anchor.ll)
            .length,
      ),
    )
    .toBe(4);

  const redTrail = truth.polylines.find((line) => line.id === 'red-ridge')!;
  await page
    .getByRole('toolbar', { name: 'Map tools' })
    .getByRole('button', { name: 'Trail', exact: true })
    .click();
  for (const index of [0, 32, redTrail.pts.length - 1])
    await clickFixturePixel(page, truth, redTrail.pts[index]!);
  const steps = page.getByRole('complementary', { name: 'Steps' });
  await page
    .getByRole('group', { name: 'Drawing' })
    .getByRole('button', { name: /Finish trail/ })
    .click();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    steps.getByRole('button', { name: 'Download GPX' }).click(),
  ]);
  expect(validateGpx(await readFile(await download.path(), 'utf8'))).toBe(true);
});
