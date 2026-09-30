import { describe, expect, it } from 'vitest';
import type { Area, FeatureId, HexColor, Px, Trail } from '../types';
import {
  chaikinSmooth,
  findJunctionCoordinates,
  simplify,
  simplifyFeature,
  simplifyFeaturesSteps,
  simplifyPathWithFixed,
  smoothPathWithFixed,
} from './simplify';
// @ts-expect-error Verbatim prototype is untyped and test-only.
import { simplify as prototypeSimplify } from '../geo/__prototype__/utilities.js';

function distanceToSegment([x, y]: Px, [ax, ay]: Px, [bx, by]: Px): number {
  const dx = bx - ax,
    dy = by - ay;
  const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(x - ax - t * dx, y - ay - t * dy);
}

describe('Douglas-Peucker characterization', () => {
  it('copies short paths and keeps both ends', () => {
    const pts: Px[] = [
      [0, 0],
      [1, 1],
    ];
    const out = simplify(pts, 1);
    expect(out).toEqual(pts);
    expect(out).not.toBe(pts);
    expect(simplify([], 1)).toEqual([]);
    expect(simplify([[0, 0]], 1)).toEqual([[0, 0]]);
  });
  it('matches the prototype and bounds every dropped point', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const pts: Px[] = Array.from({ length: 100 }, (_, i) => [
        i,
        Math.sin(i / (3 + seed)) * 8 + Math.cos(i / 5) * 2,
      ]);
      for (const eps of [0, 0.5, 1, 3]) {
        const out = simplify(pts, eps);
        expect(out).toEqual(prototypeSimplify(pts, eps));
        expect(out[0]).toEqual(pts[0]);
        expect(out.at(-1)).toEqual(pts.at(-1));
        for (const p of pts) {
          const distance = Math.min(
            ...out.slice(1).map((q, i) => distanceToSegment(p, out[i]!, q)),
          );
          expect(distance).toBeLessThanOrEqual(eps + 1e-9);
        }
      }
    }
  });
  it('matches the prototype for negative epsilon, including the review repro', () => {
    const repro: Px[] = [
      [0, 0],
      [1, 1],
      [2, 0],
    ];
    expect(simplify(repro, -0.1)).toEqual(prototypeSimplify(repro, -0.1));
    expect(simplify(repro, -0.1)).toEqual(repro);
  });
  it('handles coincident endpoints without recursion', () => {
    const pts: Px[] = [
      [0, 0],
      [3, 0],
      [0, 0],
    ];
    expect(simplify(pts, 1)).toEqual(prototypeSimplify(pts, 1));
    const long: Px[] = Array.from({ length: 20000 }, (_, i) => [i, Math.sin(i)]);
    expect(simplify(long, 2)).toEqual([long[0], long.at(-1)]);
  });

  it('matches the prototype on 200 seeded stress paths with near ties and degenerate chords', () => {
    let state = 0x114c0de;
    const random = (): number => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 0x1_0000_0000;
    };
    for (let caseIndex = 0; caseIndex < 200; caseIndex++) {
      const count = 3 + Math.floor(random() * 98);
      const pts: Px[] = Array.from({ length: count }, (_, i) => {
        if (caseIndex % 4 === 0 && i === count - 1) return [0, 0];
        const x = caseIndex % 7 === 0 ? Math.floor(random() * 12) : i;
        const y = caseIndex % 5 === 0 ? Math.round(random() * 8) / 8 : Math.round(random() * 64) / 16;
        return [x, y];
      });
      const eps = [-0.1, 0, 0.25, 0.5, 1, 3][caseIndex % 6]!;
      expect(simplify(pts, eps)).toEqual(prototypeSimplify(pts, eps));
    }
  });
});

describe('Chaikin smoothing (T-222 Acceptance 2)', () => {
  it('keeps endpoints fixed on open polylines and rounds corners', () => {
    const pts: Px[] = [
      [0, 0],
      [10, 10],
      [20, 0],
    ];
    const smoothed = chaikinSmooth(pts, false);
    expect(smoothed[0]).toEqual([0, 0]);
    expect(smoothed.at(-1)).toEqual([20, 0]);
    // 3 points -> 4 points (endpoints + 2 intermediate rounded points)
    expect(smoothed).toHaveLength(4);
    expect(smoothed[1]).toEqual([7.5, 7.5]);
    expect(smoothed[2]).toEqual([12.5, 7.5]);
  });

  it('preserves short polylines < 3 points', () => {
    const pts2: Px[] = [
      [0, 0],
      [10, 10],
    ];
    expect(chaikinSmooth(pts2, false)).toEqual(pts2);
    expect(chaikinSmooth([], false)).toEqual([]);
  });

  it('smooths closed rings without endpoints (T-222 Acceptance 5)', () => {
    const ring: Px[] = [
      [0, 0],
      [10, 0],
      [0, 10],
    ];
    const smoothed = chaikinSmooth(ring, true);
    // Closed triangle (3 points) -> hexagon (6 points)
    expect(smoothed).toHaveLength(6);
    expect(smoothed[0]).toEqual([2.5, 0]);
    expect(smoothed[1]).toEqual([7.5, 0]);
    expect(smoothed[2]).toEqual([7.5, 2.5]);
    expect(smoothed[3]).toEqual([2.5, 7.5]);
    expect(smoothed[4]).toEqual([0, 7.5]);
    expect(smoothed[5]).toEqual([0, 2.5]);
  });
});

