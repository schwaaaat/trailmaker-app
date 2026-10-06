import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Feature, Project, Px } from '../../core/types';
import { sessionBridge } from '../../state/bridge';
import { makeProject, makeSession } from '../../state/fixtures.test.helper';
import {
  appStore,
  openSession,
  redo,
  selectFeature,
  setJoinArmed,
  setKeyboardMode,
  setTool,
  setBoxSelectMode,
  undo,
} from '../../state/store';
import { Editor } from './Editor';
import { dragFrom, key, makeCanvas, ptr, tap } from './pointer.test.helper';
import {
  TIPS,
  Tools,
  chooseTool,
  continueTrail,
  keyAction,
  settled,
  tipFor,
  undoAction,
  type KeyContext,
  type KeyInput,
} from './tools';
import { toScr } from './view';

const trail: Feature = {
  kind: 'trail',
  id: 'f1',
  name: 'Ridge',
  color: '#D9480F',
  notes: '',
  pts: [
    [100, 100],
    [300, 100],
    [300, 300],
  ],
  ink: null,
};

let canvas: HTMLCanvasElement;
let ed: Editor;
let tools: Tools;

const st = () => appStore.getState();
const proj = () => st().session!.project;
/** Canvas-local screen point of an image pixel under the current view. */
const scr = (p: Px) => toScr(ed.view, p) as [number, number];
const click = (p: Px) => tap(canvas, scr(p));

describe('box selecting trails (T-333)', () => {
  const chain = (id: string, from: Px, to: Px): Feature => ({ ...trail, id, pts: [from, to] });
  it('selects every crossing trail under forward/reverse drags and transformed views', () => {
    open(
      makeProject({
        features: [
          chain('a', [0, 100], [300, 100]),
          chain('b', [300, 100], [500, 100]),
          chain('c', [500, 100], [900, 100]),
          chain('outside', [0, 200], [900, 200]),
        ],
      }),
    );
    for (const reverse of [false, true]) {
      ed.panBy(24, 16);
      ed.zoomBy(1.2);
      setBoxSelectMode(true);
      dragFrom(
        canvas,
        scr(reverse ? [600, 120] : [200, 80]),
        scr(reverse ? [200, 80] : [600, 120]),
      );
      expect(st().selectedTrailIds).toEqual(['a', 'b', 'c']);
      expect(st().boxSelectMode).toBe(false);
    }
  });
  it('supports touch drag and two corner taps; a pinch cancels without selecting', () => {
    setBoxSelectMode(true);
    const [x0, y0] = scr([80, 80]);
    const [x1, y1] = scr([320, 120]);
    ptr(canvas, 'pointerdown', x0, y0, { pointerType: 'touch' });
    ptr(canvas, 'pointermove', x1, y1, { pointerType: 'touch' });
    ptr(canvas, 'pointerup', x1, y1, { pointerType: 'touch' });
    expect(st().selectedTrailIds).toEqual(['f1']);
    setBoxSelectMode(true);
    for (const point of [
      [80, 80],
      [320, 120],
    ] as Px[]) {
      const [x, y] = scr(point);
      ptr(canvas, 'pointerdown', x, y, { pointerType: 'touch' });
      ptr(canvas, 'pointerup', x, y, { pointerType: 'touch' });
    }
    expect(st().selectedTrailIds).toEqual(['f1']);
    const selected = st().selectedTrailIds;
    setBoxSelectMode(true);
    touchDragBecomesPinch([80, 80]);
    expect(st().selectedTrailIds).toBe(selected);
    expect(st().boxSelectMode).toBe(false);
  });
  it('sizes a keyboard rectangle, previews with J, applies with Enter, and undoes once', () => {
    const [x, y] = ed.centerPointerAt().px;
    open(
      makeProject({
        features: [
          chain('a', [x - 100, y + 5], [x + 10, y + 5]),
          chain('b', [x + 10, y + 5], [x + 100, y + 5]),
        ],
      }),
    );
    key('b');
    expect(document.activeElement).toBe(canvas);
    key('Enter', {}, canvas);
    key('ArrowRight', {}, canvas);
    key('ArrowDown', {}, canvas);
    key('Enter', {}, canvas);
    expect(st().selectedTrailIds).toEqual(['a', 'b']);
    key('j', {}, canvas);
    expect(st().boxJoinPreview?.proposal.chainCount).toBe(1);
    const before = proj();
    key('Enter', {}, canvas);
    expect(proj().features).toHaveLength(1);
    undo();
    expect(proj()).toStrictEqual(before);
  });
  it('Escape cancels a keyboard rectangle and does not alter the project', () => {
    const before = proj();
    key('b');
    key('Enter', {}, canvas);
    key('ArrowDown', {}, canvas);
    key('Escape', {}, canvas);
    expect(st().boxSelectMode).toBe(false);
    expect(st().selectedTrailIds).toEqual([]);
    expect(proj()).toBe(before);
  });
  it('does not apply a join when Enter belongs to a focused panel button; Escape still cancels', () => {
    open(
      makeProject({
        features: [chain('a', [100, 100], [200, 100]), chain('b', [200, 100], [300, 100])],
      }),
    );
    setBoxSelectMode(true);
    dragFrom(canvas, scr([150, 90]), scr([250, 110]));
    key('j', {}, canvas);
    expect(st().boxJoinPreview?.proposal.chainCount).toBe(1);
    const before = proj();
    const button = document.createElement('button');
    document.body.appendChild(button);
    button.focus();
    key('Enter', {}, button);
    expect(proj()).toBe(before);
    key('Escape', {}, button);
    expect(st().boxJoinPreview).toBeNull();
  });
});

