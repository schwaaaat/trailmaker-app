import { describe, expect, it } from 'vitest';
import type { Px } from '../types';
import { hasIndependentAffineSupport, MIN_AFFINE_SPREAD_RATIO, spatialSpreadRatio } from './conditioning';

const seabBranch: Px[] = [
  [1127, 720],
  [1025, 562],
  [655, 162],
  [475, 395],
];

describe('affine conditioning', () => {
  it('detects the Seabranch geometry where one control alone supports the cross-line axis', () => {
    expect(spatialSpreadRatio(seabBranch)).toBeGreaterThan(MIN_AFFINE_SPREAD_RATIO);
    expect(spatialSpreadRatio(seabBranch.slice(0, 3))).toBeLessThan(MIN_AFFINE_SPREAD_RATIO);
    expect(hasIndependentAffineSupport(seabBranch)).toBe(false);
  });

  it('accepts a well-spread set that remains conditioned after any one anchor is removed', () => {
    const spread: Px[] = [
      [80, 90],
      [1100, 100],
      [100, 700],
      [1080, 690],
      [590, 330],
    ];
    expect(hasIndependentAffineSupport(spread)).toBe(true);
    expect(spatialSpreadRatio(spread)).toBeGreaterThan(MIN_AFFINE_SPREAD_RATIO);
  });

  it('returns zero for too few points and coincident points', () => {
    expect(spatialSpreadRatio([[1, 1], [2, 2]])).toBe(0);
    expect(spatialSpreadRatio([[1, 1], [1, 1], [1, 1]])).toBe(0);
  });
});
