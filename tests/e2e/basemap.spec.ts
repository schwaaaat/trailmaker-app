import { expect, test } from './network-fixture';
import { basemapResponseHeaders, installOfflineBasemap } from './offline-basemap';

test('offline MapLibre style and tiles load under COOP/COEP', async ({ page }) => {
  test.setTimeout(30_000);
  const consoleErrors: string[] = [];
  const responses: string[] = [];
  const mapHeaders: Record<string, string>[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('response', (response) => {
    if (response.url().includes('/__test_basemap/')) {
      responses.push(response.url());
      mapHeaders.push(response.headers());
    }
  });
  await installOfflineBasemap(page);
  const response = await page.goto('/tests/fixtures/basemap/harness.html');
  expect(response?.headers()['cross-origin-opener-policy']).toBe('same-origin');
  expect(response?.headers()['cross-origin-embedder-policy']).toBe('require-corp');
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
  await expect
    .poll(
      async () => {
        const state = await page.evaluate(() => window.__basemapHarness);
        if (state?.errors.length)
          throw new Error(
            `MapLibre: ${state.errors.join('; ')}; console: ${consoleErrors.join('; ')}; responses: ${responses.join(', ')}`,
          );
        return state?.ready;
      },
      // 30 s: the first request in a fresh worktree waits for Vite to pre-bundle maplibre-gl.
      { timeout: 30_000 },
    )
    .toBe(true);
  const state = await page.evaluate(() => window.__basemapHarness);
  expect(state?.tileLoads).toBeGreaterThan(0);
  expect(state?.errors).toEqual([]);
  expect(
    consoleErrors.filter((message) => /COEP|CORP|cross.origin|failed to load/i.test(message)),
  ).toEqual([]);
  expect(responses.some((url) => url.endsWith('/__test_basemap/style.json'))).toBe(true);
  expect(responses.some((url) => /\/__test_basemap\/tiles\/\d+\/\d+\/\d+\.png$/.test(url))).toBe(
    true,
  );
  for (const headers of mapHeaders) {
    expect(headers['cross-origin-resource-policy']).toBe(
      basemapResponseHeaders['Cross-Origin-Resource-Policy'],
    );
    expect(headers['access-control-allow-origin']).toBe(
      basemapResponseHeaders['Access-Control-Allow-Origin'],
    );
  }
});
