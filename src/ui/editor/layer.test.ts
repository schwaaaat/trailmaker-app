import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Feature, Px } from '../../core/types';
import * as C from '../../state/commands';
import { makeProject, makeSession } from '../../state/fixtures.test.helper';
import { appStore, edit, openSession, selectFeature, undo } from '../../state/store';
import { Editor } from './Editor';
import {
  LAYER_MARGIN_PX,
  LineLayer,
  STROKE_PAD_PX,
  SYNC_PAINT_MAX_VERTS,
  covers,
  diffContent,
  paintCost,
  type LayerContent,
} from './layer';
import { Slicer } from './slice';
import { manualTasks } from './slice.test.helper';
import type { View } from './view';

const trail = (id: string, pts: Px[]): Feature => ({
  kind: 'trail',
  id,
  name: id,
  color: '#D9480F',
  notes: '',
  pts,
  ink: null,
});
const poi = (id: string, at: Px): Feature => ({
  kind: 'poi',
  id,
  name: id,
  color: '#1F6FB2',
  notes: '',
  at,
  poiType: 'Water',
});

const A = trail('a', [
  [0, 0],
  [10, 10],
]);
const B = trail('b', [
  [100, 100],
  [120, 130],
]);
const P = poi('p', [50, 50]);
const base: LayerContent = { features: [A, B, P], editId: null };

describe('diffContent', () => {
  it('is full the first time and none for identical content', () => {
    expect(diffContent(null, base)).toStrictEqual({ kind: 'full' });
    expect(diffContent(base, base)).toStrictEqual({ kind: 'none' });
    expect(diffContent(base, { ...base, features: [...base.features] })).toStrictEqual({
      kind: 'none',
    });
  });

  it('dirties the union of old and new bounds of a replaced feature only', () => {
    const moved = trail('b', [
      [100, 100],
      [150, 90],
    ]);
    expect(diffContent(base, { ...base, features: [A, moved, P] })).toStrictEqual({
      kind: 'dirty',
      box: [100, 90, 150, 130],
    });
  });

  it('dirties added and removed lines, and a feature hidden or shown by a draft', () => {
    const C1 = trail('c', [
      [200, 200],
      [210, 220],
    ]);
    expect(diffContent(base, { ...base, features: [A, B, P, C1] })).toStrictEqual({
      kind: 'dirty',
      box: [200, 200, 210, 220],
    });
    expect(diffContent(base, { ...base, features: [B, P] })).toStrictEqual({
      kind: 'dirty',
      box: [0, 0, 10, 10],
    });
    expect(diffContent(base, { ...base, editId: 'a' })).toStrictEqual({
      kind: 'dirty',
      box: [0, 0, 10, 10],
    });
    expect(diffContent({ ...base, editId: 'a' }, base)).toStrictEqual({
      kind: 'dirty',
      box: [0, 0, 10, 10],
    });
  });

  it('ignores POIs, which are not in the layer', () => {
    expect(diffContent(base, { ...base, features: [A, B, poi('p', [60, 60])] })).toStrictEqual({
      kind: 'none',
    });
    expect(diffContent(base, { ...base, features: [A, B] })).toStrictEqual({ kind: 'none' });
  });
});

describe('covers', () => {
  const at = { s: 2, x: 100, y: 50 };

  it('accepts pans within the margin and rejects pans past it', () => {
    expect(covers(at, at, 800, 600, 256)).toBe(true);
    expect(covers(at, { ...at, x: at.x + 256 }, 800, 600, 256)).toBe(true);
    expect(covers(at, { ...at, x: at.x + 257 }, 800, 600, 256)).toBe(false);
    expect(covers(at, { ...at, y: at.y - 257 }, 800, 600, 256)).toBe(false);
  });

  it('accounts for zoom: zooming in stays covered, zooming far out does not', () => {
    const zin = { s: 4, x: 400 - (400 - at.x) * 2, y: 300 - (300 - at.y) * 2 };
    expect(covers(at, zin, 800, 600, 256)).toBe(true);
    const zout = { s: 0.5, x: 400 - (400 - at.x) / 4, y: 300 - (300 - at.y) / 4 };
    expect(covers(at, zout, 800, 600, 256)).toBe(false);
  });
});

/* ------------------------------------------------ LineLayer with a recording 2D context */