function touchDragBecomesPinch(at: Px): void {
  const [x, y] = scr(at);
  ptr(canvas, 'pointerdown', x, y, { id: 1, pointerType: 'touch' });
  ptr(canvas, 'pointermove', x + 24, y + 2, { id: 1, pointerType: 'touch' });
  ptr(canvas, 'pointerdown', x + 120, y + 2, { id: 2, pointerType: 'touch' });
  ptr(canvas, 'pointerup', x + 24, y + 2, { id: 1, pointerType: 'touch' });
  ptr(canvas, 'pointerup', x + 120, y + 2, { id: 2, pointerType: 'touch' });
}

function open(p: Project) {
  openSession(makeSession(p));
}

beforeEach(async () => {
  await settled();
  setTool('select');
  open(makeProject({ features: [trail], seq: 10 }));
  canvas = makeCanvas();
  ed = new Editor();
  ed.mount(canvas);
  tools = new Tools(ed);
});

afterEach(async () => {
  await settled();
  tools.destroy();
  ed.destroy();
  canvas.remove();
  document.body.innerHTML = '';
});

describe('anchor tool', () => {
  it('adds an anchor with no coordinates, selects it and asks for input focus', () => {
    chooseTool('anchor');
    click([500, 400]);
    expect(proj().anchors).toStrictEqual([
      { id: 'g10', px: [500, 400], ll: null, source: 'paste' },
    ]);
    expect(st().selectedAnchorId).toBe('g10');
    expect(st().focusRequest).toMatchObject({ target: 'anchor', id: 'g10' });
  });

  it('clicking an existing pin selects it instead of adding another, and outside the image adds nothing', () => {
    chooseTool('anchor');
    click([500, 400]);
    click([200, 200]);
    expect(proj().anchors).toHaveLength(2);
    click([500, 400]);
    expect(proj().anchors).toHaveLength(2);
    expect(st().selectedAnchorId).toBe('g10');
    tap(canvas, [2, 2]); // outside the fitted image
    expect(proj().anchors).toHaveLength(2);
  });

  it('dragging a pin is one undo step, sealed from neighbouring edits', () => {
    chooseTool('anchor');
    click([500, 400]);
    const afterAdd = proj();
    const [x, y] = scr([500, 400]);
    dragFrom(canvas, [x, y], [x + 40, y + 20], 5);
    expect(proj().anchors[0]!.px[0]).toBeCloseTo(500 + 40 / ed.view.s, 6);
    expect(st().history.undoLabel).toBe('Move anchor');
    // A second drag of the same pin is its own step.
    dragFrom(canvas, scr(proj().anchors[0]!.px), [x, y], 3);
    undo();
    undo();
    expect(proj()).toStrictEqual(afterAdd);
  });

  it('restores a pin and the exact undo/redo state when its touch drag becomes a pinch', () => {
    chooseTool('anchor');
    click([500, 400]);
    click([600, 500]);
    undo(); // leave a redo entry while retaining the first pin
    setTool('select');
    const before = proj();
    const historyBefore = st().history;

    touchDragBecomesPinch([500, 400]);

    expect(proj()).toStrictEqual(before);
    expect(st().history).toStrictEqual(historyBefore);
    expect(st().anchorDragging).toBe(false);
    redo();
    expect(proj().anchors).toHaveLength(2);
    undo();
    expect(proj()).toStrictEqual(before);
  });

  it('keeps a one-finger touch drag as a normal single undo step', () => {
    chooseTool('anchor');
    click([500, 400]);
    const before = proj();
    const [x, y] = scr([500, 400]);
    ptr(canvas, 'pointerdown', x, y, { id: 1, pointerType: 'touch' });
    ptr(canvas, 'pointermove', x + 30, y + 10, { id: 1, pointerType: 'touch' });
    ptr(canvas, 'pointerup', x + 30, y + 10, { id: 1, pointerType: 'touch' });

    expect(proj().anchors[0]!.px).not.toStrictEqual(before.anchors[0]!.px);
    expect(st().history.undoLabel).toBe('Move anchor');
    undo();
    expect(proj()).toStrictEqual(before);
  });
});

