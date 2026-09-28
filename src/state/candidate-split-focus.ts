import type { CandidateId } from '../core/types';

/** Keyboard focus for the point where a reviewed candidate will be split. */
export interface CandidateSplitFocus {
  readonly candidateId: CandidateId;
  /** Zero-based vertex index in the candidate polyline. */
  readonly index: number;
  /** True after an arrow changed the initial split point. */
  readonly moved: boolean;
}

/** Start near the middle, but only at a valid interior vertex. */
export function initialCandidateSplitPoint(pointCount: number): number | null {
  if (!Number.isInteger(pointCount) || pointCount < 3) return null;
  return Math.floor((pointCount - 1) / 2);
}

/** Move one or ten candidate vertices, clamped away from degenerate endpoint splits. */
export function stepCandidateSplitPoint(
  index: number,
  pointCount: number,
  direction: -1 | 1,
  amount: 1 | 10 = 1,
): number | null {
  if (!Number.isInteger(pointCount) || pointCount < 3) return null;
  const first = 1;
  const last = pointCount - 2;
  return Math.max(first, Math.min(last, index + direction * amount));
}

export function candidateSplitAnnouncement(index: number, pointCount: number): string {
  return `Split point ${index + 1} of ${pointCount}`;
}
