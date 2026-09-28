import { AxeBuilder } from '@axe-core/playwright';
import { readFile } from 'node:fs/promises';
import { expect, test } from './network-fixture';
import { openReadyApp } from './app-ready';
import { clickFixturePixel, openFixture } from './golden-helpers';
import { installOfflineBasemap, offlineStylePath } from './offline-basemap';
import type { FixtureTruth } from '../fixtures/truth';

async function expectNoSeriousViolations(page: ConstructorParameters<typeof AxeBuilder>[0]['page'], selector: string) {
  const result = await new AxeBuilder({ page }).include(selector).analyze();
  const severe = result.violations
    .filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
    .map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      targets: violation.nodes.flatMap((node) => node.target),
    }));
  expect(severe).toEqual([]);
}


test('file opening and empty map stage have no serious axe violations [T-311]', async ({ page }) => {
  test.setTimeout(90_000);
  await openReadyApp(page);
  await expect(page.getByRole('region', { name: 'Map drop zone' })).toBeVisible();
  await expectNoSeriousViolations(page, '.map-drop-zone');
});

test('PDF page picker, save control, and resume prompt have no serious axe violations [T-311]', async ({ page }) => {
  test.setTimeout(90_000);
  await openFixture(page, 'tests/fixtures/generated/solid.pdf');
  await expect(page.getByRole('combobox', { name: 'Page' })).toBeVisible();
  await expectNoSeriousViolations(page, '.page-picker');
  await expect(page.getByRole('button', { name: 'Save project' })).toBeVisible();

  await expect.poll(() => page.evaluate(async () => {
    const { readAutosave } = await import('/src/io/autosave.ts' as string);
    return Boolean(await readAutosave());
  }), { timeout: 10_000 }).toBe(true);
  await page.reload({ waitUntil: 'networkidle' });
  await expect(page.getByRole('button', { name: /^Resume / })).toBeVisible();
  await expectNoSeriousViolations(page, '.resume-slot');
});

test('basemap consent and settings have no serious axe violations [T-311]', async ({ page }) => {
  await installOfflineBasemap(page);
  await page.goto('/');
  await page.evaluate(async (styleUrl) => {
    const settings = await import('/src/io/settings.ts' as string);
    settings.updateBasemapSettings({ enabled: false, styleUrl });
    const host = document.createElement('div');
    host.id = 'test-accessibility-basemap-host';
    host.style.cssText = 'position:fixed;inset:0;z-index:9999;background:white';
    document.body.append(host);
    const { mountBasemapPane } = await import('/src/ui/georef/testMount.ts' as string);
    mountBasemapPane(host, { overrideStyleUrl: styleUrl });
  }, offlineStylePath);

  const host = page.locator('#test-accessibility-basemap-host');
  await expect(host.getByRole('button', { name: 'Enable basemap' })).toBeVisible();
  await expectNoSeriousViolations(page, '#test-accessibility-basemap-host');

  await host.getByRole('button', { name: 'Enable basemap' }).click();
  await expect(host.getByRole('region', { name: 'Basemap', exact: true })).toBeVisible();
  await expectNoSeriousViolations(page, '#test-accessibility-basemap-host');
  await host.getByRole('button', { name: 'Basemap settings' }).click();
  await expect(host.getByRole('dialog', { name: 'Basemap settings' })).toBeVisible();
  await expectNoSeriousViolations(page, '#test-accessibility-basemap-host');
});