describe('trail and area drafting', () => {
  it('clicks start and extend a draft; clicking the last point finishes it as one undo step', async () => {
    const before = sessionBridge.getSession()!.project;
    chooseTool('trail');
    click([100, 500]);
    click([300, 520]);
    click([500, 450]);
    await settled();
    expect(st().draft).toMatchObject({
      kind: 'trail',
      name: 'Trail 2',
      cps: [1, 2, 3],
      editId: null,
    });
    expect(st().draft!.pts).toHaveLength(3);
    click([500, 450]); // the last point again
    await settled();
    expect(st().draft).toBeNull();
    const added = proj().features[1]!;
    expect(added).toMatchObject({
      kind: 'trail',
      id: 'f10',
      name: 'Trail 2',
      color: '#D9480F',
      ink: null,
    });
    expect(st().selectedFeatureId).toBe('f10');
    const after = sessionBridge.getSession()!.project;
    undo();
    expect(sessionBridge.getSession()!.project).toStrictEqual(before);
    redo();
    expect(sessionBridge.getSession()!.project).toStrictEqual(after);
  });

  it('keyboard-mode Enter adds a point at the view centre instead of finishing; a second Enter without panning finishes (T-215 review)', async () => {
    chooseTool('trail');
    click([100, 500]);
    await settled();
    expect(st().draft!.pts).toHaveLength(1);
    // Arrows/Tab set this while drafting too; simulate that directly rather than panning.
    setKeyboardMode(true);
    key('Enter');
    await settled();
    expect(st().draft).not.toBeNull();
    expect(st().draft!.pts).toHaveLength(2);
    key('Enter');
    await settled();
    expect(st().draft).toBeNull();
    expect(proj().features.at(-1)).toMatchObject({ kind: 'trail' });
  });

  it('mouse-drafted trails still finish on a plain Enter (keyboardMode stays false)', async () => {
    chooseTool('trail');
    click([100, 500]);
    click([300, 500]);
    await settled();
    expect(st().keyboardMode).toBe(false);
    key('Enter');
    await settled();
    expect(st().draft).toBeNull();
    expect(proj().features.at(-1)).toMatchObject({ kind: 'trail' });
  });

  it('simplifies at 0.6 px on finish', async () => {
    chooseTool('trail');
    for (const p of [
      [100, 500],
      [200, 500.3],
      [300, 500],
    ] as Px[])
      click(p);
    await settled();
    key('Enter');
    await settled();
    // The middle point is within 0.6 px of the chord and is dropped (prototype simplify).
    expect((proj().features[1] as Extract<Feature, { kind: 'trail' }>).pts).toHaveLength(2);
  });

  it('Backspace undoes clicks one at a time; undoing the first click cancels; Esc cancels', async () => {
    chooseTool('trail');
    click([100, 500]);
    click([300, 500]);
    await settled();
    key('Backspace');
    await settled();
    expect(st().draft!.pts).toHaveLength(1);
    key('Backspace');
    await settled();
    expect(st().draft).toBeNull();
    click([100, 500]);
    click([300, 500]);
    await settled();
    key('Escape');
    await settled();
    expect(st().draft).toBeNull();
    expect(proj().features).toHaveLength(1);
  });

  it('finishing with too few points drops the draft with the prototype toast', async () => {
    chooseTool('trail');
    click([100, 500]);
    await settled();
    key('Enter');
    await settled();
    expect(st().draft).toBeNull();
    expect(st().toast?.message).toBe('A trail needs at least 2 points.');
    chooseTool('area');
    click([100, 500]);
    click([300, 500]);
    await settled();
    key('Enter');
    await settled();
    expect(st().toast?.message).toBe('An area needs at least 3 points.');
    expect(proj().features).toHaveLength(1);
  });

  it('clicking the first point of an area (> 2 points) closes it', async () => {
    chooseTool('area');
    for (const p of [
      [600, 500],
      [800, 500],
      [800, 700],
    ] as Px[])
      click(p);
    const [fx, fy] = scr([600, 500]);
    tap(canvas, [fx + 5, fy + 5]); // within 10 px of the first point
    await settled();
    expect(st().draft).toBeNull();
    expect(proj().features[1]).toMatchObject({ kind: 'area', name: 'Area 1', color: '#3A7D44' });
    expect((proj().features[1] as Extract<Feature, { kind: 'area' }>).pts).toHaveLength(3);
  });

  it('switching to another tool finishes the draft; the ink picker keeps it', async () => {
    chooseTool('trail');
    click([100, 500]);
    click([300, 500]);
    chooseTool('ink');
    await settled();
    expect(st().draft).not.toBeNull();
    // Returning from the picker to the draft's own tool keeps drawing (a prototype fix).
    chooseTool('trail');
    await settled();
    expect(st().draft).not.toBeNull();
    chooseTool('select');
    await settled();
    expect(st().draft).toBeNull();
    expect(proj().features).toHaveLength(2);
  });

  it('uses the hop provider (async), keeps clicks in order, and falls back to a straight segment', async () => {
    ed.setHopProvider({
      hop: async (from, to) => {
        await new Promise((r) => setTimeout(r, 5));
        return [[(from[0] + to[0]) / 2, from[1]], to];
      },
    });
    chooseTool('trail');
    click([100, 500]);
    click([300, 500]);
    click([500, 500]);
    await settled();
    expect(st().draft!.pts).toStrictEqual(
      [
        [100, 500],
        [200, 500],
        [300, 500],
        [400, 500],
        [500, 500],
      ].map(([x, y]) => [expect.closeTo(x!, 6), expect.closeTo(y!, 6)]),
    );
    expect(st().draft!.cps).toStrictEqual([1, 3, 5]);
    // Undo removes a whole hop.
    key('Backspace');
    await settled();
    expect(st().draft!.pts).toHaveLength(3);

    ed.setHopProvider({ hop: () => null });
    click([700, 500]);
    await settled();
    expect(st().toast?.message).toMatch(/^Too far to follow in one step/);
    expect(st().draft!.pts).toHaveLength(4);
    ed.setHopProvider(null);
  });

  it('drops a hop whose draft was replaced while it ran (e.g. a new map opened)', async () => {
    let release: (pts: Px[]) => void = () => {};
    const called = new Promise<void>((calledResolve) =>
      ed.setHopProvider({
        hop: (_f, to) =>
          new Promise((r) => {
            release = () => r([to]);
            calledResolve();
          }),
      }),
    );
    chooseTool('trail');
    click([100, 500]);
    click([300, 500]);
    await called;
    open(makeProject({ features: [], seq: 50 }));
    release([]);
    await settled();
    expect(st().draft).toBeNull();
    expect(proj().features).toStrictEqual([]);
    ed.setHopProvider(null);
  });
});

