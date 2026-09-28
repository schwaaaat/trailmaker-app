// T-211 acceptance 3: long-task check at the 2,000 x 50 stress load in the isolated preview.
// Non-gating on SwiftShader (D-012 item 7): it records the max long task per action and only
// asserts that every action completed. Set TRAILMAKER_GPU=1 for real-GPU Chromium flags.
import { stat } from 'node:fs/promises';
import { expect, test } from './network-fixture';
import { openReadyApp } from './app-ready';

test.use({
  viewport: { width: 1280, height: 800 },
  deviceScaleFactor: 2,
  permissions: ['clipboard-read', 'clipboard-write'],
  launchOptions: {
    args: process.env.TRAILMAKER_GPU
      ? ['--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist']
      : [],
  },
});

type Probe = {
  since: number;
  tasks: { start: number; dur: number }[];
  frames: { at: number; dt: number }[];
};
type Sample = {
  action: string;
  maxTask: number;
  tasks: number;
  maxFrame: number;
  wallMs: number;
  bytes?: number;
};
type W = Window & { __t211?: Probe; __t211Session?: unknown };

test('stress load: record long tasks while open, zoom and exports complete [T-211]', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await openReadyApp(page);
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
  await page.evaluate(() => {
    const probe: Probe = { since: Infinity, tasks: [], frames: [] };
    (window as W).__t211 = probe;
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) probe.tasks.push({ start: e.startTime, dur: e.duration });
    }).observe({ type: 'longtask', buffered: false });
    let last = performance.now();
    const tick = (t: number) => {
      probe.frames.push({ at: t, dt: t - last });
      last = t;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

  // Only tasks and frames after the in-page start mark count: Playwright's own locator work
  // (name resolution and actionability over ~33k nodes) runs on the page's main thread and is
  // kept out of the window by resolving every element before the mark.
  const samples: Sample[] = [];
  const settleMs = 1_200; // trailing slices, the layer swap and the 500 ms idle junction hint
  const measure = async (action: string, run: () => Promise<number | void>) => {
    const t0 = Date.now();
    const bytes = await run();
    await page.waitForTimeout(settleMs);
    const r = await page.evaluate(() => {
      const p = (window as W).__t211!;
      const since = p.since;
      p.since = Infinity;
      return {
        // The triggering task can start before the in-page mark inside that same task.
        tasks: p.tasks.filter((t) => t.start + t.dur > since).map((t) => t.dur),
        frames: p.frames.filter((f) => f.at > since).map((f) => f.dt),
      };
    });
    samples.push({
      action,
      maxTask: Math.round(Math.max(0, ...r.tasks)),
      tasks: r.tasks.length,
      maxFrame: Math.round(Math.max(0, ...r.frames)),
      wallMs: Date.now() - t0 - settleMs,
      ...(typeof bytes === 'number' ? { bytes } : {}),
    });
  };
  const mark = () =>
    page.evaluate(() => {
      (window as W).__t211!.since = performance.now();
    });

  // Build the fixture outside the measured window; the window covers openSession + idle only.
  await page.evaluate(async () => {
    const W = 3000;
    const H = 2200;
    const canvas = new OffscreenCanvas(W, H);
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.fillStyle = '#f4efe2';
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = '#9bb58a';
    for (let i = 0; i < 60; i++) {
      ctx.beginPath();
      ctx.arc((i * 997) % W, (i * 613) % H, 80 + (i % 7) * 30, 0, Math.PI * 2);
      ctx.stroke();
    }
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    const display = await createImageBitmap(canvas);
    const data = ctx.getImageData(0, 0, W, H).data;
    const bytes = await blob.arrayBuffer();
    const hash = await crypto.subtle.digest('SHA-256', bytes);
    const sha256 = [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
    let seed = 211;
    const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
    const clamp = (v: number, hi: number) => Math.min(hi - 1, Math.max(1, v));
    const colors = ['#D9480F', '#1F6FB2', '#3A7D44', '#7B2CBF', '#E8590C'];
    const features: unknown[] = [];
    for (let i = 0; i < 2_000; i++) {
      let x = rnd() * W;
      let y = rnd() * H;
      let a = rnd() * Math.PI * 2;
      const pts: [number, number][] = [];
      for (let k = 0; k < 50; k++) {
        pts.push([clamp(x, W), clamp(y, H)]);
        a += (rnd() - 0.5) * 0.8;
        x += Math.cos(a) * 12;
        y += Math.sin(a) * 12;
      }
      const base = { id: `f${i}`, name: `Feature ${i}`, color: colors[i % 5]!, notes: '' };
      features.push(
        i % 10 === 9 ? { ...base, kind: 'area', pts } : { ...base, kind: 'trail', pts, ink: null },
      );
    }
    for (let i = 0; i < 20; i++) {
      features.push({
        id: `p${i}`,
        name: `POI ${i}`,
        color: '#1F6FB2',
        notes: '',
        kind: 'poi',
        at: [clamp(rnd() * W, W), clamp(rnd() * H, H)],
        poiType: 'Trailhead',
      });
    }
    // A plain affine map: lat falls with y, lon grows with x (no mirror, plausible scale).
    const ll = (x: number, y: number) => [44.6 - y * 2e-5, -110.6 + x * 2.8e-5] as const;
    const anchorPx: [number, number][] = [
      [200, 200],
      [2800, 220],
      [2780, 2000],
      [240, 1980],
      [1500, 1100],
      [900, 600],
    ];
    const anchors = anchorPx.map((px, i) => ({
      id: `a${i}`,
      px,
      ll: ll(px[0], px[1]),
      source: 'paste',
    }));
    const meta = {
      fileName: 'stress.png',
      width: W,
      height: H,
      originalWidth: W,
      originalHeight: H,
      source: { kind: 'image' as const, mimeType: 'image/png' },
      sha256,
    };
    (window as W).__t211Session = {
      project: {
        version: 1,
        name: 'Stress 2000x50',
        image: meta,
        anchors,
        fitMethod: 'auto',
        features,
        units: 'mi',
        trace: { smartFollow: true, tolerance: 60, ink: null },
        autoTrace: { chips: [], gapPx: 10, minLengthPct: 4 },
        seq: 3000,
        updatedAt: '2026-09-26T12:00:00Z',
      },
      map: { meta, display, raster: { width: W, height: H, data }, original: blob, pdf: null },
    };
  });
  await measure('open (openSession)', () =>
    page.evaluate(async () => {
      const w = window as W;
      w.__t211!.since = performance.now();
      w.__trailmaker!.session.openSession(w.__t211Session as never);
      delete w.__t211Session;
      await w.__trailmaker!.idle();
    }),
  );

  const box = (await page.locator('canvas').first().boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (const [action, dy] of [
    ['wheel zoom in x5 + settle', -240],
    ['wheel zoom out x5 + settle', 240],
  ] as const) {
    await measure(action, async () => {
      await mark();
      for (let i = 0; i < 5; i++) {
        await page.mouse.wheel(0, dy);
        await page.waitForTimeout(40);
      }
    });
  }

  const busyGone = () =>
    page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          const poll = () =>
            (document.querySelector('.busy') as HTMLElement | null)?.hidden
              ? resolve()
              : setTimeout(poll, 50);
          poll();
        }),
    );
  const exportAction = async (action: string, name: string, download: boolean) => {
    const button = page.getByRole('button', { name, exact: true });
    await button.scrollIntoViewIfNeeded();
    const handle = await button.elementHandle();
    await measure(action, async () => {
      const pending = download ? page.waitForEvent('download', { timeout: 60_000 }) : null;
      await handle!.evaluate((el) => {
        (window as W).__t211!.since = performance.now();
        (el as HTMLElement).click();
      });
      await busyGone();
      if (!pending) return;
      const file = await (await pending).path();
      return (await stat(file)).size;
    });
  };
  await exportAction('Download GPX', 'Download GPX', true);
  await exportAction('Download KML', 'Download KML', true);
  await exportAction('Download GeoJSON', 'Download GeoJSON', true);
  await exportAction('Download KMZ', 'Download KMZ with map overlay', true);
  await exportAction('Download all (.zip)', 'Download all (.zip)', true);
  await exportAction('Copy GPX', 'Copy GPX', false);
  await exportAction('Copy KML', 'Copy KML', false);

  const renderer = await page.evaluate(() => {
    const gl = document.createElement('canvas').getContext('webgl');
    const ext = gl?.getExtension('WEBGL_debug_renderer_info');
    return ext ? String(gl!.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : 'unknown';
  });
  console.log(`T-211 long tasks (renderer: ${renderer})`);
  console.table(samples);
  await test.info().attach('t211-longtasks.json', {
    body: JSON.stringify({ renderer, samples }, null, 2),
    contentType: 'application/json',
  });
  expect(samples).toHaveLength(10);
  // Each download carried the full export (a stalled or empty export would be tiny).
  for (const s of samples.filter((x) => x.bytes !== undefined))
    expect(s.bytes).toBeGreaterThan(500_000);
});
