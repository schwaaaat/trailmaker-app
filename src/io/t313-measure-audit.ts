import { chromium } from '@playwright/test';
import { PDFDocument, rgb } from 'pdf-lib';
import sharp from 'sharp';
import { serializeProject, newProject, type StoredImage } from '../core/project';
import type { Anchor, Feature, MapImage, Project, Px } from '../core/types';

interface LongTaskRecord {
  start: number;
  dur: number;
  name?: string;
}

declare global {
  interface Window {
    __longTasks?: LongTaskRecord[];
    __mark?: number;
  }
}

async function generateAssets() {
  console.log('Generating test assets...');

  // 1. 3000x2200 PNG
  const png3000x2200Buffer = await sharp({
    create: {
      width: 3000,
      height: 2200,
      channels: 4,
      background: { r: 240, g: 235, b: 220, alpha: 1 },
    },
  })
    .png()
    .toBuffer();

  // 2. 10 MB JPEG
  // 4200x4200 with noise/gradient at high quality to reach ~10 MB
  const rawPixels = Buffer.alloc(4000 * 4000 * 3);
  for (let i = 0; i < rawPixels.length; i += 3) {
    rawPixels[i] = (i * 17) & 0xff;
    rawPixels[i + 1] = (i * 31) & 0xff;
    rawPixels[i + 2] = (i * 73) & 0xff;
  }
  const jpeg10MBBuffer = await sharp(rawPixels, {
    raw: { width: 4000, height: 4000, channels: 3 },
  })
    .jpeg({ quality: 92 })
    .toBuffer();

  console.log(`JPEG size: ${(jpeg10MBBuffer.length / 1024 / 1024).toFixed(2)} MB`);

  // 3. 5-page PDF (page 2 at 300 dpi equivalent, 2550x3300 pt)
  const pdfDoc = await PDFDocument.create();
  for (let i = 1; i <= 5; i++) {
    const page = pdfDoc.addPage([612, 792]);
    page.drawText(`Page ${i} of Park Map PDF`, {
      x: 50,
      y: 700,
      size: 24,
      color: rgb(0.2, 0.4, 0.2),
    });
    page.drawRectangle({
      x: 50,
      y: 200,
      width: 512,
      height: 450,
      color: rgb(0.95, 0.93, 0.88),
    });
  }
  const pdfBytes = await pdfDoc.save();

  // 4. .trailmaker project whose image is 10 MB
  const imgMeta: MapImage = {
    fileName: '10mb-map.jpg',
    width: 4000,
    height: 4000,
    originalWidth: 4000,
    originalHeight: 4000,
    source: { kind: 'image', mimeType: 'image/jpeg' },
    sha256: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  };
  const proj = newProject(imgMeta, 'Stress Project 10MB', new Date().toISOString());
  const stored: StoredImage = {
    bytes: new Uint8Array(jpeg10MBBuffer),
    mimeType: 'image/jpeg',
  };
  const trailmakerZip10MB = serializeProject(proj, stored);
  console.log(`Trailmaker zip size: ${(trailmakerZip10MB.length / 1024 / 1024).toFixed(2)} MB`);

  // 5. GPX import of 50k points
  let gpx50k = '<gpx version="1.1"><wpt lat="38.5" lon="-78.3"><name>W1</name></wpt><trk><name>50k Track</name><trkseg>';
  for (let i = 0; i < 50_000; i++) {
    gpx50k += `<trkpt lat="${(38.0 + i * 0.0001).toFixed(5)}" lon="-78.0"><ele>100</ele></trkpt>`;
  }
  gpx50k += '</trkseg></trk></gpx>';
  console.log(`GPX 50k size: ${(gpx50k.length / 1024 / 1024).toFixed(2)} MB`);

  return {
    png3000x2200Buffer,
    jpeg10MBBuffer,
    pdfBytes,
    trailmakerZip10MB,
    gpx50k,
    proj,
    stored,
  };
}

