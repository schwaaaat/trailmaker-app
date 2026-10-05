import { expect, type Page } from '@playwright/test';
import type { Px } from '../../src/core/types';
import type { FixtureTruth } from '../fixtures/truth';
import { openReadyApp } from './app-ready';

export async function openFixture(page: Page, path: string) {
  await openReadyApp(page);
  const openButton = page
    .getByRole('complementary', { name: 'Steps' })
    .getByRole('button', { name: 'Open image or PDF' });
  await expect(openButton).toBeVisible();
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), openButton.click()]);
  await chooser.setFiles(path);
  await expect
    .poll(() =>
      page.evaluate(() => window.__trailmaker!.session.getSession()?.project.image.fileName),
    )
    .toBe('solid');
}

export async function clickFixturePixel(page: Page, truth: FixtureTruth, px: Px) {
  const point = await page.evaluate(
    ({ px, width, height }) => {
      const image = window.__trailmaker!.session.getSession()!.project.image;
      return window.__trailmaker!.imageToClient([
        (px[0] * image.width) / width,
        (px[1] * image.height) / height,
      ]);
    },
    { px, width: truth.width, height: truth.height },
  );
  await page.mouse.click(point.x, point.y);
}

export async function placeFourAnchors(page: Page, truth: FixtureTruth) {
  await page.getByRole('button', { name: 'Add anchor' }).click();
  for (const [i, anchor] of truth.anchors.slice(0, 4).entries()) {
    await clickFixturePixel(page, truth, anchor.px);
    const input = page.getByRole('textbox', { name: `Coordinates for anchor ${i + 1}` });
    await expect(input).toBeVisible();
    await input.fill(`${anchor.ll![0]}, ${anchor.ll![1]}`);
    await input.press('Enter');
  }
  await expect
    .poll(() =>
      page.evaluate(
        () => window.__trailmaker!.session.getSession()!.project.anchors.filter((a) => a.ll).length,
      ),
    )
    .toBe(4);
}

/**
 * Start this test with a saved side-by-side layout (T-325 made Tabs the default for fresh
 * profiles). Seeds the pre-T-325 layout shape once per test, which loads as side by side; later
 * reloads see whatever the app saved.
 */
export async function pinSideBySide(page: Page) {
  await page.addInitScript(() => {
    if (sessionStorage.getItem('e2e-side-by-side-seeded')) return;
    localStorage.setItem(
      'trailmaker:splitLayout',
      JSON.stringify({ show: false, mode: 'pair', frac: 0.55 }),
    );
    sessionStorage.setItem('e2e-side-by-side-seeded', '1');
  });
}
