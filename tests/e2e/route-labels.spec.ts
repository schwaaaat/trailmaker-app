import { readFile } from 'node:fs/promises';
import { unzipSync } from 'fflate';
import type { Project, Px, Trail } from '../../src/core/types';
import { parseKml, validateGpx } from '../metrics/xml';
import { expect, test } from './network-fixture';
import { openReadyApp } from './app-ready';

type Page = Parameters<typeof openReadyApp>[0];

test.use({ viewport: { width: 1280, height: 900 } });

const openLine: readonly Px[] = [
  [150, 300],
  [300, 400],
  [450, 450],
];
// Counterclockwise in image coordinates: classification must never persist contradictory winding.
const ring: readonly Px[] = [
  [550, 250],
  [550, 450],
  [800, 450],
  [800, 250],
  [550, 250],
];

async function seed(page: Page) {
  await openReadyApp(page);
  await page.evaluate(
    async ({ openLine, ring }) => {
      const { newProject } = await import('/src/core/project/index.ts' as string);
      const canvas = document.createElement('canvas');
      canvas.width = 1000;
      canvas.height = 800;
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = 'white';
      ctx.fillRect(0, 0, 1000, 800);
      const original = await new Promise<Blob>((resolve) =>
        canvas.toBlob((blob) => resolve(blob!)),
      );
      const hash = new Uint8Array(
        await crypto.subtle.digest('SHA-256', await original.arrayBuffer()),
      );
      const meta = {
        fileName: 'directed-routes.png',
        width: 1000,
        height: 800,
        originalWidth: 1000,
        originalHeight: 800,
        source: { kind: 'image' as const, mimeType: 'image/png' },
        sha256: [...hash].map((b) => b.toString(16).padStart(2, '0')).join(''),
      };
      const project = newProject(meta, 'Directed routes', '2026-10-05T00:00:00.000Z');
      window.__trailmaker!.session.openSession({
        project: {
          ...project,
          seq: 7,
          anchors: [
            [0, 0],
            [1000, 0],
            [0, 800],
            [1000, 800],
          ].map(([x, y], i) => ({
            id: `a${i + 1}`,
            px: [x!, y!],
            ll: [40 - y! * 0.00001, -75 + x! * 0.00001],
            source: 'paste',
          })),
          features: [openLine, ring].map((pts, i) => ({
            kind: 'trail',
            id: `f${i + 1}`,
            name: i ? 'Park loop' : 'Ridge trail',
            color: '#D9480F',
            notes: 'Route test',
            pts,
            ink: null,
          })),
        },
        map: {
          meta,
          display: await createImageBitmap(canvas),
          original,
          pdf: null,
          raster: { width: 1000, height: 800, data: ctx.getImageData(0, 0, 1000, 800).data },
        },
      });
    },
    { openLine, ring },
  );
  await expect(page.getByRole('button', { name: 'Download GPX', exact: true })).toBeEnabled();
}

const snapshot = (page: Page): Promise<Project> =>
  page.evaluate(() => window.__trailmaker!.session.getSession()!.project);
const trail = async (page: Page, id: string) =>
  (await snapshot(page)).features.find((f) => f.id === id) as Trail;

async function choose(page: Page, px: Px) {
  await page
    .getByRole('toolbar', { name: 'Map tools' })
    .getByRole('button', { name: 'Select', exact: true })
    .click();
  const client = await page.evaluate((px) => window.__trailmaker!.imageToClient(px), px);
  await page.mouse.click(client.x, client.y);
  await expect(page.getByRole('combobox', { name: 'Route type', exact: true })).toBeVisible();
}

async function downloadText(page: Page, button: string) {
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: button, exact: true }).click(),
  ]);
  return readFile(await download.path(), 'utf8');
}

async function saveAndReopen(page: Page) {
  const saved = await snapshot(page);
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Save project', exact: true }).click(),
  ]);
  const bytes = await readFile(await download.path());
  const archive = unzipSync(new Uint8Array(bytes));
  const json = JSON.parse(new TextDecoder().decode(archive['project.json']!)) as Project;
  expect(json.version).toBe(4);
  expect(json.features).toEqual(saved.features);
  // Change geometry after saving: reopening must actually restore the saved state.
  await page.getByRole('button', { name: 'Reverse direction', exact: true }).click();
  expect((await snapshot(page)).features).not.toEqual(saved.features);
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByRole('button', { name: 'Open project', exact: true }).click(),
  ]);
  await chooser.setFiles({
    name: 'directed-routes.trailmaker',
    mimeType: 'application/octet-stream',
    buffer: bytes,
  });
  await expect.poll(async () => (await snapshot(page)).features).toEqual(saved.features);
  return saved;
}

