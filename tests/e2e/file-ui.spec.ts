import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, test } from './network-fixture';

test.describe('T-304 File UI and Open Routing', () => {
  test('opening a PNG, a PDF (page 2) and a saved .trailmaker round trip', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Trailmaker', exact: true })).toBeVisible();

    const pngBytes = await readFile(resolve(process.cwd(), 'tests/fixtures/generated/solid.png'));
    const pdfBytes = await readFile(resolve(process.cwd(), 'tests/fixtures/generated/solid.pdf'));

    // Step 1: Open PNG via openFileBlob
    const pngResult = await page.evaluate(async (bytesArray) => {
      const { openFileBlob } = await import('/src/ui/files/index.ts' as string);
      const bridge = window.__trailmaker!.session;

      const blob = new Blob([new Uint8Array(bytesArray)], { type: 'image/png' });
      const ok = await openFileBlob(blob, 'solid.png', { bridge });

      const session = bridge.getSession();
      return {
        ok,
        hasSession: Boolean(session),
        name: session?.project.name,
        kind: session?.project.image.source.kind,
        width: session?.project.image.width,
        height: session?.project.image.height,
      };
    }, Array.from(pngBytes));

    expect(pngResult.ok).toBe(true);
    expect(pngResult.hasSession).toBe(true);
    expect(pngResult.name).toBe('solid');
    expect(pngResult.kind).toBe('image');
    expect(pngResult.width).toBe(800);
    expect(pngResult.height).toBe(600);

    // Step 2: Open PDF and switch to page 2
    const pdfResult = await page.evaluate(async (bytesArray) => {
      const { openFileBlob } = await import('/src/ui/files/index.ts' as string);
      const bridge = window.__trailmaker!.session;

      const blob = new Blob([new Uint8Array(bytesArray)], { type: 'application/pdf' });
      const ok = await openFileBlob(blob, 'solid.pdf', { bridge });

      const session1 = bridge.getSession()!;
      const page1 = session1.project.image.source.kind === 'pdf' ? session1.project.image.source.page : 0;
      const pageCount = session1.map.pdf?.pageCount ?? 0;

      // Render page 2
      const page2Map = await session1.map.pdf!.renderPage(2);
      bridge.openSession({
        project: {
          ...session1.project,
          image: page2Map.meta,
          anchors: [],
          features: [],
        },
        map: page2Map,
      });

      const session2 = bridge.getSession()!;
      const page2 = session2.project.image.source.kind === 'pdf' ? session2.project.image.source.page : 0;

      return {
        ok,
        page1,
        page2,
        pageCount,
        p2Width: page2Map.meta.width,
        p2Height: page2Map.meta.height,
      };
    }, Array.from(pdfBytes));

    expect(pdfResult.ok).toBe(true);
    expect(pdfResult.page1).toBe(1);
    expect(pdfResult.page2).toBe(2);
    expect(pdfResult.pageCount).toBe(2);

    // Step 3: Add feature, serialize to .trailmaker, and reload roundtrip
    const trailmakerRoundtrip = await page.evaluate(async () => {
      const { serializeProject } = await import('/src/core/project/index.ts' as string);
      const { openFileBlob } = await import('/src/ui/files/index.ts' as string);
      const bridge = window.__trailmaker!.session;
      const current = bridge.getSession()!;

      // Add a test trail feature
      const projectWithFeature = {
        ...current.project,
        name: 'Roundtrip Park',
        features: [
          {
            id: 'trail-1',
            name: 'Summit Trail',
            color: '#e63946',
            notes: 'Beautiful ridge walk',
            kind: 'trail' as const,
            pts: [
              [100, 100] as const,
              [200, 200] as const,
              [300, 250] as const,
            ],
            ink: null,
          },
        ],
      };

      const originalBytes = new Uint8Array(await current.map.original.arrayBuffer());
      const zipBytes = serializeProject(projectWithFeature, {
        bytes: originalBytes,
        mimeType: 'application/pdf',
      });

      // Clear session
      (bridge as unknown as { openSession: (s: unknown) => void }).openSession(null);
      const wasCleared = bridge.getSession() === null;

      // Open .trailmaker
      const blob = new Blob([zipBytes], { type: 'application/octet-stream' });
      const ok = await openFileBlob(blob, 'Pine.trailmaker', { bridge });
      const restored = bridge.getSession()!;

      const feat = restored.project.features[0];
      const featurePts = feat && feat.kind === 'trail' ? feat.pts.length : 0;

      return {
        ok,
        wasCleared,
        name: restored.project.name,
        featureCount: restored.project.features.length,
        featureName: feat?.name,
        featurePts,
        sourceKind: restored.project.image.source.kind,
      };
    });

    expect(trailmakerRoundtrip.wasCleared).toBe(true);
    expect(trailmakerRoundtrip.ok).toBe(true);
    expect(trailmakerRoundtrip.name).toBe('Roundtrip Park');
    expect(trailmakerRoundtrip.featureCount).toBe(1);
    expect(trailmakerRoundtrip.featureName).toBe('Summit Trail');
    expect(trailmakerRoundtrip.featurePts).toBe(3);
    expect(trailmakerRoundtrip.sourceKind).toBe('pdf');
  });

  test('captures screenshots of empty state, drag-over state, replace-arm state, and page picker to the test output folder', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Trailmaker', exact: true })).toBeVisible();

    const host = page.locator('#test-file-ui-host');

    // 1. Screenshot: Empty State
    await page.evaluate(async () => {
      await import('/src/ui/files/index.ts' as string);
      const { mountMapDropZone } = (await import(
        '/src/ui/files/testMount.ts' as string
      )) as typeof import('../../src/ui/files/testMount');
      const bridge = window.__trailmaker!.session;
      (bridge as unknown as { openSession: (s: unknown) => void }).openSession(null);

      let hostEl = document.getElementById('test-file-ui-host');
      if (!hostEl) {
        hostEl = document.createElement('div');
        hostEl.id = 'test-file-ui-host';
        hostEl.style.position = 'fixed';
        hostEl.style.top = '70px';
        hostEl.style.left = '320px';
        hostEl.style.right = '20px';
        hostEl.style.bottom = '20px';
        hostEl.style.background = '#f5f5f0';
        hostEl.style.zIndex = '100';
        document.body.appendChild(hostEl);
      }
      hostEl.innerHTML = '';
      mountMapDropZone(hostEl, bridge);
    });

    await expect(host.locator('.map-drop-zone')).toBeVisible();
    await expect(host.locator('#empty')).toBeVisible();
    await expect(host.getByRole('heading', { name: 'Drop a park map here' })).toBeVisible();

    const emptyDrop = host.locator('.drop');
    const initialBorderColor = await emptyDrop.evaluate((el) => window.getComputedStyle(el).borderColor);

    const emptyShot = await host.screenshot();
    await writeFile(test.info().outputPath('empty-state.png'), emptyShot);

    // 2. Screenshot: Drag-over state
    // Mount real MapDropZone, trigger a drag event, assert a visible style change
    await page.evaluate(() => {
      const dropZone = document.querySelector('#test-file-ui-host .map-drop-zone');
      if (!dropZone) throw new Error('Drop zone not found');
      const dt = new DataTransfer();
      dt.items.add(new File(['dummy'], 'park-map.png', { type: 'image/png' }));
      dropZone.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: dt }));
      dropZone.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
    });

    await expect(host.locator('.map-drop-zone')).toHaveClass(/drag-over/);

    // Wait for CSS transition to finish and assert visible style change
    await expect(emptyDrop).toHaveCSS('border-color', 'rgb(242, 181, 49)');

    const dragBorderColor = await emptyDrop.evaluate((el) => window.getComputedStyle(el).borderColor);
    expect(dragBorderColor).not.toBe(initialBorderColor);
    expect(dragBorderColor).toBe('rgb(242, 181, 49)'); // var(--blaze)

    const dragOverShot = await host.screenshot();
    expect(Buffer.compare(emptyShot, dragOverShot)).not.toBe(0);
    await writeFile(test.info().outputPath('drag-over.png'), dragOverShot);

    // 3. Screenshot: Replace-arm state ("Click again to replace this map")
    await page.evaluate(async () => {
      const { mountOpenMapButton } = (await import(
        '/src/ui/files/testMount.ts' as string
      )) as typeof import('../../src/ui/files/testMount');
      const bridge = window.__trailmaker!.session;
      const { loadImageFile } = (await import(
        '/src/io/image.ts' as string
      )) as typeof import('../../src/io/image');

      const canvas = document.createElement('canvas');
      canvas.width = 100;
      canvas.height = 100;
      const blob = await new Promise<Blob>((r) => canvas.toBlob((b) => r(b!), 'image/png'));
      const map = await loadImageFile(blob, 'park.png');

      bridge.openSession({
        project: {
          version: 4,
          name: 'Existing Park Map',
          image: map.meta,
          anchors: [
            { id: 'a1', px: [10, 10], ll: [40, -105], source: 'paste' },
          ],
          fitMethod: 'auto',
          features: [],
          units: 'mi',
          trace: { smartFollow: true, tolerance: 60, ink: null },
          autoTrace: { chips: [], gapPx: 20, minLengthPct: 4 },
          seq: 1,
          updatedAt: new Date().toISOString(),
        },
        map,
      });

      const hostEl = document.getElementById('test-file-ui-host')!;
      hostEl.innerHTML = '<div id="button-container" style="display:flex; justify-content:center; align-items:center; height:100%;"></div>';
      const btnHost = document.getElementById('button-container')!;
      mountOpenMapButton(btnHost, bridge, 'test-open-btn');
    });

    const openBtn = page.locator('#test-open-btn');
    await expect(openBtn).toBeVisible();
    await expect(openBtn).toHaveText('Open image or PDF');

    // Click to arm
    await openBtn.click();
    await expect(openBtn).toHaveText('Click again to replace this map');
    await expect(openBtn).toHaveClass(/arm/);

    const replaceArmShot = await host.screenshot();
    await writeFile(test.info().outputPath('replace-arm.png'), replaceArmShot);

    // 4. Screenshot: Multi-page PDF page picker
    const pdfBytes = await readFile(resolve(process.cwd(), 'tests/fixtures/generated/solid.pdf'));
    await page.evaluate(async (bytesArray) => {
      const { mountPdfPagePicker } = (await import(
        '/src/ui/files/testMount.ts' as string
      )) as typeof import('../../src/ui/files/testMount');
      const bridge = window.__trailmaker!.session;
      const { loadPdfFile } = (await import(
        '/src/io/pdf.ts' as string
      )) as typeof import('../../src/io/pdf');
      const blob = new Blob([new Uint8Array(bytesArray)], { type: 'application/pdf' });
      const map = await loadPdfFile(blob, 'solid.pdf', 1);

      bridge.openSession({
        project: {
          version: 4,
          name: 'Multi-page Park Map',
          image: map.meta,
          anchors: [],
          fitMethod: 'auto',
          features: [],
          units: 'mi',
          trace: { smartFollow: true, tolerance: 60, ink: null },
          autoTrace: { chips: [], gapPx: 20, minLengthPct: 4 },
          seq: 1,
          updatedAt: new Date().toISOString(),
        },
        map,
      });

      const hostEl = document.getElementById('test-file-ui-host')!;
      hostEl.innerHTML = `
        <div id="picker-container" style="display:flex; flex-direction:column; align-items:center; justify-content:center; height:100%; gap:16px;">
          <h2 style="font-family:serif; color:#2c3e50;">Park Map (PDF, 2 pages)</h2>
          <div id="picker-slot"></div>
        </div>
      `;
      const slot = document.getElementById('picker-slot')!;
      mountPdfPagePicker(slot, bridge);
    }, Array.from(pdfBytes));

    const pagePicker = host.locator('.page-picker');
    await expect(pagePicker).toBeVisible();
    await expect(pagePicker.getByRole('combobox', { name: 'Page' })).toBeVisible();

    const pagePickerShot = await host.screenshot();
    await writeFile(test.info().outputPath('page-picker.png'), pagePickerShot);
  });
});
