import { expect, test } from './network-fixture';
import { installOfflineBasemap, offlineStylePath } from './offline-basemap';

test('BasemapPane requests no tiles before consent and loads the offline style after opt-in', async ({
  page,
}) => {
  test.setTimeout(45_000);
  const mapRequests: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/__test_basemap/')) mapRequests.push(request.url());
  });
  await installOfflineBasemap(page);
  const response = await page.goto('/');
  expect(response?.headers()['cross-origin-opener-policy']).toBe('same-origin');
  expect(response?.headers()['cross-origin-embedder-policy']).toBe('require-corp');
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);

  await page.evaluate(async (styleUrl) => {
    const settingsPath: string = '/src/io/settings.ts';
    const settings = await import(settingsPath);
    settings.updateBasemapSettings({
      enabled: false,
      styleUrl,
      lastCenter: [-78.395, 38.597],
      lastZoom: 14,
    });
    const host = document.createElement('div');
    host.id = 'test-basemap-pane-host';
    host.style.cssText = 'position:fixed;inset:0;z-index:9999;background:white';
    document.body.append(host);
    const mountPath: string = '/src/ui/georef/testMount.ts';
    const { mountBasemapPane } = await import(mountPath);
    mountBasemapPane(host, { overrideStyleUrl: styleUrl });
  }, offlineStylePath);

  const host = page.locator('#test-basemap-pane-host');
  await expect(host.getByRole('button', { name: 'Enable basemap' })).toBeVisible();
  expect(mapRequests).toEqual([]);
  await host.getByRole('button', { name: 'Enable basemap' }).click();
  await expect.poll(() => mapRequests.some((url) => url.endsWith(offlineStylePath)), { timeout: 20_000 }).toBe(true);
  await expect.poll(() => mapRequests.some((url) => /\/tiles\/\d+\/\d+\/\d+\.png$/.test(url)), { timeout: 20_000 }).toBe(true);
  await expect(host.getByRole('status')).toHaveCount(0);
});
