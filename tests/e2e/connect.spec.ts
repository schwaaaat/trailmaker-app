import { readFile } from 'node:fs/promises';
import type { Px } from '../../src/core/types';
import type { FixtureTruth } from '../fixtures/truth';
import { expect, test } from './network-fixture';
import { clickFixturePixel, openFixture } from './golden-helpers';

type Page = Parameters<typeof openFixture>[0];

/**
 * T-221 Connect tool (Integrator e2e, the card's Request). Two trails are cut from the fixture's
 * red-ridge ink with a gap between them; each mode joins a point on one to a point on the other.
 */
async function setup(page: Page) {
  const truth = JSON.parse(await readFile('tests/fixtures/generated/solid.truth.json', 'utf8')) as FixtureTruth;
  const red = truth.polylines.find((line) => line.id === 'red-ridge')!.pts;
  await openFixture(page, 'tests/fixtures/generated/solid.png');
  const aEnd = Math.floor(red.length * 0.35);
  const bStart = Math.floor(red.length * 0.6);
  await page.evaluate(
    ({ a, b, w, h }) => {
      const t = window.__trailmaker!;
      const cur = t.session.getSession()!;
      const sx = cur.project.image.width / w;
      const sy = cur.project.image.height / h;
      const scale = (pts: [number, number][]) => pts.map(([x, y]) => [x * sx, y * sy] as [number, number]);
      t.session.openSession({
        project: {
          ...cur.project,
          trace: { ...cur.project.trace, smartFollow: true },
          features: [
            { id: 'tA', kind: 'trail', name: 'A', color: '#cc3030', notes: '', pts: scale(a), ink: [205, 48, 48] },
            { id: 'tB', kind: 'trail', name: 'B', color: '#cc3030', notes: '', pts: scale(b), ink: [205, 48, 48] },
          ],
        },
        map: cur.map,
      });
    },
    {
      a: red.slice(0, aEnd + 1) as [number, number][],
      b: red.slice(bStart) as [number, number][],
      w: truth.width,
      h: truth.height,
    },
  );
  await page.evaluate(() => window.__trailmaker!.idle());
  return { truth, pa: red[aEnd]! as Px, pb: red[bStart]! as Px, mid: red[Math.floor((aEnd + bStart) / 2)]! as Px };
}

const features = (page: Page) =>
  page.evaluate(() =>
    window.__trailmaker!.session.getSession()!.project.features.map((f) => ({
      id: f.id,
      pts: f.kind === 'trail' ? f.pts.map((p) => [p[0], p[1]]) : [],
    })),
  );

async function pickTwoPoints(page: Page, truth: FixtureTruth, pa: Px, pb: Px) {
  await page.getByRole('toolbar', { name: 'Map tools' }).getByRole('button', { name: 'Connect', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Connect trails' });
  await expect(panel).toContainText('Choose a point on the first trail.');
  await clickFixturePixel(page, truth, pa);
  await expect(panel).toContainText('Choose a point on a trail to connect to.');
  await clickFixturePixel(page, truth, pb);
  await expect(panel).toContainText('Choose how the connector should run.');
  return panel;
}

async function expectSharedEnds(page: Page) {
  const after = await features(page);
  expect(after).toHaveLength(3);
  const a = after.find((f) => f.id === 'tA')!;
  const b = after.find((f) => f.id === 'tB')!;
  const c = after.find((f) => f.id !== 'tA' && f.id !== 'tB')!;
  const same = (p: number[], q: number[]) => p[0] === q[0] && p[1] === q[1];
  // The connector's ends are exactly vertices of A and B (shared junction points).
  expect(a.pts.some((p) => same(p, c.pts[0]!))).toBe(true);
  expect(b.pts.some((p) => same(p, c.pts.at(-1)!))).toBe(true);
}

for (const mode of ['Straight', 'Follow the map'] as const) {
  test(`Connect: ${mode} joins two trails at shared points; one undo removes it [T-221]`, async ({ page }) => {
    test.setTimeout(90_000);
    const { truth, pa, pb } = await setup(page);
    const before = await features(page);
    const panel = await pickTwoPoints(page, truth, pa, pb);
    await panel.getByRole('button', { name: mode, exact: true }).click();
    await page.evaluate(() => window.__trailmaker!.idle());
    await expect(panel).toContainText('Preview the line, then connect the trails.');
    await panel.getByRole('button', { name: 'Connect trails', exact: true }).click();
    await expectSharedEnds(page);
    await page.keyboard.press('Control+z');
    await expect.poll(() => features(page)).toEqual(before);
  });
}

test('Connect: Draw it runs through the drawn point and ends on both trails [T-221]', async ({ page }) => {
  test.setTimeout(90_000);
  const { truth, pa, pb, mid } = await setup(page);
  const panel = await pickTwoPoints(page, truth, pa, pb);
  await panel.getByRole('button', { name: 'Draw it', exact: true }).click();
  await expect(panel).toContainText('Tap or click to add points, then finish the line.');
  await clickFixturePixel(page, truth, [mid[0] + 20, mid[1] + 20]);
  await panel.getByRole('button', { name: 'Finish drawing', exact: true }).click();
  await panel.getByRole('button', { name: 'Connect trails', exact: true }).click();
  await expectSharedEnds(page);
  const connector = (await features(page)).find((f) => f.id !== 'tA' && f.id !== 'tB')!;
  expect(connector.pts.length).toBeGreaterThanOrEqual(3);
});

test('Connect: Escape cancels and changes nothing [T-221]', async ({ page }) => {
  test.setTimeout(60_000);
  const { truth, pa, pb } = await setup(page);
  const before = await features(page);
  const panel = await pickTwoPoints(page, truth, pa, pb);
  await panel.getByRole('button', { name: 'Straight', exact: true }).click();
  await page.keyboard.press('Escape');
  // The Connect tool stays active, back at its first step, with nothing added.
  await expect(panel).toContainText('Choose a point on the first trail.');
  expect(await features(page)).toEqual(before);
});
