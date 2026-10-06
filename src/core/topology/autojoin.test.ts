import { describe, expect, it } from 'vitest';
import type { Feature, Trail } from '../types';
import { autoJoinTrails, trailIntersectsRect } from './autojoin';

const trail = (id: string, pts: Trail['pts']): Trail => ({
  kind: 'trail',
  id,
  pts,
  name: `Trail ${id}`,
  color: '#123456',
  notes: id,
  ink: [1, 2, 3],
});
const apply = (features: readonly Feature[], result: ReturnType<typeof autoJoinTrails>) =>
  features
    .filter((f) => !result.edit.removed.includes(f.id))
    .map((f) => result.edit.updated.find((u) => u.id === f.id) ?? f);
const join = (features: readonly Feature[], ids = features.map((f) => f.id), tolerancePx = 2) =>
  autoJoinTrails(features, ids, { tolerancePx });

describe('trailIntersectsRect', () => {
  const rect = { x: 10, y: 10, width: 10, height: 10 };
  it('includes crossings without inside vertices, edges, and inside segments', () => {
    expect(
      trailIntersectsRect(
        trail('a', [
          [0, 15],
          [30, 15],
        ]),
        rect,
      ),
    ).toBe(true);
    expect(
      trailIntersectsRect(
        trail('b', [
          [10, 0],
          [10, 30],
        ]),
        rect,
      ),
    ).toBe(true);
    expect(
      trailIntersectsRect(
        trail('c', [
          [12, 12],
          [18, 18],
        ]),
        rect,
      ),
    ).toBe(true);
    expect(
      trailIntersectsRect(
        trail('d', [
          [0, 0],
          [9, 9],
        ]),
        rect,
      ),
    ).toBe(false);
    expect(
      trailIntersectsRect(
        trail('e', [
          [0, 21],
          [30, 21],
        ]),
        rect,
      ),
    ).toBe(false);
  });
  it('normalizes reverse rectangles and handles degenerate segments', () => {
    expect(
      trailIntersectsRect(
        trail('a', [
          [0, 15],
          [30, 15],
        ]),
        { x: 20, y: 20, width: -10, height: -10 },
      ),
    ).toBe(true);
    expect(
      trailIntersectsRect(
        trail('b', [
          [15, 15],
          [15, 15],
        ]),
        rect,
      ),
    ).toBe(true);
  });
});

