import type { Px, RasterImage, Rgb } from '../types';

const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, value));

/** Pick the pixel color that differs most from the local mean after a distance penalty. */
export function pickInk(img: RasterImage, at: Px, radiusPx: number): Rgb {
  const { width, height, data } = img;
  if (width < 1 || height < 1) return [0, 0, 0];
  const x = Math.round(at[0]),
    y = Math.round(at[1]);
  const radius = clamp(Math.round(radiusPx), 1, 14);
  const extent = radius * 2;
  let red = 0,
    green = 0,
    blue = 0,
    count = 0;
  for (let yy = Math.max(0, y - extent); yy <= Math.min(height - 1, y + extent); yy++) {
    for (let xx = Math.max(0, x - extent); xx <= Math.min(width - 1, x + extent); xx++) {
      const i = (yy * width + xx) * 4;
      red += data[i]!;
      green += data[i + 1]!;
      blue += data[i + 2]!;
      count++;
    }
  }
  if (!count) return [0, 0, 0];
  const meanR = red / count,
    meanG = green / count,
    meanB = blue / count;
  let bestScore = -1,
    bestR = 0,
    bestG = 0,
    bestB = 0;
  for (let yy = Math.max(0, y - radius); yy <= Math.min(height - 1, y + radius); yy++) {
    for (let xx = Math.max(0, x - radius); xx <= Math.min(width - 1, x + radius); xx++) {
      const dx = xx - x,
        dy = yy - y;
      if (dx * dx + dy * dy > radius * radius) continue;
      const i = (yy * width + xx) * 4;
      const dr = data[i]! - meanR,
        dg = data[i + 1]! - meanG,
        db = data[i + 2]! - meanB;
      const score = Math.hypot(dr, dg, db) - Math.hypot(dx, dy) * 2;
      if (score > bestScore) {
        bestScore = score;
        bestR = data[i]!;
        bestG = data[i + 1]!;
        bestB = data[i + 2]!;
      }
    }
  }
  if (bestScore < 10) {
    const cx = clamp(x, 0, width - 1),
      cy = clamp(y, 0, height - 1),
      i = (cy * width + cx) * 4;
    return [data[i]!, data[i + 1]!, data[i + 2]!];
  }
  return [bestR, bestG, bestB];
}

/** Find the best nearby pixel within both the distance radius and color tolerance. */
export function snapToInk(
  img: RasterImage,
  at: Px,
  ink: Rgb,
  tolerance: number,
  radiusPx: number,
): Px | null {
  const { width, height, data } = img;
  const x = Math.round(at[0]),
    y = Math.round(at[1]);
  const radius = clamp(Math.round(radiusPx), 2, 30);
  const maxTolerance = Math.max(0, tolerance);
  let bestScore = Infinity,
    bestX = -1,
    bestY = -1;
  for (let yy = Math.max(0, y - radius); yy <= Math.min(height - 1, y + radius); yy++) {
    for (let xx = Math.max(0, x - radius); xx <= Math.min(width - 1, x + radius); xx++) {
      const distance = Math.hypot(xx - at[0], yy - at[1]);
      if (distance > radius) continue;
      const i = (yy * width + xx) * 4;
      const colorDistance = Math.hypot(
        data[i]! - ink[0],
        data[i + 1]! - ink[1],
        data[i + 2]! - ink[2],
      );
      if (colorDistance > maxTolerance) continue;
      const score =
        distance + (maxTolerance > 0 ? (colorDistance / maxTolerance) * radius * 0.5 : 0);
      if (score < bestScore) {
        bestScore = score;
        bestX = xx;
        bestY = yy;
      }
    }
  }
  return bestX < 0 ? null : [bestX, bestY];
}
