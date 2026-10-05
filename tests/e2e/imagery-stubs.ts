import { deflateSync } from 'node:zlib';
import type { Page } from '@playwright/test';

/**
 * Local answers for the public imagery hosts (T-316/T-318/T-320). Specs using this must also
 * declare `test.use({ stubbedHosts: IMAGERY_HOSTS })` so the network guard allows the requests.
 */
export const IMAGERY_HOSTS = [
  'basemap.nationalmap.gov',
  'imagery.nationalmap.gov',
  'ibasemaps-api.arcgis.com',
  'geoweb.martin.fl.us',
];

/** 1x1 PNG; any decodable raster works for MapLibre tiles and NAIP exportImage mosaics. */
export const TILE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Cross-Origin-Resource-Policy': 'cross-origin',
};

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
  // Martin County 3-inch imagery (T-326): curated capture source inside its coverage.
  await stubMartinCounty(page, seen);
  // Esri World Imagery via ArcGIS basemap services (T-319); only requested when a key is set.
  await page.route('https://ibasemaps-api.arcgis.com/**', async (route) => {
    seen.push(route.request().url());
    await route.fulfill({ status: 200, contentType: 'image/png', headers, body: TILE_PNG });
  });
}

export const isUsgsTile = (u: string) => /USGSImageryOnly\/MapServer\/tile\/\d+\/\d+\/\d+/.test(u);
export const isNaipExport = (u: string) => /USGSNAIPImagery\/ImageServer\/exportImage\?/.test(u);
export const isEsriTile = (u: string) =>
  /^https:\/\/ibasemaps-api\.arcgis\.com\/arcgis\/rest\/services\/World_Imagery\/MapServer\/tile\/\d+\/\d+\/\d+/.test(
    u,
  );

/** A 64x64 PNG of seeded noise: decodes like real imagery and isn't mistaken for a blank export. */
export const TEXTURED_PNG = (() => {
  const w = 64;
  const h = 64;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  let seed = 12345;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w * 3; x++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      raw[y * (w * 3 + 1) + 1 + x] = seed % 256;
    }
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const x of b) c = table[(c ^ x) & 255]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
})();

export const MARTIN_SERVICE =
  'https://geoweb.martin.fl.us/arcgis/rest/services/Imagery/MC_Imagery/MapServer';

/** Martin County MapServer metadata, layer 0 and /export (T-326; trimmed from the live service). */
export async function stubMartinCounty(
  page: Page,
  seen: string[],
  opts: { blank?: boolean } = {},
): Promise<void> {
  await page.route('https://geoweb.martin.fl.us/**', async (route) => {
    const url = route.request().url();
    seen.push(url);
    const json = (body: unknown) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers,
        body: JSON.stringify(body),
      });
    if (/\/MapServer\?f=json/.test(url))
      return json({
        name: 'MC_Imagery',
        layers: [{ id: 0, name: 'Current_Imagery' }],
        fullExtent: {
          xmin: -8983106.55923276,
          ymin: 3116499.117350954,
          xmax: -8912756.246533474,
          ymax: 3158127.2318873256,
          spatialReference: { wkid: 102100, latestWkid: 3857 },
        },
        spatialReference: { wkid: 102100, latestWkid: 3857 },
        maxImageWidth: 2048,
        maxImageHeight: 2048,
        documentInfo: { Title: '2021 Imagery' },
      });
    if (/\/MapServer\/0\?f=json/.test(url))
      return json({
        name: 'Current_Imagery',
        description:
          '3-inch orthoimagery. Flight season was from January 27, 2026 through February 2, 2026 for all areas.',
        copyrightText: 'GPI Geospatial, Inc.',
      });
    await route.fulfill({
      status: 200,
      contentType: 'image/png',
      headers,
      body: opts.blank ? TILE_PNG : TEXTURED_PNG,
    });
  });
}

export const isMartinExport = (u: string) => /MC_Imagery\/MapServer\/export\?/.test(u);