interface Rec {
  clears: number[][];
  /** Feature paths stroked, by the id recorded on each Path2D. */
  strokes: string[];
}
let rec: Rec;

class FakePath {
  id = '';
  moveTo(x: number, y: number) {
    this.id ||= `${x},${y}`;
  }
  lineTo() {}
  closePath() {}
}

function fakeCtx(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const known: Record<string, unknown> = {
    canvas,
    measureText: () => ({ width: 0 }),
    clearRect: (...r: number[]) => rec.clears.push(r),
    // Only Path2D strokes are layer strokes; live (screen-space) strokes take no argument.
    stroke: (p?: FakePath) => {
      if (p) rec.strokes.push(p.id);
    },
  };
  // Everything else (transforms, paths, style setters) is a no-op.
  return new Proxy(known, {
    get: (t, k: string) => (k in t ? t[k] : () => {}),
    set: () => true,
  }) as unknown as CanvasRenderingContext2D;
}

beforeEach(() => {
  rec = { clears: [], strokes: [] };
  vi.stubGlobal('Path2D', FakePath);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (
    this: HTMLCanvasElement,
  ) {
    return fakeCtx(this) as never;
  } as never);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('LineLayer', () => {
  const V: View = { s: 1, x: 0, y: 0 };
  const target = () => fakeCtx(document.createElement('canvas'));
  // Two far-apart trails; strokes are recorded by their first point.
  const far = trail('far', [
    [700, 500],
    [720, 520],
  ]);

  it('paints everything once, then repaints only a dirty rect with the features inside it', () => {
    const layer = new LineLayer();
    layer.draw(target(), V, 1, 800, 600, { features: [A, far], editId: null }, true);
    expect(layer.stats).toStrictEqual({ full: 1, dirty: 0, sliced: 0 });
    // Casing + color per line.
    expect(rec.strokes).toStrictEqual(['0,0', '0,0', '700,500', '700,500']);

    rec = { clears: [], strokes: [] };
    const moved = trail('a', [
      [0, 0],
      [30, 20],
    ]);
    layer.draw(target(), V, 1, 800, 600, { features: [moved, far], editId: null }, true);
    expect(layer.stats).toStrictEqual({ full: 1, dirty: 1, sliced: 0 });
    // Only the edited trail is redrawn; the far one does not reach the rect.
    expect(rec.strokes).toStrictEqual(['0,0', '0,0']);
    const m = LAYER_MARGIN_PX;
    const p = STROKE_PAD_PX;
    expect(rec.clears).toStrictEqual([[m - p, m - p, 30 + 2 * p, 20 + 2 * p]]);

    // Same content again: nothing repainted.
    rec = { clears: [], strokes: [] };
    layer.draw(target(), V, 1, 800, 600, { features: [moved, far], editId: null }, true);
    expect(rec.strokes).toStrictEqual([]);
    expect(layer.stats).toStrictEqual({ full: 1, dirty: 1, sliced: 0 });
  });

  it('repaints fully on resize and after a settled zoom, but only blits mid-zoom and for small pans', () => {
    const layer = new LineLayer();
    const content = { features: [A], editId: null };
    layer.draw(target(), V, 1, 800, 600, content, true);
    layer.draw(target(), { ...V, x: 100 }, 1, 800, 600, content, true);
    layer.draw(target(), { s: 2, x: 0, y: 0 }, 1, 800, 600, content, false);
    expect(layer.stats.full).toBe(1);
    expect(layer.isScaled({ s: 2, x: 0, y: 0 })).toBe(true);
    layer.draw(target(), { s: 2, x: 0, y: 0 }, 1, 800, 600, content, true);
    expect(layer.stats.full).toBe(2);
    layer.draw(target(), { s: 2, x: 0, y: 0 }, 1, 801, 600, content, true);
    expect(layer.stats.full).toBe(3);
  });

  it('defers a margin-exceeding pan rebuild until panSettled, unlike zoom which gates on its own arg (T-216)', () => {
    const layer = new LineLayer();
    const content = { features: [A], editId: null };
    layer.draw(target(), V, 1, 800, 600, content, true);
    expect(layer.stats.full).toBe(1);
    const farPan: View = { ...V, x: 500 }; // exceeds LAYER_MARGIN_PX (256)
    // Mid-drag (panSettled=false, the default when omitted): still uncovered, but no rebuild yet.
    layer.draw(target(), farPan, 1, 800, 600, content, true, false);
    expect(layer.stats.full).toBe(1);
    expect(layer.isPanned(farPan, 800, 600)).toBe(true);
    // A repeated mid-drag frame at a different offset (simulating continuous dragging) still
    // doesn't rebuild -- this is the thrash this card's fix avoids.
    layer.draw(target(), { ...farPan, x: 550 }, 1, 800, 600, content, true, false);
    expect(layer.stats.full).toBe(1);
    // Once the drag settles, the next frame rebuilds.
    layer.draw(target(), { ...farPan, x: 550 }, 1, 800, 600, content, true, true);
    expect(layer.stats.full).toBe(2);
    expect(layer.isPanned({ ...farPan, x: 550 }, 800, 600)).toBe(false);
  });
});

describe('LineLayer sliced rebuilds (T-211)', () => {
  const V: View = { s: 1, x: 0, y: 0 };
  const target = () => fakeCtx(document.createElement('canvas'));
  /** Enough 50-vertex trails that a full paint is over the sync budget. */
  const N = Math.ceil(SYNC_PAINT_MAX_VERTS / 50) + 20;
  const many = (tag: string): Feature[] =>
    Array.from({ length: N }, (_, i) =>
      trail(
        `${tag}${i}`,
        Array.from({ length: 50 }, (_, k): Px => [i + k / 100, (i % 100) + k / 100]),
      ),
    );
  const setup = () => {
    const tasks = manualTasks();
    // Each clock read advances 1 ms, so a slice stops after its 8th check.
    const now = () => tasks.advance(1);
    const layer = new LineLayer(new Slicer(tasks.post, now));
    let ready = 0;
    layer.onReady = () => ready++;
    return { tasks, layer, ready: () => ready };
  };
  const drawn = (id: string) => rec.strokes.filter((s) => s === id).length;

  it('counts the vertices a paint touches', () => {
    const c = { features: [A, B, P], editId: null };
    expect(paintCost(c, null)).toBe(4);
    expect(paintCost(c, [0, 0, 20, 20])).toBe(2);
    expect(paintCost({ ...c, editId: 'a' }, null)).toBe(2);
  });

  it('slices a large first paint and shows nothing of it until it is complete', () => {
    const { tasks, layer, ready } = setup();
    const content = { features: many('f'), editId: null };
    layer.draw(target(), V, 1, 800, 600, content, true);
    expect(layer.building).toBe(true);
    expect(layer.renderedAt).toBeNull();
    expect(rec.strokes).toStrictEqual([]);
    tasks.runOne();
    // One slice painted some features, not all of them.
    expect(rec.strokes.length).toBeGreaterThan(0);
    expect(rec.strokes.length).toBeLessThan(2 * N);
    const slices = 1 + tasks.runAll();
    expect(slices).toBeGreaterThan(2);
    expect(rec.strokes.length).toBe(2 * N);
    expect(layer.building).toBe(false);
    expect(layer.renderedAt).toStrictEqual(V);
    expect(ready()).toBe(1);
    expect(layer.stats).toStrictEqual({ full: 1, dirty: 0, sliced: 1 });
  });

  it('keeps blitting the stale raster during a zoom-settle rebuild, then swaps', () => {
    const { tasks, layer } = setup();
    const content = { features: many('f'), editId: null };
    layer.draw(target(), V, 1, 800, 600, content, true);
    tasks.runAll();
    const zoomed: View = { s: 2, x: -400, y: -300 };
    layer.draw(target(), zoomed, 1, 800, 600, content, true);
    expect(layer.building).toBe(true);
    expect(layer.renderedAt).toStrictEqual(V);
    // Further frames during the build don't restart it.
    tasks.runOne();
    layer.draw(target(), zoomed, 1, 800, 600, content, true);
    expect(layer.building).toBe(true);
    tasks.runAll();
    expect(layer.renderedAt).toStrictEqual(zoomed);
    expect(layer.stats.sliced).toBe(2);
  });

  it('patches the stale raster for an edit during a build, and the new raster at swap', () => {
    const { tasks, layer } = setup();
    const features = many('f');
    layer.draw(target(), V, 1, 800, 600, { features, editId: null }, true);
    tasks.runAll();
    layer.draw(target(), { s: 2, x: 0, y: 0 }, 1, 800, 600, { features, editId: null }, true);
    tasks.runOne();
    rec = { clears: [], strokes: [] };
    const moved = trail('f3', [
      [3.2, 3.3],
      [10, 10],
    ]);
    const edited = features.map((f) => (f.id === 'f3' ? moved : f));
    layer.draw(
      target(),
      { s: 2, x: 0, y: 0 },
      1,
      800,
      600,
      { features: edited, editId: null },
      true,
    );
    // The stale raster got a dirty repaint including the moved trail.
    expect(layer.stats.dirty).toBe(1);
    expect(drawn('3.2,3.3')).toBe(2);
    rec = { clears: [], strokes: [] };
    tasks.runAll();
    // The build painted from its snapshot (old f3), then the swap patched in the moved one.
    expect(layer.stats.dirty).toBe(2);
    expect(drawn('3.2,3.3')).toBe(2);
  });

  it('turns a dirty rect touching many vertices into a sliced rebuild', () => {
    const { tasks, layer } = setup();
    layer.draw(target(), V, 1, 800, 600, { features: many('f'), editId: null }, true);
    tasks.runAll();
    // Every feature replaced at once (e.g. an undo of a big accept).
    layer.draw(target(), V, 1, 800, 600, { features: many('g'), editId: null }, true);
    expect(layer.stats.dirty).toBe(0);
    expect(layer.building).toBe(true);
    tasks.runAll();
    expect(layer.stats).toStrictEqual({ full: 2, dirty: 0, sliced: 2 });
  });

  it('reset cancels a build and forgets the raster', () => {
    const { tasks, layer, ready } = setup();
    layer.draw(target(), V, 1, 800, 600, { features: many('f'), editId: null }, true);
    tasks.runOne();
    layer.reset();
    expect(layer.building).toBe(false);
    expect(tasks.runAll()).toBe(0);
    expect(layer.renderedAt).toBeNull();
    expect(ready()).toBe(0);
  });

  it('restarts a build when the canvas size changes mid-build', () => {
    const { tasks, layer } = setup();
    const content = { features: many('f'), editId: null };
    layer.draw(target(), V, 1, 800, 600, content, true);
    tasks.runOne();
    layer.draw(target(), V, 1, 900, 600, content, true);
    tasks.runAll();
    expect(layer.stats.sliced).toBe(1);
    // A second draw at the new size is a plain blit.
    layer.draw(target(), V, 1, 900, 600, content, true);
    expect(layer.building).toBe(false);
  });
});

describe('Editor + LineLayer (D-012)', () => {
  let canvas: HTMLCanvasElement;
  let ed: Editor;

  beforeEach(() => {
    const features = Array.from({ length: 20 }, (_, i) =>
      trail(`f${i}`, [
        [i * 40, 10],
        [i * 40 + 20, 30],
      ]),
    );
    openSession(makeSession(makeProject({ features, seq: 100 })));
    canvas = document.createElement('canvas');
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 500, height: 400 }) as DOMRect;
    document.body.appendChild(canvas);
    ed = new Editor();
    ed.mount(canvas);
    ed.renderNow();
  });
  afterEach(() => {
    ed.destroy();
    canvas.remove();
  });

  it('never repaints the layer for a selection change', () => {
    const before = { ...ed.lines.stats };
    selectFeature('f3');
    ed.renderNow();
    selectFeature('f7');
    ed.renderNow();
    selectFeature(null);
    ed.renderNow();
    expect(ed.lines.stats).toStrictEqual(before);
  });

  it('repaints a dirty rect (not everything) for an edit and for its undo', () => {
    const full = ed.lines.stats.full;
    const p = appStore.getState().session!.project;
    edit(C.moveVertex(p, 'f5', 1, [230, 60]));
    rec = { clears: [], strokes: [] };
    ed.renderNow();
    expect(ed.lines.stats.full).toBe(full);
    expect(ed.lines.stats.dirty).toBe(1);
    // Only f5 and its neighbours within the stroke pad are redrawn, not all 20.
    const redrawn = new Set(rec.strokes);
    expect(redrawn.has('200,10')).toBe(true);
    expect(redrawn.size).toBeLessThanOrEqual(3);

    undo();
    ed.renderNow();
    expect(ed.lines.stats).toStrictEqual({ full, dirty: 2, sliced: 0 });
  });
});
