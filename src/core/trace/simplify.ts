import type { Px } from '../types';

/** Iterative Douglas-Peucker with the prototype's perpendicular-distance rule. */
export function simplify(pts: readonly Px[], eps: number): Px[] {
  if (pts.length < 3) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stackLeft = new Int32Array(pts.length * 2);
  const stackRight = new Int32Array(pts.length * 2);
  let stackSize = 1;
  stackLeft[0] = 0;
  stackRight[0] = pts.length - 1;
  while (stackSize > 0) {
    stackSize--;
    const a = stackLeft[stackSize]!;
    const b = stackRight[stackSize]!;
    const [ax, ay] = pts[a]!,
      [bx, by] = pts[b]!;
    const dx = bx - ax,
      dy = by - ay,
      length = Math.hypot(dx, dy);
    let maxMeasure = -1,
      farthest = -1;
    for (let i = a + 1; i < b; i++) {
      const [x, y] = pts[i]!;
      const measure =
        length > 1e-6
          ? Math.abs(dy * x - dx * y + bx * ay - by * ax)
          : Math.hypot(x - ax, y - ay);
      if (measure > maxMeasure) {
        maxMeasure = measure;
        farthest = i;
      }
    }
    // For a non-degenerate chord, every candidate distance shares the same divisor `length`.
    // Compare the unscaled cross products to avoid a division for every point. Keep the exact
    // degenerate-chord rule and negative-epsilon behavior.
    const exceedsEpsilon =
      eps < 0 || (length > 1e-6 ? maxMeasure > eps * length : maxMeasure > eps);
    // A negative epsilon keeps every existing vertex, but adjacent ranges have no
    // interior candidate to split at. The prototype simply leaves those ranges alone.
    if (farthest >= 0 && exceedsEpsilon) {
      keep[farthest] = 1;
      stackLeft[stackSize] = a;
      stackRight[stackSize] = farthest;
      stackSize++;
      stackLeft[stackSize] = farthest;
      stackRight[stackSize] = b;
      stackSize++;
    }
  }
  const result: Px[] = [];
  for (let i = 0; i < pts.length; i++) if (keep[i]) result.push(pts[i]!);
  return result;
}