describe('continue trail', () => {
  it('re-opens the trail as a draft; finishing replaces its points as one undo step', async () => {
    await continueTrail('f1');
    expect(st().tool).toBe('trail');
    expect(st().draft).toMatchObject({ editId: 'f1', name: 'Ridge', cps: [3] });
    const before = proj();
    click([500, 300]);
    await settled();
    // Draft undo steps back within the draft and never touches the original trail.
    undoAction();
    await settled();
    expect(st().draft!.pts).toHaveLength(3);
    expect(proj()).toBe(before);
    click([500, 300]);
    key('Enter');
    await settled();
    const f = proj().features[0] as Extract<Feature, { kind: 'trail' }>;
    expect(f.pts).toHaveLength(4);
    expect(proj().features).toHaveLength(1);
    undo();
    expect(proj()).toStrictEqual(before);
  });

  it('drops the draft if the continued trail was deleted meanwhile', async () => {
    await continueTrail('f1');
    click([500, 300]);
    await settled();
    // Delete is ignored while drafting (it would remove the trail being continued).
    selectFeature('f1');
    key('Delete');
    expect(proj().features).toHaveLength(1);
    // Force the trail away (e.g. a panel action), then finish: no throw, draft dropped.
    appStore.setState({
      session: { ...st().session!, project: { ...proj(), features: [] } },
    });
    key('Enter');
    await settled();
    expect(st().draft).toBeNull();
    expect(proj().features).toHaveLength(0);
  });
});

describe('point tool', () => {
  it('adds "Point n", a Waypoint in the POI color, selected, with its name field focused', () => {
    chooseTool('point');
    click([400, 400]);
    click([410, 420]);
    const pois = proj().features.filter((f) => f.kind === 'poi');
    expect(pois.map((f) => f.name)).toStrictEqual(['Point 1', 'Point 2']);
    expect(pois[0]).toMatchObject({ poiType: 'Waypoint', color: '#1F6FB2', at: [400, 400] });
    expect(st().selectedFeatureId).toBe(pois[1]!.id);
    expect(st().focusRequest).toMatchObject({ target: 'feature-name', id: pois[1]!.id });
  });
});

