import type { Page } from '@playwright/test';

/**
 * Local answers for the public imagery hosts (T-316/T-318/T-320). Specs using this must also
 * declare `test.use({ stubbedHosts: IMAGERY_HOSTS })` so the network guard allows the requests.
 */
export const IMAGERY_HOSTS = ['basemap.nationalmap.gov', 'imagery.nationalmap.gov', 'ibasemaps-api.arcgis.com'];

/** 1x1 PNG; any decodable raster works for MapLibre tiles and NAIP exportImage mosaics. */
export const TILE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

const headers = { 'Access-Control-Allow-Origin': '*', 'Cross-Origin-Resource-Policy': 'cross-origin' };

/** Stub USGS basemap tiles and NAIP exportImage/identify; every requested URL is pushed to `seen`. */
export async function stubImagery(page: Page, seen: string[], naipYear = 2023): Promise<void> {
  await page.route('https://basemap.nationalmap.gov/**', async (route) => {
    seen.push(route.request().url());
    await route.fulfill({ status: 200, contentType: 'image/png', headers, body: TILE_PNG });
  });
  await page.route('https://imagery.nationalmap.gov/**', async (route) => {
    const url = route.request().url();
    seen.push(url);
    if (/\/identify\b/.test(url)) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers,
        body: JSON.stringify({ catalogItems: { features: [{ attributes: { Year: naipYear } }] } }),
      });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'image/png', headers, body: TILE_PNG });
  });
  // Esri World Imagery via ArcGIS basemap services (T-319); only requested when a key is set.
  await page.route('https://ibasemaps-api.arcgis.com/**', async (route) => {
    seen.push(route.request().url());
    await route.fulfill({ status: 200, contentType: 'image/png', headers, body: TILE_PNG });
  });
}

export const isUsgsTile = (u: string) => /USGSImageryOnly\/MapServer\/tile\/\d+\/\d+\/\d+/.test(u);
export const isNaipExport = (u: string) => /USGSNAIPImagery\/ImageServer\/exportImage\?/.test(u);
export const isEsriTile = (u: string) =>
  /^https:\/\/ibasemaps-api\.arcgis\.com\/arcgis\/rest\/services\/World_Imagery\/MapServer\/tile\/\d+\/\d+\/\d+/.test(u);