test('one-way trailhead/end swaps, undo, v4 reopen and ordered exports [T-334]', async ({
  page,
}) => {
  await seed(page);
  await choose(page, openLine[1]!);
  const type = page.getByRole('combobox', { name: 'Route type', exact: true });
  await type.selectOption('loop');
  await expect(page.getByText(/Trail ends are too far apart/)).toBeVisible();
  expect((await trail(page, 'f1')).pts).toEqual(openLine);
  expect((await trail(page, 'f1')).route).toBeUndefined();
  await type.selectOption('one-way');
  await expect.poll(async () => (await trail(page, 'f1')).route).toEqual({ kind: 'one-way' });
  await page.getByRole('button', { name: 'Swap start and end', exact: true }).click();
  await expect.poll(async () => (await trail(page, 'f1')).pts).toEqual([...openLine].reverse());
  await page
    .getByRole('toolbar', { name: 'Map tools' })
    .getByRole('button', { name: 'Undo', exact: true })
    .click();
  expect((await trail(page, 'f1')).pts).toEqual(openLine);
  expect((await trail(page, 'f1')).route).toEqual({ kind: 'one-way' });
  await page.getByRole('button', { name: 'Reverse direction', exact: true }).click();
  await saveAndReopen(page);

  const gpx = await downloadText(page, 'Download GPX');
  expect(validateGpx(gpx)).toBe(true);
  expect(gpx).toContain('Route: One-way');
  const points = [...gpx.matchAll(/<trkpt\s+lat="([^"]+)"\s+lon="([^"]+)"/g)];
  expect(Number(points[0]![1])).toBeCloseTo(39.9955, 5);
  expect(Number(points[0]![2])).toBeCloseTo(-74.9955, 5);
  const kml = await downloadText(page, 'Download KML');
  expect(parseKml(kml)[0]![0]![0]).toBeCloseTo(39.9955, 5);
  expect(kml).toContain('<Data name="route"><value>one-way</value>');
  const geo = JSON.parse(await downloadText(page, 'Download GeoJSON'));
  expect(geo.features[0].properties.route).toBe('one-way');
  expect(geo.features[0].geometry.coordinates[0][0]).toBeCloseTo(-74.9955, 5);
});

test('counterclockwise loop classification stays valid through start, direction, reopen and autosave [T-334]', async ({
  page,
}) => {
  await seed(page);
  await choose(page, ring[1]!);
  await page.getByRole('combobox', { name: 'Route type', exact: true }).selectOption('loop');
  const direction = page.getByRole('combobox', { name: 'Loop direction', exact: true });
  await direction.selectOption('counterclockwise');
  await page.getByRole('combobox', { name: 'Loop start point', exact: true }).selectOption('1');
  const marked = await trail(page, 'f2');
  expect(marked.route).toEqual({ kind: 'loop', direction: 'counterclockwise' });
  expect(marked.pts[0]).toEqual(ring[1]);
  expect(marked.pts.at(-1)).toEqual(marked.pts[0]);
  await page.getByRole('button', { name: 'Reverse direction', exact: true }).click();
  const reversed = await trail(page, 'f2');
  expect(reversed.route).toEqual({ kind: 'loop', direction: 'clockwise' });
  expect(reversed.pts[0]).toEqual(marked.pts[0]);
  expect(reversed.pts).toEqual([...marked.pts].reverse());
  await saveAndReopen(page);
  const kml = await downloadText(page, 'Download KML');
  expect(parseKml(kml)).toHaveLength(2);
  expect(kml).toContain('<Data name="direction"><value>clockwise</value>');
  const geo = JSON.parse(await downloadText(page, 'Download GeoJSON'));
  expect(geo.features[1].properties).toMatchObject({ route: 'loop', direction: 'clockwise' });
  const before = await snapshot(page);
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const { readAutosave } = await import('/src/io/autosave.ts' as string);
          return (await readAutosave())?.project;
        }),
      { timeout: 10_000 },
    )
    .toEqual(before);
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByRole('button', { name: /^Resume / }).click();
  await expect
    .poll(() => page.evaluate(() => window.__trailmaker!.session.getSession()?.project.features))
    .toEqual(before.features);
});
