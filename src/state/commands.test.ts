import { describe, expect, it } from 'vitest';
import { joinTrails, snapTrailEnds, splitTrail } from '../core/topology';
import { POI_TYPES, type Feature, type HistoryCommand, type Project, type Px } from '../core/types';
import * as C from './commands';
import { makeProject, rng } from './fixtures.test.helper';
import { History } from './history';

const trail = (id: string, pts: Px[]): Extract<Feature, { kind: 'trail' }> => ({
  kind: 'trail',
  id,
  name: `Trail ${id}`,
  color: '#D9480F',
  notes: '',
  pts,
  ink: null,
});

function roundTrip(p: Project, cmd: HistoryCommand): Project {
  const q = cmd.apply(p);
  expect(cmd.revert(q)).toStrictEqual(p);
  return q;
}

describe('command factories', () => {
  it('take ids from seq with the prototype prefixes and restore seq on revert', () => {
    const p = makeProject({ seq: 7 });
    const a = C.addAnchor(p, [10, 20]);
    expect(a.id).toBe('g7');
    const q = roundTrip(p, a.command);
    expect(q.seq).toBe(8);
    expect(q.anchors).toStrictEqual([{ id: 'g7', px: [10, 20], ll: null, source: 'paste' }]);

    const f = C.addFeature(q, {
      kind: 'poi',
      name: 'Point 1',
      color: '#1F6FB2',
      notes: '',
      at: [1, 2],
      poiType: 'Waypoint',
    });
    expect(f.id).toBe('f8');
    expect(roundTrip(q, f.command).features[0]?.id).toBe('f8');
  });

  it('stamp updatedAt on apply, restore it on revert, and apply identically twice', () => {
    const p = makeProject();
    const cmd = C.setUnits(p, 'km');
    const q = roundTrip(p, cmd);
    expect(q.updatedAt).not.toBe(p.updatedAt);
    expect(Number.isNaN(Date.parse(q.updatedAt))).toBe(false);
    expect(cmd.apply(p)).toStrictEqual(q);
  });

  it('keep untouched arrays by reference', () => {
    const p = makeProject({
      features: [
        trail('f1', [
          [0, 0],
          [5, 5],
        ]),
      ],
    });
    const q = C.updateFeature(p, 'f1', { name: 'Ridge' }).apply(p);
    expect(q.anchors).toBe(p.anchors);
    expect(q.autoTrace).toBe(p.autoTrace);
    const r = C.addAnchor(p, [1, 1]).command.apply(p);
    expect(r.features).toBe(p.features);
  });

  it('restore removed anchors, features and chips at their original index', () => {
    let p = makeProject();
    for (let i = 0; i < 3; i++) p = C.addAnchor(p, [i, i]).command.apply(p);
    for (let i = 0; i < 3; i++)
      p = C.addFeature(p, {
        ...trail('x', [
          [i, 0],
          [i, 9],
        ]),
      }).command.apply(p);
    p = C.addChips(p, [
      { rgb: [255, 0, 0], name: 'Red', enabled: true, share: 0.1, named: false },
      { rgb: [0, 0, 255], name: 'Blue', enabled: true, share: 0.1, named: false },
      { rgb: [0, 160, 0], name: 'Green', enabled: true, share: 0.1, named: false },
    ]).command!.apply(p);
    const mid = (xs: readonly { id: string }[]) => xs[1]!.id;
    roundTrip(p, C.removeAnchor(p, mid(p.anchors)));
    roundTrip(p, C.deleteFeature(p, mid(p.features)));
    roundTrip(p, C.removeChip(p, mid(p.autoTrace.chips)));
  });

  it('refuse deleting below the minimum vertex count with the prototype messages', () => {
    const p = makeProject({
      features: [
        trail('f1', [
          [0, 0],
          [1, 1],
        ]),
        {
          kind: 'area',
          id: 'f2',
          name: 'Lake',
          color: '#3A7D44',
          notes: '',
          pts: [
            [0, 0],
            [9, 0],
            [9, 9],
          ],
        },
      ],
    });
    expect(C.deleteVertex(p, 'f1', 0)).toStrictEqual({
      error: 'A trail needs at least 2 points. Delete it from the sidebar instead.',
    });
    expect(C.deleteVertex(p, 'f2', 1)).toStrictEqual({
      error: 'An area needs at least 3 points. Delete it from the sidebar instead.',
    });
    const ok = C.deleteVertex(
      makeProject({
        features: [
          trail('f1', [
            [0, 0],
            [1, 1],
            [2, 2],
          ]),
        ],
      }),
      'f1',
      1,
    );
    expect(C.isRefusal(ok)).toBe(false);
  });

  it('move POIs through vertex 0 and reject programming errors', () => {
    const poi: Feature = {
      kind: 'poi',
      id: 'f1',
      name: 'P',
      color: '#1F6FB2',
      notes: '',
      at: [1, 1],
      poiType: 'Parking',
    };
    const p = makeProject({
      features: [
        poi,
        trail('f2', [
          [0, 0],
          [1, 1],
        ]),
      ],
    });
    expect(roundTrip(p, C.moveVertex(p, 'f1', 0, [5, 6])).features[0]).toMatchObject({
      at: [5, 6],
    });
    expect(() => C.moveVertex(p, 'f1', 1, [0, 0])).toThrow();
    expect(() => C.moveVertex(p, 'f2', 2, [0, 0])).toThrow();
    expect(() => C.updateFeature(p, 'f2', { poiType: 'Water' })).toThrow();
    expect(() => C.reverseTrail(p, 'f1')).toThrow();
    expect(() => C.replaceTrailPoints(p, 'f2', [[0, 0]], null)).toThrow();
    expect(() => C.deleteFeature(p, 'nope')).toThrow('Feature nope not found');
    expect(() => C.acceptCandidates(p, [])).toThrow();
  });

  it('merge a near-duplicate chip instead of adding it (prototype addChip)', () => {
    const p0 = makeProject({ seq: 3 });
    const first = C.addChips(p0, [
      { rgb: [200.4, 10, 10], name: 'Red', enabled: false, share: 0.2, named: false },
    ]);
    const p = first.command!.apply(p0);
    expect(p.autoTrace.chips).toStrictEqual([
      { id: 'c3', rgb: [200, 10, 10], name: 'Red', enabled: false, share: 0.2, named: false },
    ]);
    // Same ink, nothing new to say: no command.
    expect(
      C.addChips(p, [
        { rgb: [205, 12, 9], name: 'Red', enabled: false, share: null, named: false },
      ]),
    ).toStrictEqual({
      command: null,
      ids: ['c3'],
    });
    // A legend name renames and enabling enables, still one chip.
    const legend = C.addChips(p, [
      { rgb: [205, 12, 9], name: 'Loop Trail', enabled: true, share: null, named: true },
    ]);
    expect(legend.ids).toStrictEqual(['c3']);
    const q = roundTrip(p, legend.command!);
    expect(q.autoTrace.chips).toStrictEqual([
      { id: 'c3', rgb: [200, 10, 10], name: 'Loop Trail', enabled: true, share: 0.2, named: true },
    ]);
    expect(q.seq).toBe(p.seq);
  });

  it('accept candidates as consecutive trail ids in one command', () => {
    const p = makeProject({ seq: 10 });
    const res = C.acceptCandidates(p, [
      {
        name: 'Red (part 1)',
        color: '#c00',
        pts: [
          [0, 0],
          [1, 1],
        ],
        ink: [200, 0, 0],
      },
      {
        name: 'Red (part 2)',
        color: '#c00',
        pts: [
          [2, 2],
          [3, 3],
        ],
        ink: [200, 0, 0],
      },
    ]);
    expect(res.id).toStrictEqual(['f10', 'f11']);
    expect(res.command.label).toBe('Add 2 trails');
    const q = roundTrip(p, res.command);
    expect(q.seq).toBe(12);
    expect(q.features.map((f) => f.kind)).toStrictEqual(['trail', 'trail']);
  });
});

