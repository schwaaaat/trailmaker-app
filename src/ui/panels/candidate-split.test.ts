import { describe, expect, it } from 'vitest';
import type { Px } from '../../core/types';
import type { ReviewCandidate } from '../../state/store';
import { splitCandidateAt, splitCandidateAtMidpoint } from './candidate-split';

const cand = (pts: Px[], over: Partial<ReviewCandidate> = {}): ReviewCandidate => ({
  id: 'k1',
  chipId: 'c1',
  pts,
  lengthPx: 0,
  ink: [200, 40, 40],
  confidence: 0.8,
  on: true,
  name: 'Red trail',
  color: '#c82828',
  ...over,
});

const seq = () => {
  let n = 0;
  return () => `new${++n}`;
};

describe('splitCandidateAt', () => {
  it('snaps to an interior vertex within tolerance, keeping the id/name on the first half', () => {
    const c = cand([
      [0, 0],
      [10, 0],
      [20, 0],
    ]);
    const result = splitCandidateAt(c, [10, 1], 5, seq());
    expect(result).not.toBeNull();
    expect(result!.a).toMatchObject({
      id: 'k1',
      name: 'Red trail',
      pts: [
        [0, 0],
        [10, 0],
      ],
    });
    expect(result!.b).toMatchObject({
      id: 'new1',
      name: 'Red trail (2)',
      pts: [
        [10, 0],
        [20, 0],
      ],
    });
    expect(result!.a.lengthPx).toBeCloseTo(10);
    expect(result!.b.lengthPx).toBeCloseTo(10);
  });

  it('both halves keep chip, ink, confidence and alsoChips', () => {
    const c = cand(
      [
        [0, 0],
        [10, 0],
        [20, 0],
      ],
      { chipId: 'c2', ink: [1, 2, 3], confidence: 0.42, alsoChips: ['c3'] },
    );
    const result = splitCandidateAt(c, [10, 0], 5, seq())!;
    for (const half of [result.a, result.b]) {
      expect(half.chipId).toBe('c2');
      expect(half.ink).toStrictEqual([1, 2, 3]);
      expect(half.confidence).toBe(0.42);
      expect(half.alsoChips).toStrictEqual(['c3']);
    }
  });

  it('inserts a new vertex when the click lands mid-segment, not on a vertex', () => {
    const c = cand([
      [0, 0],
      [20, 0],
    ]);
    const result = splitCandidateAt(c, [8, 3], 2, seq())!;
    expect(result.a.pts).toStrictEqual([
      [0, 0],
      [8, 0],
    ]);
    expect(result.b.pts).toStrictEqual([
      [8, 0],
      [20, 0],
    ]);
  });

  it('refuses to split at either endpoint', () => {
    const c = cand([
      [0, 0],
      [10, 0],
      [20, 0],
    ]);
    expect(splitCandidateAt(c, [0, 0], 5, seq())).toBeNull();
    expect(splitCandidateAt(c, [20, 0], 5, seq())).toBeNull();
  });

  it('refuses a split that would leave a half with fewer than 2 points', () => {
    // A single-point "line" has no segment or interior vertex to split at.
    expect(splitCandidateAt(cand([[5, 5]]), [5, 5], 5, seq())).toBeNull();
    expect(splitCandidateAt(cand([]), [5, 5], 5, seq())).toBeNull();
  });

  it('prefers a vertex snap over a segment projection when both are in range', () => {
    const c = cand([
      [0, 0],
      [10, 0],
      [20, 0],
    ]);
    // Closer to the segment midpoint (15,0) than to vertex (10,0), but vertex tolerance is wide.
    const result = splitCandidateAt(c, [12, 0], 15, seq())!;
    expect(result.a.pts).toStrictEqual([
      [0, 0],
      [10, 0],
    ]);
  });

  it('keyboard split at a vertex matches Alt-click at the same vertex', () => {
    const c = cand([
      [0, 0],
      [3, 2],
      [8, 5],
      [14, 5],
      [21, 3],
    ]);
    const at = c.pts[2]!;
    const keyboard = splitCandidateAt(c, at, 0, () => 'new1');
    const altClick = splitCandidateAt(c, at, 8, () => 'new1');
    expect(keyboard).toStrictEqual(altClick);
  });
});

describe('splitCandidateAtMidpoint', () => {
  it('splits at the arc-length midpoint', () => {
    const c = cand([
      [0, 0],
      [10, 0],
      [10, 10],
    ]); // total length 20, midpoint at [10, 0]
    const result = splitCandidateAtMidpoint(c, seq())!;
    expect(result.a.pts).toStrictEqual([
      [0, 0],
      [10, 0],
    ]);
    expect(result.b.pts).toStrictEqual([
      [10, 0],
      [10, 10],
    ]);
  });

  it('refuses a zero-length or single-point candidate', () => {
    expect(splitCandidateAtMidpoint(cand([[5, 5]]), seq())).toBeNull();
    expect(
      splitCandidateAtMidpoint(
        cand([
          [5, 5],
          [5, 5],
        ]),
        seq(),
      ),
    ).toBeNull();
  });
});