async function runAudit() {
  const assets = await generateAssets();

  const { createServer } = await import('vite');
  const server = await createServer({
    configFile: './vite.config.ts',
    server: { host: '127.0.0.1', port: 4192, strictPort: false },
  });

  server.middlewares.use((req, res, next) => {
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('Access-Control-Allow-Origin', '*');

    if (req.url === '/test-assets/png3000x2200') {
      res.setHeader('Content-Type', 'image/png');
      res.end(assets.png3000x2200Buffer);
      return;
    }
    if (req.url === '/test-assets/jpeg10mb') {
      res.setHeader('Content-Type', 'image/jpeg');
      res.end(assets.jpeg10MBBuffer);
      return;
    }
    if (req.url === '/test-assets/pdf5page') {
      res.setHeader('Content-Type', 'application/pdf');
      res.end(assets.pdfBytes);
      return;
    }
    if (req.url === '/test-assets/trailmaker10mb') {
      res.setHeader('Content-Type', 'application/octet-stream');
      res.end(assets.trailmakerZip10MB);
      return;
    }
    if (req.url === '/test-assets/gpx50k') {
      res.setHeader('Content-Type', 'application/gpx+xml');
      res.end(assets.gpx50k);
      return;
    }
    next();
  });

  await server.listen();
  const address = server.httpServer?.address();
  const port = typeof address === 'object' && address ? address.port : 4192;
  const baseUrl = `http://127.0.0.1:${port}`;
  console.log(`Vite server listening on ${baseUrl}`);

  console.log('Launching Chromium with real GPU flags (headed)...');
  const browser = await chromium.launch({
    headless: false,
    args: [
      '--enable-gpu',
      '--use-angle=d3d11',
      '--ignore-gpu-blocklist',
      '--enable-webgl',
    ],
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });
  const page = await context.newPage();
  page.on('console', (msg) => console.log('  [Browser]', msg.text()));

  await page.route('**/test-assets/png3000x2200', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'image/png',
      body: assets.png3000x2200Buffer,
    });
  });
  await page.route('**/test-assets/jpeg10mb', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'image/jpeg',
      body: assets.jpeg10MBBuffer,
    });
  });
  await page.route('**/test-assets/pdf5page', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/pdf',
      body: Buffer.from(assets.pdfBytes),
    });
  });
  await page.route('**/test-assets/trailmaker10mb', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/octet-stream',
      body: Buffer.from(assets.trailmakerZip10MB),
    });
  });
  await page.route('**/test-assets/gpx50k', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/gpx+xml',
      body: assets.gpx50k,
    });
  });

  await page.goto(baseUrl);

  // Inject performance observer for long tasks
  await page.evaluate(() => {
    window.__longTasks = [];
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        window.__longTasks?.push({
          start: entry.startTime,
          dur: entry.duration,
          name: entry.name,
        });
      }
    });
    observer.observe({ type: 'longtask', buffered: true });
  });

  console.log('\n--- Real-GPU Performance Audit (T-313 Acceptance 1 & 2) ---');

  // Helper to measure in-page actions
  const measureAction = async <T>(
    label: string,
    action: () => Promise<T>,
  ) => {
    await page.evaluate(() => {
      window.__mark = performance.now();
      window.__longTasks = [];
    });

    const wallStart = Date.now();
    const result = await action();
    const wallMs = Date.now() - wallStart;

    await page.waitForTimeout(100);

    const longTasks = await page.evaluate(() => {
      return window.__longTasks ?? [];
    });

    const maxTask = longTasks.length > 0 ? Math.max(...longTasks.map((t) => t.dur)) : 0;
    const taskCount = longTasks.length;

    console.log(
      `| ${label.padEnd(42)} | Wall: ${wallMs.toString().padStart(5)} ms | Long tasks: ${taskCount.toString().padStart(2)} | Max task: ${maxTask.toFixed(1).padStart(5)} ms | Status: ${maxTask <= 50 ? 'PASS (<=50ms)' : 'OVER BUDGET'}`
    );
    if (taskCount > 0) {
      console.log('   -> Long tasks:', JSON.stringify(longTasks));
    }

    return { label, wallMs, taskCount, maxTask, result };
  };

  // 1. Image Decode: 3000x2200 PNG
  await measureAction('Open 3000x2200 PNG (file/drop/paste)', async () => {
    return page.evaluate(async () => {
      const res = await fetch('/test-assets/png3000x2200');
      const blob = await res.blob();
      const file = new File([blob], 'map-3000x2200.png', { type: 'image/png' });
      const { loadImageFile } = await import('/src/io/image.ts' as string);
      const loaded = await loadImageFile(file, file.name);
      return { width: loaded.meta.width, height: loaded.meta.height };
    });
  });

  // 2. Image Decode: 10 MB JPEG
  await measureAction('Open 10 MB JPEG (file/drop/paste)', async () => {
    return page.evaluate(async () => {
      const res = await fetch('/test-assets/jpeg10mb');
      const blob = await res.blob();
      const file = new File([blob], 'map-10mb.jpg', { type: 'image/jpeg' });
      const { loadImageFile } = await import('/src/io/image.ts' as string);
      const loaded = await loadImageFile(file, file.name);
      return { width: loaded.meta.width, height: loaded.meta.height };
    });
  });

  // 3. PDF page picker thumbnails and render (5-page PDF, page 2 at 300 dpi)
  await measureAction('PDF render page 2 at 300 dpi', async () => {
    return page.evaluate(async () => {
      const res = await fetch('/test-assets/pdf5page');
      const blob = await res.blob();
      const file = new File([blob], 'survey.pdf', { type: 'application/pdf' });
      const { loadPdfFile } = await import('/src/io/pdf.ts' as string);
      const loaded = await loadPdfFile(file, file.name, 2);
      return { pageCount: loaded.pdf?.pageCount, width: loaded.meta.width };
    });
  });

  // 4. Project save: 10 MB image .trailmaker zip
  await measureAction('Project save (10 MB .trailmaker async zip)', async () => {
    return page.evaluate(async () => {
      const res = await fetch('/test-assets/jpeg10mb');
      const buffer = await res.arrayBuffer();
      const { serializeProjectAsync, newProject } = await import('/src/core/project/index.ts' as string);
      const imgMeta = {
        fileName: '10mb-map.jpg',
        width: 4000,
        height: 4000,
        originalWidth: 4000,
        originalHeight: 4000,
        source: { kind: 'image' as const, mimeType: 'image/jpeg' },
        sha256: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      };
      const proj = newProject(imgMeta, 'Stress Project 10MB', new Date().toISOString());
      const stored = { bytes: new Uint8Array(buffer), mimeType: 'image/jpeg' };
      const zip = await serializeProjectAsync(proj, stored);
      return { length: zip.byteLength };
    });
  });

  // 5. Project open: 10 MB image .trailmaker async unzip
  await measureAction('Project open (10 MB .trailmaker async unzip)', async () => {
    return page.evaluate(async () => {
      const res = await fetch('/test-assets/trailmaker10mb');
      const buffer = await res.arrayBuffer();
      const { deserializeProjectAsync } = await import('/src/core/project/index.ts' as string);
      const resProj = await deserializeProjectAsync(new Uint8Array(buffer));
      return { name: resProj.project.name, byteLength: resProj.image.bytes.length };
    });
  });

  // 6. Autosave write (with 10 MB image)
  await measureAction('Autosave write (IndexedDB with 10 MB image)', async () => {
    return page.evaluate(async () => {
      const res = await fetch('/test-assets/jpeg10mb');
      const blob = await res.blob();
      const { getDb, STORE_NAME } = await import('/src/io/autosave.ts' as string);
      const { newProject } = await import('/src/core/project/index.ts' as string);
      const db = await getDb();
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const imgMeta = {
        fileName: '10mb-map.jpg',
        width: 4000,
        height: 4000,
        originalWidth: 4000,
        originalHeight: 4000,
        source: { kind: 'image' as const, mimeType: 'image/jpeg' },
        sha256: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      };
      const proj = newProject(imgMeta, 'Stress Project 10MB', new Date().toISOString());
      await store.put(proj, 'project');
      await store.put(blob, 'image');
      await store.put(proj.image.sha256, 'image_sha256');
      await tx.done;
      return { done: true };
    });
  });

  // 7. Autosave restore (with 10 MB image)
  await measureAction('Autosave restore (IndexedDB readAutosave)', async () => {
    return page.evaluate(async () => {
      const { readAutosave } = await import('/src/io/autosave.ts' as string);
      const result = await readAutosave();
      return { hasProject: !!result?.project, hasImage: !!result?.imageBlob };
    });
  });

  // 8. GPX import of 50k points
  await measureAction('GPX import of 50k points (parseGpx)', async () => {
    return page.evaluate(async () => {
      const res = await fetch('/test-assets/gpx50k');
      const gpxText = await res.text();
      const { parseGpx } = await import('/src/io/gpx.ts' as string);
      await new Promise((r) => setTimeout(r, 0));
      const t0 = performance.now();
      const parsed = parseGpx(gpxText, 'huge-50k.gpx');
      const parseDuration = performance.now() - t0;
      console.log(`[Browser] parseGpx pure CPU duration: ${parseDuration.toFixed(2)} ms`);
      return {
        pointCount: parsed.ok ? parsed.points.length : 0,
        trackCount: parsed.ok ? parsed.tracks.length : 0,
        parseDuration,
      };
    });
  });

  // 9. OverlayPreview sliced export document steps (Acceptance 5 / D-025 item 4)
  await measureAction('OverlayPreview exportDocumentSteps (sliced)', async () => {
    return page.evaluate(async () => {
      const { exportDocumentSteps } = await import('/src/core/export/document.ts' as string);
      const { runSliced } = await import('/src/ui/editor/slice.ts' as string);
      const { fitAnchors } = await import('/src/core/geo/fit.ts' as string);
      const { newProject } = await import('/src/core/project/index.ts' as string);

      // Build stress project (2,000 trails x 50 vertices)
      const features: Feature[] = [];
      for (let i = 0; i < 2000; i++) {
        const pts: Px[] = [];
        for (let j = 0; j < 50; j++) {
          pts.push([i + j, i * 2 + j]);
        }
        features.push({
          id: `f-${i}`,
          name: `Trail ${i}`,
          color: '#ff0000',
          notes: '',
          kind: 'trail',
          pts,
          ink: null,
        });
      }
      const anchors: Anchor[] = [
        { id: 'a1', px: [0, 0], ll: [38.0, -78.0], source: 'paste' },
        { id: 'a2', px: [3000, 0], ll: [38.0, -77.0], source: 'paste' },
        { id: 'a3', px: [3000, 2200], ll: [37.0, -77.0], source: 'paste' },
        { id: 'a4', px: [0, 2200], ll: [37.0, -78.0], source: 'paste' },
      ];
      const fit = fitAnchors(anchors, 3000, 2200, 'affine');
      const baseProj = newProject(
        {
          fileName: 'stress.png',
          width: 3000,
          height: 2200,
          originalWidth: 3000,
          originalHeight: 2200,
          source: { kind: 'image', mimeType: 'image/png' },
          sha256: '0000000000000000000000000000000000000000000000000000000000000000',
        },
        'Stress 2k',
        '2026-09-27T00:00:00.000Z'
      );
      const proj: Project = {
        ...baseProj,
        anchors,
        fitMethod: 'affine',
        features,
        units: 'mi',
      };

      const doc = await runSliced(exportDocumentSteps(proj, fit));
      return { featureCount: doc.features.length };
    });
  });

  await browser.close();
  await server.close();
  console.log('\nAudit complete.');
}

runAudit().catch(console.error);
