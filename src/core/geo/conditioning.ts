import type { Px } from '../types';

/** Below eight percent, the minor map axis is too weak to trust an affine stretch. */
export const MIN_AFFINE_SPREAD_RATIO = 0.08;

/** Ratio of the minor to major singular values for centred 2D point positions. */
export function spatialSpreadRatio(points: readonly Px[]): number {
  if (points.length < 3) return 0;
  const cx = points.reduce((sum, point) => sum + point[0], 0) / points.length;
  const cy = points.reduce((sum, point) => sum + point[1], 0) / points.length;
  let xx = 0;
  let xy = 0;
  let yy = 0;
  for (const [x, y] of points) {
    const dx = x - cx;
    const dy = y - cy;
    xx += dx * dx;
    xy += dx * dy;
    yy += dy * dy;
  }
  const trace = xx + yy;
  if (!(trace > 0) || !Number.isFinite(trace)) return 0;
  const discriminant = Math.hypot(xx - yy, 2 * xy);
  const largestEigenvalue = (trace + discriminant) / 2;
  if (!(largestEigenvalue > 0)) return 0;
  const determinant = Math.max(0, xx * yy - xy * xy);
  const smallestEigenvalue = determinant / largestEigenvalue;
  return Math.sqrt(smallestEigenvalue / largestEigenvalue);
}

/** Whether these controls have enough 2D spread to determine an affine fit. */
export function supportsAffine(points: readonly Px[]): boolean {
  return points.length >= 3 && spatialSpreadRatio(points) >= MIN_AFFINE_SPREAD_RATIO;
}

/**
 * Require every anchor to be independently removable while retaining affine support.
 * A single off-line point can make the complete set look well-spread while being the only
 * source of information about cross-line stretch.
 */
export function hasIndependentAffineSupport(points: readonly Px[]): boolean {
  if (points.length < 4) return false;
  for (let omitted = 0; omitted < points.length; omitted++) {
    if (!supportsAffine(points.filter((_, index) => index !== omitted))) return false;
  }
  return true;
}