describe('select tool', () => {
  it('selects a feature on click and deselects on empty space', () => {
    click([200, 100]);
    expect(st().selectedFeatureId).toBe('f1');
    click([700, 700]);
    expect(st().selectedFeatureId).toBeNull();
  });

  it('drags a vertex of the selected feature as one undo step', () => {
    selectFeature('f1');
    const before = proj();
    const [x, y] = scr([300, 100]);
    dragFrom(canvas, [x, y], [x, y + 30], 4);
    const f = proj().features[0] as Extract<Feature, { kind: 'trail' }>;
    expect(f.pts[1]![1]).toBeCloseTo(100 + 30 / ed.view.s, 6);
    undo();
    expect(proj()).toStrictEqual(before);
  });

  it.each([
    ['trail', trail],
    [
      'area',
      {
        kind: 'area',
        id: 'area1',
        name: 'Meadow',
        color: '#D9480F',
        notes: '',
        pts: [
          [100, 100],
          [300, 100],
          [300, 300],
        ],
      },
    ],
  ] as const)('restores a %s vertex drag when a second touch starts a pinch', (_kind, feature) => {
    open(makeProject({ features: [feature] }));
    selectFeature(feature.id);
    const before = proj();
    const historyBefore = st().history;

    touchDragBecomesPinch([300, 100]);

    expect(proj()).toStrictEqual(before);
    expect(st().history).toStrictEqual(historyBefore);
  });

  it('right-click on a vertex opens the menu (T-209): endpoints cannot split, interior vertices can', () => {
    selectFeature('f1');
    ptr(canvas, 'contextmenu', ...scr([300, 300]), { button: 2 }); // index 2, an endpoint
    expect(st().vertexMenu).toMatchObject({ featureId: 'f1', index: 2, canSplit: false });
    ptr(canvas, 'contextmenu', ...scr([300, 100]), { button: 2 }); // index 1, interior
    expect(st().vertexMenu).toMatchObject({ featureId: 'f1', index: 1, canSplit: true });
    expect((proj().features[0] as Extract<Feature, { kind: 'trail' }>).pts).toHaveLength(3);
  });

  it('right-click away from any vertex closes the menu; so does a plain click; so does Esc', () => {
    selectFeature('f1');
    ptr(canvas, 'contextmenu', ...scr([300, 100]), { button: 2 });
    expect(st().vertexMenu).not.toBeNull();
    ptr(canvas, 'contextmenu', ...scr([900, 700]), { button: 2 });
    expect(st().vertexMenu).toBeNull();

    ptr(canvas, 'contextmenu', ...scr([300, 100]), { button: 2 });
    expect(st().vertexMenu).not.toBeNull();
    click([900, 700]);
    expect(st().vertexMenu).toBeNull();

    selectFeature('f1');
    ptr(canvas, 'contextmenu', ...scr([300, 100]), { button: 2 });
    expect(st().vertexMenu).not.toBeNull();
    key('Escape');
    expect(st().vertexMenu).toBeNull();
    // Escape closing the menu doesn't also deselect the feature.
    expect(st().selectedFeatureId).toBe('f1');
  });

  it('a right-drag pan that ends on a vertex does not delete it', () => {
    selectFeature('f1');
    const [x, y] = scr([300, 300]);
    setTool('anchor'); // right-drag pans outside the select tool...
    setTool('select'); // ...and in select it is an untargeted drag, which pans too
    dragFrom(canvas, [x - 40, y], [x, y], 4, 2);
    ptr(canvas, 'contextmenu', ...scr([300, 300]), { button: 2 });
    expect((proj().features[0] as Extract<Feature, { kind: 'trail' }>).pts).toHaveLength(3);
  });

  it('Delete and Backspace delete the selected feature', () => {
    selectFeature('f1');
    key('Delete');
    expect(proj().features).toHaveLength(0);
    undo();
    selectFeature('f1');
    key('Backspace');
    expect(proj().features).toHaveLength(0);
  });
});

