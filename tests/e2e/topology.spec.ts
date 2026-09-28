import { expect, test } from './network-fixture';

test('split, join, and undo both topology edits exactly [T-209]', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 1000;
    canvas.height = 800;
    const context = canvas.getContext('2d')!;
    context.fillStyle = 'white';
    context.fillRect(0, 0, canvas.width, canvas.height);
    const meta = {
      fileName: 'topology.png',
      width: 1000,
      height: 800,
      originalWidth: 1000,
      originalHeight: 800,
      source: { kind: 'image' as const, mimeType: 'image/png' },
      sha256: '0'.repeat(64),
    };
    window.__trailmaker!.session.openSession({
      project: {
        version: 2,
        name: 'Topology',
        image: meta,
        anchors: [],
        fitMethod: 'auto',
        features: [{
          kind: 'trail',
          id: 'f1',
          name: 'Ridge',
          color: '#D9480F',
          notes: '',
          pts: [[200, 300], [500, 500], [800, 300]],
          ink: null,
        }],
        units: 'mi',
        trace: { smartFollow: false, tolerance: 60, ink: null },
        autoTrace: { chips: [], gapPx: 13, minLengthPct: 4 },
        seq: 2,
        updatedAt: '2026-09-25T00:00:00.000Z',
      },
      map: {
        meta,
        display: await createImageBitmap(canvas),
        raster: { width: 1000, height: 800, data: new Uint8ClampedArray(1000 * 800 * 4) },
        original: new Blob([], { type: 'image/png' }),
        pdf: null,
      },
    });
  });

  const project = () => page.evaluate(() => window.__trailmaker!.session.getSession()!.project);
  const original = await project();
  await page.getByRole('toolbar', { name: 'Map tools' }).getByRole('button', { name: 'Select' }).click();
  await page.getByRole('list', { name: 'Traced features' }).getByRole('button', { name: /Ridge/ }).click();
  const middle = await page.evaluate(() => window.__trailmaker!.imageToClient([500, 500]));
  await page.mouse.click(middle.x, middle.y, { button: 'right' });
  await page.getByRole('menu', { name: 'Vertex actions' }).getByRole('menuitem', { name: 'Split here' }).click();
  await expect.poll(async () => (await project()).features.length).toBe(2);
  const split = await project();
  expect(split.features.map((feature) => feature.name)).toEqual(['Ridge', 'Ridge (2)']);

  await page.getByRole('list', { name: 'Traced features' }).getByRole('button', { name: 'Ridge', exact: true }).click();
  const secondHalf = await page.evaluate(() => window.__trailmaker!.imageToClient([650, 400]));
  await page.keyboard.down('Shift');
  await page.mouse.click(secondHalf.x, secondHalf.y);
  await page.keyboard.up('Shift');
  await page.getByRole('button', { name: 'Join trails' }).click();
  await expect.poll(async () => (await project()).features.length).toBe(1);
  expect((await project()).features[0]?.name).toBe('Ridge');

  await page.getByRole('toolbar', { name: 'Map tools' }).getByRole('button', { name: 'Undo' }).click();
  await expect.poll(project).toEqual(split);
  await page.getByRole('toolbar', { name: 'Map tools' }).getByRole('button', { name: 'Undo' }).click();
  await expect.poll(project).toEqual(original);
});
