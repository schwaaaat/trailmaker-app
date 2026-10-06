import { expect, test } from './network-fixture';
import { openReadyApp } from './app-ready';

// T-330 acceptance. Run on its feature branch until the editor merges.

test('virtual tiled map renders within its cache cap and reads full-resolution tracing patches [T-330]', async ({ page }) => {
  test.setTimeout(90_000);
  await openReadyApp(page);
  await page.evaluate(async () => {
    const width = 40_000;
    const height = 30_000;
    const overview = document.createElement('canvas');
    overview.width = 400;
    overview.height = 300;
    const overviewContext = overview.getContext('2d')!;
    overviewContext.fillStyle = '#fff';
    overviewContext.fillRect(0, 0, 400, 300);
    overviewContext.fillStyle = '#d03030';
    overviewContext.fillRect(180, 150, 40, 1);
    overviewContext.fillStyle = '#3048d0';
    overviewContext.fillRect(180, 151, 40, 1);
    const meta = {
      fileName: 'tiled-editor-fixture.png',
      width,
      height,
      originalWidth: width,
      originalHeight: height,
      source: {
        kind: 'tiles' as const,
        sourceId: 'test:synthetic',
        z: 20,
        tileSize: 256,
        origin: { x: 0, y: 0 },
        boundary: [[27.13, -80.14], [27.13, -80.13], [27.12, -80.13]] as const,
        tileCount: 1,
      },
      sha256: '0'.repeat(64),
    };
    const levels = Array.from({ length: 8 }, (_, level) => ({
      level,
      width: Math.ceil(width / 2 ** level),
      height: Math.ceil(height / 2 ** level),
      cols: Math.ceil(width / 2 ** level / 256),
      rows: Math.ceil(height / 2 ** level / 256),
    }));
    const requested: string[] = [];
    Object.assign(window, { __t330Requested: requested });
    const handle = {
      levels,
      tileSize: 256,
      overviewScale: 0.01,
      async getTileBitmap(level: number, col: number, row: number) {
        requested.push(`${level}/${col}/${row}`);
        const tile = document.createElement('canvas');
        tile.width = tile.height = 256;
        const ctx = tile.getContext('2d')!;
        ctx.fillStyle = '#f5f5ed';
        ctx.fillRect(0, 0, 256, 256);
        return createImageBitmap(tile);
      },
      async readRegion(rect: { x: number; y: number; width: number; height: number }, level: number) {
        const scale = 2 ** level;
        const rasterWidth = Math.ceil(rect.width / scale);
        const rasterHeight = Math.ceil(rect.height / scale);
        const data = new Uint8ClampedArray(rasterWidth * rasterHeight * 4);
        for (let y = 0; y < rasterHeight; y++) {
          for (let x = 0; x < rasterWidth; x++) {
            const offset = (y * rasterWidth + x) * 4;
            const globalX = rect.x + x * scale;
            const globalY = rect.y + y * scale;
            const red = globalX >= 18_000 && globalX <= 22_000 && Math.abs(globalY - 15_000) <= 1;
            const blue = globalX >= 18_000 && globalX <= 22_000 && Math.abs(globalY - 15_100) <= 1;
            data[offset] = red ? 208 : blue ? 48 : 255;
            data[offset + 1] = red ? 48 : blue ? 72 : 255;
            data[offset + 2] = red ? 48 : blue ? 208 : 255;
            data[offset + 3] = 255;
          }
        }
        return { width: rasterWidth, height: rasterHeight, data };
      },
    };
    window.__trailmaker!.session.openSession({
      project: {
        version: 4,
        name: 'Synthetic tiled editor',
        image: meta,
        anchors: [],
        fitMethod: 'auto',
        features: [],
        units: 'mi',
        trace: { smartFollow: true, tolerance: 60, ink: [208, 48, 48] },
        autoTrace: {
          chips: [
            { id: 'red', rgb: [208, 48, 48], name: 'Red', enabled: true, share: null, named: true },
            { id: 'blue', rgb: [48, 72, 208], name: 'Blue', enabled: true, share: null, named: true },
          ],
          gapPx: 0,
          minLengthPct: 4,
        },
        seq: 1,
        updatedAt: '2026-10-04T00:00:00.000Z',
      },
      map: {
        meta,
        display: await createImageBitmap(overview),
        raster: { width: 400, height: 300, data: overviewContext.getImageData(0, 0, 400, 300).data },
        original: new Blob([], { type: 'image/png' }),
        tiles: handle,
        pdf: null,
      },
    });
    await window.__trailmaker!.idle();
  });

  const canvas = page.locator('canvas').first();
  const box = await canvas.boundingBox();
  if (!box) throw new Error('Editor canvas is missing');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -2600);
  await expect.poll(() => page.evaluate(() => (window as typeof window & { __t330Requested: string[] }).__t330Requested.length)).toBeGreaterThan(0);
  const stats = await page.evaluate(() => (window as typeof window & { __trailmakerTiled: () => { bytes: number; byteLimit: number } | null }).__trailmakerTiled());
  expect(stats).not.toBeNull();
  expect(stats!.bytes).toBeGreaterThan(0);
  expect(stats!.bytes).toBeLessThanOrEqual(stats!.byteLimit);

  const centerBeforePan = await page.evaluate(() => window.__trailmaker!.imageToClient([20_000, 15_000]));
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 80, box.y + box.height / 2 + 30, { steps: 8 });
  await page.mouse.up();
  const centerAfterPan = await page.evaluate(() => window.__trailmaker!.imageToClient([20_000, 15_000]));
  expect(centerAfterPan.x - centerBeforePan.x).toBeGreaterThan(50);
  expect(centerAfterPan.y - centerBeforePan.y).toBeGreaterThan(15);
  const pannedStats = await page.evaluate(() => (window as typeof window & { __trailmakerTiled: () => { bytes: number; byteLimit: number } | null }).__trailmakerTiled());
  expect(pannedStats!.bytes).toBeLessThanOrEqual(pannedStats!.byteLimit);

  const toolbar = page.getByRole('toolbar', { name: 'Map tools' });
  await toolbar.getByRole('button', { name: 'Trail', exact: true }).click();
  for (const px of [[19_900, 15_000], [20_100, 15_000]] as const) {
    const at = await page.evaluate((point) => window.__trailmaker!.imageToClient(point), px);
    await page.mouse.click(at.x, at.y);
    await page.evaluate(() => window.__trailmaker!.idle());
  }
  await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(() => window.__trailmaker!.session.getSession()!.project.features.filter((feature) => feature.kind === 'trail').length)).toBe(1);
  const traceStats = await page.evaluate(() => (window as typeof window & { __trailmakerTiled: () => { patchReadMs: number; patchLoadMs: number; smartHopMs: number } | null }).__trailmakerTiled());
  expect(traceStats!.patchReadMs).toBeGreaterThan(0);
  expect(traceStats!.patchLoadMs).toBeGreaterThan(0);
  expect(traceStats!.smartHopMs).toBeGreaterThanOrEqual(0);

  const tracePanel = page.getByRole('region', { name: 'Trace' });
  await tracePanel.getByRole('button', { name: 'Auto-trace a region' }).click();
  await expect(tracePanel.getByText('Drag a rectangle on the map. Press Escape to cancel.')).toBeVisible();
  const from = await page.evaluate(() => window.__trailmaker!.imageToClient([19_850, 14_950]));
  const to = await page.evaluate(() => window.__trailmaker!.imageToClient([20_150, 15_150]));
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 8 });
  await page.mouse.up();
  const found = tracePanel.getByRole('group', { name: 'Found lines' });
  await expect(found).toBeVisible({ timeout: 30_000 });
  await expect(found.getByRole('checkbox')).toHaveCount(2);
});
