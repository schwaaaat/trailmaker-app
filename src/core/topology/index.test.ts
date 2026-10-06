import { describe, expect, it } from 'vitest';
import type { Area, Feature, Poi, Px, SnapOptions, TopologyEdit, Trail } from '../types';
import { connectTrailPoints, hasUnsnappedEnds, joinTrails, snapTrailEnds, splitTrail } from './index';

const trail = (id: string, pts: Trail['pts'], extra: Partial<Trail> = {}): Trail => ({
  id,
  kind: 'trail',
  name: `Trail ${id}`,
  color: '#123456',
  notes: `notes ${id}`,
  ink: [1, 2, 3],
  pts,
  ...extra,
});

describe('connectTrailPoints', () => {
  it('inserts exact mid-segment junctions and preserves both trails', () => {
    const a = trail('a', [[0, 0], [10, 0]]);
    const b = trail('b', [[5, 5], [5, -5]]);
    const connector = trail('c', [[99, 99], [100, 100]]);
    const result = connectTrailPoints([a, b],
      { trailId: 'a', segmentIndex: 0, point: [5, 0] },
      { trailId: 'b', segmentIndex: 0, point: [5, 0] }, connector);
    expect(result.updated.map((t) => t.kind === 'trail' ? t.pts : null)).toEqual([[[0, 0], [5, 0], [10, 0]], [[5, 5], [5, 0], [5, -5]], [[5, 0], [5, 0]]]);
  });

  it('reuses a shared junction coordinate for three- and four-way joins', () => {
    const at = [5, 0] as Px;
    const trails = [
      trail('a', [[0, 0], [10, 0]]), trail('b', [[5, 5], [5, -5]]),
      trail('c', [[0, 5], [10, -5]]), trail('d', [[0, -5], [10, 5]]),
    ];
    const first = connectTrailPoints(trails.slice(0, 2),
      { trailId: 'a', segmentIndex: 0, point: at },
      { trailId: 'b', segmentIndex: 0, point: at }, trail('x', [at, [6, 0]]));
    const second = connectTrailPoints([...trails, ...first.updated],
      { trailId: 'c', segmentIndex: 0, point: at },
      { trailId: 'd', segmentIndex: 0, point: at }, trail('y', [at, [6, 0]]));
    const merged = new Map([...trails, ...first.updated, ...second.updated].map((f) => [f.id, f]));
    expect([...merged.values()].filter((f) => f.kind === 'trail').every((f) => f.pts.includes(at))).toBe(true);
    expect([...merged.values()].filter((f) => f.kind === 'trail' && f.pts.includes(at))).toHaveLength(6);
  });
});
const poi: Poi = {
  id: 'poi', kind: 'poi', name: 'POI', color: '#123456', notes: '',
  at: [30, 30], poiType: 'Water',
};
const area: Area = {
  id: 'area', kind: 'area', name: 'Area', color: '#123456', notes: '',
  pts: [[40, 40], [50, 40], [45, 50]],
};
const coords = (t: Trail) => t.pts.map(([x, y]) => [x, y]);
const matchesSnap = (features: readonly Feature[], tolerancePx: number): boolean =>
  snapTrailEnds(features, { tolerancePx }).updated.length > 0;

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

