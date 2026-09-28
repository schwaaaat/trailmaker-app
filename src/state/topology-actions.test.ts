import { beforeEach, describe, expect, it } from 'vitest';
import type { Feature, Px } from '../core/types';
import { makeProject, makeSession } from './fixtures.test.helper';
import { appStore, openSession, selectFeature, selectSecondFeature } from './store';
import {
  canSplitAt,
  cleanupJunctions,
  cleanupTolerancePx,
  CLEANUP_TOLERANCE_MAX_PX,
  CLEANUP_TOLERANCE_MIN_PX,
  countSnappedEnds,
  joinSelected,
  needsCleanup,
  splitHere,
} from './topology-actions';

const trail = (id: string, pts: Px[]): Extract<Feature, { kind: 'trail' }> => ({
  kind: 'trail',
  id,
  name: `Trail ${id}`,
  color: '#D9480F',
  notes: '',
  pts,
  ink: null,
});

const proj = () => appStore.getState().session!.project;

beforeEach(() => {
  openSession(makeSession(makeProject()));
});

describe('cleanupTolerancePx', () => {
  it('scales with view zoom and clamps to [2, 30] image px', () => {
    expect(cleanupTolerancePx(1)).toBe(8);
    expect(cleanupTolerancePx(0.1)).toBe(CLEANUP_TOLERANCE_MAX_PX);
    expect(cleanupTolerancePx(10)).toBe(CLEANUP_TOLERANCE_MIN_PX);
  });
});

describe('canSplitAt', () => {
  const t = trail('f1', [
    [0, 0],
    [10, 0],
    [20, 0],
  ]);
  it('is true only for an interior vertex of a trail', () => {
    expect(canSplitAt(t, 0)).toBe(false);
    expect(canSplitAt(t, 1)).toBe(true);
    expect(canSplitAt(t, 2)).toBe(false);
    expect(canSplitAt(undefined, 1)).toBe(false);
  });
  it('is false for areas and points', () => {
    const area: Feature = { ...t, kind: 'area', pts: [...t.pts, [0, 10]] };
    const poi: Feature = {
      kind: 'poi',
      id: 'p1',
      name: 'P',
      color: '#000',
      notes: '',
      at: [0, 0],
      poiType: 'Waypoint',
    };
    expect(canSplitAt(area, 1)).toBe(false);
    expect(canSplitAt(poi, 0)).toBe(false);
  });
});

describe('countSnappedEnds', () => {
  it('counts only ends that actually moved', () => {
    const before = [
      trail('f1', [
        [0, 0],
        [10, 0],
      ]),
      trail('f2', [
        [10.4, 0],
        [20, 0],
      ]),
    ];
    // f1 unchanged, f2's start moved but its end (and everything else) did not.
    const updated = [before[0]!, trail('f2', [[10, 0], [20, 0]])];
    expect(countSnappedEnds(before, updated)).toBe(1);
  });

  it('does not count a trail that only gained a mid-line junction vertex', () => {
    const before = [trail('f1', [[0, 0], [20, 0]])];
    const updated = [trail('f1', [[0, 0], [10, 0], [20, 0]])];
    expect(countSnappedEnds(before, updated)).toBe(0);
  });
});

describe('splitHere', () => {
  it('splits the trail and selects the new (second) half', () => {
    openSession(
      makeSession(
        makeProject({
          seq: 5,
          features: [
            trail('f1', [
              [0, 0],
              [10, 0],
              [20, 0],
            ]),
          ],
        }),
      ),
    );
    splitHere('f1', 1);
    const features = proj().features;
    expect(features.map((f) => f.id)).toStrictEqual(['f1', 'f5']);
    expect(appStore.getState().selectedFeatureId).toBe('f5');
  });

  it('does nothing for an endpoint or a missing feature', () => {
    openSession(
      makeSession(makeProject({ features: [trail('f1', [[0, 0], [10, 0], [20, 0]])] })),
    );
    splitHere('f1', 0);
    expect(proj().features).toHaveLength(1);
    splitHere('nope', 1);
    expect(proj().features).toHaveLength(1);
  });
});

describe('joinSelected', () => {
  it('joins the selected trail with the shift-selected one, keeping the first id', () => {
    openSession(
      makeSession(
        makeProject({
          features: [
            trail('f1', [
              [0, 0],
              [10, 0],
            ]),
            trail('f2', [
              [10, 0],
              [20, 0],
            ]),
          ],
        }),
      ),
    );
    selectFeature('f1');
    selectSecondFeature('f2');
    joinSelected();
    expect(proj().features.map((f) => f.id)).toStrictEqual(['f1']);
    expect(appStore.getState().selectedFeatureId).toBe('f1');
  });

  it('does nothing without two distinct selected trails', () => {
    openSession(
      makeSession(makeProject({ features: [trail('f1', [[0, 0], [10, 0]])] })),
    );
    selectFeature('f1');
    joinSelected(); // no second selection
    expect(proj().features).toHaveLength(1);
  });
});

describe('cleanupJunctions', () => {
  it('snaps ends within tolerance, as one undo step, and toasts a count', () => {
    openSession(
      makeSession(
        makeProject({
          features: [
            trail('f1', [
              [0, 0],
              [10, 0],
            ]),
            trail('f2', [
              [10.4, 0],
              [20, 0],
            ]),
          ],
        }),
      ),
    );
    cleanupJunctions(2);
    // Both ends move to their shared midpoint (10.2, 0): f1's end and f2's start each count.
    expect(appStore.getState().toast?.message).toBe('Joined 2 trail ends');
    const f2 = proj().features.find((f) => f.id === 'f2')!;
    expect(f2.kind === 'trail' && f2.pts[0]).toStrictEqual([10.2, 0]);
  });

  it('toasts "Nothing to clean up" and makes no history entry when nothing is in range', () => {
    openSession(
      makeSession(
        makeProject({
          features: [
            trail('f1', [
              [0, 0],
              [10, 0],
            ]),
            trail('f2', [
              [500, 500],
              [520, 500],
            ]),
          ],
        }),
      ),
    );
    const before = proj();
    cleanupJunctions(2);
    expect(appStore.getState().toast?.message).toBe('Nothing to clean up');
    expect(proj()).toBe(before);
  });
});

describe('needsCleanup', () => {
  it('is memoized on the features array reference', () => {
    const features = [
      trail('f1', [
        [0, 0],
        [10, 0],
      ]),
      trail('f2', [
        [10.4, 0],
        [20, 0],
      ]),
    ];
    expect(needsCleanup(features, 2)).toBe(true);
    expect(needsCleanup(features, 2)).toBe(true);
    expect(needsCleanup(features, 0.01)).toBe(false);
  });
});