describe('autoJoinTrails', () => {
  it('joins reversed chains deterministically with stable ID, attributes, and all removed IDs', () => {
    const features = [
      trail('c', [
        [30, 0],
        [20, 0],
      ]),
      trail('a', [
        [0, 0],
        [10, 0],
      ]),
      trail('b', [
        [20, 0],
        [10, 0],
      ]),
    ];
    const result = join(features);
    expect(result.chainCount).toBe(1);
    expect(result.ambiguousJunctionCount).toBe(0);
    expect(result.edit.removed).toEqual(['b', 'c']);
    expect(result.edit.updated).toEqual([
      {
        ...features[1],
        pts: [
          [0, 0],
          [10, 0],
          [20, 0],
          [30, 0],
        ],
      },
    ]);
    expect(join([...features].reverse())).toEqual(result);
    expect(join(apply(features, result)).edit).toEqual({ updated: [], removed: [] });
  });
  it('snaps nearby ends to one shared point rather than retaining a connector segment', () => {
    const result = join([
      trail('a', [
        [0, 0],
        [10, 0],
      ]),
      trail('b', [
        [12, 0],
        [25, 0],
      ]),
    ]);
    expect((result.edit.updated[0] as Trail).pts).toEqual([
      [0, 0],
      [11, 0],
      [25, 0],
    ]);
  });
  it('leaves gaps beyond tolerance and unrelated trails unchanged', () => {
    const features = [
      trail('a', [
        [0, 0],
        [10, 0],
      ]),
      trail('b', [
        [13, 0],
        [25, 0],
      ]),
      trail('other', [
        [25, 0],
        [40, 0],
      ]),
    ];
    expect(join(features, ['a', 'b']).edit).toEqual({ updated: [], removed: [] });
  });
  it('preserves a three-way junction with one deterministic shared point and no drift', () => {
    const features = [
      trail('a', [
        [0, 0],
        [10, 0],
      ]),
      trail('b', [
        [11, 0],
        [25, 0],
      ]),
      trail('c', [
        [10, 1],
        [10, 20],
      ]),
    ];
    const result = join(features);
    expect(result.chainCount).toBe(0);
    expect(result.ambiguousJunctionCount).toBe(1);
    expect(result.edit.removed).toEqual([]);
    expect(result.ambiguousTrailIds).toEqual(['a', 'b', 'c']);
    const trails = apply(features, result) as Trail[];
    expect(trails[0]!.pts.at(-1)).toEqual(trails[1]!.pts[0]);
    expect(trails[1]!.pts[0]).toEqual(trails[2]!.pts[0]);
    expect(join([...features].reverse())).toEqual(result);
    expect(join(trails).edit).toEqual({ updated: [], removed: [] });
  });
  it('does not choose a continuation across an interior or unselected branch', () => {
    const a = trail('a', [
      [0, 0],
      [10, 0],
    ]);
    const b = trail('b', [
      [10, 0],
      [20, 0],
    ]);
    for (const branch of [
      trail('c', [
        [10, -10],
        [10, 10],
      ]),
      trail('c', [
        [10, 0],
        [10, 10],
      ]),
    ]) {
      const result = join([a, b, branch], ['a', 'b']);
      expect(result.chainCount).toBe(0);
      expect(result.ambiguousJunctionCount).toBe(1);
      expect(result.edit).toEqual({ updated: [], removed: [] });
    }
  });
  it('joins an arm away from a branch while keeping its shared junction and remaining arms stable', () => {
    const features = [
      trail('a', [
        [0, 0],
        [10, 0],
      ]),
      trail('b', [
        [10, 0],
        [30, 0],
      ]),
      trail('c', [
        [10, 0],
        [10, 20],
      ]),
      trail('d', [
        [-20, 0],
        [0, 0],
      ]),
    ];
    const result = join(features);
    expect(result.chainCount).toBe(1);
    expect(result.ambiguousJunctionCount).toBe(1);
    expect(result.edit.removed).toEqual(['d']);
    expect((result.edit.updated[0] as Trail).pts).toEqual([
      [10, 0],
      [0, 0],
      [-20, 0],
    ]);
    expect(join(apply(features, result)).edit).toEqual({ updated: [], removed: [] });
  });
  it('does not pull a previously separate endpoint into a branch on the second pass', () => {
    const features = [
      trail('a', [
        [-20, 0],
        [-1, 0],
      ]),
      trail('b', [
        [1, 0],
        [20, 0],
      ]),
      trail('c', [
        [0, -0.1],
        [0, -20],
      ]),
      trail('d', [
        [0, 1.95],
        [0, 20],
      ]),
    ];
    const result = join(features);
    expect(result.ambiguousJunctionCount).toBe(1);
    expect(result.edit.updated.map((f) => f.id)).toEqual(['b', 'c']);
    expect(join(apply(features, result)).edit).toEqual({ updated: [], removed: [] });
  });
  it('joins deterministic closed chains without losing the closing shared vertex', () => {
    const features = [
      trail('a', [
        [0, 0],
        [20, 0],
      ]),
      trail('b', [
        [20, 0],
        [10, 20],
      ]),
      trail('c', [
        [10, 20],
        [0, 0],
      ]),
    ];
    const result = join(features);
    expect(result.chainCount).toBe(1);
    expect((result.edit.updated[0] as Trail).pts).toEqual([
      [0, 0],
      [20, 0],
      [10, 20],
      [0, 0],
    ]);
    expect(join(apply(features, result)).edit).toEqual({ updated: [], removed: [] });
  });
  it('preserves an interior junction even when the same trail also ends there', () => {
    const features = [
      trail('a', [
        [0, 0],
        [10, 0],
        [10, 20],
        [30, 20],
        [10, 0],
      ]),
      trail('b', [
        [10, 0],
        [10, -20],
      ]),
    ];
    const result = join(features);
    expect(result.chainCount).toBe(0);
    expect(result.ambiguousJunctionCount).toBe(1);
    expect(result.edit).toEqual({ updated: [], removed: [] });
  });
  it('does not transitively bridge endpoints farther apart than tolerance', () => {
    const result = join([
      trail('a', [
        [-20, 0],
        [0, 0],
      ]),
      trail('b', [
        [2, 0],
        [20, 0],
      ]),
      trail('c', [
        [4, 0],
        [4, 20],
      ]),
    ]);
    expect(result.edit).toEqual({ updated: [], removed: [] });
    expect(result.ambiguousJunctionCount).toBe(1);
  });
});
