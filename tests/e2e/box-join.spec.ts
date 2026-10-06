import { readFile } from 'node:fs/promises';
import { unzipSync } from 'fflate';
import { expect, test } from './network-fixture';
import { openReadyApp } from './app-ready';

test.use({ viewport: { width: 1280, height: 900 } });
type Page = Parameters<typeof openReadyApp>[0];
type Point = readonly [number, number];
type ProbeWindow = Window & {
  __boxJoinProbe?: { since: number; actionMs: number; tasks: number[] };
};

async function openTrails(page: Page, lines: readonly (readonly Point[])[], stress = false) {
  await openReadyApp(page);
  await page.evaluate(
    async ({ lines, stress }) => {
      const { newProject } = await import('/src/core/project/index.ts' as string);
      const canvas = document.createElement('canvas');
      canvas.width = stress ? 2200 : 1000;
      canvas.height = stress ? 1800 : 800;
      const context = canvas.getContext('2d')!;
      context.fillStyle = 'white';
      context.fillRect(0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob>((resolve) => canvas.toBlob((blob) => resolve(blob!)));
      const meta = {
        fileName: 'box-join.png',
        width: canvas.width,
        height: canvas.height,
        originalWidth: canvas.width,
        originalHeight: canvas.height,
        source: { kind: 'image' as const, mimeType: 'image/png' },
        sha256: '0'.repeat(64),
      };
      const project = newProject(meta, 'Box join', '2026-10-05T00:00:00.000Z');
      window.__trailmaker!.session.openSession({
        project: {
          ...project,
          seq: lines.length + 1,
          features: lines.map((pts, index) => ({
            kind: 'trail',
            id: `f${String(index + 1).padStart(4, '0')}`,
            name: `Trail ${index + 1}`,
            color: '#D9480F',
            notes: `Original ${index + 1}`,
            pts,
            ink: null,
          })),
        },
        map: {
          meta,
          display: await createImageBitmap(canvas),
          raster: {
            width: canvas.width,
            height: canvas.height,
            data: context.getImageData(0, 0, canvas.width, canvas.height).data,
          },
          original: blob,
          pdf: null,
        },
      });
    },
    { lines, stress },
  );
}

const project = (page: Page) =>
  page.evaluate(() => window.__trailmaker!.session.getSession()!.project);

async function selectBox(page: Page, from: Point, to: Point) {
  await page.getByRole('button', { name: 'Box select trails', exact: true }).click();
  const points = await page.evaluate(
    ({ from, to }) => ({
      from: window.__trailmaker!.imageToClient(from),
      to: window.__trailmaker!.imageToClient(to),
    }),
    { from, to },
  );
  await page.mouse.move(points.from.x, points.from.y);
  await page.mouse.down();
  await page.mouse.move(points.to.x, points.to.y, { steps: 5 });
  await page.mouse.up();
}

test('box crossings join one chain, save its geometry, and undo exactly once [T-333]', async ({
  page,
}) => {
  const lines = [
    [
      [100, 200],
      [400, 500],
    ],
    [
      [400, 500],
      [700, 200],
    ],
    [
      [700, 200],
      [900, 500],
    ],
    [
      [50, 650],
      [900, 650],
    ],
  ] as const;
  await openTrails(page, lines);
  const original = await project(page);
  // Every selected segment crosses the box, although none of its vertices is inside it.
  await selectBox(page, [150, 300], [850, 400]);
  await expect(page.getByRole('status').filter({ hasText: /^3 trails selected$/ })).toBeVisible();
  await page.getByRole('button', { name: 'Preview auto-join', exact: true }).click();
  const preview = page.getByRole('group', { name: 'Auto-join preview' });
  await expect(preview).toContainText('1 chains to join; 0 ambiguous junctions left separate.');
  expect(await project(page)).toEqual(original);
  await preview.getByRole('button', { name: 'Apply auto-join' }).click();
  const joinedPoints = [
    [100, 200],
    [400, 500],
    [700, 200],
    [900, 500],
  ];
  await expect.poll(async () => (await project(page)).features.length).toBe(2);
  const joined = await project(page);
  expect(joined.features[0]).toEqual({ ...original.features[0], pts: joinedPoints });
  expect(joined.features[1]).toEqual(original.features[3]);

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Save project', exact: true }).click(),
  ]);
  const archive = unzipSync(new Uint8Array(await readFile(await download.path())));
  const saved = JSON.parse(new TextDecoder().decode(archive['project.json']!)) as {
    features: unknown[];
  };
  expect(saved.features).toEqual(joined.features);
  await page
    .getByRole('toolbar', { name: 'Map tools' })
    .getByRole('button', { name: 'Undo', exact: true })
    .click();
  await expect.poll(() => project(page)).toEqual(original);

  // Reversing the gesture selects the same three trails.
  await selectBox(page, [850, 400], [150, 300]);
  await expect(page.getByRole('status').filter({ hasText: /^3 trails selected$/ })).toBeVisible();
});

test('large connected selection reports browser preview and apply timing [T-333]', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const vertices: Point[] = [];
  for (let row = 0; vertices.length < 2001; row++) {
    for (let col = 0; col < 50 && vertices.length < 2001; col++) {
      vertices.push([100 + (row % 2 ? 49 - col : col) * 40, 100 + row * 40]);
    }
  }
  const lines = vertices.slice(1).map((end, index) => {
    const start = vertices[index]!;
    return Array.from({ length: 50 }, (_, step): Point => [
      start[0] + ((end[0] - start[0]) * step) / 49,
      start[1] + ((end[1] - start[1]) * step) / 49,
    ]);
  });
  await openTrails(page, lines, true);
  await page.evaluate(async () => {
    const { selectTrails } = await import('/src/state/store.ts' as string);
    selectTrails(window.__trailmaker!.session.getSession()!.project.features.map((f) => f.id));
    const probe = { since: Infinity, actionMs: 0, tasks: [] as number[] };
    (window as ProbeWindow).__boxJoinProbe = probe;
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.startTime + entry.duration > probe.since) probe.tasks.push(entry.duration);
      }
    }).observe({ type: 'longtask', buffered: false });
  });
  await page.waitForTimeout(1200);
  const measure = async (name: string) => {
    const handle = await page.getByRole('button', { name, exact: true }).elementHandle();
    await handle!.evaluate((element) => {
      const probe = (window as ProbeWindow).__boxJoinProbe!;
      probe.tasks = [];
      probe.since = performance.now();
      (element as HTMLElement).click();
      probe.actionMs = performance.now() - probe.since;
    });
    await page.waitForTimeout(300);
    return page.evaluate(() => {
      const probe = (window as ProbeWindow).__boxJoinProbe!;
      const result = { actionMs: probe.actionMs, maxTaskMs: Math.max(0, ...probe.tasks) };
      probe.since = Infinity;
      return result;
    });
  };
  const preview = await measure('Preview auto-join');
  await expect(page.getByRole('group', { name: 'Auto-join preview' })).toContainText(
    '1 chains to join; 0 ambiguous junctions',
  );
  const apply = await measure('Apply auto-join');
  await expect.poll(async () => (await project(page)).features.length).toBe(1);
  console.log(
    JSON.stringify({ boxJoinStress: { trails: 2000, vertices: 100000, preview, apply } }),
  );
  // Total browser long tasks are reported, like the existing SwiftShader stress audit (D-012).
  // The Integrator reviews these measurements before merging; functional correctness gates here.
  expect((await project(page)).features[0]?.kind).toBe('trail');
});
