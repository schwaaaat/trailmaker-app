import { expect, test } from './network-fixture';
import { openReadyApp } from './app-ready';

/** A 64x64 map with one line that switches red -> blue -> green, and three enabled chips. */
async function openColorSwitch(page: Parameters<typeof openReadyApp>[0]) {
  await openReadyApp(page);
  await page.evaluate(async () => {
    const colors = [
      [205, 48, 48],
      [35, 96, 195],
      [38, 132, 65],
    ] as const;
    const canvas = new OffscreenCanvas(64, 64);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('OffscreenCanvas 2D context unavailable');
    context.fillStyle = '#fff';
    context.fillRect(0, 0, 64, 64);
    for (let x = 8; x < 56; x++) {
      const [r, g, b] = colors[x < 24 ? 0 : x < 40 ? 1 : 2]!;
      context.fillStyle = `rgb(${r}, ${g}, ${b})`;
      context.fillRect(x, 32, 1, 1);
    }
    const original = await canvas.convertToBlob({ type: 'image/png' });
    const display = await createImageBitmap(original);
    const bytes = await original.arrayBuffer();
    const hash = await crypto.subtle.digest('SHA-256', bytes);
    const sha256 = [...new Uint8Array(hash)]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
    const meta = {
      fileName: 'color-switch.png',
      width: 64,
      height: 64,
      originalWidth: 64,
      originalHeight: 64,
      source: { kind: 'image' as const, mimeType: 'image/png' },
      sha256,
    };
    window.__trailmaker!.session.openSession({
      project: {
        version: 4,
        name: 'Color switch',
        image: meta,
        anchors: [],
        fitMethod: 'auto',
        features: [],
        units: 'mi',
        trace: { smartFollow: true, tolerance: 20, ink: null },
        autoTrace: {
          chips: colors.map((rgb, index) => ({
            id: `chip-${index}`,
            rgb: [...rgb],
            name: ['Red', 'Blue', 'Green'][index]!,
            enabled: true,
            named: true,
            share: null,
          })),
          gapPx: 3,
          minLengthPct: 4,
        },
        seq: 1,
        updatedAt: '2026-09-26T12:00:00.000Z',
      },
      map: {
        meta,
        display,
        raster: { width: 64, height: 64, data: context.getImageData(0, 0, 64, 64).data },
        original,
        pdf: null,
      },
    });
    await window.__trailmaker!.idle();
  });
}

test('real worker joins a color-switch trail, then review splits and accepts it [T-210]', async ({
  page,
}) => {
  test.setTimeout(60_000);
  await openColorSwitch(page);

  const trace = page.getByRole('region', { name: 'Trace' });
  await expect(trace.getByRole('checkbox', { name: 'Join colors that continue each other' })).toBeChecked();
  await trace.getByRole('button', { name: 'Find trails', exact: true }).click();
  await page.evaluate(() => window.__trailmaker!.idle());
  const found = trace.getByRole('group', { name: 'Found lines' });
  await expect(found).toBeVisible();
  await expect(found.getByRole('checkbox')).toHaveCount(1);
  await found.getByRole('button', { name: 'Split', exact: true }).click();
  await expect(found.getByRole('checkbox')).toHaveCount(2);
  await found.getByRole('button', { name: 'Undo split' }).click();
  await expect(found.getByRole('checkbox')).toHaveCount(1);
  await found.getByRole('button', { name: 'Split', exact: true }).click();
  await found.getByRole('button', { name: 'Add 2 as trails' }).click();
  const trails = await page.evaluate(() =>
    window.__trailmaker!.session.getSession()!.project.features.filter((feature) => feature.kind === 'trail'),
  );
  expect(trails).toHaveLength(2);
  expect(trails[0]?.notes).toContain('Also follows:');
  expect(trails[1]?.notes).toContain('Also follows:');
});

test('keyboard-only candidate split, undo, accept and trail join [T-217]', async ({ page }) => {
  test.setTimeout(60_000);
  await openColorSwitch(page);
  const trace = page.getByRole('region', { name: 'Trace' });
  await trace.getByRole('button', { name: 'Find trails', exact: true }).press('Enter');
  await page.evaluate(() => window.__trailmaker!.idle());
  const found = trace.getByRole('group', { name: 'Found lines' });
  await expect(found.getByRole('checkbox')).toHaveCount(1);
  // Move the split point with the arrow keys; each step is announced, then Enter splits there.
  const split = found.getByRole('button', { name: 'Split', exact: true });
  const announced = page.getByText(/^Split point \d+ of \d+$/);
  const point = async () => Number(/Split point (\d+)/.exec((await announced.textContent()) ?? '')?.[1]);
  await split.focus();
  await split.press('ArrowRight');
  await expect(announced).toBeAttached();
  const first = await point();
  await split.press('ArrowRight');
  await expect.poll(point).toBe(first + 1);
  await split.press('Enter');
  await expect(found.getByRole('checkbox')).toHaveCount(2);

  await found.getByRole('button', { name: 'Undo split' }).press('Enter');
  await expect(found.getByRole('checkbox')).toHaveCount(1);
  await found.getByRole('button', { name: 'Split', exact: true }).press('Enter');
  await expect(found.getByRole('checkbox')).toHaveCount(2);
  await found.getByRole('button', { name: 'Add 2 as trails' }).press('Enter');
  await expect
    .poll(() =>
      page.evaluate(
        () => window.__trailmaker!.session.getSession()!.project.features.filter((f) => f.kind === 'trail').length,
      ),
    )
    .toBe(2);

  // Select one trail row, Shift+Enter the other to arm a join, then J joins them.
  const rows = page.locator('button[aria-keyshortcuts="Shift+Enter Shift+Space"]');
  await expect(rows).toHaveCount(2);
  await rows.nth(0).press('Enter');
  await rows.nth(1).press('Shift+Enter');
  await page.keyboard.press('j');
  await expect
    .poll(() =>
      page.evaluate(
        () => window.__trailmaker!.session.getSession()!.project.features.filter((f) => f.kind === 'trail').length,
      ),
    )
    .toBe(1);
});
