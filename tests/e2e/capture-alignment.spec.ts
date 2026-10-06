import { deflateSync } from 'node:zlib';
import { expect, test } from './network-fixture';
import { openReadyApp } from './app-ready';
import { installOfflineBasemap, offlineStylePath } from './offline-basemap';
import { IMAGERY_HOSTS, MARTIN_SERVICE, stubImagery, stubMartinCounty } from './imagery-stubs';

test.use({ stubbedHosts: IMAGERY_HOSTS });

/** Synthetic RGB PNG using the same built-in encoder approach as imagery-stubs. */
function markerPng(width: number, height: number, cx: number, cy: number, seed: number): Buffer {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * (width * 3 + 1) + 1 + x * 3;
      const marker = (x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 <= 64;
      raw[i] = marker ? 255 : 30 + ((seed * 13) % 160);
      raw[i + 1] = marker ? 0 : 120 + (x % 80);
      raw[i + 2] = marker ? 0 : 150 + (y % 80);
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    let crc = 0xffffffff;
    for (const byte of body) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
    const size = Buffer.alloc(4),
      sum = Buffer.alloc(4);
    size.writeUInt32BE(data.length);
    sum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([size, body, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

test('dynamic capture registers a synthetic geographic marker to its coordinates [T-337]', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const known: readonly [number, number] = [27.1375, -80.1705];
  const radius = 6_378_137;
  const east = (radius * known[1] * Math.PI) / 180;
  const north = radius * Math.log(Math.tan(Math.PI / 4 + (known[0] * Math.PI) / 360));
  await installOfflineBasemap(page);
  await stubImagery(page, []);
  await stubMartinCounty(page, []);
  let exports = 0;
  const footprints: unknown[] = [];
  await page.route(`${MARTIN_SERVICE}/export**`, async (route) => {
    const url = new URL(route.request().url());
    const [west, south, right, top] = url.searchParams.get('bbox')!.split(',').map(Number);
    const [width, height] = url.searchParams.get('size')!.split(',').map(Number);
    const x = ((east - west!) / (right! - west!)) * width!;
    const y = ((top! - north) / (top! - south!)) * height!;
    exports++;
    footprints.push({ bbox: [west, south, right, top], size: [width, height], marker: [x, y] });
    // Only generated geometry: every red marker represents the same known ground coordinate.
    await route.fulfill({
      status: 200,
      contentType: 'image/png',
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Cross-Origin-Resource-Policy': 'cross-origin',
      },
      body: markerPng(width!, height!, x, y, exports),
    });
  });
  await openReadyApp(page);
  await page.evaluate(
    async ({ styleUrl, known }) => {
      const settings = await import('/src/io/settings.ts' as string);
      settings.updateBasemapSettings({
        enabled: true,
        imagery: 'satellite',
        styleUrl,
        lastCenter: [known[1], known[0]],
        lastZoom: 20,
      });
    },
    { styleUrl: offlineStylePath, known },
  );
  await page.getByRole('button', { name: 'Start from satellite' }).first().click();
  const overlay = page.getByRole('dialog', { name: 'Capture satellite map' });
  await expect(overlay).toBeVisible();
  await overlay.getByLabel('Capture imagery source').selectOption('martin-county');
  await overlay.getByRole('button', { name: 'Capture map', exact: true }).click();
  await expect
    .poll(
      () => page.evaluate(() => window.__trailmaker?.session.getSession()?.project.anchors.length),
      { timeout: 30_000 },
    )
    .toBe(9);
  const check = await page.evaluate(async (known) => {
    const { fitAnchors, forward, inverse } = await import('/src/core/geo/fit.ts' as string);
    const { haversine } = await import('/src/core/geo/distance.ts' as string);
    const session = window.__trailmaker!.session.getSession()!;
    const { width, height } = session.map.raster;
    // The app transfers its raster to the worker; decode the saved synthetic image instead.
    const bitmap = await createImageBitmap(session.map.original);
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d')!;
    context.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();
    const { data } = context.getImageData(0, 0, width, height);
    const fit = fitAnchors(session.project.anchors, width, height, 'auto');
    if (!fit.ok) throw new Error('Capture anchors did not fit');
    const target = inverse(fit, known)!;
    let count = 0,
      sumX = 0,
      sumY = 0;
    for (
      let y = Math.max(0, Math.floor(target[1] - 32));
      y < Math.min(height, target[1] + 32);
      y++
    ) {
      for (
        let x = Math.max(0, Math.floor(target[0] - 32));
        x < Math.min(width, target[0] + 32);
        x++
      ) {
        const i = (y * width + x) * 4;
        if (data[i]! > 220 && data[i + 1]! < 40 && data[i + 2]! < 40) {
          count++;
          sumX += x + 0.5;
          sumY += y + 0.5;
        }
      }
    }
    return {
      target,
      width,
      height,
      count,
      errorM: count ? haversine(forward(fit, [sumX / count, sumY / count]), known) : null,
      attribution: session.project.image.attribution,
    };
  }, known);
  expect(exports).toBeGreaterThan(0);
  expect(check.attribution).toContain('Martin County');
  expect(check.count, JSON.stringify({ check, footprints })).toBeGreaterThan(0);
  expect(check.errorM).not.toBeNull();
  expect(check.errorM!).toBeLessThan(1);
});
