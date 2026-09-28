import { expect, type Page } from '@playwright/test';

/** Wait for Vite's first-load dependency pass and any resulting reload before page.evaluate. */
export async function openReadyApp(page: Page) {
  const response = await page.goto('/', { waitUntil: 'networkidle' });
  await expect(page.getByRole('heading', { name: 'Trailmaker', exact: true })).toBeVisible();
  await page.waitForFunction(() => Boolean(window.__trailmaker));
  await page.waitForLoadState('networkidle');
  return response;
}
