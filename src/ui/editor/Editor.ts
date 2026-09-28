// Lane B. The canvas editor (card T-203): owns the view transform, pointer/pinch/wheel input,
// hit-testing and rendering. Plain TypeScript; React only mounts it (EditorStage.tsx).
// It never edits the project: it reports clicks and drags as typed events, and the tools
// (T-204) turn those into store commands. Port of the prototype's view/drawing/pointer code.
import type { AnchorId, FeatureId, Px, Rgb } from '../../core/types';
import { anchorOutlier } from '../../state/outliers';
import { appStore, selectFit, type AppState, type Draft, type Tool } from '../../state/store';
import { hitAnchor, hitHandle } from './hit';
import { LineLayer } from './layer';
import { renderFrame, type RenderModel } from './render';
import { centerOn, fitView, panBy, toImg, toScr, zoomAt, type Screen, type View } from './view';

/** Zoom idle time (ms) before the line layer is re-rasterized at the new scale. */
export const ZOOM_SETTLE_MS = 150;

/**
 * Pan idle time (ms) before a drag that crossed the layer's margin triggers a full rebuild
 * (T-216): rebuilding on every frame of a fast/long drag measured well over the 50 ms budget on
 * a real GPU, because each frame's rebuild superseded the last before it could finish.
 */
export const PAN_SETTLE_MS = 150;

/** Movement (CSS px) that turns a press into a drag (prototype). */
export const DRAG_THRESHOLD_PX = 4;

/**
 * Smart follow hooks for trail/area drafting (T-206). All positions are working-raster pixels;
 * `view` is the view when the user clicked (zoom-dependent radii use it).
 */
export interface HopProvider {
  /** First click: where the draft really starts (snapped) and the ink it follows. */
  start?(at: Px, view: View, kind: Draft['kind']): Promise<{ at: Px; ink: Rgb | null }>;
  /**
   * The points after `from` up to (or near) `to`, or null when the hop cannot be traced (the
   * tools then add a straight segment and say so). May reject with a JobCancelled error, which
   * drops the click silently.
   */
  hop(
    from: Px,
    to: Px,
    draft: Draft,
    view: View,
  ): readonly Px[] | null | Promise<readonly Px[] | null>;
  /** Cancel the hop in flight, if any (a new click or Esc supersedes it). */
  cancel?(): void;
}

/** Something a drag moves. */
export type DragTarget =
  | { readonly kind: 'anchor'; readonly id: AnchorId }
  | { readonly kind: 'vertex'; readonly featureId: FeatureId; readonly index: number };

/** Where a pointer event happened. */
export interface PointerAt {
  /** Working-raster pixel (unclamped). */
  readonly px: Px;
  /** Canvas CSS pixels. */
  readonly screen: Screen;
  /** Whether px lies on the image. */
  readonly inside: boolean;
}

export interface EditorEvents {
  /** A left press released without moving past the threshold. target: what was under it at press. */
  click: PointerAt & {
    readonly target: DragTarget | null;
    readonly shiftKey: boolean;
    /** T-210: Alt-click splits a candidate under review instead of toggling it. */
    readonly altKey: boolean;
  };
  /** A left drag of a target started; px is clamped to the image. */
  dragStart: PointerAt & { readonly target: DragTarget };
  /** The dragged target moved; px is clamped to the image. */
  drag: PointerAt & { readonly target: DragTarget };
  /** The drag ended (pointer up or cancel). */
  dragEnd: PointerAt & { readonly target: DragTarget; readonly cancelled: boolean };
  /** Right-click (the prototype deletes a vertex with it in the select tool). */
  contextmenu: PointerAt;
  /** Pointer moved over the canvas, or left it (null). */
  cursor: PointerAt | null;
  /** The view transform changed. */
  view: View;
  /** A press started on the canvas (T-215: tools use it to drop keyboard-nav modality). */
  pointerdown: Screen;
}

type Listener<K extends keyof EditorEvents> = (e: EditorEvents[K]) => void;

interface Press {
  readonly start: Screen;
  last: Screen;
  moved: boolean;
  readonly button: number;
  pan: boolean;
  readonly target: DragTarget | null;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
}

