import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Feature, Project } from '../../core/types';
import { makeProject, makeSession } from '../../state/fixtures.test.helper';
import { appStore, openSession, selectFeature, setTool } from '../../state/store';
import type { LoadedMap } from '../contract';
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

function bitmap(): ImageBitmap {
  return { width: 256, height: 256, close: vi.fn() } as unknown as ImageBitmap;
}

function makeDetailMap(isDetailAvailable: () => boolean) {
  const session = makeSession();
  const sources = new Map<string, ImageBitmap>();
  let notify: (rect: { x: number; y: number; width: number; height: number }) => void = () => {};
  const unsubscribe = vi.fn();
  const getTileBitmap = vi.fn(async (level: number, col: number, row: number) => {
    if (level === -1 && !isDetailAvailable()) return null;
    const key = `${level}/${col}/${row}`;
    let source = sources.get(key);
    if (!source) {
      source = bitmap();
      sources.set(key, source);
    }
    return source;
  });
  const map: LoadedMap = {
    ...session.map,
    tiles: {
      levels: [
        { level: -1, width: 2000, height: 1600, cols: 8, rows: 7 },
        { level: 0, width: 1000, height: 800, cols: 4, rows: 4 },
      ],
      tileSize: 256,
      overviewScale: 0.1,
      getTileBitmap,
      readRegion: async ({ width, height }) => ({
        width,
        height,
        data: new Uint8ClampedArray(width * height * 4),
      }),
      subscribeDetailChanged: (listener) => {
        notify = listener;
        return unsubscribe;
      },
    },
  };
  return {
    map,
    session,
    sources,
    getTileBitmap,
    unsubscribe,
    notify: (rect: { x: number; y: number; width: number; height: number }) => notify(rect),
  };
}

function drawTiledMap(ed: Editor, map: LoadedMap, ctx: CanvasRenderingContext2D): void {
  (
    ed as unknown as { drawTiledMap(ctx: CanvasRenderingContext2D, map: LoadedMap): void }
  ).drawTiledMap(ctx, map);
}

function tiledRequests(ed: Editor) {
  return ed as unknown as {
    tiledTiles: { get(key: string): ImageBitmap | undefined };
    missingTiles: Set<string>;
    pendingTiles: Map<string, unknown>;
  };
}

