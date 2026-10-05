import { describe, expect, it } from 'vitest';
import {
  MAX_ZOOM,
  MIN_ZOOM,
  centerOn,
  fitView,
  panBy,
  preserveCenterOnResize,
  toImg,
  toScr,
  zoomAt,
  type View,
} from './view';

const V: View = { s: 2.5, x: -130, y: 47 };

describe('view math', () => {
  it('toScr and toImg are inverses', () => {
    for (const p of [
      [0, 0],
      [123.25, -7],
      [4000, 2999.5],
    ] as const) {
      const [sx, sy] = toScr(V, p);
      expect(sx).toBe(p[0] * 2.5 - 130);
      const [x, y] = toImg(V, [sx, sy]);
      expect(x).toBeCloseTo(p[0], 10);
      expect(y).toBeCloseTo(p[1], 10);
    }
  });

  it('zoomAt keeps the image point under the cursor fixed', () => {
    const at = [311, 207] as const;
    const before = toImg(V, at);
    for (const f of [1.25, 0.5, 3]) {
      const z = zoomAt(V, at, f);
      expect(z.s).toBeCloseTo(V.s * f, 12);
      const after = toImg(z, at);
      expect(after[0]).toBeCloseTo(before[0], 9);
      expect(after[1]).toBeCloseTo(before[1], 9);
    }
  });

  it('zoomAt clamps scale to 0.02..40 and still keeps the cursor point fixed', () => {
    const at = [50, 60] as const;
    const hi = zoomAt(V, at, 1000);
    expect(hi.s).toBe(MAX_ZOOM);
    const lo = zoomAt(V, at, 1e-6);
    expect(lo.s).toBe(MIN_ZOOM);
    for (const z of [hi, lo]) {
      const p = toImg(z, at);
      const q = toImg(V, at);
      expect(p[0]).toBeCloseTo(q[0], 9);
      expect(p[1]).toBeCloseTo(q[1], 9);
    }
    expect([MIN_ZOOM, MAX_ZOOM]).toStrictEqual([0.02, 40]);
  });

  it('fitView centers the image with the prototype 0.94 margin', () => {
    const v = fitView(800, 600, 2000, 1000);
    expect(v.s).toBeCloseTo(Math.min(800 / 2000, 600 / 1000) * 0.94, 12);
    // Centered: image center maps to the canvas center.
    const [cx, cy] = toScr(v, [1000, 500]);
    expect(cx).toBeCloseTo(400, 9);
    expect(cy).toBeCloseTo(300, 9);
  });

  it('fitView of an empty canvas or image returns a usable unit view', () => {
    expect(fitView(0, 600, 100, 100)).toStrictEqual({ s: 1, x: 0, y: 0 });
    expect(fitView(800, 600, 0, 0)).toStrictEqual({ s: 1, x: 0, y: 0 });
  });

  it('centerOn puts an image point at the canvas center; panBy shifts', () => {
    const v = centerOn(V, 640, 480, [100, 200]);
    expect(toScr(v, [100, 200])).toStrictEqual([320, 240]);
    expect(v.s).toBe(V.s);
    expect(panBy(V, 5, -7)).toStrictEqual({ s: 2.5, x: -125, y: 40 });
  });

  it('preserves the image point at canvas center when the stage width changes', () => {
    const old = { s: 1.75, x: -420, y: 90 };
    const imageAtCenter = toImg(old, [800, 450]);
    const resized = preserveCenterOnResize(old, 1600, 900, 1876, 996);
    expect(toImg(resized, [938, 498])).toEqual(imageAtCenter);
    expect(resized.s).toBe(old.s);
    expect(preserveCenterOnResize(old, 0, 0, 500, 400)).toBe(old);
  });
});
