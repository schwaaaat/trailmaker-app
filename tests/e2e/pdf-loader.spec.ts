import { readFile, writeFile } from 'node:fs/promises';
import { expect, test } from './network-fixture';
import type { FixtureTruth } from '../fixtures/truth';

test.describe('T-303 PDF loader', () => {
  test('opens multi-page vector fixture, renders page 1 and page 2 without re-parsing, and matches truth ink within 2 px', async ({
    page,
  }) => {
    // 1. Monitor network requests to ensure NO external CDN requests are made
    const requests: string[] = [];
    page.on('request', (req) => {
      requests.push(req.url());
    });

    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Trailmaker', exact: true })).toBeVisible();

    const [solidPdfBytes, solidTruthText] = await Promise.all([
      readFile('tests/fixtures/generated/solid.pdf'),
      readFile('tests/fixtures/generated/solid.truth.json', 'utf8'),
    ]);
    const solidTruth = JSON.parse(solidTruthText) as FixtureTruth;

    const result = await page.evaluate(
      async ({ base64, truth }) => {
        const bin = atob(base64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const blob = new Blob([bytes], { type: 'application/pdf' });

        const ioPath = '/src/io/index.ts';
        const { loadPdfFile } = (await import(ioPath)) as typeof import('../../src/io/index');

        // Render page 1
        const mapPage1 = await loadPdfFile(blob, 'solid.pdf', 1);

        // Render page 2 using the same parsed document without re-parsing
        const mapPage2 = await mapPage1.pdf!.renderPage(2);

        // Sample ink color on page 2 against truth polylines within 2 px
        const renderScale = mapPage2.meta.source.kind === 'pdf' ? mapPage2.meta.source.renderScale : 1;
        const width = mapPage2.raster.width;
        const height = mapPage2.raster.height;
        const data = mapPage2.raster.data;

        const checkInkMatch = (
          targetColor: readonly [number, number, number],
          pts: readonly (readonly [number, number])[]
        ) => {
          let matched = 0;
          let totalChecked = 0;

          // Check sample points along the line
          for (let i = 0; i < pts.length; i += 3) {
            const pt = pts[i]!;
            const cx = Math.round(pt[0] * renderScale);
            const cy = Math.round(pt[1] * renderScale);
            totalChecked++;

            // Search within 2 px radius
            let found = false;
            for (let dy = -2; dy <= 2; dy++) {
              for (let dx = -2; dx <= 2; dx++) {
                const px = cx + dx;
                const py = cy + dy;
                if (px < 0 || px >= width || py < 0 || py >= height) continue;
                const idx = (py * width + px) * 4;
                const r = data[idx]!;
                const g = data[idx + 1]!;
                const b = data[idx + 2]!;
                const dist = Math.hypot(r - targetColor[0], g - targetColor[1], b - targetColor[2]);
                if (dist < 40) {
                  found = true;
                  break;
                }
              }
              if (found) break;
            }
            if (found) matched++;
          }
          return { matched, totalChecked, ratio: matched / totalChecked };
        };

        const redLine = truth.polylines.find((l) => l.id === 'red-ridge')!;
        const blueLine = truth.polylines.find((l) => l.id === 'blue-creek')!;

        const redResult = checkInkMatch(redLine.color, redLine.pts);
        const blueResult = checkInkMatch(blueLine.color, blueLine.pts);

        return {
          page1: {
            fileName: mapPage1.meta.fileName,
            width: mapPage1.meta.width,
            height: mapPage1.meta.height,
            source: mapPage1.meta.source,
            sha256: mapPage1.meta.sha256,
            hasPdf: mapPage1.pdf !== null,
            pageCount: mapPage1.pdf?.pageCount,
          },
          page2: {
            fileName: mapPage2.meta.fileName,
            width: mapPage2.meta.width,
            height: mapPage2.meta.height,
            source: mapPage2.meta.source,
            sha256: mapPage2.meta.sha256,
            hasPdf: mapPage2.pdf !== null,
            pageCount: mapPage2.pdf?.pageCount,
          },
          redResult,
          blueResult,
        };
      },
      { base64: Buffer.from(solidPdfBytes).toString('base64'), truth: solidTruth }
    );

    // Verify page 1 metadata
    expect(result.page1.fileName).toBe('solid');
    expect(result.page1.pageCount).toBe(2);
    expect(result.page1.source).toMatchObject({
      kind: 'pdf',
      page: 1,
      pageCount: 2,
    });
    expect(result.page1.width).toBe(4200);
    expect(result.page1.height).toBe(3150);

    // Verify page 2 metadata
    expect(result.page2.fileName).toBe('solid');
    expect(result.page2.pageCount).toBe(2);
    expect(result.page2.source).toMatchObject({
      kind: 'pdf',
      page: 2,
      pageCount: 2,
      renderScale: 5.25,
    });
    expect(result.page2.width).toBe(4200);
    expect(result.page2.height).toBe(3150);
    expect(result.page2.sha256).toBe(result.page1.sha256);

    // Acceptance 5: Trail pixels match ground truth within 2 px
    expect(result.redResult.ratio).toBeGreaterThanOrEqual(0.95);
    expect(result.blueResult.ratio).toBeGreaterThanOrEqual(0.95);

    // Acceptance 1: Zero network requests to external CDNs
    const appOrigin = new URL(page.url()).origin;
    const externalRequests = requests.filter(
      (url) => !url.startsWith(`${appOrigin}/`) && !url.startsWith('data:') && !url.startsWith('blob:')
    );
    expect(externalRequests).toEqual([]);
  });

  test('corrupt PDF rejects with readable error message', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Trailmaker', exact: true })).toBeVisible();

    const error = await page.evaluate(async () => {
      const corruptBlob = new Blob(['%PDF-1.4 this is corrupt data not valid pdf'], {
        type: 'application/pdf',
      });
      const ioPath = '/src/io/index.ts';
      const { loadPdfFile } = (await import(ioPath)) as typeof import('../../src/io/index');
      try {
        await loadPdfFile(corruptBlob, 'bad.pdf');
        return null;
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
    });

    expect(error).toBe('That PDF couldn’t be read because the file is damaged or not a valid PDF.');
  });

  test('password-protected PDF rejects with readable error message', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Trailmaker', exact: true })).toBeVisible();

    // Standard encrypted PDF syntax that triggers PasswordException in pdfjs
    const encryptedPdfContent = `%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] >> endobj
4 0 obj << /Filter /Standard /V 1 /R 2 /O (xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx) /U (xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx) /P -64 >> endobj
xref
0 5
0000000000 65535 f 
0000000009 00000 n 
0000000058 00000 n 
0000000115 00000 n 
0000000186 00000 n 
trailer << /Size 5 /Root 1 0 R /Encrypt 4 0 R /ID [<12345678901234567890123456789012> <12345678901234567890123456789012>] >>
startxref
305
%%EOF`;

    const error = await page.evaluate(async (pdfString) => {
      const encBlob = new Blob([pdfString], { type: 'application/pdf' });
      const ioPath = '/src/io/index.ts';
      const { loadPdfFile } = (await import(ioPath)) as typeof import('../../src/io/index');
      try {
        await loadPdfFile(encBlob, 'encrypted.pdf');
        return null;
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
    }, encryptedPdfContent);

    expect(error).toBe('This PDF is password-protected. Please remove the password and try again.');
  });

  test('generates screenshots of solid.pdf pages 1 and 2 and real multi-page park map into the test output folder', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Trailmaker', exact: true })).toBeVisible();

    const [solidPdfBytes, realParkMapPdfBytes] = await Promise.all([
      readFile('tests/fixtures/generated/solid.pdf'),
      readFile('tests/fixtures/dickey-ridge-trail-map.pdf'),
    ]);

    // Render in browser and extract data URLs
    const shots = await page.evaluate(
      async ({ solidB64, realMapB64 }) => {
        const toBlob = (b64: string) => {
          const s = atob(b64);
          const u8 = new Uint8Array(s.length);
          for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
          return new Blob([u8], { type: 'application/pdf' });
        };

        const ioPath = '/src/io/index.ts';
        const { loadPdfFile } = (await import(ioPath)) as typeof import('../../src/io/index');

        // Render solid page 1 and page 2
        const solid1 = await loadPdfFile(toBlob(solidB64), 'solid.pdf', 1);
        const solid2 = await solid1.pdf!.renderPage(2);

        // Render real multi-page park map page 1 (official Shenandoah National Park Dickey Ridge Area Road and Trail Map)
        const realMap1 = await loadPdfFile(toBlob(realMapB64), 'dickey-ridge-trail-map.pdf', 1);

        const toDataUrl = (bitmap: ImageBitmap, maxWidth = 800) => {
          const c = document.createElement('canvas');
          const aspect = bitmap.height / bitmap.width;
          c.width = maxWidth;
          c.height = Math.round(maxWidth * aspect);
          const ctx = c.getContext('2d')!;
          ctx.drawImage(bitmap, 0, 0, c.width, c.height);
          return c.toDataURL('image/png');
        };

        return {
          solidPage1Url: toDataUrl(solid1.display),
          solidPage2Url: toDataUrl(solid2.display),
          parkMapUrl: toDataUrl(realMap1.display),
        };
      },
      {
        solidB64: Buffer.from(solidPdfBytes).toString('base64'),
        realMapB64: Buffer.from(realParkMapPdfBytes).toString('base64'),
      }
    );

    // Save screenshots into the test output folder (kept out of the source tree)
    const saveShot = async (dataUrl: string, filePath: string) => {
      const base64Data = dataUrl.replace(/^data:image\/png;base64,/, '');
      await writeFile(filePath, Buffer.from(base64Data, 'base64'));
    };

    await saveShot(shots.solidPage1Url, test.info().outputPath('page1.png'));
    await saveShot(shots.solidPage2Url, test.info().outputPath('page2.png'));
    await saveShot(shots.parkMapUrl, test.info().outputPath('park-map.png'));

    expect(shots.solidPage1Url).toContain('data:image/png');
    expect(shots.solidPage2Url).toContain('data:image/png');
    expect(shots.parkMapUrl).toContain('data:image/png');
  });
});