function tileContext() {
  return {
    save: vi.fn(),
    restore: vi.fn(),
    drawImage: vi.fn(),
  } as unknown as CanvasRenderingContext2D & { drawImage: ReturnType<typeof vi.fn> };
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

  it('reports center and zoom for the detail focus controller', () => {
    const viewChanges = vi.fn();
    ed.on('view', viewChanges);
    expect(ed.detailFocus.center).toEqual(ed.centerPointerAt().px);
    expect(ed.detailFocus.scale).toBe(ed.view.s);

    ed.zoomBy(2);
    expect(viewChanges).toHaveBeenCalledOnce();
    expect(ed.detailFocus.center).toEqual(ed.centerPointerAt().px);
    expect(ed.detailFocus.scale).toBe(ed.view.s);
  });

  it('passes a projected local location overlay to the renderer and clears it on map change', () => {
    const overlay = {
      center: [400, 300] as const,
      accuracyBoundary: [
        [390, 300],
        [400, 290],
        [410, 300],
        [400, 310],
      ] as const,
    };
    ed.setLocationOverlay(overlay);
    const editorModel = (ed as unknown as { model(): { locationOverlay: unknown } }).model();
    expect(editorModel.locationOverlay).toBe(overlay);

    open(makeProject({ image: { ...makeProject().image, width: 900, height: 700 } }));
    expect(
      (ed as unknown as { model(): { locationOverlay: unknown } }).model().locationOverlay,
    ).toBe(null);
  });

  it('falls back to the overview and clears pending state if a shared tile closes before cloning', async () => {
    const session = makeSession();
    const sharedBitmap = {} as ImageBitmap;
    const getTileBitmap = vi.fn(async () => sharedBitmap);
    const map: LoadedMap = {
      ...session.map,
      tiles: {
        levels: [{ level: 0, width: 1000, height: 800, cols: 1, rows: 1 }],
        tileSize: 1000,
        overviewScale: 0.1,
        getTileBitmap,
        readRegion: async ({ width, height }) => ({
          width,
          height,
          data: new Uint8ClampedArray(width * height * 4),
        }),
      },
    };
    openSession({ ...session, map });
    const cloneBitmap = vi
      .fn()
      .mockRejectedValue(new DOMException('The shared bitmap is closed', 'InvalidStateError'));
    vi.stubGlobal('createImageBitmap', cloneBitmap);

    try {
      const drawTiledMap = (
        ed as unknown as {
          drawTiledMap(ctx: CanvasRenderingContext2D, map: LoadedMap): void;
        }
      ).drawTiledMap.bind(ed);
      drawTiledMap({} as CanvasRenderingContext2D, map);

      await vi.waitFor(() => expect(cloneBitmap).toHaveBeenCalledOnce());
      const requests = ed as unknown as {
        pendingTiles: Map<string, LoadedMap>;
        missingTiles: Set<string>;
      };
      await vi.waitFor(() => expect(requests.pendingTiles.has('0/0/0')).toBe(false));
      expect(requests.missingTiles.has('0/0/0')).toBe(true);

      // Missing marks this tile as using the overview fallback and avoids an immediate retry loop.
      drawTiledMap({} as CanvasRenderingContext2D, map);
      expect(getTileBitmap).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('reloads a missing detail tile when stored detail changes', async () => {
    let detailAvailable = false;
    const detail = makeDetailMap(() => detailAvailable);
    openSession({ ...detail.session, map: detail.map });
    vi.stubGlobal('createImageBitmap', async (source: ImageBitmap) => source);
    const ctx = tileContext();
    ed.zoomBy(16);
    const key = '-1/3/3';

    try {
      drawTiledMap(ed, detail.map, ctx);
      await vi.waitFor(() => expect(tiledRequests(ed).missingTiles.has(key)).toBe(true));

      detailAvailable = true;
      detail.notify({ x: 384, y: 384, width: 128, height: 128 });
      expect(tiledRequests(ed).missingTiles.has(key)).toBe(false);
      drawTiledMap(ed, detail.map, ctx);
      await vi.waitFor(() => expect(tiledRequests(ed).tiledTiles.get(key)).toBeDefined());

      drawTiledMap(ed, detail.map, ctx);
      expect(ctx.drawImage.mock.calls.some(([source]) => source === detail.sources.get(key))).toBe(
        true,
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('does not let a retired detail lookup overwrite its replacement result', async () => {
    const detail = makeDetailMap(() => true);
    const pendingTarget: Array<(result: ImageBitmap | null) => void> = [];
    const originalGetTileBitmap = detail.getTileBitmap;
    const getTileBitmap = vi.fn((level: number, col: number, row: number) => {
      if (level === -1 && col === 3 && row === 3) {
        return new Promise<ImageBitmap | null>((resolve) => pendingTarget.push(resolve));
      }
      if (level === -1) return Promise.resolve(null);
      return originalGetTileBitmap(level, col, row);
    });
    const map: LoadedMap = {
      ...detail.map,
      tiles: { ...detail.map.tiles!, getTileBitmap },
    };
    openSession({ ...detail.session, map });
    vi.stubGlobal('createImageBitmap', async (source: ImageBitmap) => source);
    const ctx = tileContext();
    ed.zoomBy(16);
    const key = '-1/3/3';

    try {
      drawTiledMap(ed, map, ctx);
      expect(pendingTarget).toHaveLength(1);

      detail.notify({ x: 384, y: 384, width: 128, height: 128 });
      drawTiledMap(ed, map, ctx);
      expect(pendingTarget).toHaveLength(2);
      const replacement = bitmap();
      pendingTarget[1]!(replacement);
      await vi.waitFor(() => expect(tiledRequests(ed).tiledTiles.get(key)).toBe(replacement));

      pendingTarget[0]!(null);
      await Promise.resolve();
      await Promise.resolve();
      await vi.waitFor(() => expect(tiledRequests(ed).pendingTiles.has(key)).toBe(false));
      expect(tiledRequests(ed).missingTiles.has(key)).toBe(false);
      expect(tiledRequests(ed).tiledTiles.get(key)).toBe(replacement);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('drops deleted detail and draws the cached level-0 fallback', async () => {
    let detailAvailable = true;
    const detail = makeDetailMap(() => detailAvailable);
    openSession({ ...detail.session, map: detail.map });
    vi.stubGlobal('createImageBitmap', async (source: ImageBitmap) => source);
    const ctx = tileContext();
    ed.zoomBy(16);
    const detailKey = '-1/3/3';
    const overviewKey = '0/1/1';

    try {
      drawTiledMap(ed, detail.map, ctx);
      await vi.waitFor(() => expect(tiledRequests(ed).tiledTiles.get(detailKey)).toBeDefined());
      await vi.waitFor(() => expect(tiledRequests(ed).tiledTiles.get(overviewKey)).toBeDefined());

      detailAvailable = false;
      detail.notify({ x: 384, y: 384, width: 128, height: 128 });
      expect(tiledRequests(ed).tiledTiles.get(detailKey)).toBeUndefined();
      drawTiledMap(ed, detail.map, ctx);
      await vi.waitFor(() => expect(tiledRequests(ed).missingTiles.has(detailKey)).toBe(true));

      ctx.drawImage.mockClear();
      drawTiledMap(ed, detail.map, ctx);
      expect(
        ctx.drawImage.mock.calls.some(([source]) => source === detail.sources.get(overviewKey)),
      ).toBe(true);
      expect(detail.getTileBitmap).toHaveBeenCalledWith(0, 1, 1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('unsubscribes detail changes on map replacement and editor destruction', () => {
    const first = makeDetailMap(() => false);
    openSession({ ...first.session, map: first.map });
    expect(first.unsubscribe).not.toHaveBeenCalled();
    expect(first.map.tiles?.subscribeDetailChanged).toBeDefined();

    const withoutTiles = makeSession();
    openSession(withoutTiles);
    expect(first.unsubscribe).toHaveBeenCalledOnce();

    const second = makeDetailMap(() => false);
    openSession({ ...second.session, map: second.map });
    ed.destroy();
    expect(second.unsubscribe).toHaveBeenCalledOnce();
    ed = new Editor();
    ed.mount(canvas);
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
