import { describe, expect, it } from 'vitest';
import type { LatLon } from '../types';
import { haversine, pathLength } from './distance';
// @ts-expect-error Verbatim prototype is untyped and test-only.
import { hav, pathLen } from './__prototype__/utilities.js';

describe('distance characterization', () => {
  const points: LatLon[] = [
    [26.36, -80.12],
    [26.37, -80.13],
    [26.38, -80.11],
  ];
  it('matches prototype haversine to nanometers', () => {
    for (const a of points)
      for (const b of points) expect(Math.abs(haversine(a, b) - hav(a, b))).toBeLessThan(1e-9);
  });
  it('sums segments and an optional closing edge', () => {
    expect(pathLength(points)).toBe(pathLen(points));
    expect(pathLength(points, true)).toBe(pathLen(points) + hav(points[2]!, points[0]!));
    expect(pathLength([], true)).toBe(0);
    expect(pathLength([points[0]!], true)).toBe(0);
  });
});
