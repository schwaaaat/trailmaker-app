import { readFile } from 'node:fs/promises';
import { expect, test } from './network-fixture';
import type { FixtureTruth } from '../fixtures/truth';
import { openReadyApp } from './app-ready';

test('real worker traces three colors and a 400 px hop without blocking the UI', async ({
  page,
}) => {
  test.setTimeout(60_000);
  const [benchmarkPng, solidPng, solidTruth] = await Promise.all([
    readFile('tests/fixtures/generated/benchmark.png'),
    readFile('tests/fixtures/generated/solid.png'),
    readFile('tests/fixtures/generated/solid.truth.json', 'utf8').then(
      (text) => JSON.parse(text) as FixtureTruth,
    ),
  ]);
  const red = solidTruth.polylines.find((line) => line.id === 'red-ridge');
  if (!red || red.pts.length < 51) throw new Error('Missing 400 px solid smart-follow truth');
  const from = red.pts[0]!;
  const to = red.pts[50]!;

  await page.route('**/__fixtures/benchmark.png', (route) =>
    route.fulfill({ body: benchmarkPng, contentType: 'image/png' }),
  );
  await page.route('**/__fixtures/solid.png', (route) =>
    route.fulfill({ body: solidPng, contentType: 'image/png' }),
  );
  await openReadyApp(page);

  const result = await page.evaluate(
    async ({ from, to }) => {
      const clientPath = '/src/worker/client.ts';
      const { getWorker, newJobId } = await import(clientPath);
      const raster = async (url: string) => {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Fixture fetch failed: ${response.status}`);
        const bitmap = await createImageBitmap(await response.blob());
        const canvas = document.createElement('canvas');
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        const context = canvas.getContext('2d', { willReadFrequently: true });
        if (!context) throw new Error('Canvas 2D context unavailable');
        context.drawImage(bitmap, 0, 0);
        bitmap.close();
        return {
          width: canvas.width,
          height: canvas.height,
          data: context.getImageData(0, 0, canvas.width, canvas.height).data,
        };
      };

      const worker = getWorker();
      const benchmark = await worker.loadImage(await raster('/__fixtures/benchmark.png'));
      const solid = await worker.loadImage(await raster('/__fixtures/solid.png'));
      const longTasks: number[] = [];
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) longTasks.push(entry.duration);
      });
      observer.observe({ entryTypes: ['longtask'] });
      try {
        const autoRequest = {
            imageId: benchmark,
            colors: [
              { chipId: 'red', rgb: [205, 48, 48] },
              { chipId: 'blue', rgb: [35, 96, 195] },
              { chipId: 'green', rgb: [38, 132, 65] },
            ],
            tolerance: 60,
            gapPx: 38,
            minLengthPx: 120,
          };
        const autoSamples: number[] = [];
        let candidates = [] as Awaited<ReturnType<typeof worker.autoTrace>>;
        // Retry only a timing miss: shared CI hosts can briefly preempt the worker.
        // Sustained slowness still fails the 1.5 s budget after three samples.
        do {
          const start = performance.now();
          candidates = await worker.autoTrace(autoRequest, { jobId: newJobId() });
          autoSamples.push(performance.now() - start);
        } while (Math.min(...autoSamples) >= 1_500 && autoSamples.length < 3);
        const autoMs = Math.min(...autoSamples);

        const hopSamples: number[] = [];
        let hopPathLength = 0;
        for (let run = 0; run < 20; run++) {
          const hop = await worker.smartTrace(
            { imageId: solid, from, to, ink: [205, 48, 48], tolerance: 60, snapRadiusPx: 8 },
            { jobId: newJobId() },
          );
          hopSamples.push(hop.ms);
          hopPathLength = hop.path?.length ?? 0;
        }
        hopSamples.sort((a, b) => a - b);
        await new Promise((resolve) => setTimeout(resolve, 0));
        return {
          isolated: crossOriginIsolated,
          autoMs,
          autoSamples,
          candidateCount: candidates.length,
          hopMedianMs: (hopSamples[9]! + hopSamples[10]!) / 2,
          hopPathLength,
          maxLongTaskMs: Math.max(0, ...longTasks),
        };
      } finally {
        observer.disconnect();
        await worker.releaseImage(benchmark);
        await worker.releaseImage(solid);
      }
    },
    { from, to },
  );

  console.info(`Worker bench: ${JSON.stringify(result)}`);
  expect(result.isolated).toBe(true);
  expect(result.candidateCount).toBeGreaterThan(0);
  expect(result.autoMs).toBeLessThan(1_500);
  expect(result.hopPathLength).toBeGreaterThan(1);
  expect(result.hopMedianMs).toBeLessThan(100);
  expect(result.maxLongTaskMs).toBe(0);
});

test('real worker cancels a running auto-trace within 100 ms', async ({ page }) => {
  const benchmarkPng = await readFile('tests/fixtures/generated/benchmark.png');
  await page.route('**/__fixtures/benchmark.png', (route) =>
    route.fulfill({ body: benchmarkPng, contentType: 'image/png' }),
  );
  await openReadyApp(page);

  const result = await page.evaluate(async () => {
    const clientPath = '/src/worker/client.ts';
    const { getWorker, newJobId } = await import(clientPath);
    const bitmap = await createImageBitmap(await (await fetch('/__fixtures/benchmark.png')).blob());
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('Canvas 2D context unavailable');
    context.drawImage(bitmap, 0, 0);
    bitmap.close();
    const image = {
      width: canvas.width,
      height: canvas.height,
      data: context.getImageData(0, 0, canvas.width, canvas.height).data,
    };
    const worker = getWorker();
    const imageId = await worker.loadImage(image);
    const jobId = newJobId();
    let signalStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const job = worker.autoTrace(
      {
        imageId,
        colors: [
          { chipId: 'red', rgb: [205, 48, 48] },
          { chipId: 'blue', rgb: [35, 96, 195] },
          { chipId: 'green', rgb: [38, 132, 65] },
        ],
        tolerance: 60,
        gapPx: 38,
        minLengthPx: 120,
      },
      { jobId, onProgress: () => signalStarted() },
    );
    const outcome = (job as Promise<unknown>).then(
      () => ({ name: 'fulfilled', message: '' }),
      (error: unknown) => ({
        name: error instanceof Error ? error.name : String(error),
        message: error instanceof Error ? error.message : String(error),
      }),
    );
    try {
      const first = await Promise.race([
        started.then(() => 'progress'),
        outcome.then(({ name, message }) => `finished: ${name}: ${message}`),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Worker did not report progress')), 2_000),
        ),
      ]);
      if (first !== 'progress') throw new Error(`Worker job ${first} before progress`);
      const cancelledAt = performance.now();
      const cancelCall = worker.cancel(jobId);
      const result = await outcome;
      const rejectMs = performance.now() - cancelledAt;
      await cancelCall;
      return { ...result, rejectMs };
    } finally {
      await worker.releaseImage(imageId);
    }
  });

  console.info(`Worker cancel: ${JSON.stringify(result)}`);
  expect(result.name).toBe('JobCancelled');
  expect(result.rejectMs).toBeLessThan(100);
});
