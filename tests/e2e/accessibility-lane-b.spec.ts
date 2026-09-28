import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from './network-fixture';
import { openReadyApp } from './app-ready';
import { openFixture } from './golden-helpers';

async function expectNoSevere(page: ConstructorParameters<typeof AxeBuilder>[0]['page'], selector: string) {
  const result = await new AxeBuilder({ page }).include(selector).analyze();
  expect(result.violations
    .filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
    .map((violation) => ({
      id: violation.id,
      nodes: violation.nodes.map((node) => ({ target: node.target, html: node.html, summary: node.failureSummary })),
    }))).toEqual([]);
}

test('shell, toolbar, and keyboard help have no severe axe violations [T-215]', async ({ page }) => {
  test.setTimeout(90_000);
  await openReadyApp(page);
  await expectNoSevere(page, '.app-header');
  await expectNoSevere(page, '.side .step:nth-of-type(3)');
  await expectNoSevere(page, '.side .step:nth-of-type(4)');
  await expectNoSevere(page, '.stage-editor');
  const toolbar = page.getByRole('toolbar', { name: 'Map tools' });
  await toolbar.getByRole('button', { name: 'Keyboard shortcuts' }).click();
  await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible();
  await expectNoSevere(page, '.help-dialog');
});

test('selected trail vertex, feature editor, and export controls have no severe axe violations [T-215]', async ({ page }) => {
  test.setTimeout(90_000);
  await openFixture(page, 'tests/fixtures/generated/solid.png');
  await page.evaluate(async () => {
    const current = window.__trailmaker!.session.getSession()!;
    window.__trailmaker!.session.openSession({
      ...current,
      project: {
        ...current.project,
        features: [{
          kind: 'trail', id: 'a11y-trail', name: 'Accessible trail', color: '#D9480F',
          notes: '', pts: [[100, 100], [200, 150], [300, 100]], ink: null,
        }],
      },
    });
    const store = await import('/src/state/store.ts' as string);
    store.selectFeature('a11y-trail');
    store.setVertexFocus({ featureId: 'a11y-trail', index: 1 });
  });
  await expect(page.getByRole('group', { name: 'Edit Accessible trail' })).toBeVisible();
  await expectNoSevere(page, '.stage-editor');
  await expectNoSevere(page, '.side .step:nth-of-type(3)');
  await expectNoSevere(page, '.side .step:nth-of-type(4)');
  await expect(page.getByRole('region', { name: 'Export' }).getByRole('button', { name: 'Download GPX' })).toBeVisible();
});

test('candidate review has no severe axe violations [T-215]', async ({ page }) => {
  test.setTimeout(90_000);
  await openFixture(page, 'tests/fixtures/generated/solid.png');
  await page.evaluate(async () => {
    const store = await import('/src/state/store.ts' as string);
    store.setCandidates([{
      id: 'candidate-a11y', chipId: 'chip-a11y', pts: [[100, 100], [200, 150], [300, 100]],
      lengthPx: 224, ink: [205, 48, 48], confidence: 0.9,
      on: true, name: 'Found trail', color: '#CD3030',
    }]);
  });
  await expect(page.getByRole('group', { name: 'Found lines' })).toBeVisible();
  await expectNoSevere(page, '.cands');
});
