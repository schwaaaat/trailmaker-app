import type { LatLon } from '../types';

const D2R = Math.PI / 180;
const R = 6378137;

/** Great-circle distance in meters (prototype Earth radius). */
export function haversine(a: LatLon, b: LatLon): number {
  const dLat = (b[0] - a[0]) * D2R,
    dLon = (b[1] - a[1]) * D2R;
  const s =
    Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * D2R) * Math.cos(b[0] * D2R) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Sum of segment lengths, optionally including the closing edge. */
export function pathLength(ll: readonly LatLon[], closed = false): number {
  let distance = 0;
  for (let i = 1; i < ll.length; i++) distance += haversine(ll[i - 1]!, ll[i]!);
  if (closed && ll.length > 1) distance += haversine(ll[ll.length - 1]!, ll[0]!);
  return distance;
}
