import { expect, type Page } from '@playwright/test';

/** Wait for the app after Vite's first-load dependency pass and any resulting reload. */
export async function openReadyApp(page: Page) {
  const response = await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'Trailmaker', exact: true })).toBeVisible({ timeout: 30_000 });
  await page.waitForFunction(() => Boolean(window.__trailmaker), null, { timeout: 30_000 });
  return response;
}
