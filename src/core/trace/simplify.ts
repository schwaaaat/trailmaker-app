import type { Feature, FeatureId, Px } from '../types';

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

const round2 = (v: number): number => Math.round(v * 100) / 100;

/**
 * Light Chaikin-style corner-cutting smoothing pass (T-222 Acceptance 2).
 * For open polylines, keeps endpoints fixed. For closed rings (areas), rounds all corners.
 */
export function chaikinSmooth(pts: readonly Px[], closed = false): Px[] {
  if (pts.length < 3) return pts.slice();
  if (closed) {
    const n = pts.length;
    const result: Px[] = [];
    for (let i = 0; i < n; i++) {
      const p0 = pts[i]!;
      const p1 = pts[(i + 1) % n]!;
      result.push([
        round2(0.75 * p0[0] + 0.25 * p1[0]),
        round2(0.75 * p0[1] + 0.25 * p1[1]),
      ]);
      result.push([
        round2(0.25 * p0[0] + 0.75 * p1[0]),
        round2(0.25 * p0[1] + 0.75 * p1[1]),
      ]);
    }
    return result;
  }

  const n = pts.length;
  const result: Px[] = [pts[0]!]; // endpoint fixed
  for (let i = 0; i < n - 1; i++) {
    const p0 = pts[i]!;
    const p1 = pts[i + 1]!;
    if (i > 0) {
      result.push([
        round2(0.75 * p0[0] + 0.25 * p1[0]),
        round2(0.75 * p0[1] + 0.25 * p1[1]),
      ]);
    }
    if (i < n - 2) {
      result.push([
        round2(0.25 * p0[0] + 0.75 * p1[0]),
        round2(0.25 * p0[1] + 0.75 * p1[1]),
      ]);
    }
  }
  result.push(pts[n - 1]!); // endpoint fixed
  return result;
}

/**
 * Finds all vertex coordinates shared with another trail (a junction), or shared between
 * a trail and an area (T-222 Acceptance 3). Topology requires that these vertices remain fixed.
 */
export function findJunctionCoordinates(features: readonly Feature[]): Set<string> {
  const trailOwners = new Map<string, FeatureId>();
  const junctions = new Set<string>();
  for (const f of features) {
    if (f.kind !== 'trail') continue;
    for (const pt of f.pts) {
      const k = `${pt[0]},${pt[1]}`;
      const prev = trailOwners.get(k);
      if (prev !== undefined && prev !== f.id) {
        junctions.add(k);
      } else if (prev === undefined) {
        trailOwners.set(k, f.id);
      }
    }
  }
  for (const f of features) {
    if (f.kind !== 'area') continue;
    for (const pt of f.pts) {
      const k = `${pt[0]},${pt[1]}`;
      if (trailOwners.has(k)) {
        junctions.add(k);
      }
    }
  }
  return junctions;
}

/**
 * Simplifies a polyline or ring using Douglas-Peucker while guaranteeing that every
 * vertex index in `fixedIndices` (including endpoints for open trails) is preserved at
 * its exact coordinate (T-222 Acceptance 3).
 */
export function simplifyPathWithFixed(
  pts: readonly Px[],
  eps: number,
  fixedIndices: ReadonlySet<number>,
  closed = false,
): Px[] {
  if (pts.length < 3 || eps <= 0) return pts.slice();

  if (!closed) {
    const sorted = Array.from(fixedIndices).filter((i) => i >= 0 && i < pts.length);
    if (!sorted.includes(0)) sorted.push(0);
    if (!sorted.includes(pts.length - 1)) sorted.push(pts.length - 1);
    sorted.sort((a, b) => a - b);

    const result: Px[] = [];
    for (let j = 0; j < sorted.length - 1; j++) {
      const start = sorted[j]!;
      const end = sorted[j + 1]!;
      if (end <= start) continue;
      const sub = pts.slice(start, end + 1);
      const simplifiedSub = simplify(sub, eps);
      if (result.length === 0) {
        result.push(...simplifiedSub);
      } else {
        result.push(...simplifiedSub.slice(1));
      }
    }
    return result;
  }

  // Closed ring (Area)
  const sorted = Array.from(fixedIndices)
    .filter((i) => i >= 0 && i < pts.length)
    .sort((a, b) => a - b);

  if (sorted.length === 0) {
    const closedPts = [...pts, pts[0]!];
    const simplified = simplify(closedPts, eps);
    const ring = simplified.slice(0, -1);
    if (ring.length >= 3) return ring;
    return pts.length >= 3 ? pts.slice(0, 3) : pts.slice();
  }

  // Closed ring with fixed vertices: partition along fixed vertices
  const result: Px[] = [];
  for (let j = 0; j < sorted.length; j++) {
    const start = sorted[j]!;
    const end = j === sorted.length - 1 ? sorted[0]! : sorted[j + 1]!;
    let sub: Px[];
    if (j === sorted.length - 1) {
      sub = [...pts.slice(start), ...pts.slice(0, end + 1)];
    } else {
      sub = pts.slice(start, end + 1);
    }
    const simplifiedSub = simplify(sub, eps);
    if (result.length === 0) {
      result.push(...simplifiedSub.slice(0, -1));
    } else {
      result.push(...simplifiedSub.slice(1, -1));
    }
  }
  return result.length >= 3 ? result : pts.slice();
}

