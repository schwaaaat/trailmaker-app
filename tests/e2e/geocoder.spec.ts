import { expect, test } from './network-fixture';
import { installOfflineBasemap, offlineStylePath } from './offline-basemap';
import type { BasemapHandle } from '../../src/ui/georef/types';

test('opted-in place search selects a canned result without external requests [T-308]', async ({
  page,
}) => {
  test.setTimeout(45_000);
  await installOfflineBasemap(page);
  const searches: URL[] = [];
  await page.route('**/__test_geocoder/search?**', async (route) => {
    searches.push(new URL(route.request().url()));
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([
        {
          display_name: 'Dickey Ridge Visitor Center, Virginia',
          lat: '38.597',
          lon: '-78.395',
          boundingbox: ['38.594', '38.600', '-78.399', '-78.391'],
        },
      ]),
    });
  });
  await page.goto('/');
  await page.evaluate(async (styleUrl) => {
    const settingsPath: string = '/src/io/settings.ts';
    const settings = await import(settingsPath);
    settings.updateBasemapSettings({
      enabled: true,
      styleUrl,
      lastCenter: [-78.5, 38.5],
      lastZoom: 10,
    });
    settings.updateGeocoderSettings({
      enabled: true,
      serviceUrl: `${location.origin}/__test_geocoder/search`,
    });
    const host = document.createElement('div');
    host.id = 'test-geocoder-host';
    host.style.cssText = 'position:fixed;inset:0;z-index:9999;background:white';
    document.body.append(host);
    const mountPath: string = '/src/ui/georef/testMount.ts';
    const { mountBasemapPane } = await import(mountPath);
    const handleRef: { current: BasemapHandle | null } = { current: null };
    (window as Window & { __geocoderBasemapRef?: typeof handleRef }).__geocoderBasemapRef =
      handleRef;
    mountBasemapPane(host, { overrideStyleUrl: styleUrl, handleRef });
  }, offlineStylePath);

  const pane = page.locator('#test-geocoder-host');
  const query = pane.getByRole('combobox', { name: 'Search for a place' });
  await query.fill('Dickey Ridge Visitor Center');
  const option = pane.getByRole('option', { name: 'Dickey Ridge Visitor Center, Virginia' });
  await expect(option).toBeVisible();
  await query.press('ArrowDown');
  await expect(option).toHaveAttribute('aria-selected', 'true');
  await query.press('Enter');
  await expect(option).toHaveCount(0);
  expect(searches).toHaveLength(1);
  expect(searches[0]!.pathname).toBe('/__test_geocoder/search');
  expect([...searches[0]!.searchParams.entries()]).toEqual([
    ['format', 'jsonv2'],
    ['q', 'Dickey Ridge Visitor Center'],
  ]);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const map = (
          window as Window & {
            __geocoderBasemapRef?: {
              current: { getMap(): { getCenter(): { lng: number; lat: number } } | null } | null;
            };
          }
        ).__geocoderBasemapRef?.current?.getMap();
        const center = map?.getCenter();
        return center ? Math.hypot(center.lng + 78.395, center.lat - 38.597) : Infinity;
      }),
    )
    .toBeLessThan(0.003);
});