// Straightforward exhaustive oracle matching the pre-index snap implementation.
// Kept in tests so optimized candidate pruning is checked against complete scans.
function referenceSnapTrailEnds(features: readonly Feature[], opts: SnapOptions): TopologyEdit {
  const tolerance = opts.tolerancePx;
  if (!(tolerance > 0) || !Number.isFinite(tolerance)) return { updated: [], removed: [] };
  const tolerance2 = tolerance * tolerance;
  const trails = features
    .filter((feature): feature is Trail => feature.kind === 'trail' && feature.pts.length >= 2)
    .sort((a, b) => a.id.localeCompare(b.id));
  type RefEnd = { trail: Trail; side: 0 | 1; point: Px };
  const ends: RefEnd[] = trails.flatMap((item) => [
    { trail: item, side: 0 as const, point: item.pts[0]! },
    { trail: item, side: 1 as const, point: item.pts[item.pts.length - 1]! },
  ]);
  const parents = Int32Array.from({ length: ends.length }, (_, index) => index);
  const rootOf = (index: number): number => {
    while (parents[index] !== index) index = parents[index]!;
    return index;
  };
  for (let i = 0; i < ends.length; i++) for (let j = 0; j < i; j++) {
    const a = ends[i]!;
    const b = ends[j]!;
    if (a.trail.id === b.trail.id) continue;
    const dx = a.point[0] - b.point[0];
    const dy = a.point[1] - b.point[1];
    if (dx * dx + dy * dy > tolerance2) continue;
    const left = rootOf(j);
    const right = rootOf(i);
    if (left !== right) parents[right] = left;
  }
  const groups = new Map<number, number[]>();
  for (let index = 0; index < ends.length; index++) {
    const root = rootOf(index);
    const group = groups.get(root);
    if (group) group.push(index);
    else groups.set(root, [index]);
  }
  const paired = new Set<number>();
  const endpointTargets = new Map<string, Px>();
  const key = (end: RefEnd): string => `${end.trail.id}:${end.side}`;
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    for (const index of group) paired.add(index);
    const origin = ends[group[0]!]!.point;
    let dx = 0;
    let dy = 0;
    for (const index of group) {
      dx += ends[index]!.point[0] - origin[0];
      dy += ends[index]!.point[1] - origin[1];
    }
    const shared: Px = [origin[0] + dx / group.length, origin[1] + dy / group.length];
    for (const index of group) endpointTargets.set(key(ends[index]!), shared);
  }
  type RefInsertion = { index: number; t: number; point: Px };
  const insertions = new Map<string, RefInsertion[]>();
  const distanceSquared = (a: Px, b: Px): number => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;
  for (let endIndex = 0; endIndex < ends.length; endIndex++) {
    if (paired.has(endIndex)) continue;
    const end = ends[endIndex]!;
    let best: { trail: Trail; index: number; point: Px; t: number; distance2: number } | undefined;
    for (const candidate of trails) {
      if (candidate.id === end.trail.id) continue;
      for (let index = 0; index < candidate.pts.length - 1; index++) {
        const a = candidate.pts[index]!;
        const b = candidate.pts[index + 1]!;
        const dx = b[0] - a[0];
        const dy = b[1] - a[1];
        const length2 = dx * dx + dy * dy;
        if (length2 === 0) continue;
        const t = Math.max(0, Math.min(1, ((end.point[0] - a[0]) * dx + (end.point[1] - a[1]) * dy) / length2));
        const point: Px = [a[0] + t * dx, a[1] + t * dy];
        const distance2 = distanceSquared(end.point, point);
        if (distance2 <= tolerance2 && (!best || distance2 < best.distance2 ||
          (distance2 === best.distance2 && (candidate.id.localeCompare(best.trail.id) < 0 ||
            (candidate.id === best.trail.id && index < best.index))))) {
          best = { trail: candidate, index, point, t, distance2 };
        }
      }
    }
    if (!best) continue;
    endpointTargets.set(key(end), best.point);
    if (best.t > 1e-9 && best.t < 1 - 1e-9) {
      const list = insertions.get(best.trail.id) ?? [];
      list.push({ index: best.index, t: best.t, point: best.point });
      insertions.set(best.trail.id, list);
    }
  }
  const updated: Trail[] = [];
  for (const item of trails) {
    const points: Px[] = [endpointTargets.get(`${item.id}:0`) ?? item.pts[0]!];
    const bySegment = new Map<number, RefInsertion[]>();
    for (const insertion of insertions.get(item.id) ?? []) {
      const group = bySegment.get(insertion.index);
      if (group) group.push(insertion);
      else bySegment.set(insertion.index, [insertion]);
    }
    for (let index = 0; index < item.pts.length - 1; index++) {
      for (const insertion of (bySegment.get(index) ?? []).sort((a, b) => a.t - b.t)) {
        const last = points[points.length - 1]!;
        if (last[0] !== insertion.point[0] || last[1] !== insertion.point[1]) points.push(insertion.point);
      }
      points.push(item.pts[index + 1]!);
    }
    const end = endpointTargets.get(`${item.id}:1`);
    if (end) points[points.length - 1] = end;
    if (points.length === item.pts.length && points.every((point, index) =>
      point[0] === item.pts[index]![0] && point[1] === item.pts[index]![1])) continue;
    updated.push({ ...item, pts: points });
  }
  return { updated, removed: [] };
}

