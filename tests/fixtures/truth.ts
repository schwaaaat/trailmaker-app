import type { Anchor, LatLon, Px, Rgb } from '../../src/core/types';

export interface TruthTransform {
  origin: LatLon;
  metersPerPixel: number;
  metersPerDegree: Px;
  // Pixel x is displaced by amplitude*sin(2*pi*y/period); inverse is exact.
  warp: { amplitude: number; period: number };
}
export interface TruthLine {
  id: string;
  pts: Px[];
  color: Rgb;
  style: 'solid' | 'dashed' | 'dotted';
}
export interface FixtureTruth {
  version: 1;
  name: string;
  seed: number;
  width: number;
  height: number;
  transform: TruthTransform;
  polylines: TruthLine[];
  anchors: Anchor[];
  pois: { name: string; px: Px; ll: LatLon }[];
  challenges: string[];
}
export function warpPixel([x, y]: Px, transform: TruthTransform): Px {
  return [x + transform.warp.amplitude * Math.sin((2 * Math.PI * y) / transform.warp.period), y];
}
export function pixelToLatLon([x, y]: Px, transform: TruthTransform): LatLon {
  const unwarpedX =
    x - transform.warp.amplitude * Math.sin((2 * Math.PI * y) / transform.warp.period);
  return [
    transform.origin[0] - (y * transform.metersPerPixel) / transform.metersPerDegree[1],
    transform.origin[1] + (unwarpedX * transform.metersPerPixel) / transform.metersPerDegree[0],
  ];
}