describe('applyTopologyEdit (T-209)', () => {
  it('splits: the new half lands right after its source, one undo step, seq advances by 1', () => {
    const a = trail('f1', [
      [0, 0],
      [10, 0],
      [20, 0],
    ]);
    const b = trail('f2', [
      [0, 5],
      [10, 5],
    ]);
    const p = makeProject({ seq: 20, features: [a, b] });
    const cmd = C.applyTopologyEdit(p, {
      updated: [
        { ...a, pts: [[0, 0], [10, 0]] },
        { ...a, id: 'f20', name: `${a.name} (2)`, pts: [[10, 0], [20, 0]] },
      ],
      removed: [],
    });
    expect(cmd.label).toBe('Split trail');
    const q = roundTrip(p, cmd);
    expect(q.seq).toBe(21);
    expect(q.features.map((f) => f.id)).toStrictEqual(['f1', 'f20', 'f2']);
    expect((q.features[0] as Feature & { kind: 'trail' }).pts).toStrictEqual([
      [0, 0],
      [10, 0],
    ]);
  });

  it('joins: removes the second trail, keeps the first id, one undo step, seq unchanged', () => {
    const a = trail('f1', [
      [0, 0],
      [10, 0],
    ]);
    const b = trail('f2', [
      [10, 0],
      [20, 0],
    ]);
    const c = trail('f3', [
      [0, 5],
      [10, 5],
    ]);
    const p = makeProject({ seq: 20, features: [a, b, c] });
    const cmd = C.applyTopologyEdit(p, {
      updated: [{ ...a, pts: [[0, 0], [10, 0], [20, 0]] }],
      removed: ['f2'],
    });
    expect(cmd.label).toBe('Join trails');
    const q = roundTrip(p, cmd);
    expect(q.seq).toBe(20);
    expect(q.features.map((f) => f.id)).toStrictEqual(['f1', 'f3']);
  });

  it('clean up junctions: replaces features in place, keeping the original order', () => {
    const a = trail('f1', [
      [0, 0],
      [10, 0],
    ]);
    const b = trail('f2', [
      [10.4, 0],
      [20, 0],
    ]);
    const p = makeProject({ seq: 20, features: [a, b] });
    const cmd = C.applyTopologyEdit(p, {
      updated: [{ ...b, pts: [[10, 0], [20, 0]] }],
      removed: [],
    });
    expect(cmd.label).toBe('Clean up junctions');
    const q = roundTrip(p, cmd);
    expect(q.seq).toBe(20);
    expect(q.features.map((f) => f.id)).toStrictEqual(['f1', 'f2']);
    expect((q.features[1] as Feature & { kind: 'trail' }).pts).toStrictEqual([
      [10, 0],
      [20, 0],
    ]);
  });

  it('an empty edit round-trips to a no-op command', () => {
    const p = makeProject({ seq: 20, features: [trail('f1', [[0, 0], [1, 1]])] });
    const cmd = C.applyTopologyEdit(p, { updated: [], removed: [] });
    const q = roundTrip(p, cmd);
    expect(q.features).toStrictEqual(p.features);
    expect(q.seq).toBe(p.seq);
  });
});

