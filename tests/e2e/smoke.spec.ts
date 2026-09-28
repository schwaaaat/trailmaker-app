import { expect, test } from './network-fixture';
import { openReadyApp } from './app-ready';

test('app and bundled module worker load', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const response = await openReadyApp(page);
  expect(response?.headers()['cross-origin-opener-policy']).toBe('same-origin');
  expect(response?.headers()['cross-origin-embedder-policy']).toBe('require-corp');
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
  expect(page.workers().some((worker) => worker.url().includes('worker'))).toBe(true);
  expect(errors).toEqual([]);
});
