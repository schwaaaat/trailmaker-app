import { beforeEach, describe, expect, it } from 'vitest';
import type { Trail } from '../core/types';
import { makeProject, makeSession } from './fixtures.test.helper';
import { appStore, openSession, redo, selectTrails, undo } from './store';
import {
  applyAutoJoin,
  cancelAutoJoin,
  previewAutoJoin,
  selectTrailsInRect,
} from './topology-actions';

const trail = (id: string, start: number, end: number, y = 100): Trail => ({
  kind: 'trail',
  id,
  name: id,
  color: '#123456',
  notes: id,
  ink: null,
  pts: [
    [start, y],
    [end, y],
  ],
});
const project = () => appStore.getState().session!.project;
const initial = makeProject({
  features: [
    trail('a', 0, 100),
    trail('b', 100, 200),
    trail('c', 200, 300),
    trail('outside', 0, 300, 400),
  ],
});
beforeEach(() => openSession(makeSession(initial)));

describe('box selection auto-join transaction', () => {
  it('selects crossing geometry, previews without editing, applies and undoes the whole chain once', () => {
    selectTrailsInRect({ x: 50, y: 90, width: 200, height: 20 });
    expect(appStore.getState().selectedTrailIds).toEqual(['a', 'b', 'c']);
    previewAutoJoin(1);
    expect(project()).toBe(initial);
    expect(appStore.getState().boxJoinPreview?.proposal.chainCount).toBe(1);
    expect(applyAutoJoin()).toBe(true);
    const joined = project();
    expect(joined.features.map((f) => f.id)).toEqual(['a', 'outside']);
    expect(joined.features[1]).toBe(initial.features[3]);
    expect((joined.features[0] as Trail).pts).toEqual([
      [0, 100],
      [100, 100],
      [200, 100],
      [300, 100],
    ]);
    undo();
    expect(project()).toStrictEqual(initial);
    expect(appStore.getState().history.canUndo).toBe(false);
    redo();
    expect(project()).toStrictEqual(joined);
  });
  it('cancels without changing saved project bytes and invalidates preview on another map', () => {
    selectTrails(['a', 'b', 'c']);
    previewAutoJoin(1);
    cancelAutoJoin();
    expect(project()).toBe(initial);
    previewAutoJoin(1);
    openSession(makeSession(makeProject()));
    expect(applyAutoJoin()).toBe(false);
    expect(appStore.getState().selectedTrailIds).toEqual([]);
  });
  it('uses existing zoom-dependent snap tolerance and keeps a larger gap separate', () => {
    openSession(makeSession(makeProject({ features: [trail('a', 0, 100), trail('b', 109, 200)] })));
    selectTrails(['a', 'b']);
    previewAutoJoin(1);
    expect(appStore.getState().boxJoinPreview?.proposal.chainCount).toBe(0);
    previewAutoJoin(0.5);
    expect(appStore.getState().boxJoinPreview?.proposal.chainCount).toBe(1);
  });

  it('preserves one-way labels at a normalized branch without a false clearing notice', () => {
    const branches: Trail[] = [
      trail('a', 0, 100),
      { ...trail('b', 102, 200), route: { kind: 'one-way' } },
      {
        ...trail('c', 0, 0),
        pts: [
          [101, 102],
          [101, 200],
        ],
      },
    ];
    openSession(makeSession(makeProject({ features: branches })));
    selectTrails(['a', 'b', 'c']);
    previewAutoJoin(1);
    expect(appStore.getState().boxJoinPreview?.proposal.ambiguousJunctionCount).toBe(1);
    appStore.setState({ toast: null });
    expect(applyAutoJoin()).toBe(true);
    const changed = project().features.find((f) => f.id === 'b') as Trail;
    expect(changed.pts[0]).toEqual([100, 100]);
    expect(changed.route).toEqual({ kind: 'one-way' });
    expect(appStore.getState().toast).toBeNull();
    undo();
    expect(project().features).toEqual(branches);
  });

  it('announces relabelling when a joined-away trail was the only classified member', () => {
    openSession(
      makeSession(
        makeProject({
          features: [trail('a', 0, 100), { ...trail('b', 100, 200), route: { kind: 'one-way' } }],
        }),
      ),
    );
    selectTrails(['a', 'b']);
    previewAutoJoin(1);
    appStore.setState({ toast: null });
    expect(applyAutoJoin()).toBe(true);
    expect(project().features).toHaveLength(1);
    expect((project().features[0] as Trail).route).toBeUndefined();
    expect(appStore.getState().toast?.message).toBe('Route cleared: relabelling needed');
  });
});
