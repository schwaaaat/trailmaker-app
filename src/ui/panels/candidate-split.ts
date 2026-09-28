// Lane B. Splitting a reviewed auto-trace candidate at a clicked point (card T-210), before
// acceptance touches project history. Adapted from src/core/topology's splitTrail geometry for a
// simplified polyline (a ReviewCandidate has no vertex-insertion history to preserve).
//
// The orchestration functions below live here, not in trace-actions.ts, because tools.ts (T-204)
// needs to call them for Alt-click and trace-actions.ts already imports from tools.ts; putting
// them there would create an import cycle.
import type { CandidateId, Px } from '../../core/types';
import {
  appStore,
  showToast,
  splitCandidateInReview,
  type ReviewCandidate,
} from '../../state/store';
import { VERTEX_HIT_PX } from '../editor/hit';

const pxLength = (pts: readonly Px[]): number => {
  let d = 0;
  for (let i = 1; i < pts.length; i++) {
    d += Math.hypot(pts[i]![0] - pts[i - 1]![0], pts[i]![1] - pts[i - 1]![1]);
  }
  return d;
};

const distance2 = (a: Px, b: Px): number => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;

/** The point on segment ab nearest p. */
function projectToSegment(p: Px, a: Px, b: Px): Px {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return a;
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
  return [a[0] + t * dx, a[1] + t * dy];
}

export interface CandidateSplit {
  /** The first half, keeping the original id and name. */
  readonly a: ReviewCandidate;
  /** The second half, a new id and " (2)" appended to the name. */
  readonly b: ReviewCandidate;
}

function halves(c: ReviewCandidate, left: Px[], right: Px[], newId: () => string): CandidateSplit {
  return {
    a: { ...c, pts: left, lengthPx: pxLength(left) },
    b: { ...c, id: newId(), name: `${c.name} (2)`, pts: right, lengthPx: pxLength(right) },
  };
}

/**
 * Split `c` at the point on its polyline nearest `at` (working-raster px): snap to an existing
 * interior vertex within `vertexTolerancePx`, otherwise insert a new vertex at the nearest
 * segment projection. Both halves keep chip, ink, confidence and alsoChips. Refuses (returns
 * null) a split at either end, or one that would leave either half with fewer than 2 points.
 */
export function splitCandidateAt(
  c: ReviewCandidate,
  at: Px,
  vertexTolerancePx: number,
  newId: () => string,
): CandidateSplit | null {
  if (c.pts.length < 2) return null;
  let nearestVertex = -1;
  let nearestVertexD2 = vertexTolerancePx * vertexTolerancePx;
  for (let i = 1; i < c.pts.length - 1; i++) {
    const d2 = distance2(c.pts[i]!, at);
    if (d2 <= nearestVertexD2) {
      nearestVertexD2 = d2;
      nearestVertex = i;
    }
  }
  if (nearestVertex >= 0) {
    return halves(c, c.pts.slice(0, nearestVertex + 1), c.pts.slice(nearestVertex), newId);
  }
  let bestSeg = -1;
  let bestSegD2 = Infinity;
  let bestPoint: Px = at;
  for (let i = 0; i < c.pts.length - 1; i++) {
    const point = projectToSegment(at, c.pts[i]!, c.pts[i + 1]!);
    const d2 = distance2(at, point);
    if (d2 < bestSegD2) {
      bestSegD2 = d2;
      bestSeg = i;
      bestPoint = point;
    }
  }
  if (bestSeg < 0) return null;
  // A projection landing exactly on the candidate's own start or end point (t=0 on the first
  // segment, or t=1 on the last) would produce a degenerate, zero-length half.
  const first = c.pts[0]!;
  const last = c.pts[c.pts.length - 1]!;
  if (
    (bestSeg === 0 && bestPoint[0] === first[0] && bestPoint[1] === first[1]) ||
    (bestSeg === c.pts.length - 2 && bestPoint[0] === last[0] && bestPoint[1] === last[1])
  ) {
    return null;
  }
  const left = [...c.pts.slice(0, bestSeg + 1), bestPoint];
  const right = [bestPoint, ...c.pts.slice(bestSeg + 1)];
  if (left.length < 2 || right.length < 2) return null;
  return halves(c, left, right, newId);
}

/** Split `c` at its arc-length midpoint (the review row's "Split" button, with no click point). */
export function splitCandidateAtMidpoint(
  c: ReviewCandidate,
  newId: () => string,
): CandidateSplit | null {
  const total = pxLength(c.pts);
  if (total === 0) return null;
  let acc = 0;
  for (let i = 1; i < c.pts.length; i++) {
    const seg = Math.hypot(c.pts[i]![0] - c.pts[i - 1]![0], c.pts[i]![1] - c.pts[i - 1]![1]);
    if (acc + seg >= total / 2) {
      const t = seg === 0 ? 0 : (total / 2 - acc) / seg;
      const mid: Px = [
        c.pts[i - 1]![0] + t * (c.pts[i]![0] - c.pts[i - 1]![0]),
        c.pts[i - 1]![1] + t * (c.pts[i]![1] - c.pts[i - 1]![1]),
      ];
      // tolerancePx 0: the midpoint essentially never lands exactly on an existing vertex, so
      // this always takes the segment-projection path above.
      return splitCandidateAt(c, mid, 0, newId);
    }
    acc += seg;
  }
  return null;
}

const state = () => appStore.getState();
let splitSeq = 0;

/** "Split" (Alt-click on the map, T-210): split candidate `id` at the clicked working-raster px. */
export function splitReviewedCandidate(id: CandidateId, at: Px, viewScale: number): void {
  const cands = state().candidates;
  const c = cands?.find((x) => x.id === id);
  if (!cands || !c) return;
  const result = splitCandidateAt(c, at, VERTEX_HIT_PX / viewScale, () => `${c.id}~${++splitSeq}`);
  if (!result) {
    showToast('Click closer to the middle of the line to split it there.');
    return;
  }
  splitCandidateInReview(cands.flatMap((x) => (x.id === id ? [result.a, result.b] : [x])));
}

/** The review row's "Split" button (T-210): no click point, so split at the line's midpoint. */
export function splitReviewedCandidateAtMidpoint(id: CandidateId): void {
  const cands = state().candidates;
  const c = cands?.find((x) => x.id === id);
  if (!cands || !c) return;
  const result = splitCandidateAtMidpoint(c, () => `${c.id}~${++splitSeq}`);
  if (!result) {
    showToast('This line is too short to split.');
    return;
  }
  splitCandidateInReview(cands.flatMap((x) => (x.id === id ? [result.a, result.b] : [x])));
}

/** Keyboard split at the focused existing candidate vertex (T-217). */
export function splitReviewedCandidateAtVertex(id: CandidateId, index: number): void {
  const cands = state().candidates;
  const c = cands?.find((x) => x.id === id);
  const at = c?.pts[index];
  if (!cands || !c || !at || index <= 0 || index >= c.pts.length - 1) {
    showToast('Choose an interior point on the line to split it.');
    return;
  }
  const result = splitCandidateAt(c, at, 0, () => `${c.id}~${++splitSeq}`);
  if (!result) {
    showToast('This line is too short to split.');
    return;
  }
  splitCandidateInReview(cands.flatMap((x) => (x.id === id ? [result.a, result.b] : [x])));
}
