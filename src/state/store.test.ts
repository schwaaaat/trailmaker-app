import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FitResult } from '../core/types';
import * as C from './commands';
import { makeProject, makeSession } from './fixtures.test.helper';
import {
  appStore,
  edit,
  openSession,
  redo,
  sealHistory,
  selectFit,
  selectProject,
  setCandidateOn,
  setCandidates,
  setDraft,
  setVertexFocus,
  splitCandidateInReview,
  undo,
  undoCandidateSplit,
  type ReviewCandidate,
} from './store';

// fitAnchors is Lane A's (T-101); the store only memoizes it.
const fitResult: FitResult = { ok: false, reason: 'too-few', anchorCount: 0, need: 2 };
const fitAnchors = vi.hoisted(() => vi.fn());
vi.mock('../core/geo/fit', () => ({ fitAnchors }));

const project = () => appStore.getState().session!.project;

beforeEach(() => {
  fitAnchors.mockReset().mockImplementation(() => ({ ...fitResult }));
  openSession(makeSession());
});

describe('store', () => {
  it('announces a focused vertex as a point number', () => {
    const project = makeProject({
      features: [
        {
          kind: 'trail',
          id: 'focus-trail',
          name: 'Trail',
          color: '#D9480F',
          notes: '',
          pts: Array.from({ length: 52 }, (_, i) => [i, 0] as [number, number]),
          ink: null,
        },
      ],
    });
    openSession(makeSession(project));
    setVertexFocus({ featureId: 'focus-trail', index: 13 });
    expect(appStore.getState().announcement?.text).toBe('Point 14 of 52');
  });
  it('edits, undoes and redoes through history, mirroring status into state', () => {
    const { command, id } = C.addAnchor(project(), [5, 5]);
    expect(edit(command, { anchor: id })).toBe(true);
    let s = appStore.getState();
    expect(s.selectedAnchorId).toBe('g1');
    expect(s.history).toStrictEqual({
      canUndo: true,
      canRedo: false,
      undoLabel: 'Add anchor',
      redoLabel: null,
    });

    expect(undo()).toBe(true);
    s = appStore.getState();
    expect(s.session!.project.anchors).toHaveLength(0);
    // Prototype undo(): a selection that no longer exists is dropped.
    expect(s.selectedAnchorId).toBeNull();
    expect(s.history.redoLabel).toBe('Add anchor');

    expect(redo()).toBe(true);
    expect(project().anchors.map((a) => a.id)).toStrictEqual(['g1']);
  });

  it('toasts instead of applying a refusal, and when nothing to undo/redo', () => {
    const p = makeProject({
      features: [
        {
          kind: 'trail',
          id: 'f1',
          name: 't',
          color: '#D9480F',
          notes: '',
          pts: [
            [0, 0],
            [1, 1],
          ],
          ink: null,
        },
      ],
    });
    openSession(makeSession(p));
    expect(edit(C.deleteVertex(p, 'f1', 0))).toBe(false);
    expect(appStore.getState().toast?.message).toMatch(/needs at least 2 points/);
    expect(project()).toBe(p);

    expect(undo()).toBe(false);
    expect(appStore.getState().toast?.message).toBe('Nothing to undo');
    expect(redo()).toBe(false);
    expect(appStore.getState().toast?.message).toBe('Nothing to redo');
  });

  it('rejects a command built from an older project (it would rewind seq)', () => {
    const stale = C.setUnits(project(), 'km');
    edit(C.addAnchor(project(), [1, 1]).command);
    const before = project();
    expect(() => edit(stale)).toThrow('Stale command "Change units"');
    expect(project()).toBe(before);
    expect(appStore.getState().history.undoLabel).toBe('Add anchor');
  });

  it('throws when editing without a session', () => {
    appStore.setState({ session: null });
    expect(() => edit(C.setUnits(makeProject(), 'km'))).toThrow('No session');
    expect(undo()).toBe(false);
  });

  it('openSession clears history, selection, draft, candidates and busy', () => {
    edit(
      C.addFeature(project(), {
        kind: 'poi',
        name: 'P',
        color: '#1F6FB2',
        notes: '',
        at: [1, 1],
        poiType: 'Water',
      }).command,
      {
        feature: 'f1',
      },
    );
    setDraft({
      kind: 'trail',
      pts: [[0, 0]],
      cps: [1],
      ink: null,
      color: '#D9480F',
      name: 'Trail 1',
      editId: null,
    });
    const cand: ReviewCandidate = {
      id: 'k1',
      chipId: 'c1',
      pts: [
        [0, 0],
        [9, 9],
      ],
      lengthPx: 12.7,
      ink: [0, 0, 0],
      confidence: null,
      on: true,
      name: 'Black',
      color: '#000000',
    };
    setCandidates([cand]);
    setCandidateOn('k1', false);
    expect(appStore.getState().candidates![0]!.on).toBe(false);
    appStore.setState({ busy: 'Tracing…' });

    openSession(makeSession());
    const s = appStore.getState();
    expect([s.selectedFeatureId, s.draft, s.candidates, s.busy]).toStrictEqual([
      null,
      null,
      null,
      null,
    ]);
    expect(s.history.canUndo).toBe(false);
  });

  it('sealHistory splits a coalescing run', () => {
    edit(
      C.addFeature(project(), {
        kind: 'poi',
        name: '',
        color: '#1F6FB2',
        notes: '',
        at: [1, 1],
        poiType: 'Water',
      }).command,
    );
    edit(C.updateFeature(project(), 'f1', { name: 'a' }));
    edit(C.updateFeature(project(), 'f1', { name: 'ab' }));
    sealHistory();
    edit(C.updateFeature(project(), 'f1', { name: 'abc' }));
    undo();
    expect(project().features[0]!.name).toBe('ab');
    undo();
    expect(project().features[0]!.name).toBe('');
  });

  it('memoizes the fit on anchors, method and image size', () => {
    const s0 = appStore.getState();
    const f0 = selectFit(s0);
    expect(f0).toStrictEqual(fitResult);
    expect(selectFit(s0)).toBe(f0);
    expect(fitAnchors).toHaveBeenCalledTimes(1);

    // Feature edits keep the anchors array: no refit.
    edit(
      C.addFeature(project(), {
        kind: 'poi',
        name: 'P',
        color: '#1F6FB2',
        notes: '',
        at: [1, 1],
        poiType: 'Water',
      }).command,
    );
    edit(C.setUnits(project(), 'km'));
    expect(selectFit(appStore.getState())).toBe(f0);
    expect(fitAnchors).toHaveBeenCalledTimes(1);

    edit(C.addAnchor(project(), [3, 3]).command);
    selectFit(appStore.getState());
    expect(fitAnchors).toHaveBeenCalledTimes(2);
    expect(fitAnchors).toHaveBeenLastCalledWith(project().anchors, 1000, 800, 'auto');

    edit(C.setFitMethod(project(), 'affine'));
    selectFit(appStore.getState());
    expect(fitAnchors).toHaveBeenCalledTimes(3);

    const p = project();
    openSession(makeSession({ ...p, image: { ...p.image, width: 2000 } }));
    selectFit(appStore.getState());
    expect(fitAnchors).toHaveBeenCalledTimes(4);

    appStore.setState({ session: null });
    expect(selectFit(appStore.getState())).toBeNull();
    expect(selectProject(appStore.getState())).toBeNull();
  });

  it('undoes a candidate split under review without touching project history (T-213)', () => {
    const cand: ReviewCandidate = {
      id: 'k1',
      chipId: 'c1',
      pts: [
        [0, 0],
        [9, 9],
      ],
      lengthPx: 12.7,
      ink: [0, 0, 0],
      confidence: null,
      on: true,
      name: 'Black',
      color: '#000000',
    };
    setCandidates([cand]);
    expect(appStore.getState().reviewUndoStack).toStrictEqual([]);
    expect(undoCandidateSplit()).toBe(false);

    const a: ReviewCandidate = {
      ...cand,
      id: 'k1a',
      pts: [
        [0, 0],
        [4, 4],
      ],
    };
    const b: ReviewCandidate = {
      ...cand,
      id: 'k1b',
      pts: [
        [4, 4],
        [9, 9],
      ],
    };
    splitCandidateInReview([a, b]);
    expect(appStore.getState().candidates).toStrictEqual([a, b]);
    expect(appStore.getState().reviewUndoStack).toStrictEqual([[cand]]);
    expect(appStore.getState().history.canUndo).toBe(false);

    expect(undoCandidateSplit()).toBe(true);
    expect(appStore.getState().candidates).toStrictEqual([cand]);
    expect(appStore.getState().reviewUndoStack).toStrictEqual([]);
    expect(appStore.getState().history.canUndo).toBe(false);

    expect(undoCandidateSplit()).toBe(false);
    expect(appStore.getState().candidates).toStrictEqual([cand]);
  });
});
