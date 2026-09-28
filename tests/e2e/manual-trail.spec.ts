import { expect, test } from './network-fixture';

test('draw a three-point trail by hand, then undo and redo the exact project', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Trailmaker' })).toBeVisible();
  await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 1000;
    canvas.height = 800;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const meta = {
      fileName: 'manual-trail.png',
      width: canvas.width,
      height: canvas.height,
      originalWidth: canvas.width,
      originalHeight: canvas.height,
      source: { kind: 'image' as const, mimeType: 'image/png' },
      sha256: '0'.repeat(64),
    };
    window.__trailmaker!.session.openSession({
      project: {
        version: 2,
        name: 'Manual trail',
        image: meta,
        anchors: [],
        fitMethod: 'auto',
        features: [],
        units: 'mi',
        trace: { smartFollow: false, tolerance: 60, ink: null },
        autoTrace: { chips: [], gapPx: 13, minLengthPct: 4 },
        seq: 1,
        updatedAt: '2026-09-24T00:00:00.000Z',
      },
      map: {
        meta,
        display: await createImageBitmap(canvas),
        raster: {
          width: canvas.width,
          height: canvas.height,
          data: new Uint8ClampedArray(canvas.width * canvas.height * 4),
        },
        original: new Blob([], { type: 'image/png' }),
        pdf: null,
      },
    });
  });

  const before = await page.evaluate(() => window.__trailmaker!.session.getSession()!.project);
  const toolbar = page.getByRole('toolbar', { name: 'Map tools' });
  const trail = toolbar.getByRole('button', { name: 'Trail', exact: true });
  await trail.click();
  await expect(trail).toHaveAttribute('aria-pressed', 'true');

  const points = await page.evaluate(() =>
    (
      [
        [200, 300],
        [500, 500],
        [800, 300],
      ] as const
    ).map((px) => window.__trailmaker!.imageToClient(px)),
  );
  for (const point of [...points, points[2]!]) {
    await page.mouse.click(point.x, point.y);
  }

  await expect
    .poll(() =>
      page.evaluate(() => window.__trailmaker!.session.getSession()!.project.features.length),
    )
    .toBe(1);
  const after = await page.evaluate(() => window.__trailmaker!.session.getSession()!.project);
  expect(after.features).toHaveLength(1);
  expect(after.features[0]).toMatchObject({ kind: 'trail', pts: expect.any(Array) });
  if (after.features[0]?.kind !== 'trail') throw new Error('Expected a trail');
  expect(after.features[0].pts).toHaveLength(3);

  await page.keyboard.press('Control+z');
  await expect
    .poll(() =>
      page.evaluate(() => window.__trailmaker!.session.getSession()!.project.features.length),
    )
    .toBe(0);
  expect(await page.evaluate(() => window.__trailmaker!.session.getSession()!.project)).toEqual(
    before,
  );

  await page.keyboard.press('Control+Shift+z');
  await expect
    .poll(() =>
      page.evaluate(() => window.__trailmaker!.session.getSession()!.project.features.length),
    )
    .toBe(1);
  expect(await page.evaluate(() => window.__trailmaker!.session.getSession()!.project)).toEqual(
    after,
  );
});
