// Lane A/C. Directed trail route math and geometry-bound invariants (D-043, T-334).
import type { LoopDirection, Px, TrailRoute } from '../types';

/**
 * Compute the signed area of a polygon using the shoelace formula.
 * In screen / map coordinates where y increases downward:
 * - A positive area corresponds to clockwise winding.
 * - A negative area corresponds to counterclockwise winding.
 * - Zero indicates a collinear or degenerate ring.
 */
export function polygonSignedArea(pts: readonly Px[]): number {
  if (pts.length < 3) return 0;
  let sum = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const p1 = pts[i]!;
    const p2 = pts[i + 1]!;
    sum += p1[0] * p2[1] - p2[0] * p1[1];
  }
  // If not explicitly closed, close with the last segment back to the start
  const pFirst = pts[0]!;
  const pLast = pts[pts.length - 1]!;
  if (pFirst[0] !== pLast[0] || pFirst[1] !== pLast[1]) {
    sum += pLast[0] * pFirst[1] - pFirst[0] * pLast[1];
  }
  return sum / 2;
}

/**
 * Determine the winding direction of a closed loop in screen coordinates (y downward).
 * Returns null if the area is degenerate / zero.
 */
export function loopWinding(pts: readonly Px[]): LoopDirection | null {
  const area = polygonSignedArea(pts);
  if (area > 1e-6) return 'clockwise';
  if (area < -1e-6) return 'counterclockwise';
  return null;
}

/**
 * Count distinct (x, y) coordinates in a list of points.
 */
export function distinctVertexCount(pts: readonly Px[]): number {
  const seen = new Set<string>();
  for (const [x, y] of pts) {
    seen.add(`${x},${y}`);
  }
  return seen.size;
}

/**
 * Check if a polyline forms a valid closed loop:
 * - At least 4 vertices in the array
 * - Starts and ends at the exact same vertex (pts[0] === pts[pts.length - 1])
 * - Contains at least 3 distinct vertices
 */
export function isClosedLoop(pts: readonly Px[]): boolean {
  if (pts.length < 4) return false;
  const first = pts[0]!;
  const last = pts[pts.length - 1]!;
  if (first[0] !== last[0] || first[1] !== last[1]) return false;
  return distinctVertexCount(pts) >= 3;
}

/**
 * Rotate a closed loop so that the vertex at newStartIndex becomes the start and end vertex,
 * preserving cyclic order, closure, and winding.
 */
export function rotateLoop(pts: readonly Px[], newStartIndex: number): Px[] {
  if (!Number.isInteger(newStartIndex) || newStartIndex < 0 || newStartIndex >= pts.length) {
    throw new RangeError(`newStartIndex must be between 0 and ${pts.length - 1}`);
  }
  if (!isClosedLoop(pts)) {
    throw new Error('Cannot rotate an open or degenerate loop');
  }
  // The closed loop has pts[0] == pts[pts.length - 1].
  // The distinct vertices in cyclic order are pts.slice(0, -1).
  const distinct = pts.slice(0, -1);
  const n = distinct.length;
  const idx = newStartIndex % n;
  if (idx === 0) {
    return [...pts];
  }
  const rotated = [...distinct.slice(idx), ...distinct.slice(0, idx)];
  return [...rotated, [rotated[0]![0], rotated[0]![1]] as Px];
}

/**
 * Reverse a loop: keeps the trailhead (pts[0]) fixed and reverses the intermediate vertices,
 * flipping the travel direction and winding.
 */
export function reverseLoop(pts: readonly Px[]): Px[] {
  if (!isClosedLoop(pts)) {
    throw new Error('Cannot reverse an unclosed loop with reverseLoop');
  }
  // pts = [p0, p1, ..., pn-2, p0]
  // [...pts].reverse() gives [p0, pn-2, ..., p1, p0]
  // Start and end remain p0; direction is inverted!
  return [...pts].reverse();
}

/**
 * Reverse a one-way trail: swaps the trailhead (pts[0]) and the end (pts[last]).
 */
export function reverseOneWay(pts: readonly Px[]): Px[] {
  return [...pts].reverse();
}

/**
 * Choose which endpoint is the trailhead for a one-way trail.
 * side: 0 means keep current pts[0] as trailhead.
 * side: 1 means reverse so pts.at(-1) becomes trailhead.
 */
export function chooseOneWayStart(pts: readonly Px[], side: 0 | 1): Px[] {
  return side === 0 ? [...pts] : [...pts].reverse();
}

export type CloseLoopResult =
  | { readonly ok: true; readonly pts: Px[]; readonly direction: LoopDirection }
  | { readonly ok: false; readonly error: string };

/**
 * Validate and optionally close an open trail as a loop within a given snap tolerance.
 * If endpoints already touch or are within tolerancePx, snaps the final endpoint to pts[0].
 * Rejects if endpoints are too distant, vertices < 3 distinct, or area is zero.
 */
export function canCloseAsLoop(pts: readonly Px[], tolerancePx: number): CloseLoopResult {
  if (pts.length < 3) {
    return { ok: false, error: 'A loop requires at least 3 vertices.' };
  }
  const first = pts[0]!;
  const last = pts[pts.length - 1]!;
  const dx = first[0] - last[0];
  const dy = first[1] - last[1];
  const dist = Math.hypot(dx, dy);

  let closedPts: Px[];
  if (dist === 0) {
    closedPts = [...pts];
  } else if (dist <= tolerancePx) {
    // Snap final endpoint to first point
    closedPts = [...pts.slice(0, -1), [first[0], first[1]] as Px];
  } else {
    return {
      ok: false,
      error: `Trail ends are too far apart (${dist.toFixed(1)} px) to close into a loop (must be within snap tolerance of ${tolerancePx.toFixed(1)} px).`,
    };
  }

  if (distinctVertexCount(closedPts) < 3) {
    return { ok: false, error: 'A loop requires at least 3 distinct vertices.' };
  }

  const direction = loopWinding(closedPts);
  if (!direction) {
    return { ok: false, error: 'Trail has zero area and cannot form a loop.' };
  }

  return { ok: true, pts: closedPts, direction };
}

export interface RouteInvariantResult {
  readonly valid: boolean;
  readonly reason?: string;
}

/**
 * Validate that a trail's geometry satisfies its route invariants:
 * - One-way: at least 2 points, not closed.
 * - Loop: closed, >= 3 distinct vertices, non-zero area, geometry winding agrees with route.direction.
 */
export function validateRouteInvariants(
  pts: readonly Px[],
  route: TrailRoute | undefined,
): RouteInvariantResult {
  if (!route) return { valid: true };

  if (route.kind === 'one-way') {
    if (pts.length < 2) {
      return { valid: false, reason: 'A one-way trail needs at least 2 points' };
    }
    const first = pts[0]!;
    const last = pts[pts.length - 1]!;
    if (first[0] === last[0] && first[1] === last[1]) {
      return { valid: false, reason: 'A one-way trail cannot be closed' };
    }
    return { valid: true };
  }

  if (route.kind === 'loop') {
    if (!isClosedLoop(pts)) {
      return { valid: false, reason: 'Loop must be closed with at least 3 distinct vertices' };
    }
    const winding = loopWinding(pts);
    if (!winding) {
      return { valid: false, reason: 'Loop must have non-zero area' };
    }
    if (winding !== route.direction) {
      return {
        valid: false,
        reason: `Loop direction ${route.direction} does not match geometry winding ${winding}`,
      };
    }
    return { valid: true };
  }

  return { valid: false, reason: `Unknown route kind "${(route as { kind?: unknown }).kind}"` };
}