/* ---------------------------------------------------------------- property test */

type Gen = (p: Project, r: () => number) => HistoryCommand | C.EditRefusal | null;

const pick = <T>(xs: readonly T[], r: () => number): T | undefined =>
  xs[Math.floor(r() * xs.length)];
const px = (r: () => number): Px => [Math.round(r() * 1000), Math.round(r() * 800)];
const hasPts = (f: Feature): f is Exclude<Feature, { kind: 'poi' }> => f.kind !== 'poi';

const GENS: Gen[] = [
  (p, r) => C.addAnchor(p, px(r)).command,
  (p, r) => {
    const a = pick(p.anchors, r);
    return a ? C.moveAnchor(p, a.id, px(r)) : null;
  },
  (p, r) => {
    const a = pick(p.anchors, r);
    return a ? C.setAnchorCoords(p, a.id, r() < 0.2 ? null : [40 + r(), -105 - r()]) : null;
  },
  (p, r) => {
    const a = pick(p.anchors, r);
    return a ? C.removeAnchor(p, a.id) : null;
  },
  (p, r) => C.setFitMethod(p, pick(['auto', 'similarity', 'affine', 'tps'] as const, r)!),
  (p, r) => {
    const k = r();
    if (k < 0.4)
      return C.addFeature(p, {
        kind: 'trail',
        name: 'T',
        color: '#D9480F',
        notes: '',
        pts: [px(r), px(r), px(r)],
        ink: null,
      }).command;
    if (k < 0.7)
      return C.addFeature(p, {
        kind: 'area',
        name: 'A',
        color: '#3A7D44',
        notes: '',
        pts: [px(r), px(r), px(r), px(r)],
      }).command;
    return C.addFeature(p, {
      kind: 'poi',
      name: 'P',
      color: '#1F6FB2',
      notes: '',
      at: px(r),
      poiType: pick(POI_TYPES, r)!,
    }).command;
  },
  // Typing into the name field: coalescing runs on the same key.
  (p, r) => {
    const f = pick(p.features, r);
    return f ? C.updateFeature(p, f.id, { name: f.name + 'x' }) : null;
  },
  (p, r) => {
    const f = pick(p.features, r);
    if (!f) return null;
    return f.kind === 'poi' && r() < 0.5
      ? C.updateFeature(p, f.id, { poiType: pick(POI_TYPES, r)!, notes: 'n' })
      : C.updateFeature(p, f.id, { color: '#123456' });
  },
  (p, r) => {
    const f = pick(p.features, r);
    if (!f) return null;
    return hasPts(f)
      ? C.moveVertex(p, f.id, Math.floor(r() * f.pts.length), px(r))
      : C.moveVertex(p, f.id, 0, px(r));
  },
  // Includes refusals when at the minimum.
  (p, r) => {
    const f = pick(p.features.filter(hasPts), r);
    return f ? C.deleteVertex(p, f.id, Math.floor(r() * f.pts.length)) : null;
  },
  (p, r) => {
    const f = pick(
      p.features.filter((f) => f.kind === 'trail'),
      r,
    );
    if (!f) return null;
    return r() < 0.5
      ? C.reverseTrail(p, f.id)
      : C.replaceTrailPoints(p, f.id, [...f.pts, px(r)], [10, 20, 30]);
  },
  (p, r) => {
    const f = pick(p.features, r);
    return f ? C.deleteFeature(p, f.id) : null;
  },
  (p, r) =>
    C.acceptCandidates(p, [
      { name: 'c', color: '#c00', pts: [px(r), px(r)], ink: null },
      { name: 'd', color: '#c00', pts: [px(r), px(r)], ink: [1, 2, 3] },
    ]).command,
  (p, r) => C.setUnits(p, r() < 0.5 ? 'mi' : 'km'),
  (p) => C.setProjectName(p, p.name + 'z'),
  (p, r) =>
    C.setTraceSettings(
      p,
      r() < 0.5 ? { tolerance: Math.round(r() * 200) } : { smartFollow: r() < 0.5, ink: [1, 2, 3] },
    ),
  (p, r) =>
    C.setAutoTraceSettings(
      p,
      r() < 0.5 ? { gapPx: Math.round(r() * 120) } : { minLengthPct: Math.round(r() * 10) },
    ),
  (p, r) =>
    C.addChips(p, [
      {
        rgb: [Math.round(r() * 255), Math.round(r() * 255), Math.round(r() * 255)],
        name: 'k',
        enabled: r() < 0.5,
        share: null,
        named: r() < 0.3,
      },
    ]).command,
  (p, r) => {
    const c = pick(p.autoTrace.chips, r);
    if (!c) return null;
    return r() < 0.5
      ? C.updateChip(p, c.id, { name: c.name + 'y', named: true })
      : C.updateChip(p, c.id, { enabled: !c.enabled });
  },
  (p, r) => {
    const c = pick(p.autoTrace.chips, r);
    return c ? C.removeChip(p, c.id) : null;
  },
  // Split: needs a trail with >= 3 points (an interior vertex to split at).
  (p, r) => {
    const trails = p.features.filter((f): f is Extract<Feature, { kind: 'trail' }> =>
      f.kind === 'trail' && f.pts.length >= 3,
    );
    const f = pick(trails, r);
    if (!f) return null;
    const index = 1 + Math.floor(r() * (f.pts.length - 2));
    return C.applyTopologyEdit(p, splitTrail(f, index, `f${p.seq}`));
  },
  // Join: any two distinct trails.
  (p, r) => {
    const trails = p.features.filter((f): f is Extract<Feature, { kind: 'trail' }> => f.kind === 'trail');
    if (trails.length < 2) return null;
    const a = pick(trails, r)!;
    const rest = trails.filter((f) => f.id !== a.id);
    const b = pick(rest, r);
    if (!b) return null;
    return C.applyTopologyEdit(p, joinTrails(a, b));
  },
  // Clean up junctions: a random tolerance, sometimes wide enough to snap something.
  (p, r) => C.applyTopologyEdit(p, snapTrailEnds(p.features, { tolerancePx: 5 + r() * 35 })),
];

