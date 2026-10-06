import { readFile } from 'node:fs/promises';
import { expect, test } from './network-fixture';
import type { GeoFeature, JobProgress, KmzRequest } from '../../src/core/types';
import type { Remote } from 'comlink';
import type { WorkerApi } from '../../src/core/types';
import { hausdorff } from '../metrics/geometry';
import type { FixtureTruth } from '../fixtures/truth';
import { openReadyApp } from './app-ready';

test('real worker cancels a stress KMZ build within 100 ms [T-207]', async ({ page }) => {
  test.setTimeout(60_000);
  await openReadyApp(page);

  const result = await page.evaluate(async () => {
    const worker = (window as Window & { __trailmakerWorker?: Remote<WorkerApi> })
      .__trailmakerWorker;
    if (!worker) throw new Error('Test-mode worker is unavailable');
    // Build the T-106 4096 px noisy JPEG before starting the timed worker job.
    const side = 4096;
    const canvas = new OffscreenCanvas(side, side);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('OffscreenCanvas 2D context unavailable');
    const pixels = context.createImageData(side, side);
    let imageSeed = 0x9e3779b9;
    for (let i = 0; i < pixels.data.length; i += 4) {
      for (let channel = 0; channel < 3; channel++) {
        imageSeed ^= imageSeed << 13;
        imageSeed ^= imageSeed >>> 17;
        imageSeed ^= imageSeed << 5;
        pixels.data[i + channel] = imageSeed & 0xff;
      }
      pixels.data[i + 3] = 255;
    }
    context.putImageData(pixels, 0, 0);
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.78 });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const features: GeoFeature[] = [];
    let seed = 7;
    const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let trail = 0; trail < 2000; trail++) {
      let lat = 37.7 + random() * 0.1;
      let lon = -119.6 + random() * 0.1;
      const ll: [number, number][] = [];
      for (let vertex = 0; vertex < 50; vertex++) {
        lat += (random() - 0.5) * 1e-4;
        lon += (random() - 0.5) * 1e-4;
        ll.push([lat, lon]);
      }
      features.push({
        kind: 'trail',
        id: `f${trail}`,
        name: `Trail ${trail}`,
        color: '#D9480F',
        notes: '',
        pts: [],
        ink: null,
        ll,
        lengthM: 1000 + trail,
      });
    }
    const request: KmzRequest = {
      doc: { name: 'Stress', features },
      options: { units: 'mi', time: '2026-09-24T12:00:00.000Z' },
      overlayImage: { bytes, ext: 'jpg' },
      quad: [
        [37.72, -119.56],
        [37.72, -119.54],
        [37.735, -119.54],
        [37.735, -119.56],
      ],
    };
    const jobId = crypto.randomUUID() as Parameters<WorkerApi['cancel']>[0];
    let signalStarted!: (stage: string) => void;
    const started = new Promise<string>((resolve) => {
      signalStarted = resolve;
    });
    const job = worker.buildKmz(request, {
      jobId,
      onProgress: (event: JobProgress) => {
        signalStarted(event.stage);
      },
    });
    const outcome = (job as Promise<unknown>).then(
      () => ({ name: 'fulfilled', message: '' }),
      (error: unknown) => ({
        name: error instanceof Error ? error.name : String(error),
        message: error instanceof Error ? error.message : String(error),
      }),
    );
    const first = await Promise.race([
      started.then((stage) => ({ kind: 'progress', stage })),
      outcome.then(({ name }) => ({ kind: 'finished', stage: name })),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('KMZ writer did not report progress')), 5_000),
      ),
    ]);
    if (first.kind !== 'progress') throw new Error(`KMZ job ${first.stage} before progress`);
    // The initial progress message is emitted just before the synchronous writer begins.
    // Give it time to enter KML generation, then require that the job is still running.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const alreadySettled = await Promise.race([
      outcome.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 0)),
    ]);
    if (alreadySettled) throw new Error('Stress KMZ completed before running cancellation');
    const cancelledAt = performance.now();
    const cancelCall = worker.cancel(jobId);
    const settled = await outcome;
    const rejectMs = performance.now() - cancelledAt;
    await cancelCall;
    return { ...settled, rejectMs, stage: first.stage, jpegBytes: bytes.byteLength };
  });

  console.info(`Worker KMZ cancel: ${JSON.stringify(result)}`);
  expect(result.name).toBe('JobCancelled');
  expect(result.rejectMs).toBeLessThan(100);
  expect(result.jpegBytes).toBeGreaterThan(1_000_000);
});

