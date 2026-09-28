import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Feature, Project } from '../../core/types';
import { makeProject, makeSession } from '../../state/fixtures.test.helper';
import { appStore, openSession, selectFeature, setTool } from '../../state/store';
import { Editor, type EditorEvents } from './Editor';
import { toImg, toScr } from './view';

// Canvas at client (10, 20), 500 x 400 CSS px. Image 1000 x 800 -> fit scale 0.47.
const RECT = { left: 10, top: 20, width: 500, height: 400 };

function makeCanvas(): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.getBoundingClientRect = () =>
    ({
      ...RECT,
      x: RECT.left,
      y: RECT.top,
      right: 510,
      bottom: 420,
      toJSON: () => ({}),
    }) as DOMRect;
  // jsdom has no 2D context; the editor must cope (it skips drawing).
  c.getContext = (() => null) as HTMLCanvasElement['getContext'];
  document.body.appendChild(c);
  return c;
}

/** Dispatch a pointer event at canvas-local CSS coordinates. */
function ptr(
  c: HTMLCanvasElement,
  type: string,
  x: number,
  y: number,
  init: { button?: number; id?: number } = {},
) {
  const e = new MouseEvent(type, {
    clientX: RECT.left + x,
    clientY: RECT.top + y,
    button: init.button ?? 0,
    bubbles: true,
    cancelable: true,
  });
  Object.defineProperty(e, 'pointerId', { value: init.id ?? 1 });
  c.dispatchEvent(e);
  return e;
}

function record(ed: Editor) {
  const log: { type: keyof EditorEvents; e: unknown }[] = [];
  for (const type of ['click', 'dragStart', 'drag', 'dragEnd', 'contextmenu'] as const) {
    ed.on(type, (e) => log.push({ type, e }));
  }
  return log;
}

const trail: Feature = {
  kind: 'trail',
  id: 'f1',
  name: 'T',
  color: '#D9480F',
  notes: '',
  pts: [
    [100, 100],
    [500, 100],
  ],
  ink: null,
};

let canvas: HTMLCanvasElement;
let ed: Editor;

function open(project: Project = makeProject()) {
  openSession(makeSession(project));
}

beforeEach(() => {
  setTool('select');
  open(
    makeProject({
      anchors: [{ id: 'g1', px: [500, 400], ll: null, source: 'paste' }],
      features: [trail],
    }),
  );
  canvas = makeCanvas();
  ed = new Editor();
  ed.mount(canvas);
});

afterEach(() => {
  ed.destroy();
  canvas.remove();
});