/**
 * Smooths a polyline or ring using Chaikin corner-cutting while guaranteeing that every
 * vertex index in `fixedIndices` (including endpoints for open trails) is preserved at
 * its exact coordinate (T-222 Acceptance 3).
 */
export function smoothPathWithFixed(
  pts: readonly Px[],
  fixedIndices: ReadonlySet<number>,
  closed = false,
): Px[] {
  if (pts.length < 3) return pts.slice();

  if (!closed) {
    const sorted = Array.from(fixedIndices).filter((i) => i >= 0 && i < pts.length);
    if (!sorted.includes(0)) sorted.push(0);
    if (!sorted.includes(pts.length - 1)) sorted.push(pts.length - 1);
    sorted.sort((a, b) => a - b);

    const result: Px[] = [];
    for (let j = 0; j < sorted.length - 1; j++) {
      const start = sorted[j]!;
      const end = sorted[j + 1]!;
      if (end <= start) continue;
      const sub = pts.slice(start, end + 1);
      const smoothedSub = chaikinSmooth(sub, false);
      if (result.length === 0) {
        result.push(...smoothedSub);
      } else {
        result.push(...smoothedSub.slice(1));
      }
    }
    return result;
  }

  // Closed ring (Area)
  const sorted = Array.from(fixedIndices)
    .filter((i) => i >= 0 && i < pts.length)
    .sort((a, b) => a - b);

  if (sorted.length === 0) {
    return chaikinSmooth(pts, true);
  }

  const result: Px[] = [];
  for (let j = 0; j < sorted.length; j++) {
    const start = sorted[j]!;
    const end = j === sorted.length - 1 ? sorted[0]! : sorted[j + 1]!;
    let sub: Px[];
    if (j === sorted.length - 1) {
      sub = [...pts.slice(start), ...pts.slice(0, end + 1)];
    } else {
      sub = pts.slice(start, end + 1);
    }
    const smoothedSub = chaikinSmooth(sub, false);
    if (result.length === 0) {
      result.push(...smoothedSub.slice(0, -1));
    } else {
      result.push(...smoothedSub.slice(1, -1));
    }
  }
  return result.length >= 3 ? result : pts.slice();
}

/**
 * Simplifies and/or smooths a Trail or Area, keeping endpoints and junction vertices fixed.
 */
export function simplifyFeature<T extends Feature>(
  feature: T,
  tolerancePx: number,
  smooth: boolean,
  junctionCoords: ReadonlySet<string> = new Set(),
): T {
  if (feature.kind === 'poi') return feature;
  const isArea = feature.kind === 'area';
  const pts = feature.pts;
  if (pts.length < 3) return feature;

  // 1. Identify fixed indices based on junctions
  const fixedIndices = new Set<number>();
  if (!isArea) {
    fixedIndices.add(0);
    fixedIndices.add(pts.length - 1);
  }
  for (let i = 0; i < pts.length; i++) {
    const pt = pts[i]!;
    if (junctionCoords.has(`${pt[0]},${pt[1]}`)) {
      fixedIndices.add(i);
    }
  }

  // 2. Simplify if tolerancePx > 0
  let currentPts: Px[];
  if (tolerancePx > 0) {
    currentPts = simplifyPathWithFixed(pts, tolerancePx, fixedIndices, isArea);
  } else {
    currentPts = pts.slice();
  }

  // 3. Smooth if requested
  if (smooth) {
    const smoothFixed = new Set<number>();
    if (!isArea) {
      smoothFixed.add(0);
      smoothFixed.add(currentPts.length - 1);
    }
    for (let i = 0; i < currentPts.length; i++) {
      const pt = currentPts[i]!;
      if (junctionCoords.has(`${pt[0]},${pt[1]}`)) {
        smoothFixed.add(i);
      }
    }
    currentPts = smoothPathWithFixed(currentPts, smoothFixed, isArea);
  }

  return {
    ...feature,
    pts: currentPts,
  };
}

const SIMPLIFY_VERTICES_PER_STEP = 5_000;

/**
 * Generator function that simplifies features in time-sliced steps for runSliced (T-222 Acceptance 4).
 * Yields periodically every ~5,000 vertices processed.
 */
export function* simplifyFeaturesSteps(
  features: readonly Feature[],
  tolerancePx: number,
  smooth = false,
  filter?: (f: Feature) => boolean,
): Generator<void, Feature[], undefined> {
  const junctionCoords = findJunctionCoordinates(features);
  const result: Feature[] = [];
  let verticesSinceYield = 0;

  for (const f of features) {
    if ((filter && !filter(f)) || f.kind === 'poi') {
      result.push(f);
      continue;
    }
    const simplified = simplifyFeature(f, tolerancePx, smooth, junctionCoords);
    result.push(simplified);
    verticesSinceYield += f.pts.length;
    if (verticesSinceYield >= SIMPLIFY_VERTICES_PER_STEP) {
      yield;
      verticesSinceYield = 0;
    }
  }
  if (verticesSinceYield > 0) yield;
  return result;
}