const isTyping = (t: EventTarget | null): boolean =>
  t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));

export class Editor {
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private dpr = 1;
  private cw = 0;
  private ch = 0;
  private v: View = { s: 1, x: 0, y: 0 };
  /** Fit the view once the canvas has a size (after mount or a new map). */
  private needsFit = true;
  private raf = 0;
  private cursor: Screen | null = null;
  private readonly pointers = new Map<number, Screen>();
  private pinch: { d: number; m: Screen } | null = null;
  private press: Press | null = null;
  private spaceDown = false;
  private readonly listeners = new Map<keyof EditorEvents, Set<Listener<never>>>();
  private readonly cleanups: (() => void)[] = [];
  /** Cached raster of the unselected lines (see layer.ts). */
  readonly lines = new LineLayer();
  private lastZoom = -Infinity;
  private lastPan = -Infinity;
  private settleTimer: ReturnType<typeof setTimeout> | null = null;
  /** CPU time of the last renderNow call, ms (excludes GPU rasterization). */
  lastFrameMs = 0;
  private hops: HopProvider | null = null;
  /** Set after a right-button drag, so the contextmenu that follows it on release is swallowed. */
  private swallowContextMenu = false;

  /** Install (or clear) the hop provider used by trail/area drafting (T-206). */
  setHopProvider(fn: HopProvider | null): void {
    this.hops = fn;
  }

  /** The hop provider, or null for straight segments. */
  get hopProvider(): HopProvider | null {
    return this.hops;
  }

  constructor(private readonly store = appStore) {
    // A sliced layer rebuild finished (T-211): show it.
    this.lines.onReady = () => this.invalidate();
  }

  /* ------------------------------------------------------------ lifecycle */