describe('Editor', () => {
  it('fits the map with the prototype margin on mount', () => {
    expect(ed.size).toStrictEqual({ width: 500, height: 400 });
    expect(ed.view.s).toBeCloseTo(0.47, 12);
    // Image centre at canvas centre.
    const [cx, cy] = toScr(ed.view, [500, 400]);
    expect([cx, cy].map((v) => +v.toFixed(9))).toStrictEqual([250, 200]);
  });

  it('reports a click (within the 4 px threshold) with image px and no target', () => {
    const log = record(ed);
    ptr(canvas, 'pointerdown', 100, 100);
    ptr(canvas, 'pointermove', 103, 102); // 3.6 px: still a click
    ptr(canvas, 'pointerup', 103, 102);
    expect(log.map((l) => l.type)).toStrictEqual(['click']);
    const e = log[0]!.e as EditorEvents['click'];
    expect(e.target).toBeNull();
    expect(e.inside).toBe(true);
    const px = toImg(ed.view, [100, 100]);
    expect(e.px).toStrictEqual(px);
    // imageToClient is the inverse, in client coordinates.
    const back = ed.imageToClient(e.px);
    expect(back.x).toBeCloseTo(RECT.left + 100, 9);
    expect(back.y).toBeCloseTo(RECT.top + 100, 9);
  });

  it('pans on a drag with no target, and does not click', () => {
    const log = record(ed);
    const before = ed.view;
    ptr(canvas, 'pointerdown', 100, 100);
    ptr(canvas, 'pointermove', 110, 100);
    ptr(canvas, 'pointermove', 130, 115);
    ptr(canvas, 'pointerup', 130, 115);
    expect(log).toStrictEqual([]);
    // The first move crosses the threshold and pans from the press point.
    expect(ed.view.x - before.x).toBeCloseTo(30, 9);
    expect(ed.view.y - before.y).toBeCloseTo(15, 9);
    expect(ed.view.s).toBe(before.s);
  });

  it('drags an anchor pin (select tool) with clamped image px, then no click', () => {
    const log = record(ed);
    const [tx, ty] = toScr(ed.view, [500, 400]);
    ptr(canvas, 'pointerdown', tx, ty);
    ptr(canvas, 'pointermove', tx + 10, ty);
    ptr(canvas, 'pointermove', 5000, ty); // far off the image: clamped to width - 1
    ptr(canvas, 'pointerup', 5000, ty);
    // The move that crosses the threshold starts the drag and applies itself (prototype).
    expect(log.map((l) => l.type)).toStrictEqual(['dragStart', 'drag', 'drag', 'dragEnd']);
    const start = log[0]!.e as EditorEvents['dragStart'];
    expect(start.target).toStrictEqual({ kind: 'anchor', id: 'g1' });
    const end = log[3]!.e as EditorEvents['dragEnd'];
    expect(end.px[0]).toBe(999);
    expect(end.cancelled).toBe(false);
  });

  it('clicking a pin reports it as the target', () => {
    const log = record(ed);
    const [tx, ty] = toScr(ed.view, [500, 400]);
    ptr(canvas, 'pointerdown', tx, ty - 18); // pin head
    ptr(canvas, 'pointerup', tx, ty - 18);
    expect((log[0]!.e as EditorEvents['click']).target).toStrictEqual({ kind: 'anchor', id: 'g1' });
  });

  it('offers vertices of the selected feature only, in the select tool only', () => {
    const [vx, vy] = toScr(ed.view, [500, 100]);
    const log = record(ed);
    // Not selected: no target, so the drag pans.
    ptr(canvas, 'pointerdown', vx, vy);
    ptr(canvas, 'pointermove', vx + 8, vy);
    ptr(canvas, 'pointerup', vx + 8, vy);
    expect(log).toStrictEqual([]);

    selectFeature('f1');
    const [wx, wy] = toScr(ed.view, [500, 100]);
    ptr(canvas, 'pointerdown', wx, wy);
    ptr(canvas, 'pointermove', wx + 8, wy);
    ptr(canvas, 'pointerup', wx + 8, wy);
    expect((log[0]!.e as EditorEvents['dragStart']).target).toStrictEqual({
      kind: 'vertex',
      featureId: 'f1',
      index: 1,
    });

    // Trail tool: neither anchors nor vertices are targets.
    setTool('trail');
    log.length = 0;
    const [tx, ty] = toScr(ed.view, [500, 400]);
    ptr(canvas, 'pointerdown', tx, ty);
    ptr(canvas, 'pointerup', tx, ty);
    expect((log[0]!.e as EditorEvents['click']).target).toBeNull();
  });

  it('pans with the middle button, right-drag outside select, and Space+drag, even over a target', () => {
    const log = record(ed);
    // Press on the pin's tip each time (it moves on screen as the view pans).
    const drag = (button: number) => {
      const [tx, ty] = toScr(ed.view, [500, 400]);
      const x0 = ed.view.x;
      ptr(canvas, 'pointerdown', tx, ty, { button });
      ptr(canvas, 'pointermove', tx + 20, ty);
      ptr(canvas, 'pointerup', tx + 20, ty, { button });
      return ed.view.x - x0;
    };
    expect(drag(1)).toBeCloseTo(20, 9);
    setTool('anchor');
    expect(drag(2)).toBeCloseTo(20, 9);
    setTool('select');
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space' }));
    expect(drag(0)).toBeCloseTo(20, 9);
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'Space' }));
    expect(log).toStrictEqual([]);
    // Space typed into a field does not arm panning: the press drags the pin instead.
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', bubbles: true }));
    expect(drag(0)).toBe(0);
    expect(log.map((l) => l.type)).toStrictEqual(['dragStart', 'drag', 'dragEnd']);
    input.remove();
  });

  it('wheel-zooms around the cursor (deltaMode aware)', () => {
    const at = [123, 234] as const;
    const before = toImg(ed.view, at);
    const s0 = ed.view.s;
    canvas.dispatchEvent(
      new WheelEvent('wheel', {
        clientX: RECT.left + at[0],
        clientY: RECT.top + at[1],
        deltaY: -100,
        cancelable: true,
      }),
    );
    expect(ed.view.s).toBeCloseTo(s0 * Math.exp(0.16), 9);
    const after = toImg(ed.view, at);
    expect(after[0]).toBeCloseTo(before[0], 9);
    expect(after[1]).toBeCloseTo(before[1], 9);
    const s1 = ed.view.s;
    canvas.dispatchEvent(
      new WheelEvent('wheel', {
        clientX: 20,
        clientY: 30,
        deltaY: 3,
        deltaMode: 1,
        cancelable: true,
      }),
    );
    expect(ed.view.s).toBeCloseTo(s1 * Math.exp(-0.15), 9);
  });

  it('pinch-zooms with two pointers and emits no click', () => {
    const log = record(ed);
    const s0 = ed.view.s;
    ptr(canvas, 'pointerdown', 200, 200, { id: 1 });
    ptr(canvas, 'pointerdown', 300, 200, { id: 2 });
    ptr(canvas, 'pointermove', 350, 200, { id: 2 }); // distance 100 -> 150
    expect(ed.view.s).toBeCloseTo(s0 * 1.5, 9);
    ptr(canvas, 'pointerup', 350, 200, { id: 2 });
    ptr(canvas, 'pointerup', 200, 200, { id: 1 });
    expect(log).toStrictEqual([]);
  });

  it('reports right-clicks as contextmenu and prevents the browser menu', () => {
    const log = record(ed);
    const e = ptr(canvas, 'contextmenu', 50, 60, { button: 2 });
    expect(e.defaultPrevented).toBe(true);
    expect(log.map((l) => l.type)).toStrictEqual(['contextmenu']);
  });

  it('refits when a new map opens, and stops reporting after destroy', () => {
    ed.zoomBy(3);
    open(makeProject({ image: { ...makeProject().image, width: 2000, height: 400 } }));
    expect(ed.view.s).toBeCloseTo(Math.min(500 / 2000, 400 / 400) * 0.94, 12);
    const log = record(ed);
    ed.destroy();
    ptr(canvas, 'pointerdown', 100, 100);
    ptr(canvas, 'pointerup', 100, 100);
    expect(log).toStrictEqual([]);
    expect(() => ed.imageToClient([0, 0])).toThrow('not mounted');
    // Re-create for afterEach.
    ed = new Editor();
    ed.mount(canvas);
  });

  it('ignores input before a map is open', () => {
    appStore.setState({ session: null });
    const log = record(ed);
    ptr(canvas, 'pointerdown', 100, 100);
    ptr(canvas, 'pointerup', 100, 100);
    expect(log).toStrictEqual([]);
  });
});
