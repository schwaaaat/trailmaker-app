import { describe, expect, it } from 'vitest';
import type { GeoFit } from '../../core/types';
import { inverse } from '../../core/geo/fit';
import { locationToMapOverlay } from './location-overlay';

const fit = {
  frame: {
    cx: 120,
    cy: 240,
    scale: 2,
    lat0: 27.135,
    lon0: -80.172,
    kx: 100_000,
    ky: 100_000,
  },
  model: { kind: 'affine', affine: [1, 0, 0, 0, 1, 0] },
} as unknown as GeoFit;

describe('local GPS map overlay', () => {
  it('maps the fix and sampled accuracy circle through the inverse fit', () => {
    const location: readonly [number, number] = [27.1352, -80.1718];
    const overlay = locationToMapOverlay(fit, { location, accuracyMeters: 30 });

    expect(overlay?.center).toEqual(inverse(fit, location));
    expect(overlay?.accuracyBoundary).toHaveLength(32);
    expect(overlay?.accuracyBoundary.every(([x, y]) => Number.isFinite(x + y))).toBe(true);
  });

  it('returns null when the fit cannot map the location', () => {
    const singular = {
      ...fit,
      model: { kind: 'affine', affine: [1, 0, 0, 0, 0, 0] },
    } as unknown as GeoFit;
    expect(
      locationToMapOverlay(singular, { location: [27.135, -80.172], accuracyMeters: 10 }),
    ).toBeNull();
  });
});
