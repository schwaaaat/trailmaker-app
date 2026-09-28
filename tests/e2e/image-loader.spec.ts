import { expect, test } from './network-fixture';

test.describe('image loader EXIF orientation and geometry', () => {
  test('EXIF orientation 6 honors 90-degree CW rotation and matches oriented ImageBitmap', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Trailmaker', exact: true })).toBeVisible();

    const result = await page.evaluate(async () => {
      // Create a 40x20 canvas: top half red (y 0..9), bottom half blue (y 10..19)
      const canvas = document.createElement('canvas');
      canvas.width = 40;
      canvas.height = 20;
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = '#ff0000';
      ctx.fillRect(0, 0, 40, 10);
      ctx.fillStyle = '#0000ff';
      ctx.fillRect(0, 10, 40, 10);

      // Convert to JPEG
      const origBlob = await new Promise<Blob>((r) => canvas.toBlob((b) => r(b!), 'image/jpeg', 0.95));
      const origBytes = new Uint8Array(await origBlob.arrayBuffer());

      // Build APP1 EXIF orientation payload (orientation = 6)
      const exifPayload = new Uint8Array(6 + 8 + 2 + 12 + 4);
      const pView = new DataView(exifPayload.buffer);
      exifPayload.set([0x45, 0x78, 0x69, 0x66, 0x00, 0x00], 0);
      const tiff = 6;
      exifPayload[tiff] = 0x49; // II
      exifPayload[tiff + 1] = 0x49;
      pView.setUint16(tiff + 2, 42, true);
      pView.setUint32(tiff + 4, 8, true);
      const ifd0 = tiff + 8;
      pView.setUint16(ifd0, 1, true); // 1 entry
      const entry = ifd0 + 2;
      pView.setUint16(entry, 0x0112, true); // Orientation
      pView.setUint16(entry + 2, 3, true); // SHORT
      pView.setUint32(entry + 4, 1, true); // count 1
      pView.setUint16(entry + 8, 6, true); // Orientation 6

      // Insert APP1 after SOI (0xFF, 0xD8)
      const app1Len = 2 + exifPayload.length;
      const combined = new Uint8Array(origBytes.length + 2 + app1Len);
      combined[0] = 0xff;
      combined[1] = 0xd8;
      combined[2] = 0xff;
      combined[3] = 0xe1;
      combined[4] = (app1Len >> 8) & 0xff;
      combined[5] = app1Len & 0xff;
      combined.set(exifPayload, 6);
      combined.set(origBytes.subarray(2), 6 + exifPayload.length);

      const blob = new Blob([combined], { type: 'image/jpeg' });

      // Check browser native createImageBitmap orientation
      const nativeBitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
      const nativeWidth = nativeBitmap.width;
      const nativeHeight = nativeBitmap.height;
      nativeBitmap.close();

      const ioPath = '/src/io/index.ts';
      const { loadImageFile } = (await import(ioPath)) as typeof import('../../src/io/index');
      const loaded = await loadImageFile(blob, 'exif-6.jpg');

      const pixelAt = (x: number, y: number) => {
        const idx = (y * loaded.raster.width + x) * 4;
        return [
          loaded.raster.data[idx]!,
          loaded.raster.data[idx + 1]!,
          loaded.raster.data[idx + 2]!,
          loaded.raster.data[idx + 3]!,
        ];
      };

      // In 20x40 raster rotated 90 deg CW:
      // Left side (x=2, y=20) is from raw bottom (blue)
      // Right side (x=18, y=20) is from raw top (red)
      const leftPixel = pixelAt(2, 20);
      const rightPixel = pixelAt(18, 20);

      return {
        nativeWidth,
        nativeHeight,
        metaWidth: loaded.meta.width,
        metaHeight: loaded.meta.height,
        originalWidth: loaded.meta.originalWidth,
        originalHeight: loaded.meta.originalHeight,
        rasterWidth: loaded.raster.width,
        rasterHeight: loaded.raster.height,
        rasterLen: loaded.raster.data.length,
        displayWidth: loaded.display.width,
        displayHeight: loaded.display.height,
        leftPixel,
        rightPixel,
      };
    });

    // Native ImageBitmap is 20x40
    expect(result.nativeWidth).toBe(20);
    expect(result.nativeHeight).toBe(40);

    // loadImageFile must match the oriented dimensions, not raw 40x20
    expect(result.metaWidth).toBe(20);
    expect(result.metaHeight).toBe(40);
    expect(result.originalWidth).toBe(20);
    expect(result.originalHeight).toBe(40);
    expect(result.rasterWidth).toBe(20);
    expect(result.rasterHeight).toBe(40);
    expect(result.rasterLen).toBe(20 * 40 * 4);
    expect(result.displayWidth).toBe(20);
    expect(result.displayHeight).toBe(40);

    // Orientation 6 clockwise rotation:
    // Left pixel is blue (raw bottom)
    expect(result.leftPixel[2]).toBeGreaterThanOrEqual(180); // Blue
    expect(result.leftPixel[0]).toBeLessThan(100); // Red is low
    // Right pixel is red (raw top)
    expect(result.rightPixel[0]).toBeGreaterThanOrEqual(180); // Red
    expect(result.rightPixel[2]).toBeLessThan(100); // Blue is low
  });

  test('EXIF orientation 8 honors 270-degree rotation', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Trailmaker', exact: true })).toBeVisible();

    const result = await page.evaluate(async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 40;
      canvas.height = 20;
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = '#3560c3';
      ctx.fillRect(0, 0, 40, 20);

      const origBlob = await new Promise<Blob>((r) => canvas.toBlob((b) => r(b!), 'image/jpeg', 0.95));
      const origBytes = new Uint8Array(await origBlob.arrayBuffer());

      // Orientation = 8
      const exifPayload = new Uint8Array(6 + 8 + 2 + 12 + 4);
      const pView = new DataView(exifPayload.buffer);
      exifPayload.set([0x45, 0x78, 0x69, 0x66, 0x00, 0x00], 0);
      const tiff = 6;
      exifPayload[tiff] = 0x49; // II
      exifPayload[tiff + 1] = 0x49;
      pView.setUint16(tiff + 2, 42, true);
      pView.setUint32(tiff + 4, 8, true);
      const ifd0 = tiff + 8;
      pView.setUint16(ifd0, 1, true);
      const entry = ifd0 + 2;
      pView.setUint16(entry, 0x0112, true);
      pView.setUint16(entry + 2, 3, true);
      pView.setUint32(entry + 4, 1, true);
      pView.setUint16(entry + 8, 8, true); // Orientation 8

      const app1Len = 2 + exifPayload.length;
      const combined = new Uint8Array(origBytes.length + 2 + app1Len);
      combined[0] = 0xff;
      combined[1] = 0xd8;
      combined[2] = 0xff;
      combined[3] = 0xe1;
      combined[4] = (app1Len >> 8) & 0xff;
      combined[5] = app1Len & 0xff;
      combined.set(exifPayload, 6);
      combined.set(origBytes.subarray(2), 6 + exifPayload.length);

      const blob = new Blob([combined], { type: 'image/jpeg' });
      const ioPath = '/src/io/index.ts';
      const { loadImageFile } = (await import(ioPath)) as typeof import('../../src/io/index');
      const loaded = await loadImageFile(blob, 'exif-8.jpg');

      return {
        metaWidth: loaded.meta.width,
        metaHeight: loaded.meta.height,
        originalWidth: loaded.meta.originalWidth,
        originalHeight: loaded.meta.originalHeight,
        rasterWidth: loaded.raster.width,
        rasterHeight: loaded.raster.height,
        rasterLen: loaded.raster.data.length,
        displayWidth: loaded.display.width,
        displayHeight: loaded.display.height,
      };
    });

    expect(result.metaWidth).toBe(20);
    expect(result.metaHeight).toBe(40);
    expect(result.originalWidth).toBe(20);
    expect(result.originalHeight).toBe(40);
    expect(result.rasterWidth).toBe(20);
    expect(result.rasterHeight).toBe(40);
    expect(result.rasterLen).toBe(20 * 40 * 4);
    expect(result.displayWidth).toBe(20);
    expect(result.displayHeight).toBe(40);
  });

  test('huge image with EXIF orientation 6 caps working resolution correctly', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Trailmaker', exact: true })).toBeVisible();

    const result = await page.evaluate(async () => {
      // 8000x4000 canvas with orientation 6 -> 4000x8000 oriented
      const canvas = document.createElement('canvas');
      canvas.width = 8000;
      canvas.height = 4000;
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = '#268441';
      ctx.fillRect(0, 0, 8000, 4000);

      const origBlob = await new Promise<Blob>((r) => canvas.toBlob((b) => r(b!), 'image/jpeg', 0.85));
      const origBytes = new Uint8Array(await origBlob.arrayBuffer());

      // Orientation = 6
      const exifPayload = new Uint8Array(6 + 8 + 2 + 12 + 4);
      const pView = new DataView(exifPayload.buffer);
      exifPayload.set([0x45, 0x78, 0x69, 0x66, 0x00, 0x00], 0);
      const tiff = 6;
      exifPayload[tiff] = 0x49; // II
      exifPayload[tiff + 1] = 0x49;
      pView.setUint16(tiff + 2, 42, true);
      pView.setUint32(tiff + 4, 8, true);
      const ifd0 = tiff + 8;
      pView.setUint16(ifd0, 1, true);
      const entry = ifd0 + 2;
      pView.setUint16(entry, 0x0112, true);
      pView.setUint16(entry + 2, 3, true);
      pView.setUint32(entry + 4, 1, true);
      pView.setUint16(entry + 8, 6, true); // Orientation 6

      const app1Len = 2 + exifPayload.length;
      const combined = new Uint8Array(origBytes.length + 2 + app1Len);
      combined[0] = 0xff;
      combined[1] = 0xd8;
      combined[2] = 0xff;
      combined[3] = 0xe1;
      combined[4] = (app1Len >> 8) & 0xff;
      combined[5] = app1Len & 0xff;
      combined.set(exifPayload, 6);
      combined.set(origBytes.subarray(2), 6 + exifPayload.length);

      const blob = new Blob([combined], { type: 'image/jpeg' });
      const ioPath = '/src/io/index.ts';
      const { loadImageFile } = (await import(ioPath)) as typeof import('../../src/io/index');
      const loaded = await loadImageFile(blob, 'huge-exif-6.jpg');

      return {
        metaWidth: loaded.meta.width,
        metaHeight: loaded.meta.height,
        originalWidth: loaded.meta.originalWidth,
        originalHeight: loaded.meta.originalHeight,
        rasterWidth: loaded.raster.width,
        rasterHeight: loaded.raster.height,
        displayWidth: loaded.display.width,
        displayHeight: loaded.display.height,
      };
    });

    expect(result.originalWidth).toBe(4000);
    expect(result.originalHeight).toBe(8000);
    expect(result.metaWidth).toBe(3500);
    expect(result.metaHeight).toBe(7000);
    expect(result.rasterWidth).toBe(3500);
    expect(result.rasterHeight).toBe(7000);
    expect(result.displayWidth).toBe(3500);
    expect(result.displayHeight).toBe(7000);
  });

  test('verification harness passes all tests and saves screenshots', async ({ page }) => {
    await page.goto('/test-image-loader.html');
    await page.waitForFunction(
      () =>
        (window as unknown as { __testResult?: { ok: boolean } }).__testResult !== undefined,
      { timeout: 30_000 }
    );

    const result = await page.evaluate(
      () =>
        (
          window as unknown as {
            __testResult: {
              ok: boolean;
              normal: unknown;
              huge: unknown;
              transparent: { isWhite: boolean };
              exif: { width: number; height: number };
            };
          }
        ).__testResult
    );

    expect(result.ok).toBe(true);
    expect(result.normal).toBeDefined();
    expect(result.huge).toBeDefined();
    expect(result.transparent.isWhite).toBe(true);
    expect(result.exif.width).toBe(20);
    expect(result.exif.height).toBe(40);

    // Capture screenshots into the test output folder (kept out of the source tree)
    await page.locator('#section-normal').screenshot({ path: test.info().outputPath('normal.png') });
    await page.locator('#section-huge').screenshot({ path: test.info().outputPath('huge.png') });
    await page.locator('#section-transparent').screenshot({ path: test.info().outputPath('transparent.png') });
    await page.locator('#section-exif').screenshot({ path: test.info().outputPath('exif.png') });
    await page.screenshot({ path: test.info().outputPath('overview.png'), fullPage: true });
  });
});