  mount(canvas: HTMLCanvasElement): void {
    if (this.canvas) throw new Error('Editor is already mounted');
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    const on = <K extends keyof HTMLElementEventMap>(
      target: HTMLElement | Window,
      type: K,
      fn: (e: HTMLElementEventMap[K]) => void,
      opts?: AddEventListenerOptions,
    ) => {
      target.addEventListener(type, fn as EventListener, opts);
      this.cleanups.push(() => target.removeEventListener(type, fn as EventListener, opts));
    };
    on(canvas, 'pointerdown', (e) => this.onPointerDown(e));
    on(canvas, 'pointermove', (e) => this.onPointerMove(e));
    on(canvas, 'pointerup', (e) => this.onPointerEnd(e, false));
    on(canvas, 'pointercancel', (e) => this.onPointerEnd(e, true));
    on(canvas, 'pointerleave', () => this.onPointerLeave());
    on(canvas, 'wheel', (e) => this.onWheel(e), { passive: false });
    on(canvas, 'contextmenu', (e) => this.onContextMenu(e));
    on(window, 'keydown', (e) => this.onKey(e, true));
    on(window, 'keyup', (e) => this.onKey(e, false));
    on(window, 'blur', () => (this.spaceDown = false));

    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(() => this.resize());
      ro.observe(canvas);
      this.cleanups.push(() => ro.disconnect());
    }
    this.cleanups.push(this.store.subscribe((s, prev) => this.onState(s, prev)));
    this.updateCursorStyle();
    this.resize();
  }

  destroy(): void {
    for (const off of this.cleanups.splice(0)) off();
    if (this.raf) cancelAnimationFrame(this.raf);
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.settleTimer = null;
    this.lines.reset();
    this.raf = 0;
    this.canvas = null;
    this.ctx = null;
    this.listeners.clear();
  }

  on<K extends keyof EditorEvents>(type: K, fn: Listener<K>): () => void {
    let set = this.listeners.get(type);
    if (!set) this.listeners.set(type, (set = new Set()));
    set.add(fn as Listener<never>);
    return () => set.delete(fn as Listener<never>);
  }

  private emit<K extends keyof EditorEvents>(type: K, e: EditorEvents[K]): void {
    for (const fn of this.listeners.get(type) ?? []) (fn as Listener<K>)(e);
  }

  /* ------------------------------------------------------------ view */

  get view(): View {
    return this.v;
  }

  /** Whether a pointer is down on the canvas (a click, pan or drag in progress). */
  get pressing(): boolean {
    return this.press !== null;
  }

  /** Canvas size in CSS pixels. */
  get size(): { width: number; height: number } {
    return { width: this.cw, height: this.ch };
  }

  /** The mounted canvas element, or null (T-215: gate Tab/arrow handling to canvas-focused). */
  get element(): HTMLCanvasElement | null {
    return this.canvas;
  }

  private setView(v: View): void {
    if (v.s !== this.v.s) this.lastZoom = performance.now();
    if (v.x !== this.v.x || v.y !== this.v.y) this.lastPan = performance.now();
    this.v = v;
    this.invalidate();
    this.emit('view', v);
  }

  /** Show the whole map (prototype fitView, F key). */
  fitView(): void {
    const img = this.store.getState().session?.project.image;
    if (!img || !this.cw || !this.ch) {
      this.needsFit = true;
      return;
    }
    this.needsFit = false;
    this.setView(fitView(this.cw, this.ch, img.width, img.height));
  }

  /** Zoom around a canvas point (default: the canvas center). */
  zoomBy(factor: number, at: Screen = [this.cw / 2, this.ch / 2]): void {
    this.setView(zoomAt(this.v, at, factor));
  }

  /** Scroll so an image pixel is centered. */
  centerOn(px: Px): void {
    this.setView(centerOn(this.v, this.cw, this.ch, px));
  }

  /** Pan by a CSS-pixel delta (T-215: arrow keys with no vertex focus). */
  panBy(dx: number, dy: number): void {
    this.setView(panBy(this.v, dx, dy));
  }

  /** The canvas centre, as a click there would report it (T-215: where Enter places a point,
   * or adds the next point of an open draft). */
  centerPointerAt(): PointerAt {
    return this.at([this.cw / 2, this.ch / 2]);
  }

  /** Image pixel -> CSS client coordinates (TestHook.imageToClient). */
  imageToClient(px: Px): { x: number; y: number } {
    if (!this.canvas) throw new Error('Editor is not mounted');
    const r = this.canvas.getBoundingClientRect();
    const [sx, sy] = toScr(this.v, px);
    return { x: r.left + sx, y: r.top + sy };
  }

  private resize(): void {
    const c = this.canvas;
    if (!c) return;
    const r = c.getBoundingClientRect();
    this.dpr = window.devicePixelRatio || 1;
    this.cw = r.width;
    this.ch = r.height;
    c.width = Math.max(1, Math.round(r.width * this.dpr));
    c.height = Math.max(1, Math.round(r.height * this.dpr));
    if (this.needsFit) this.fitView();
    this.invalidate();
  }

  /* ------------------------------------------------------------ rendering */

  private onState(s: AppState, prev: AppState): void {
    if (s.session?.map !== prev.session?.map) {
      // Never show the old map's lines, not even as a stale layer.
      this.lines.reset();
      this.needsFit = true;
      this.fitView();
    }
    if (s.tool !== prev.tool) this.updateCursorStyle();
    if (
      s.session !== prev.session ||
      s.selectedFeatureId !== prev.selectedFeatureId ||
      s.selectedAnchorId !== prev.selectedAnchorId ||
      s.secondSelectedFeatureId !== prev.secondSelectedFeatureId ||
      s.draft !== prev.draft ||
      s.candidates !== prev.candidates ||
      s.candidateSplitFocus !== prev.candidateSplitFocus ||
      // Drag end brings leave-one-out residuals, which may turn a pin red (T-208).
      s.anchorDragging !== prev.anchorDragging ||
      s.vertexFocus !== prev.vertexFocus ||
      s.keyboardMode !== prev.keyboardMode ||
      s.tool !== prev.tool
    ) {
      this.invalidate();
    }
  }

  /** Schedule one render on the next animation frame (coalesces repeated calls). */
  invalidate(): void {
    if (!this.raf && this.canvas) this.raf = requestAnimationFrame(() => this.renderNow());
  }

  /** Render immediately (the rAF callback; also used by the perf harness). */
  renderNow(): void {
    this.raf = 0;
    if (!this.ctx) return;
    const t0 = performance.now();
    const s = this.store.getState();
    const content = {
      features: s.session?.project.features ?? [],
      editId: s.draft?.editId ?? null,
    };
    const now = performance.now();
    const zoomSettled = now - this.lastZoom >= ZOOM_SETTLE_MS;
    const panSettled = now - this.lastPan >= PAN_SETTLE_MS;
    renderFrame(this.ctx, this.model(), this.v, this.dpr, (ctx) =>
      this.lines.draw(ctx, this.v, this.dpr, this.cw, this.ch, content, zoomSettled, panSettled),
    );
    // Mid-zoom the layer is shown scaled, and a fast/long drag can leave it uncovered past the
    // margin; re-rasterize once whichever gesture has settled.
    const pendingZoom = !zoomSettled && this.lines.isScaled(this.v);
    const pendingPan = !panSettled && this.lines.isPanned(this.v, this.cw, this.ch);
    if ((pendingZoom || pendingPan) && !this.settleTimer) {
      this.settleTimer = setTimeout(
        () => {
          this.settleTimer = null;
          this.invalidate();
        },
        Math.max(ZOOM_SETTLE_MS, PAN_SETTLE_MS),
      );
    }
    this.lastFrameMs = performance.now() - t0;
  }

  private model(): RenderModel {
    const s = this.store.getState();
    const p = s.session?.project;
    const fit = selectFit(s);
    const placementTool = s.tool === 'anchor' || s.tool === 'point';
    return {
      image: s.session?.map.display ?? null,
      features: p?.features ?? [],
      selectedFeatureId: s.selectedFeatureId,
      secondSelectedFeatureId: s.secondSelectedFeatureId,
      draft: s.draft,
      cursor: this.cursor,
      candidates: s.candidates,
      focusedCandidateSplit: s.candidateSplitFocus ?? null,
      anchors: p?.anchors ?? [],
      selectedAnchorId: s.selectedAnchorId,
      isOutlier: (id) => (fit?.ok ? anchorOutlier(fit, id) : false),
      focusedVertex: s.vertexFocus,
      centerCrosshair: s.keyboardMode && placementTool && !s.draft,
    };
  }

  private updateCursorStyle(): void {
    if (!this.canvas) return;
    const tool: Tool = this.store.getState().tool;
    this.canvas.style.cursor =
      this.press?.pan && this.press.moved
        ? 'grabbing'
        : tool === 'select'
          ? 'default'
          : 'crosshair';
  }

  /* ------------------------------------------------------------ input */

  private local(e: MouseEvent): Screen {
    const r = this.canvas!.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  private at(screen: Screen, clamp = false): PointerAt {
    const img = this.store.getState().session?.project.image;
    let px = toImg(this.v, screen);
    const w = img?.width ?? 0;
    const h = img?.height ?? 0;
    const inside = px[0] >= 0 && px[1] >= 0 && px[0] < w && px[1] < h;
    if (clamp && img) {
      px = [Math.max(0, Math.min(w - 1, px[0])), Math.max(0, Math.min(h - 1, px[1]))];
    }
    return { px, screen, inside };
  }

  private hasMap(): boolean {
    return this.store.getState().session !== null;
  }

  private targetAt(s: Screen): DragTarget | null {
    const st = this.store.getState();
    const p = st.session?.project;
    if (!p) return null;
    if (st.tool === 'select' || st.tool === 'anchor') {
      const id = hitAnchor(p.anchors, this.v, s);
      if (id) return { kind: 'anchor', id };
    }
    if (st.tool === 'select') {
      const f = p.features.find((x) => x.id === st.selectedFeatureId);
      const index = hitHandle(f, this.v, s);
      if (f && index >= 0) return { kind: 'vertex', featureId: f.id, index };
    }
    return null;
  }

  private onPointerDown(e: PointerEvent): void {
    if (!this.hasMap()) return;
    // Keyboard shortcuts go to the map, not to whatever toolbar button was clicked last.
    this.canvas!.focus({ preventScroll: true });
    this.swallowContextMenu = false;
    this.emit('pointerdown', this.local(e));
    try {
      this.canvas!.setPointerCapture(e.pointerId);
    } catch {
      // Synthetic or already-released pointers cannot be captured; input still works.
    }
    const s = this.local(e);
    this.pointers.set(e.pointerId, s);
    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()] as [Screen, Screen];
      this.pinch = {
        d: Math.hypot(a[0] - b[0], a[1] - b[1]),
        m: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2],
      };
      this.press = null;
      return;
    }
    const tool = this.store.getState().tool;
    const pan = e.button === 1 || (e.button === 2 && tool !== 'select') || this.spaceDown;
    const target = pan || e.button !== 0 ? null : this.targetAt(s);
    this.press = {
      start: s,
      last: s,
      moved: false,
      button: e.button,
      pan,
      target,
      shiftKey: e.shiftKey,
      altKey: e.altKey,
    };
  }

  private onPointerMove(e: PointerEvent): void {
    if (!this.hasMap()) return;
    const s = this.local(e);
    this.cursor = s;
    this.emit('cursor', this.at(s));
    if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, s);

    if (this.pinch && this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()] as [Screen, Screen];
      const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
      const m: Screen = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      const moved = panBy(this.v, m[0] - this.pinch.m[0], m[1] - this.pinch.m[1]);
      this.setView(zoomAt(moved, m, this.pinch.d ? d / this.pinch.d : 1));
      this.pinch = { d, m };
      return;
    }

    const p = this.press;
    if (!p) {
      if (this.store.getState().draft) this.invalidate();
      return;
    }
    if (!p.moved && Math.hypot(s[0] - p.start[0], s[1] - p.start[1]) > DRAG_THRESHOLD_PX) {
      p.moved = true;
      if (p.target && !p.pan) this.emit('dragStart', { ...this.at(s, true), target: p.target });
      else p.pan = true;
      this.updateCursorStyle();
    }
    if (!p.moved) return;
    if (p.pan) this.setView(panBy(this.v, s[0] - p.last[0], s[1] - p.last[1]));
    else if (p.target) this.emit('drag', { ...this.at(s, true), target: p.target });
    p.last = s;
  }

  private onPointerEnd(e: PointerEvent, cancelled: boolean): void {
    this.pointers.delete(e.pointerId);
    if (this.pinch) {
      if (this.pointers.size < 2) this.pinch = null;
      this.press = null;
      return;
    }
    const p = this.press;
    if (!p) return;
    this.press = null;
    this.updateCursorStyle();
    const s = this.canvas ? this.local(e) : p.last;
    if (p.moved) {
      // A right-drag pan must not end by deleting the vertex under the cursor.
      if (p.button === 2) this.swallowContextMenu = true;
      if (p.target && !p.pan)
        this.emit('dragEnd', { ...this.at(s, true), target: p.target, cancelled });
      return;
    }
    if (cancelled || p.button !== 0 || p.pan) return;
    this.emit('click', {
      ...this.at(p.start),
      target: p.target,
      shiftKey: p.shiftKey,
      altKey: p.altKey,
    });
  }

  private onPointerLeave(): void {
    this.cursor = null;
    this.emit('cursor', null);
    if (this.store.getState().draft) this.invalidate();
  }

  private onWheel(e: WheelEvent): void {
    if (!this.hasMap()) return;
    e.preventDefault();
    this.zoomBy(Math.exp(-e.deltaY * (e.deltaMode ? 0.05 : 0.0016)), this.local(e));
  }

  private onContextMenu(e: MouseEvent): void {
    e.preventDefault();
    if (this.swallowContextMenu) {
      this.swallowContextMenu = false;
      return;
    }
    if (this.hasMap()) this.emit('contextmenu', this.at(this.local(e)));
  }

  private onKey(e: KeyboardEvent, down: boolean): void {
    if (e.code !== 'Space' || isTyping(e.target)) return;
    this.spaceDown = down;
    if (down) e.preventDefault();
  }
}
