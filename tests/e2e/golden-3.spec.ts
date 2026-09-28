import { readFile } from 'node:fs/promises';
import { expect, test } from './network-fixture';
import type { Project } from '../../src/core/types';
import type { FixtureTruth } from '../fixtures/truth';
import { clickFixturePixel, openFixture, placeFourAnchors } from './golden-helpers';

test('golden 3: reload resumes the exact autosaved project and original map', async ({ page }) => {
  test.setTimeout(60_000);
  const truth = JSON.parse(await readFile('tests/fixtures/generated/solid.truth.json', 'utf8')) as FixtureTruth;
  await openFixture(page, 'tests/fixtures/generated/solid.png');
  await placeFourAnchors(page, truth);
  await page.getByRole('toolbar', { name: 'Map tools' }).getByRole('button', { name: 'Point' }).click();
  await clickFixturePixel(page, truth, truth.pois[0]!.px);
  await page.getByRole('group', { name: /Edit Point/ }).getByRole('combobox', { name: 'Type' }).selectOption('Trailhead');

  const before = await page.evaluate(() => window.__trailmaker!.session.getSession()!.project);
  // Read only to wait for the real app's debounced write. Nothing starts autosave in this test.
  await expect.poll<Project | null>(
    () => page.evaluate(async () => {
      const { readAutosave } = await import('/src/io/autosave.ts' as string) as typeof import('../../src/io/autosave');
      return (await readAutosave())?.project ?? null;
    }),
    { timeout: 10_000 },
  ).toEqual(before);

  await page.reload({ waitUntil: 'networkidle' });
  await expect(page.getByRole('heading', { name: 'Trailmaker' })).toBeVisible();
  const resume = page.getByRole('button', { name: /^Resume / });
  await expect(resume).toContainText('1 item');
  await resume.click();
  await expect.poll(() => page.evaluate(() => window.__trailmaker?.session.getSession()?.project ?? null)).toEqual(before);
  const map = await page.evaluate(async () => {
    const session = window.__trailmaker!.session.getSession()!;
    const data = new Uint8Array(await session.map.original.arrayBuffer());
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
    return {
      width: session.map.meta.width,
      height: session.map.meta.height,
      sha256: [...hash].map((b) => b.toString(16).padStart(2, '0')).join(''),
    };
  });
  expect(map).toEqual({
    width: truth.width,
    height: truth.height,
    sha256: before.image.sha256,
  });
});
