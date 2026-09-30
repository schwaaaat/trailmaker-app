import { expect, test } from './network-fixture';
import { openFixture } from './golden-helpers';
import { installOfflineBasemap, offlineStylePath } from './offline-basemap';

/**
 * T-317: zooming must never move anchors. Found on a Galaxy S20 FE: a pinch whose finger started
 * on a basemap pin dragged that pin (MapLibre draggable marker) and saved the new position, and
 * the basemap then dropped every pin. Gating since T-317 and T-220 merged (v1.1.1).
 */
test.use({ viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2.625 });

type Page = Parameters<typeof openFixture>[0];

const anchorsOf = (page: Page) =>
  page.evaluate(() => window.__trailmaker!.session.getSession()!.project.anchors.map((a) => ({ px: a.px, ll: a.ll })));

async function touch(page: Page, fingers: (t: number) => { x: number; y: number }[], steps = 10) {
  const cdp = await page.context().newCDPSession(page);
  const at = (t: number) => fingers(t).map((p, id) => ({ ...p, id }));
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: at(0).slice(0, 1) });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: at(0) });
  for (let i = 1; i <= steps; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: at(i / steps) });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

test('pinching the basemap with a finger on a pin moves no anchor and keeps every pin [T-317]', async ({ page }) => {
  test.setTimeout(90_000);
  await installOfflineBasemap(page);
  await openFixture(page, 'tests/fixtures/generated/solid.png');
  await page.evaluate(
    async ({ styleUrl }) => {
      const settings = await import('/src/io/settings.ts' as string);
      settings.updateBasemapSettings({ enabled: true, styleUrl, lastCenter: [-78.395, 38.597], lastZoom: 14 });
      const t = window.__trailmaker!;
      const cur = t.session.getSession()!;
      const ll = [
        [38.6, -78.4],
        [38.6, -78.39],
        [38.594, -78.39],
        [38.594, -78.4],
      ] as const;
      t.session.openSession({
        project: {
          ...cur.project,
          anchors: ll.map((p, i) => ({ id: `a${i}`, px: [100 + i * 100, 100 + i * 80], ll: [p[0], p[1]], source: 'paste' as const })),
        },
        map: cur.map,
      });
    },
    { styleUrl: offlineStylePath },
  );
  const show = page.getByRole('button', { name: 'Show basemap' });
  if (await show.isVisible()) await show.click();
  await page.getByRole('tab', { name: 'Basemap' }).click();
  const pins = page.locator('.stage-georef .maplibregl-marker');
  await expect(pins).toHaveCount(4);
  const before = await anchorsOf(page);

  for (let n = 0; n < 4; n++) {
    await expect(pins, 'every basemap pin is still shown').toHaveCount(4, { timeout: 5000 });
    expect(await anchorsOf(page), 'no anchor moved').toEqual(before);
    const box = (await pins.nth(n).boundingBox())!;
    const pin = { x: box.x + box.width / 2, y: box.y + box.height * 0.4 };
    // Finger 0 starts on the pin and moves away (zoom out then in); finger 1 is 90 px to the right.
    await touch(page, (t) => [
      { x: pin.x - 50 * t, y: pin.y },
      { x: pin.x + 90 + 50 * t, y: pin.y },
    ]);
    await touch(page, (t) => [
      { x: pin.x - 50 + 50 * t, y: pin.y },
      { x: pin.x + 140 - 50 * t, y: pin.y },
    ]);
    await page.waitForTimeout(400);
  }
  expect(await anchorsOf(page)).toEqual(before);
  await expect(pins).toHaveCount(4);
});

test('a finger that slides on a park-map pin before the pinch starts leaves the anchor where it was [T-317]', async ({
  page,
}) => {
  test.setTimeout(60_000);
  await openFixture(page, 'tests/fixtures/generated/solid.png');
  await page.evaluate(() => {
    const t = window.__trailmaker!;
    const cur = t.session.getSession()!;
    t.session.openSession({
      project: { ...cur.project, anchors: [{ id: 'a0', px: [300, 300], ll: [38.6, -78.4], source: 'paste' as const }] },
      map: cur.map,
    });
  });
  const before = await anchorsOf(page);
  const pin = await page.evaluate(() => window.__trailmaker!.imageToClient([300, 300]));
  const cdp = await page.context().newCDPSession(page);
  // First finger lands on the pin and slides 12 px before the second finger arrives.
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: pin.x, y: pin.y - 4, id: 0 }] });
  for (let i = 1; i <= 4; i++)
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: pin.x + i * 3, y: pin.y - 4, id: 0 }] });
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [
      { x: pin.x + 12, y: pin.y - 4, id: 0 },
      { x: pin.x + 100, y: pin.y - 4, id: 1 },
    ],
  });
  for (let i = 1; i <= 8; i++)
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [
        { x: pin.x + 12 - i * 5, y: pin.y - 4, id: 0 },
        { x: pin.x + 100 + i * 5, y: pin.y - 4, id: 1 },
      ],
    });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(300);
  expect(await anchorsOf(page)).toEqual(before);
});