describe('property: random edit sequences', () => {
  it('each command reverts exactly; undo-all returns to the start; redo-all reaches the end', () => {
    let refusals = 0;
    let coalesced = 0;
    for (let seed = 1; seed <= 60; seed++) {
      const r = rng(seed);
      const start = makeProject();
      const h = new History();
      let p = start;
      let steps = 0;
      while (steps < 80) {
        const roll = r();
        if (roll < 0.06 && h.canUndo) {
          p = h.undo(p)!;
        } else if (roll < 0.09 && h.canRedo) {
          p = h.redo(p)!;
        } else if (roll < 0.12) {
          h.seal();
        } else {
          // Repeat the name edit often, so coalescing runs happen.
          const gen = roll < 0.3 ? GENS[6]! : pick(GENS, r)!;
          const cmd = gen(p, r);
          if (!cmd) continue;
          if (C.isRefusal(cmd)) {
            refusals++;
            continue;
          }
          const depth = h.depth;
          expect(cmd.revert(cmd.apply(p))).toStrictEqual(p);
          p = h.execute(p, cmd);
          if (h.depth === depth) coalesced++;
        }
        steps++;
      }
      while (h.canRedo) p = h.redo(p)!;
      const end = p;
      while (h.canUndo) p = h.undo(p)!;
      expect(p).toStrictEqual(start);
      while (h.canRedo) p = h.redo(p)!;
      expect(p).toStrictEqual(end);
    }
    expect(refusals).toBeGreaterThan(0);
    expect(coalesced).toBeGreaterThan(0);
  });
});
