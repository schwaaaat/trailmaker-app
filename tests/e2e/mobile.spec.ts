import { expect, test } from './network-fixture';
import { openReadyApp } from './app-ready';

type Page = Parameters<typeof openReadyApp>[0];

/**
 * Phone acceptance (T-219 / T-315). Found on a real Galaxy S20 FE: the page was wider than the
 * screen, only some regions scrolled, and desktop-only hints covered the map.
 * Gating since T-219 and T-315 merged (D-029).
 */

// Pixel 7-class phone, inlined: specs may only import Playwright through ./network-fixture.
const phone = {
  userAgent:
    'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
  deviceScaleFactor: 2.625,
  isMobile: true,
  hasTouch: true,
};
const PHONES = [
  { name: 'Pixel 7 (412x915)', use: { ...phone, viewport: { width: 412, height: 915 } } },
  { name: 'small phone (360x740)', use: { ...phone, viewport: { width: 360, height: 740 } } },
];

async function openMap(page: Page) {
  await openReadyApp(page);
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByRole('button', { name: 'Open image or PDF' }).first().click(),
  ]);
  await chooser.setFiles('tests/fixtures/real/zion-wilderness.png');
  await expect
    .poll(() => page.evaluate(() => window.__trailmaker!.session.getSession()?.project.image.fileName))
    .toBe('zion-wilderness');
  await page.evaluate(() => window.__trailmaker!.idle());
}

/** Elements whose right edge is past the viewport (ignores clipped descendants of overflow:hidden). */
async function overflowing(page: Page) {
  return page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const out: string[] = [];
    for (const el of document.querySelectorAll<HTMLElement>('body *')) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.right <= vw + 1) continue;
      let clipped = false;
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
        const o = getComputedStyle(p);
        if ((o.overflowX !== 'visible' || o.overflow === 'hidden') && p.getBoundingClientRect().right <= vw + 1) {
          clipped = true;
          break;
        }
      }
      if (!clipped) out.push(`${el.tagName.toLowerCase()}.${el.className} right=${Math.round(r.right)} vw=${vw}`);
    }
    return { scrollWidth: document.documentElement.scrollWidth, vw, out: out.slice(0, 8) };
  });
}

/** True when the element's centre is the topmost hit, i.e. a tap there reaches it. */
async function tappable(page: Page, name: string) {
  const el = page.getByRole('button', { name, exact: true }).first();
  await el.scrollIntoViewIfNeeded();
  return el.evaluate((node) => {
    const r = node.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return !!hit && (hit === node || node.contains(hit));
  });
}

async function pinch(page: Page, cx: number, cy: number, from: number, to: number) {
  const cdp = await page.context().newCDPSession(page);
  const pts = (d: number) => [
    { x: cx - d, y: cy, id: 0 },
    { x: cx + d, y: cy, id: 1 },
  ];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pts(from) });
  for (let i = 1; i <= 8; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pts(from + ((to - from) * i) / 8) });
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

for (const phone of PHONES) {
  test.describe(phone.name, () => {
    test.use(phone.use);

    test('nothing is wider than the screen, before and after opening a map', async ({ page }) => {
      await openReadyApp(page);
      expect(await overflowing(page)).toEqual(expect.objectContaining({ out: [] }));
      await openMap(page);
      const after = await overflowing(page);
      expect(after.out).toEqual([]);
      expect(after.scrollWidth).toBeLessThanOrEqual(after.vw + 1);
    });

    test('every step is reachable and its main button takes a tap', async ({ page }) => {
      await openMap(page);
      // The page scrolls as a whole; the steps are not a separate scroll box (T-219 item 2).
      const scroll = await page.evaluate(() => ({
        page: document.scrollingElement!.scrollHeight > window.innerHeight,
        side: getComputedStyle(document.querySelector('.side')!).overflowY,
      }));
      expect(scroll.page).toBe(true);
      expect(['auto', 'scroll']).not.toContain(scroll.side);
      for (const step of ['Open map', 'Pin to real world', 'Trace', 'Export']) {
        const heading = page.getByRole('heading', { name: step, exact: true });
        await heading.scrollIntoViewIfNeeded();
        await expect(heading).toBeInViewport();
      }
      expect(await tappable(page, 'Add anchor')).toBe(true);
      expect(await tappable(page, 'Find trails')).toBe(true);
    });

    test('the map gets most of the screen and hints do not bury it', async ({ page }) => {
      await openMap(page);
      const vh = await page.evaluate(() => window.innerHeight);
      const editor = await page.locator('.stage-editor').boundingBox();
      expect(editor!.height).toBeGreaterThanOrEqual(vh * 0.55 - 1);
      const tip = page.locator('.tip');
      if (await tip.isVisible()) {
        const box = (await tip.boundingBox())!;
        expect(box.height * box.width).toBeLessThanOrEqual(editor!.height * editor!.width * 0.12);
        await expect(tip).not.toContainText(/right-click|shift-click|scroll to zoom/i);
      }
    });

    test('one finger pans and two fingers zoom the map', async ({ page }) => {
      await openMap(page);
      const box = (await page.locator('.stage-editor').boundingBox())!;
      const cx = box.x + box.width / 2;
      const cy = box.y + box.height / 2;
      const at = () => page.evaluate(() => window.__trailmaker!.imageToClient([500, 500]));
      const before = await at();
      await pinch(page, cx, cy, 40, 140);
      const zoomed = await at();
      expect(Math.hypot(zoomed.x - cx, zoomed.y - cy)).toBeGreaterThan(Math.hypot(before.x - cx, before.y - cy) * 1.5);
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: cx, y: cy, id: 0 }] });
      for (let i = 1; i <= 6; i++) {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: cx + i * 15, y: cy, id: 0 }] });
      }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      const panned = await at();
      expect(panned.x - zoomed.x).toBeGreaterThan(60);
    });

    test('a trail can be traced and finished with taps alone', async ({ page }) => {
      await openMap(page);
      await page.getByRole('toolbar', { name: 'Map tools' }).getByRole('button', { name: 'Trail', exact: true }).tap();
      for (const px of [
        [700, 900],
        [760, 960],
        [820, 1000],
      ] as const) {
        const p = await page.evaluate((q) => window.__trailmaker!.imageToClient(q), px as unknown as [number, number]);
        await page.touchscreen.tap(p.x, p.y);
        await page.evaluate(() => window.__trailmaker!.idle());
      }
      await page.getByRole('group', { name: 'Drawing' }).getByRole('button', { name: /Finish trail/ }).tap();
      await expect
        .poll(() =>
          page.evaluate(
            () => window.__trailmaker!.session.getSession()!.project.features.filter((f) => f.kind === 'trail').length,
          ),
        )
        .toBe(1);
    });
  });
}