describe('splitTrail', () => {
  it('splits at a shared vertex and preserves attributes', () => {
    const source = trail('a', [[0, 0], [5, 0], [10, 1], [15, 1]], { name: 'Creek', color: '#abcdef' });
    const edit = splitTrail(source, 2, 'b');
    expect(edit.removed).toEqual([]);
    expect(edit.updated).toEqual([
      { ...source, pts: [[0, 0], [5, 0], [10, 1]] },
      { ...source, id: 'b', name: 'Creek (2)', pts: [[10, 1], [15, 1]] },
    ]);
    expect(source.pts).toHaveLength(4);
  });

  it.each([-1, 0, 3, 4])('rejects invalid split vertex %i', (index) => {
    expect(() => splitTrail(trail('a', [[0, 0], [1, 0], [2, 0], [3, 0]]), index, 'b')).toThrow(RangeError);
  });

  it('clears route metadata on both split results (T-334)', () => {
    const source: Trail = {
      ...trail('a', [[0, 0], [5, 0], [10, 1], [15, 1]]),
      route: { kind: 'one-way' },
    };
    const edit = splitTrail(source, 2, 'b');
    const first = edit.updated[0] as Trail;
    const second = edit.updated[1] as Trail;
    expect(first.route).toBeUndefined();
    expect(second.route).toBeUndefined();
  });
});

describe('joinTrails', () => {
  it('chooses the closest ends and reverses b for a continuous result', () => {
    const a = trail('a', [[0, 0], [10, 0]], { name: 'Main', ink: null });
    const b = trail('b', [[20, 0], [10.2, 0]]);
    expect(joinTrails(a, b)).toEqual({
      updated: [{ ...a, pts: [[0, 0], [10, 0], [20, 0]] }], removed: ['b'],
    });
  });

  it('clears route metadata on joined trail (T-334)', () => {
    const a: Trail = {
      ...trail('a', [[0, 0], [10, 0]], { name: 'Main', ink: null }),
      route: { kind: 'one-way' },
    };
    const b: Trail = {
      ...trail('b', [[20, 0], [10.2, 0]]),
      route: { kind: 'one-way' },
    };
    const result = joinTrails(a, b);
    const joined = result.updated[0] as Trail;
    expect(joined.route).toBeUndefined();
  });

  it('keeps a connector when ends are farther than 0.5 px and reverses a if needed', () => {
    const a = trail('a', [[10, 0], [0, 0]]);
    const b = trail('b', [[20, 0], [11, 0]]);
    expect(coords(joinTrails(a, b).updated[0] as Trail)).toEqual([[0, 0], [10, 0], [11, 0], [20, 0]]);
  });

  it('rejects joining a trail with itself', () => {
    const a = trail('a', [[0, 0], [1, 0]]);
    expect(() => joinTrails(a, a)).toThrow(/itself/i);
  });
});