test('real worker smart-follow, scan, cancel, rerun and accept without a loader [T-206]', async ({
  page,
}) => {
  test.setTimeout(60_000);
  const [png, truth] = await Promise.all([
    readFile('tests/fixtures/generated/solid.png'),
    readFile('tests/fixtures/generated/solid.truth.json', 'utf8').then(
      (value) => JSON.parse(value) as FixtureTruth,
    ),
  ]);
  const red = truth.polylines.find((line) => line.id === 'red-ridge');
  if (!red || red.pts.length < 87) throw new Error('Missing red-ridge fixture truth');

  await page.route('**/__fixtures/solid.png', (route) =>
    route.fulfill({ body: png, contentType: 'image/png' }),
  );
  await openReadyApp(page);
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
  await page.evaluate(async () => {
    const response = await fetch('/__fixtures/solid.png');
    if (!response.ok) throw new Error(`Fixture fetch failed: ${response.status}`);
    const blob = await response.blob();
    const display = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(display.width, display.height);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('OffscreenCanvas 2D context unavailable');
    context.drawImage(display, 0, 0);
    const bytes = await blob.arrayBuffer();
    const hash = await crypto.subtle.digest('SHA-256', bytes);
    const sha256 = [...new Uint8Array(hash)]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
    const meta = {
      fileName: 'solid.png',
      width: display.width,
      height: display.height,
      originalWidth: display.width,
      originalHeight: display.height,
      source: { kind: 'image' as const, mimeType: 'image/png' },
      sha256,
    };
    const project = {
      version: 4 as const,
      name: 'Solid fixture',
      image: meta,
      anchors: [],
      fitMethod: 'auto' as const,
      features: [],
      units: 'mi' as const,
      trace: { smartFollow: true, tolerance: 60, ink: null },
      autoTrace: { chips: [], gapPx: 10, minLengthPct: 4 },
      seq: 1,
      updatedAt: '2026-09-25T12:00:00Z',
    };
    window.__trailmaker!.session.openSession({
      project,
      map: {
        meta,
        display,
        raster: {
          width: display.width,
          height: display.height,
          data: context.getImageData(0, 0, display.width, display.height).data,
        },
        original: blob,
        pdf: null,
      },
    });
    await window.__trailmaker!.idle();
  });

  const toolbar = page.getByRole('toolbar', { name: 'Map tools' });
  const trace = page.getByRole('region', { name: 'Trace' });
  await toolbar.getByRole('button', { name: 'Trail', exact: true }).click();
  for (const index of [0, 20, 43, 65, 86]) {
    const at = await page.evaluate((px) => window.__trailmaker!.imageToClient(px), red.pts[index]!);
    await page.mouse.click(at.x, at.y);
    await page.evaluate(() => window.__trailmaker!.idle());
  }
  await page.keyboard.press('Enter');
  await page.evaluate(() => window.__trailmaker!.idle());
  const manual = await page.evaluate(
    () => window.__trailmaker!.session.getSession()!.project.features[0],
  );
  expect(manual?.kind).toBe('trail');
  if (manual?.kind !== 'trail') throw new Error('Smart follow did not create a trail');
  expect(manual.ink).toEqual([205, 48, 48]);
  expect(hausdorff(manual.pts, red.pts)).toBeLessThanOrEqual(2);

  await trace.getByRole('button', { name: 'Scan map colors' }).click();
  await page.evaluate(() => window.__trailmaker!.idle());
  const chips = await page.evaluate(
    () => window.__trailmaker!.session.getSession()!.project.autoTrace.chips,
  );
  const list = trace.getByRole('list', { name: 'Trail colors' });
  expect(chips.length).toBeGreaterThanOrEqual(2);
  for (let index = 0; index < chips.length; index++) {
    const chip = chips[index]!;
    const use = [red, truth.polylines.find((line) => line.id === 'blue-creek')!].some(
      (line) => Math.hypot(...line.color.map((value, channel) => value - chip.rgb[channel]!)) <= 30,
    );
    const checkbox = list
      .locator('li')
      .nth(index)
      .getByRole('checkbox', { name: 'Use this color' });
    if (use) await checkbox.check();
    else await checkbox.uncheck();
  }

  await trace.getByRole('button', { name: 'Find trails' }).click();
  const progress = trace.getByRole('progressbar', { name: 'Finding trails' });
  await expect(progress).toBeVisible();
  const frameMs = await page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        const start = performance.now();
        requestAnimationFrame(() => resolve(performance.now() - start));
      }),
  );
  expect(frameMs).toBeLessThan(50);
  await trace.getByRole('button', { name: 'Cancel' }).click();
  await page.evaluate(() => window.__trailmaker!.idle());
  await expect(progress).toHaveCount(0);
  await expect(trace.getByRole('group', { name: 'Found lines' })).toHaveCount(0);
  await expect(page.getByText(/went wrong while finding lines/i)).toHaveCount(0);

  await trace.getByRole('button', { name: 'Find trails' }).click();
  await page.evaluate(() => window.__trailmaker!.idle());
  const found = trace.getByRole('group', { name: 'Found lines' });
  await expect(found.getByRole('checkbox')).toHaveCount(2);
  const beforeAccept = await page.evaluate(() =>
    JSON.stringify(window.__trailmaker!.session.getSession()!.project),
  );
  await found.getByRole('button', { name: 'Add 2 as trails' }).click();
  const afterAccept = await page.evaluate(() => window.__trailmaker!.session.getSession()!.project);
  expect(afterAccept.features).toHaveLength(3);
  await toolbar.getByRole('button', { name: 'Undo' }).click();
  expect(
    await page.evaluate(() => JSON.stringify(window.__trailmaker!.session.getSession()!.project)),
  ).toBe(beforeAccept);
});