describe('split and join (T-209)', () => {
  const trail2: Feature = {
    kind: 'trail',
    id: 'f2',
    name: 'Spur',
    color: '#3A7D44',
    notes: '',
    pts: [
      [500, 500],
      [600, 500],
    ],
    ink: null,
  };

  it('S splits the selected trail at the hovered interior vertex, and selects the new half', () => {
    selectFeature('f1');
    ptr(canvas, 'pointermove', ...scr([300, 100])); // hover the interior vertex, index 1
    key('s');
    expect(proj().features.map((f) => f.id)).toStrictEqual(['f1', 'f10']);
    expect(st().selectedFeatureId).toBe('f10');
  });

  it('S does nothing while hovering an endpoint', () => {
    selectFeature('f1');
    ptr(canvas, 'pointermove', ...scr([100, 100])); // endpoint, index 0
    key('s');
    expect(proj().features).toHaveLength(1);
  });

  it('shift-clicking a second trail arms "Join trails"; J joins them', () => {
    open(makeProject({ features: [trail, trail2], seq: 10 }));
    selectFeature('f1');
    ptr(canvas, 'pointerdown', ...scr([550, 500]), { shiftKey: true });
    ptr(canvas, 'pointerup', ...scr([550, 500]), { shiftKey: true });
    expect(st().secondSelectedFeatureId).toBe('f2');
    key('j');
    expect(proj().features.map((f) => f.id)).toStrictEqual(['f1']);
    expect(proj().features[0]!.name).toBe('Ridge');
  });

  it('long-pressing a selected vertex opens the right-click vertex menu', () => {
    vi.useFakeTimers();
    try {
      selectFeature('f1');
      ptr(canvas, 'pointerdown', ...scr([300, 100]), { pointerType: 'touch' });
      vi.advanceTimersByTime(500);
      expect(st().vertexMenu).toMatchObject({ featureId: 'f1', index: 1, canSplit: true });
      ptr(canvas, 'pointerup', ...scr([300, 100]), { pointerType: 'touch' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('joins the next tapped trail after touch join mode is armed', () => {
    open(makeProject({ features: [trail, trail2], seq: 10 }));
    selectFeature('f1');
    setJoinArmed(true);
    ptr(canvas, 'pointerdown', ...scr([550, 500]));
    ptr(canvas, 'pointerup', ...scr([550, 500]));
    expect(st().joinArmed).toBe(false);
    expect(proj().features.map((f) => f.id)).toStrictEqual(['f1']);
    expect(proj().features[0]!.name).toBe('Ridge');
  });

  it('shift-clicking the already-selected trail, an area, or empty space does not arm a join', () => {
    open(makeProject({ features: [trail, trail2], seq: 10 }));
    selectFeature('f1');
    ptr(canvas, 'pointerdown', ...scr([200, 100]), { shiftKey: true }); // f1 itself
    ptr(canvas, 'pointerup', ...scr([200, 100]), { shiftKey: true });
    expect(st().secondSelectedFeatureId).toBeNull();
    ptr(canvas, 'pointerdown', ...scr([700, 700]), { shiftKey: true }); // empty space
    ptr(canvas, 'pointerup', ...scr([700, 700]), { shiftKey: true });
    expect(st().secondSelectedFeatureId).toBeNull();
    expect(st().selectedFeatureId).toBeNull(); // the plain-select fallback ran
  });

  it('J does nothing without an armed second trail', () => {
    open(makeProject({ features: [trail, trail2], seq: 10 }));
    selectFeature('f1');
    key('j');
    expect(proj().features).toHaveLength(2);
  });
});

describe('keyboard', () => {
  it('switches tools, fits, zooms, and routes undo/redo (draft first)', async () => {
    for (const [k, tool] of [
      ['t', 'trail'],
      ['r', 'area'],
      ['p', 'point'],
      ['a', 'anchor'],
      ['v', 'select'],
    ] as const) {
      key(k);
      await settled();
      expect(st().tool).toBe(tool);
    }
    const s0 = ed.view.s;
    key('+');
    expect(ed.view.s).toBeCloseTo(s0 * 1.3, 9);
    key('-');
    key('f');
    expect(ed.view.s).toBeCloseTo(s0, 9);

    chooseTool('point');
    click([400, 400]);
    key('z', { ctrlKey: true });
    expect(proj().features).toHaveLength(1);
    key('z', { ctrlKey: true, shiftKey: true });
    expect(proj().features).toHaveLength(2);
    key('z', { metaKey: true });
    key('y', { ctrlKey: true });
    expect(proj().features).toHaveLength(2);
  });

  it('Esc leaves the ink picker for the previous drawing tool (with no draft open)', () => {
    chooseTool('area');
    chooseTool('ink');
    key('Escape');
    expect(st().tool).toBe('area');
  });

  it('Enter on a focused toolbar button does not finish the draft', async () => {
    chooseTool('trail');
    click([100, 500]);
    click([300, 500]);
    const button = document.createElement('button');
    document.body.appendChild(button);
    key('Enter', {}, button);
    await settled();
    expect(st().draft).not.toBeNull();
    // Typing in a field is never a shortcut either.
    const input = document.createElement('input');
    document.body.appendChild(input);
    key('t', {}, input);
    expect(st().tool).toBe('trail');
  });

  const ctx = (c: Partial<KeyContext> = {}): KeyContext => ({
    hasMap: true,
    drafting: false,
    tool: 'select',
    hasSelection: false,
    canSplitHere: false,
    canJoin: false,
    reviewCanUndo: false,
    hasVertexFocus: false,
    canFocusVertices: false,
    canPlaceAtCenter: false,
    keyboardMode: false,
    ...c,
  });
  const k = (keyName: string, m: Partial<KeyInput> = {}): KeyInput => ({
    key: keyName,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    targetTag: 'CANVAS',
    targetEditable: false,
    targetIsCanvas: true,
    ...m,
  });

  it.each([
    ['v', {}, {}, { tool: 'select' }],
    ['A', {}, {}, { tool: 'anchor' }],
    ['t', {}, {}, { tool: 'trail' }],
    ['p', {}, {}, { tool: 'point' }],
    ['r', {}, {}, { tool: 'area' }],
    ['c', {}, {}, { tool: 'connect' }],
    ['Enter', {}, { tool: 'connect', hasVertexFocus: true }, 'connectFocusedPoint'],
    ['Escape', {}, { tool: 'connect' }, 'cancelConnect'],
    ['Escape', { targetTag: 'BUTTON' }, { tool: 'connect' }, 'cancelConnect'],
    ['Escape', {}, { tool: 'select', hasConnectSession: true }, 'cancelConnect'],
    ['f', {}, {}, 'fit'],
    ['+', {}, {}, 'zoomIn'],
    ['=', {}, {}, 'zoomIn'],
    ['-', {}, {}, 'zoomOut'],
    ['z', { ctrlKey: true }, {}, 'undo'],
    ['z', { metaKey: true }, {}, 'undo'],
    ['z', { ctrlKey: true }, { drafting: true }, 'draftUndo'],
    ['z', { ctrlKey: true }, { reviewCanUndo: true }, 'undoSplit'],
    ['z', { metaKey: true }, { reviewCanUndo: true }, 'undoSplit'],
    ['z', { ctrlKey: true }, { drafting: true, reviewCanUndo: true }, 'draftUndo'],
    ['Z', { ctrlKey: true, shiftKey: true }, { reviewCanUndo: true }, 'redo'],
    ['Z', { ctrlKey: true, shiftKey: true }, {}, 'redo'],
    ['z', { metaKey: true, shiftKey: true }, {}, 'redo'],
    ['y', { ctrlKey: true }, {}, 'redo'],
    ['y', { metaKey: true }, {}, null],
    ['s', { ctrlKey: true }, {}, null],
    ['v', { altKey: true }, {}, null],
    ['Enter', {}, { drafting: true }, 'finish'],
    ['Enter', {}, {}, null],
    ['Escape', {}, { drafting: true }, 'cancel'],
    ['Escape', {}, { tool: 'ink' }, 'exitInk'],
    ['Escape', {}, {}, 'deselect'],
    ['Backspace', {}, { drafting: true }, 'draftUndo'],
    ['Backspace', {}, { hasSelection: true }, 'deleteSelected'],
    ['Backspace', {}, {}, null],
    ['Delete', {}, { hasSelection: true }, 'deleteSelected'],
    ['Delete', {}, { hasSelection: true, drafting: true }, null],
    ['s', {}, { canSplitHere: true }, 'splitHere'],
    ['s', {}, {}, null],
    ['S', {}, { canSplitHere: true }, 'splitHere'],
    ['j', {}, { canJoin: true }, 'joinSelected'],
    ['j', {}, {}, null],
    ['t', { targetTag: 'INPUT' }, {}, null],
    ['t', { targetTag: 'TEXTAREA' }, {}, null],
    ['t', { targetTag: 'SELECT' }, {}, null],
    ['t', { targetTag: 'DIV', targetEditable: true }, {}, null],
    ['Enter', { targetTag: 'BUTTON' }, { drafting: true }, null],
    [' ', { targetTag: 'BUTTON' }, {}, null],
    ['t', { targetTag: 'BUTTON' }, {}, { tool: 'trail' }],
    ['q', {}, {}, null],
    // T-215: keyboard vertex focus and navigation.
    ['Tab', {}, { canFocusVertices: true }, 'focusNextVertex'],
    ['Tab', { shiftKey: true }, { canFocusVertices: true }, 'focusPrevVertex'],
    ['Tab', {}, { canFocusVertices: false }, null],
    ['Tab', {}, { tool: 'trail', canFocusVertices: true }, null],
    ['Tab', { targetIsCanvas: false }, { canFocusVertices: true }, null],
    [',', {}, { canFocusVertices: true }, 'stepFocusPrevVertex'],
    ['.', {}, { canFocusVertices: true }, 'stepFocusNextVertex'],
    ['<', {}, { canFocusVertices: true }, 'stepFocusPrevVertex10'],
    ['>', {}, { canFocusVertices: true }, 'stepFocusNextVertex10'],
    ['[', {}, { canFocusVertices: true }, 'stepFocusPrevVertex10'],
    [']', {}, { canFocusVertices: true }, 'stepFocusNextVertex10'],
    [',', { targetIsCanvas: false }, { canFocusVertices: true }, null],
    ['ArrowUp', {}, { hasVertexFocus: true }, 'nudgeUp'],
    ['ArrowDown', {}, { hasVertexFocus: true }, 'nudgeDown'],
    ['ArrowLeft', {}, { hasVertexFocus: true }, 'nudgeLeft'],
    ['ArrowRight', {}, { hasVertexFocus: true }, 'nudgeRight'],
    ['ArrowUp', {}, {}, 'panUp'],
    ['ArrowDown', {}, {}, 'panDown'],
    ['ArrowLeft', {}, {}, 'panLeft'],
    ['ArrowRight', {}, {}, 'panRight'],
    ['ArrowUp', {}, { drafting: true }, 'panUp'],
    ['ArrowUp', { targetIsCanvas: false }, {}, null],
    ['Backspace', {}, { hasVertexFocus: true, hasSelection: true }, 'deleteFocusedVertex'],
    ['Delete', {}, { hasVertexFocus: true, hasSelection: true }, 'deleteFocusedVertex'],
    ['Escape', {}, { hasVertexFocus: true }, 'releaseVertexFocus'],
    ['Escape', {}, { drafting: true, hasVertexFocus: true }, 'cancel'],
    ['Enter', {}, { canPlaceAtCenter: true }, 'placeAtCenter'],
    ['Enter', {}, { canPlaceAtCenter: true, drafting: true }, 'finish'],
    ['Enter', {}, { drafting: true, keyboardMode: true }, 'placeAtCenter'],
    ['Enter', {}, { drafting: true, keyboardMode: false }, 'finish'],
    ['?', {}, {}, 'openHelp'],
  ] as const)('%j %j in %j -> %j', (name, mods, c, expected) => {
    expect(keyAction(k(name, mods), ctx(c))).toStrictEqual(expected);
  });

  it('does nothing without a map', () => {
    expect(keyAction(k('t'), ctx({ hasMap: false }))).toBeNull();
  });

  it('"?" opens help even without a map (T-215 review: it is app help, not a map tool)', () => {
    expect(keyAction(k('?'), ctx({ hasMap: false }))).toBe('openHelp');
  });
});

describe('tip line', () => {
  it('uses the prototype TIPS', () => {
    const t = (c: Partial<Parameters<typeof tipFor>[0]>) =>
      tipFor({ hasMap: true, tool: 'select', smartFollow: false, reviewing: false, ...c });
    expect(t({ hasMap: false })).toBe('');
    expect(t({})).toBe(TIPS.select);
    expect(TIPS.select).toBe(
      'Tap a point on the trail to select it (or press , / . to move between points). Then press S or pick Split here in the point’s menu. Right-click or long-press a point for its menu.',
    );
    expect(t({ reviewing: true })).toBe(TIPS.cands);
    expect(t({ tool: 'anchor' })).toBe(TIPS.anchor);
    expect(t({ tool: 'trail' })).toBe(TIPS.trail);
    expect(t({ tool: 'trail', smartFollow: true })).toBe(TIPS.trailSmart);
    expect(t({ tool: 'area', reviewing: true })).toBe(TIPS.area);
  });

  it('uses touch instructions for a coarse pointer without changing desktop text', () => {
    const t = (c: Partial<Parameters<typeof tipFor>[0]>) =>
      tipFor({ hasMap: true, tool: 'select', smartFollow: false, reviewing: false, ...c });
    expect(t({})).toBe(TIPS.select);
    expect(t({ coarsePointer: true })).toBe(
      'Select trail. Tap a point or use , / .; press S or Split here. Long-press for its menu.',
    );
    expect(t({ coarsePointer: true, reviewing: true })).not.toMatch(
      /right-click|shift-click|scroll to zoom/i,
    );
    expect(t({ coarsePointer: true, tool: 'trail', smartFollow: true })).toMatch(/^Tap /);
  });
});