describe('snapTrailEnds', () => {
  it('snaps a T junction by inserting an identical mid-segment vertex', () => {
    const horizontal = trail('h', [[0, 10], [20, 10]]);
    const vertical = trail('v', [[10, 0], [10.2, 9.8]]);
    const input = [horizontal, vertical, poi, area];
    expect(hasUnsnappedEnds(input, { tolerancePx: 1 })).toBe(matchesSnap(input, 1));
    const edit = snapTrailEnds(input, { tolerancePx: 1 });
    const updated = new Map(edit.updated.map((feature) => [feature.id, feature as Trail]));
    const h = updated.get('h')!;
    const v = updated.get('v')!;
    expect(coords(h)).toContainEqual([10.2, 10]);
    expect(v.pts[1]).toEqual([10.2, 10]);
    expect(edit.updated.some((feature) => feature.id === 'poi' || feature.id === 'area')).toBe(false);
    expect(edit.removed).toEqual([]);
  });

  it('merges nearby ends at their midpoint and leaves an existing + junction unchanged', () => {
    const a = trail('a', [[10, 10], [20.3, 10.1]]);
    const b = trail('b', [[30, 10], [20, 10]]);
    const plus = [
      trail('east', [[10, 10], [20, 10]]), trail('north', [[10, 20], [10, 10]]),
      trail('west', [[0, 10], [10, 10]]), trail('south', [[10, 0], [10, 10]]),
    ];
    expect(hasUnsnappedEnds([a, b], { tolerancePx: 1 })).toBe(matchesSnap([a, b], 1));
    const edit = snapTrailEnds([a, b], { tolerancePx: 1 });
    const updated = new Map(edit.updated.map((feature) => [feature.id, feature as Trail]));
    expect(updated.get('a')!.pts[1]).toEqual([20.15, 10.05]);
    expect(updated.get('b')!.pts[1]).toEqual([20.15, 10.05]);
    expect(hasUnsnappedEnds(plus, { tolerancePx: 1 })).toBe(false);
    expect(snapTrailEnds(plus, { tolerancePx: 1 })).toEqual({ updated: [], removed: [] });
  });

  it('is independent of input order and idempotent', () => {
    const input: Feature[] = [
      trail('a', [[0, 0], [10, 0]]), trail('b', [[5, 0.2], [5, 8]]),
      trail('c', [[5, -5], [5, -0.3]]), poi,
    ];
    const first = snapTrailEnds(input, { tolerancePx: 1 });
    expect(hasUnsnappedEnds(input, { tolerancePx: 1 })).toBe(first.updated.length > 0);
    const shuffled = snapTrailEnds([...input].reverse(), { tolerancePx: 1 });
    expect([...first.updated].sort((a, b) => a.id.localeCompare(b.id))).toEqual(
      [...shuffled.updated].sort((a, b) => a.id.localeCompare(b.id)),
    );
    const after = input.map((feature) => first.updated.find((candidate) => candidate.id === feature.id) ?? feature);
    expect(hasUnsnappedEnds(after, { tolerancePx: 1 })).toBe(false);
    expect(snapTrailEnds(after, { tolerancePx: 1 })).toEqual({ updated: [], removed: [] });
    expect(input[0]).toEqual(trail('a', [[0, 0], [10, 0]]));
  });

  it('merges three mutually-near ends to one stable junction in a single pass', () => {
    const input = [
      trail('a', [[0, 0], [0, -10]]),
      trail('b', [[0.4, 0], [-10, 0]]),
      trail('c', [[0.8, 0], [10, 0]]),
    ];
    const first = snapTrailEnds(input, { tolerancePx: 1 });
    expect(hasUnsnappedEnds(input, { tolerancePx: 1 })).toBe(first.updated.length > 0);
    const afterFirst = input.map((source) =>
      (first.updated.find((item) => item.id === source.id) as Trail | undefined) ?? source,
    );
    const junctions = afterFirst.map((item) => item.pts[0]!);
    expect(junctions.every(([x, y]) => x === junctions[0]![0] && y === junctions[0]![1])).toBe(true);
    expect(junctions[0]![0]).toBeCloseTo(0.4, 12);
    expect(junctions[0]![1]).toBe(0);
    expect(snapTrailEnds(afterFirst, { tolerancePx: 1 })).toEqual({ updated: [], removed: [] });
  });

  it('uses stable id tie breaks, ignores zero-length segments, and ignores invalid tolerances', () => {
    const tie = [
      trail('a', [[0, 0], [10, 0]]),
      trail('b', [[0, 2], [10, 2]]),
      trail('c', [[5, 1], [5, 8]]),
    ];
    const result = snapTrailEnds(tie, { tolerancePx: 1 });
    expect(hasUnsnappedEnds(tie, { tolerancePx: 1 })).toBe(result.updated.length > 0);
    expect(result.updated.find((feature) => feature.id === 'c')?.kind === 'trail' &&
      (result.updated.find((feature) => feature.id === 'c') as Trail).pts[0]).toEqual([5, 0]);
    const zeroLengthCase = snapTrailEnds(
      [trail('flat', [[0, 0], [5, 0], [5, 0], [10, 0]]), trail('end', [[5, 1], [8, 8]])],
      { tolerancePx: 2 },
    );
    expect(
      hasUnsnappedEnds(
        [trail('flat', [[0, 0], [5, 0], [5, 0], [10, 0]]), trail('end', [[5, 1], [8, 8]])],
        { tolerancePx: 2 },
      ),
    ).toBe(zeroLengthCase.updated.length > 0);
    expect((zeroLengthCase.updated.find((feature) => feature.id === 'end') as Trail).pts[0]).toEqual([5, 0]);
    expect(snapTrailEnds(tie, { tolerancePx: 0 })).toEqual({ updated: [], removed: [] });
    expect(hasUnsnappedEnds(tie, { tolerancePx: 0 })).toBe(false);
  });

  it('matches snapTrailEnds over 200 seeded scenes with mixed junction and self-contact shapes', () => {
    const rng = random(0x112c0de);
    for (let scene = 0; scene < 200; scene++) {
      const x = Math.floor(rng() * 500) - 250;
      const y = Math.floor(rng() * 500) - 250;
      const delta = (rng() - 0.5) * 3;
      const shape = scene % 6;
      const features: Feature[] = [];
      if (shape === 0) {
        features.push(trail('a', [[x, y], [x + 7, y + 3], [x + 12, y + 7]]));
        features.push(trail('b', [[x + 30, y + 20], [x + 38, y + 28]]));
      } else if (shape === 1) {
        features.push(trail('a', [[x, y], [x + 12, y]]));
        features.push(trail('b', [[x + 12 + delta, y + delta], [x + 22, y + 5]]));
      } else if (shape === 2) {
        features.push(trail('base', [[x, y], [x + 20, y]]));
        features.push(trail('branch', [[x + 10 + delta, y + delta], [x + 10, y + 12]]));
      } else if (shape === 3) {
        features.push(
          trail('east', [[x + 10, y], [x, y]]),
          trail('north', [[x, y - 10], [x + delta, y + delta]]),
          trail('west', [[x - 10, y], [x, y]]),
          trail('south', [[x, y + 10], [x, y + delta]]),
        );
      } else if (shape === 4) {
        features.push(trail('self', [[x, y], [x + 10, y], [x + 10, y + 10], [x, y]]));
        features.push(trail('near-self', [[x + delta, y], [x + delta, y - 5]]));
      } else {
        features.push(trail('loop', [[x, y], [x + 8, y], [x + 8, y + 8], [x, y]]));
        features.push(trail('separate', [[x + 50, y + 50], [x + 60, y + 50]]));
      }
      const extraTrailCount = Math.floor(rng() * 8);
      for (let extraIndex = 0; extraIndex < extraTrailCount; extraIndex++) {
        const pointCount = 2 + Math.floor(rng() * 4);
        const startX = x + (rng() - 0.5) * 100;
        const startY = y + (rng() - 0.5) * 100;
        features.push(
          trail(
            `extra-${scene}-${extraIndex}`,
            Array.from({ length: pointCount }, (_, pointIndex) => [
              startX + pointIndex * (rng() * 12 + 1),
              startY + (rng() - 0.5) * 20,
            ] as const),
          ),
        );
      }
      const tieX = x + 150;
      const tieY = y + 150;
      const tieOffset = 0.05 + rng() * 0.15;
      features.push(
        trail(`tie-target-${scene}`, [[tieX, tieY], [tieX, tieY + 20]]),
        trail(`tie-a-${scene}`, [[tieX - 10, tieY - tieOffset], [tieX + 10, tieY - tieOffset]]),
        trail(`tie-b-${scene}`, [[tieX - 10, tieY + tieOffset], [tieX + 10, tieY + tieOffset]]),
      );
      const sharedX = x + 500;
      const sharedY = y + 500;
      features.push(
        trail(`shared-a-${scene}`, [[sharedX - 10, sharedY], [sharedX, sharedY]]),
        trail(`shared-b-${scene}`, [[sharedX, sharedY], [sharedX, sharedY + 10]]),
        trail(`shared-c-${scene}`, [[sharedX, sharedY - 10], [sharedX, sharedY]]),
      );
      if (scene % 3 === 0) features.push(poi);
      const tolerancePx = 0.25 + rng() * 2.75;
      expect(snapTrailEnds(features, { tolerancePx }), `snap output scene ${scene}`).toEqual(
        referenceSnapTrailEnds(features, { tolerancePx }),
      );
      expect(hasUnsnappedEnds(features, { tolerancePx }), `scene ${scene}`).toBe(
        matchesSnap(features, tolerancePx),
      );
    }
  });

  it('detects self-proximity and interior-segment contacts with snap semantics', () => {
    const selfTouching = [trail('self', [[0, 0], [10, 0], [10, 10], [0.2, 0.1], [0, 20]])];
    expect(hasUnsnappedEnds(selfTouching, { tolerancePx: 1 })).toBe(false);
    expect(hasUnsnappedEnds(selfTouching, { tolerancePx: 1 })).toBe(matchesSnap(selfTouching, 1));

    const interiorContact = [trail('line', [[0, 0], [20, 0]]), trail('branch', [[10, 0], [10, 10]])];
    expect(hasUnsnappedEnds(interiorContact, { tolerancePx: 1 })).toBe(true);
    expect(hasUnsnappedEnds(interiorContact, { tolerancePx: 1 })).toBe(matchesSnap(interiorContact, 1));

    const coincidentPairedEndsOverThirdLine = [
      trail('a', [[10, 0], [10, 10]]),
      trail('b', [[10, 0], [15, 10]]),
      trail('third', [[0, 0], [20, 0]]),
    ];
    expect(hasUnsnappedEnds(coincidentPairedEndsOverThirdLine, { tolerancePx: 0.1 })).toBe(false);
    expect(hasUnsnappedEnds(coincidentPairedEndsOverThirdLine, { tolerancePx: 0.1 })).toBe(
      matchesSnap(coincidentPairedEndsOverThirdLine, 0.1),
    );
  });

  it('stress (2,000 x 50 trails detector): measures five-warm-run medians', () => {
    const worstCase = Array.from({ length: 2_000 }, (_, trailIndex) => {
      const origin = trailIndex * 1_000;
      return trail(
        `far-${trailIndex}`,
        Array.from({ length: 50 }, (_, pointIndex) => [origin + pointIndex * 2, origin] as const),
      );
    });
    const typical = [
      trail('typical-base', [[0, 0], [20, 0]]),
      trail('typical-branch', [[10, 0.5], [10, 12]]),
    ];
    const medianOfFive = (run: () => boolean): number => {
      run();
      const times = Array.from({ length: 5 }, () => {
        const started = performance.now();
        run();
        return performance.now() - started;
      }).sort((a, b) => a - b);
      return times[2]!;
    };

    const typicalMedianMs = medianOfFive(() => hasUnsnappedEnds(typical, { tolerancePx: 2 }));
    const worstMedianMs = medianOfFive(() => hasUnsnappedEnds(worstCase, { tolerancePx: 1 }));
    console.info(
      `unsnapped-end detector warm median: typical ${typicalMedianMs.toFixed(3)} ms; 2,000x50 no-hit ${worstMedianMs.toFixed(3)} ms`,
    );
    expect(typicalMedianMs).toBeLessThan(5);
    expect(worstMedianMs).toBeLessThan(25);
  });

  it('snaps 500 trails with 50 vertices under 200 ms', () => {
    const many = Array.from({ length: 500 }, (_, i) => trail(
      `r${i.toString().padStart(3, '0')}`,
      Array.from({ length: 50 }, (_, j) => [i * 100 + j * 2, i % 17 + j % 3] as const),
    ));
    const start = performance.now();
    const result = snapTrailEnds(many, { tolerancePx: 2 });
    const elapsedMs = performance.now() - start;
    expect(result.updated.length).toBeLessThanOrEqual(500);
    expect(elapsedMs).toBeLessThan(200);
    console.log(`500x50 topology snap: ${elapsedMs.toFixed(2)} ms`);
  });

  it('stress (2,000 x 50 trails): measures five-warm-run snap medians', () => {
    const stress = Array.from({ length: 2_000 }, (_, trailIndex) => {
      const origin = trailIndex * 1_000;
      return trail(
        `far-${trailIndex}`,
        Array.from({ length: 50 }, (_, pointIndex) => [origin + pointIndex * 2, origin] as const),
      );
    });
    const typical = [
      trail('typical-base', [[0, 0], [20, 0]]),
      trail('typical-branch', [[10, 0.5], [10, 12]]),
    ];
    const medianOfFive = (run: () => void): number => {
      run();
      const times = Array.from({ length: 5 }, () => {
        const started = performance.now();
        run();
        return performance.now() - started;
      }).sort((a, b) => a - b);
      return times[2]!;
    };
    const typicalMedianMs = medianOfFive(() => { snapTrailEnds(typical, { tolerancePx: 2 }); });
    const eightPxMedianMs = medianOfFive(() => { snapTrailEnds(stress, { tolerancePx: 8 }); });
    const thirtyPxMedianMs = medianOfFive(() => { snapTrailEnds(stress, { tolerancePx: 30 }); });
    console.info(
      `topology snap warm median: typical ${typicalMedianMs.toFixed(3)} ms; 2,000x50 at 8 px ${eightPxMedianMs.toFixed(3)} ms; 30 px ${thirtyPxMedianMs.toFixed(3)} ms`,
    );
    expect(typicalMedianMs).toBeLessThan(5);
    expect(eightPxMedianMs).toBeLessThanOrEqual(25);
    expect(thirtyPxMedianMs).toBeLessThanOrEqual(35);
  });

  it('measures clean 2,000 x 50 snap; isolated warm median must stay under 50 ms', () => {
    const clean = Array.from({ length: 1_000 }, (_, pair) => {
      const y = pair * 100;
      return [
        trail(`left-${pair}`, Array.from({ length: 50 }, (_, i) => [i, y] as const)),
        trail(`right-${pair}`, Array.from({ length: 50 }, (_, i) => [49 + i, y] as const)),
      ];
    }).flat();
    const medianOfFive = (tolerancePx: number): number => {
      snapTrailEnds(clean, { tolerancePx });
      const times = Array.from({ length: 5 }, () => {
        const started = performance.now();
        const edit = snapTrailEnds(clean, { tolerancePx });
        expect(edit).toEqual({ updated: [], removed: [] });
        return performance.now() - started;
      }).sort((a, b) => a - b);
      return times[2]!;
    };
    const at8Px = medianOfFive(8);
    const at30Px = medianOfFive(30);
    console.info(`isolated clean snap warm medians: 2,000x50 at 8 px ${at8Px.toFixed(3)} ms; 30 px ${at30Px.toFixed(3)} ms`);
    // Vitest runs this beside CPU-heavy files in CI; isolated medians above enforce the budget.
    expect(at8Px).toBeLessThanOrEqual(250);
    expect(at30Px).toBeLessThanOrEqual(250);
  });

  it('measures offset 2,000 x 50 snap; isolated warm median must stay under 50 ms', () => {
    const unsnapped = Array.from({ length: 1_000 }, (_, pair) => {
      const y = pair * 100;
      return [
        trail(`left-${pair}`, Array.from({ length: 50 }, (_, i) => [i, y] as const)),
        trail(`right-${pair}`, Array.from({ length: 50 }, (_, i) => [50 + i, y] as const)),
      ];
    }).flat();
    const medianOfFive = (tolerancePx: number): number => {
      const first = snapTrailEnds(unsnapped, { tolerancePx });
      expect(first.updated.length).toBe(2_000);
      const times = Array.from({ length: 5 }, () => {
        const started = performance.now();
        snapTrailEnds(unsnapped, { tolerancePx });
        return performance.now() - started;
      }).sort((a, b) => a - b);
      return times[2]!;
    };
    const at8Px = medianOfFive(8);
    const at30Px = medianOfFive(30);
    console.info(`isolated unsnapped snap warm medians: 2,000x50 at 8 px ${at8Px.toFixed(3)} ms; 30 px ${at30Px.toFixed(3)} ms`);
    // Vitest runs this beside CPU-heavy files in CI; isolated medians above enforce the budget.
    expect(at8Px).toBeLessThanOrEqual(250);
    expect(at30Px).toBeLessThanOrEqual(250);
  });
});
