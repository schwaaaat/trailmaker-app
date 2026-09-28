import { describe, expect, it } from 'vitest';
import type { GeoFit } from '../core/types';
import { anchorOutlier, hasOutlier, looOutlierLimit } from './outliers';

const fit = (over: Partial<GeoFit>): GeoFit => ({
  ok: true,
  requested: 'tps',
  method: 'tps',
  frame: { lat0: 0, lon0: 0, kx: 1, ky: 1, cx: 0, cy: 0, scale: 1 },
  model: { kind: 'affine', affine: [1, 0, 0, 0, 1, 0] },
  anchorCount: 5,
  residuals: { a: 1, b: 1, c: 1, d: 1, e: 1 },
  rms: 1,
  checked: true,
  looResiduals: null,
  metersPerPixel: 1,
  mirrored: false,
  implausibleScale: false,
  ...over,
});

describe('LOO outlier rule (T-208)', () => {
  it('limit is max(25 m, 2.2 x median LOO residual)', () => {
    expect(looOutlierLimit(fit({ looResiduals: { a: 5, b: 6, c: 7, d: 8, e: 9 } }))).toBe(25);
    // median of [20, 30, 40, 50] is 35 -> 77
    expect(looOutlierLimit(fit({ looResiduals: { a: 20, b: 30, c: 40, d: 50 } }))).toBeCloseTo(
      77,
      12,
    );
    expect(looOutlierLimit(fit({ looResiduals: null }))).toBeNull();
    expect(looOutlierLimit(fit({ looResiduals: {} }))).toBeNull();
  });

  it.each([
    // [case, looResiduals, residuals/rms, anchor, flagged]
    ['LOO over the 25 m floor', { a: 5, b: 6, c: 7, d: 8, e: 60 }, 'e', true],
    ['LOO under the floor', { a: 5, b: 6, c: 7, d: 8, e: 24 }, 'e', false],
    ['LOO over 2.2 x median', { a: 40, b: 40, c: 40, d: 40, e: 90 }, 'e', true],
    ['LOO just under 2.2 x median', { a: 40, b: 40, c: 40, d: 40, e: 87 }, 'e', false],
    ['not flagged when normal', { a: 5, b: 6, c: 7, d: 8, e: 60 }, 'a', false],
  ] as const)('%s', (_name, loo, id, flagged) => {
    expect(anchorOutlier(fit({ looResiduals: loo }), id)).toBe(flagged);
  });

  it('falls back to isOutlier (plain residuals) without a LOO value for the anchor', () => {
    const plain = fit({
      residuals: { a: 1, b: 1, c: 1, d: 1, e: 80 },
      rms: 10,
      looResiduals: null,
    });
    expect(anchorOutlier(plain, 'e')).toBe(true);
    expect(anchorOutlier(plain, 'a')).toBe(false);
    // LOO computed for others but not this anchor (its LOO fit failed): plain rule for it.
    const partial = fit({
      residuals: { a: 1, b: 1, c: 1, d: 1, e: 80 },
      rms: 10,
      looResiduals: { a: 1, b: 1 },
    });
    expect(anchorOutlier(partial, 'e')).toBe(true);
    // An unchecked fit never flags through the plain rule.
    expect(anchorOutlier(fit({ checked: false, residuals: { e: 999 }, rms: 1 }), 'e')).toBe(false);
  });

  it('hasOutlier answers for any anchor in the fit', () => {
    expect(hasOutlier(fit({ looResiduals: { a: 5, b: 6, c: 7, d: 8, e: 60 } }))).toBe(true);
    expect(hasOutlier(fit({ looResiduals: { a: 5, b: 6, c: 7, d: 8, e: 9 } }))).toBe(false);
    // TPS plain residuals may be tiny while LOO reveals the bad anchor.
    expect(
      hasOutlier(
        fit({
          residuals: { a: 0, b: 0, c: 0, d: 0, e: 0 },
          rms: 0,
          looResiduals: { a: 3, b: 3, c: 3, d: 3, e: 120 },
        }),
      ),
    ).toBe(true);
  });
});