test('pending basemap pairing prompt has no serious axe violations [T-311]', async ({ page }) => {
  const truth = JSON.parse(await readFile('tests/fixtures/generated/solid.truth.json', 'utf8')) as FixtureTruth;
  await installOfflineBasemap(page);
  await openFixture(page, 'tests/fixtures/generated/solid.png');
  await page.evaluate(async (styleUrl) => {
    const settings = await import('/src/io/settings.ts' as string);
    settings.updateBasemapSettings({ enabled: true, styleUrl });
    const host = document.createElement('div');
    host.id = 'test-accessibility-pairing-host';
    host.style.cssText = 'position:fixed;inset:0 0 0 auto;width:48vw;z-index:9999;background:white;pointer-events:none';
    document.body.append(host);
    const { mountBasemapPane } = await import('/src/ui/georef/testMount.ts' as string);
    mountBasemapPane(host, { overrideStyleUrl: styleUrl });
  }, offlineStylePath);
  await page.getByRole('toolbar', { name: 'Map tools' }).getByRole('button', { name: 'Anchor', exact: true }).click();
  await clickFixturePixel(page, truth, [120, 120]);
  const host = page.locator('#test-accessibility-pairing-host');
  await expect(host.getByText('Now click the same spot on the basemap')).toBeVisible();
  await expectNoSeriousViolations(page, '#test-accessibility-pairing-host');
});

test('imported GPX list and pairing controls have no serious axe violations [T-312]', async ({ page }) => {
  test.setTimeout(90_000);
  await installOfflineBasemap(page);
  await page.goto('/');
  await page.evaluate(async (styleUrl) => {
    const settings = await import('/src/io/settings.ts' as string);
    settings.updateBasemapSettings({ enabled: true, styleUrl });
    const { setActiveGpx } = await import('/src/io/gpxStorage.ts' as string);
    setActiveGpx({
      fileName: 'test.gpx',
      points: [
        { id: 'wpt-1', name: 'Trailhead', ll: [38.5, -78.4], kind: 'wpt' },
        { id: 'wpt-2', name: 'Summit', ll: [38.6, -78.3], kind: 'wpt' },
      ],
      tracks: [],
      totalPointsInFile: 2,
      wasDecimated: false,
    });
    const host = document.createElement('div');
    host.id = 'test-accessibility-gpx-host';
    host.style.cssText = 'position:fixed;inset:0;z-index:9999;background:white';
    document.body.append(host);
    const { mountBasemapPane } = await import('/src/ui/georef/testMount.ts' as string);
    mountBasemapPane(host, { overrideStyleUrl: styleUrl });
  }, offlineStylePath);

  const host = page.locator('#test-accessibility-gpx-host');
  await host.getByRole('button', { name: /GPX points/ }).click();
  await expect(host.getByRole('dialog', { name: /GPX Points/ })).toBeVisible();
  await expectNoSeriousViolations(page, '#test-accessibility-gpx-host');
});

test('overlay controls have no serious axe violations [T-311]', async ({ page }) => {
  const truth = JSON.parse(await readFile('tests/fixtures/generated/warped.truth.json', 'utf8')) as FixtureTruth;
  await installOfflineBasemap(page);
  await openReadyApp(page);
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByRole('complementary', { name: 'Steps' }).getByRole('button', { name: 'Open image or PDF' }).click(),
  ]);
  await chooser.setFiles('tests/fixtures/generated/warped.png');
  await expect.poll(() => page.evaluate(() => window.__trailmaker!.session.getSession()?.project.image.fileName)).toBe('warped');
  await page.evaluate(async ({ anchors, styleUrl }) => {
    const current = window.__trailmaker!.session.getSession()!;
    window.__trailmaker!.session.openSession({
      ...current,
      project: { ...current.project, anchors, fitMethod: 'tps' },
    });
    const settings = await import('/src/io/settings.ts' as string);
    settings.updateBasemapSettings({ enabled: true, styleUrl });
    const host = document.createElement('div');
    host.id = 'test-accessibility-overlay-host';
    host.style.cssText = 'position:fixed;inset:0;z-index:9999;background:white';
    document.body.append(host);
    const { mountOverlayPreview } = await import('/src/ui/georef/testMount.ts' as string);
    mountOverlayPreview(host, { overrideStyleUrl: styleUrl });
  }, { anchors: truth.anchors, styleUrl: offlineStylePath });
  const host = page.locator('#test-accessibility-overlay-host');
  await expect(host.getByRole('slider', { name: 'Map opacity' })).toBeVisible();
  await expectNoSeriousViolations(page, '#test-accessibility-overlay-host');
});