describe('Junction detection and fixed-vertex simplify & smooth (T-222 Acceptance 3 & 5)', () => {
  it('detects shared junction coordinates between trails', () => {
    const t1: Trail = {
      id: 't1' as FeatureId,
      kind: 'trail',
      name: 'T1',
      color: '#ff0000' as HexColor,
      notes: '',
      ink: null,
      pts: [
        [0, 0],
        [10, 10],
        [20, 20],
      ],
    };
    const t2: Trail = {
      id: 't2' as FeatureId,
      kind: 'trail',
      name: 'T2',
      color: '#00ff00' as HexColor,
      notes: '',
      ink: null,
      pts: [
        [10, 10],
        [15, 5],
      ],
    };
    const junctions = findJunctionCoordinates([t1, t2]);
    expect(junctions.has('10,10')).toBe(true);
    expect(junctions.has('0,0')).toBe(false);
  });

  it('guarantees endpoints and junction vertices remain fixed under large epsilon (Acceptance 3)', () => {
    // Polyline: 0 -> 1 -> 2 -> 3 -> 4 -> 5 -> 6
    // Suppose vertex 3 [30, 0] is a junction with another trail.
    const pts: Px[] = [
      [0, 0],
      [10, 1], // noise
      [20, -1], // noise
      [30, 0], // JUNCTION
      [40, 1], // noise
      [50, -1], // noise
      [60, 0],
    ];
    const fixedIndices = new Set([0, 3, 6]);
    // Large epsilon that would normally drop all intermediate points in a single DP pass
    const simplified = simplifyPathWithFixed(pts, 10, fixedIndices, false);

    // Endpoints and junction 3 MUST be present and at exact coordinates!
    expect(simplified).toEqual([
      [0, 0],
      [30, 0],
      [60, 0],
    ]);
  });

  it('guarantees endpoints and junction vertices remain fixed under Chaikin smoothing', () => {
    const pts: Px[] = [
      [0, 0],
      [10, 10],
      [20, 0], // JUNCTION
      [30, 10],
      [40, 0],
    ];
    const fixedIndices = new Set([0, 2, 4]);
    const smoothed = smoothPathWithFixed(pts, fixedIndices, false);

    expect(smoothed[0]).toEqual([0, 0]);
    expect(smoothed.at(-1)).toEqual([40, 0]);
    // Junction vertex [20, 0] must be preserved exactly in the smoothed output
    const hasJunction = smoothed.some((p) => p[0] === 20 && p[1] === 0);
    expect(hasJunction).toBe(true);
  });

  it('keeps area closed rings closed and preserves at least 3 points', () => {
    const area: Area = {
      id: 'a1' as FeatureId,
      kind: 'area',
      name: 'Test Lake',
      color: '#0000ff' as HexColor,
      notes: '',
      pts: [
        [0, 0],
        [10, 0],
        [10, 10],
        [5, 10],
        [0, 10],
      ],
    };
    // Simplify area with large epsilon
    const simplified = simplifyFeature(area, 20, false);
    expect(simplified.pts.length).toBeGreaterThanOrEqual(3);

    // Smooth area
    const smoothed = simplifyFeature(area, 0, true);
    expect(smoothed.pts.length).toBeGreaterThanOrEqual(3);
  });

  it('simplifyFeaturesSteps yields periodically and simplifies all features', () => {
    const t1: Trail = {
      id: 't1' as FeatureId,
      kind: 'trail',
      name: 'Trail 1',
      color: '#ff0000' as HexColor,
      notes: '',
      ink: null,
      pts: Array.from({ length: 3000 }, (_, i) => [i, (i % 2) * 2] as Px),
    };
    const t2: Trail = {
      id: 't2' as FeatureId,
      kind: 'trail',
      name: 'Trail 2',
      color: '#00ff00' as HexColor,
      notes: '',
      ink: null,
      pts: Array.from({ length: 3000 }, (_, i) => [i, (i % 3) * 2] as Px),
    };

    const gen = simplifyFeaturesSteps([t1, t2], 5, false);
    let stepCount = 0;
    let res = gen.next();
    while (!res.done) {
      stepCount++;
      res = gen.next();
    }
    // With 6,000 vertices total and 5,000 vertices per step, it yielded
    expect(stepCount).toBeGreaterThan(0);
    const updated = res.value;
    expect(updated).toHaveLength(2);
    expect((updated[0] as Trail).pts.length).toBeLessThan(3000);
    expect((updated[1] as Trail).pts.length).toBeLessThan(3000);
  });
});
