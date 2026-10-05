import { expect, test } from './network-fixture';
import { openFixture, pinSideBySide } from './golden-helpers';
import { installOfflineBasemap, offlineStylePath } from './offline-basemap';
import { IMAGERY_HOSTS, stubImagery } from './imagery-stubs';

// Satellite imagery is on before the reset, so USGS/NAIP imagery is requested; answer it locally.
test.use({ stubbedHosts: IMAGERY_HOSTS });

test('Reset interface restores defaults and leaves the project alone [T-224]', async ({ page }) => {
  test.setTimeout(90_000);
  // Before the reset the layout is side by side, so the split is visible (T-325 made Tabs the default).
  await pinSideBySide(page);
  await installOfflineBasemap(page);
  await stubImagery(page, []);
  await openFixture(page, 'tests/fixtures/generated/solid.png');
  // Give the project some content that a reset must not touch.
  await page.evaluate(() => {
    const t = window.__trailmaker!;
    const cur = t.session.getSession()!;
    t.session.openSession({
      project: {
        ...cur.project,
        anchors: [{ id: 'a0', px: [100, 100], ll: [38.6, -78.4], source: 'paste' as const }],
      },
      map: cur.map,
    });
  });
  const projectBefore = await page.evaluate(() => {
    const p = window.__trailmaker!.session.getSession()!.project;
    return JSON.stringify({ anchors: p.anchors, features: p.features, name: p.name });
  });

  // Change interface state: enable the basemap, switch to Satellite imagery, show the pane.
  await page.evaluate(
    async ({ styleUrl }) => {
      const settings = await import('/src/io/settings.ts' as string);
      settings.updateBasemapSettings({
        enabled: true,
        imagery: 'satellite',
        styleUrl,
        lastCenter: [-78.395, 38.597],
        lastZoom: 14,
      });
    },
    { styleUrl: offlineStylePath },
  );
  await page.getByRole('button', { name: 'Show basemap' }).click();
  await expect(page.locator('.stage.split')).toHaveCount(1);

  // Reset from the help dialog, with its confirm step.
  await page
    .getByRole('toolbar', { name: 'Map tools' })
    .getByRole('button', { name: 'Keyboard shortcuts' })
    .click();
  await page.getByRole('button', { name: 'Reset interface…' }).click();
  const confirm = page.getByRole('alertdialog', { name: 'Reset interface to defaults?' });
  await expect(confirm).toContainText('not touched');
  await confirm.getByRole('button', { name: 'Reset interface', exact: true }).click();

  // Defaults are back, live, with no reload.
  await expect(page.locator('.stage.split')).toHaveCount(0);
  const basemap = await page.evaluate(async () => {
    const settings = await import('/src/io/settings.ts' as string);
    const b = settings.loadSettings().basemap;
    return { enabled: b.enabled, imagery: b.imagery };
  });
  expect(basemap).toEqual({ enabled: false, imagery: 'vector' });
  await expect(page.getByRole('button', { name: 'Enable basemap' })).toBeVisible();

  // The project is untouched.
  const projectAfter = await page.evaluate(() => {
    const p = window.__trailmaker!.session.getSession()!.project;
    return JSON.stringify({ anchors: p.anchors, features: p.features, name: p.name });
  });
  expect(projectAfter).toBe(projectBefore);
});
