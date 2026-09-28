// Lane B. View transform of the canvas editor (prototype resize/fitView/toScr/toImg/zoomAt/
// centerOn). Pure: screen coordinates are CSS pixels relative to the canvas's top-left.
import type { Px } from '../../core/types';

/** screen = image * s + (x, y). */
export interface View {
  readonly s: number;
  readonly x: number;
  readonly y: number;
}

/** A point in canvas CSS pixels. */
export type Screen = readonly [sx: number, sy: number];

export const MIN_ZOOM = 0.02;
export const MAX_ZOOM = 40;
/** fitView leaves this fraction of the canvas for the image (prototype). */
export const FIT_MARGIN = 0.94;

export const toScr = (v: View, [x, y]: Px): Screen => [x * v.s + v.x, y * v.s + v.y];

export const toImg = (v: View, [sx, sy]: Screen): Px => [(sx - v.x) / v.s, (sy - v.y) / v.s];

/** Zoom by `factor` (clamped to MIN_ZOOM..MAX_ZOOM) keeping the image point under `at` fixed. */
export function zoomAt(v: View, [sx, sy]: Screen, factor: number): View {
  const s = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.s * factor));
  const k = s / v.s;
  return { s, x: sx - (sx - v.x) * k, y: sy - (sy - v.y) * k };
}

/** The whole width x height image centered in a cw x ch canvas with a small margin. */
export function fitView(cw: number, ch: number, width: number, height: number): View {
  if (cw <= 0 || ch <= 0 || width <= 0 || height <= 0) return { s: 1, x: 0, y: 0 };
  const s = Math.min(cw / width, ch / height) * FIT_MARGIN;
  return { s, x: (cw - width * s) / 2, y: (ch - height * s) / 2 };
}

/** Same zoom, image point `at` moved to the center of a cw x ch canvas. */
export function centerOn(v: View, cw: number, ch: number, [x, y]: Px): View {
  return { s: v.s, x: cw / 2 - x * v.s, y: ch / 2 - y * v.s };
}

export const panBy = (v: View, dx: number, dy: number): View => ({
  s: v.s,
  x: v.x + dx,
  y: v.y + dy,
});
