import { expect, test } from './network-fixture';
import { openFixture } from './golden-helpers';
import { installOfflineBasemap, offlineStylePath } from './offline-basemap';

for (const viewport of [
  { width: 360, height: 740 },
  { width: 412, height: 915 },
  { width: 1280, height: 900 },
]) {
  test.describe(`settings dialog at ${viewport.width}x${viewport.height}`, () => {
    test.use({
      viewport,
      isMobile: viewport.width < 820,
      hasTouch: viewport.width < 820,
      colorScheme: 'dark',
    });

    test('stays above the steps, separates key help, scrolls to actions and restores focus [T-335]', async ({
      page,
    }, testInfo) => {
      await installOfflineBasemap(page);
      await openFixture(page, 'tests/fixtures/generated/solid.png');
      await page.evaluate(async (styleUrl) => {
        const settings = await import('/src/io/settings.ts' as string);
        settings.updateBasemapSettings({ enabled: true, styleUrl });
      }, offlineStylePath);
      await page.getByRole('button', { name: 'Show basemap', exact: true }).click();
      if (viewport.width < 820)
        await page.getByRole('tab', { name: 'Basemap', exact: true }).click();
      const trigger = page.getByRole('button', { name: 'Basemap settings', exact: true }).first();
      await trigger.click();
      const dialog = page.getByRole('dialog', { name: 'Basemap Settings', exact: true });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole('button', { name: 'Close settings' })).toBeFocused();
      await dialog.getByRole('textbox', { name: 'Style URL' }).focus();
      await dialog.locator('#esri-api-key-input').fill('layout-test-key');
      await expect
        .poll(() =>
          dialog.evaluate((el) => {
            const key = el.querySelector('#esri-api-key-input')!;
            const help = [...el.querySelectorAll('p')].find((p) =>
              p.textContent?.startsWith('Saved in this browser only'),
            )!;
            return help.getBoundingClientRect().top - key.getBoundingClientRect().bottom;
          }),
        )
        .toBeGreaterThanOrEqual(8);
      const bounds = await dialog.boundingBox();
      expect(bounds!.x).toBeGreaterThanOrEqual(8);
      expect(bounds!.y).toBeGreaterThanOrEqual(8);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width - 8);
      expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height - 8);

      const reset = dialog.getByRole('button', { name: 'Reset to default', exact: true });
      await reset.scrollIntoViewIfNeeded();
      await expect(reset).toBeInViewport();
      expect(
        await reset.evaluate((el) => {
          const r = el.getBoundingClientRect();
          return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
        }),
      ).toBe(true);
      await page.evaluate(() => window.scrollTo(0, 250));
      const afterScroll = await dialog.boundingBox();
      expect(afterScroll!.y).toBeCloseTo(bounds!.y, 1);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      await dialog.evaluate((el) => {
        el.scrollTop = 0;
      });
      await page.screenshot({ path: testInfo.outputPath('settings.png') });
      await page.keyboard.press('Escape');
      await expect(dialog).not.toBeVisible();
      await expect(trigger).toBeFocused();
      await trigger.click();
      await expect(dialog).toBeVisible();
      await dialog.getByRole('button', { name: 'Close settings' }).click();
      await expect(dialog).not.toBeVisible();
    });
  });
}
