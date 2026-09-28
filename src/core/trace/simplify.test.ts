import { describe, expect, it } from 'vitest';
import type { Px } from '../types';
import { simplify } from './simplify';
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
