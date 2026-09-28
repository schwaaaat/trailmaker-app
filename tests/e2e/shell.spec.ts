import { expect, test } from './network-fixture';
import { openFixture } from './golden-helpers';

test('app shell mounts the four steps and fills the map stage with the editor', async ({
  page,
}) => {
  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'Trailmaker', exact: true })).toBeVisible();
  for (const name of ['Open map', 'Pin to real world', 'Trace', 'Export']) {
    const step = page.getByRole('region', { name, exact: true });
    await expect(step).toBeVisible();
    await expect(step.getByRole('heading', { name, exact: true })).toBeVisible();
  }

  const stage = page.getByRole('main', { name: 'Map' });
  const canvas = stage.getByRole('application', { name: 'Park map editor' });
  await expect(canvas).toBeVisible();
  const stageBox = await stage.boundingBox();
  const canvasBox = await canvas.boundingBox();
  expect(stageBox).not.toBeNull();
  expect(canvasBox).not.toBeNull();
  for (const dimension of ['x', 'y', 'width', 'height'] as const) {
    expect(canvasBox![dimension]).toBeCloseTo(stageBox![dimension], 0);
  }

  await expect
    .poll(() => page.evaluate(() => typeof window.__trailmaker?.imageToClient))
    .toBe('function');
});

test('T-218: declining the sidebar basemap keeps the map tools and canvas usable', async ({
  page,
}) => {
  await openFixture(page, 'tests/fixtures/generated/solid.png');
  const steps = page.getByRole('complementary', { name: 'Steps' });
  await steps.getByRole('button', { name: 'Not now' }).click();
  await expect(steps.getByRole('region', { name: 'Basemap disabled' })).toBeVisible();

  // The placeholder must not cover the page: the toolbar and the canvas take clicks.
  await page.getByRole('toolbar', { name: 'Map tools' }).getByRole('button', { name: 'Point' }).click();
  const at = await page.evaluate(() => window.__trailmaker!.imageToClient([200, 200]));
  await page.mouse.click(at.x, at.y);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.__trailmaker!.session.getSession()!.project.features.filter((f) => f.kind === 'poi')
            .length,
      ),
    )
    .toBe(1);

  // Enable basemap from the placeholder still grants the opt-in.
  await steps.getByRole('button', { name: 'Enable basemap' }).click();
  await expect(steps.getByRole('button', { name: 'Show basemap' })).not.toHaveAttribute(
    'aria-disabled',
    'true',
  );
});
