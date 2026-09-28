// Lane B. Cached raster of every trail/area line (card T-203 acceptance 7; DECISIONS D-012).
// Stroking thousands of lines costs 50-120 ms per frame in Chrome, so the lines are rasterized
// once into an offscreen canvas and blitted: pans shift it, zooms scale it until the zoom
// settles. Selection never touches the layer (the selected feature is drawn live on top of its
// layer copy). Edits, including undo/redo, redraw only a dirty rectangle: the old and new
// bounds of the changed features, repainting in feature order just the features that
// intersect it.
// Large full rebuilds (T-211, D-012 item 5) are time-sliced: the new raster is built in a back
// canvas in <= SLICE_MS slices while the previous (stale) raster keeps being blitted, and it is
// swapped in when complete. Small layers still paint in one go (D-012 item 6: <= 300 features
// fit in a frame), so realistic maps never show a stale frame.
import type { Feature } from '../../core/types';
import { drawLineFeature, featureBounds } from './render';
import { Slicer } from './slice';
import type { View } from './view';

/** Extra CSS px rendered around the viewport so small pans need no rebuild. */
export const LAYER_MARGIN_PX = 256;
/** Below this zoom the layer uses bevel joins (see paint). */
export const BEVEL_BELOW_ZOOM = 1;
/** Half the casing width plus antialiasing and round caps, CSS px, added around dirty rects. */
export const STROKE_PAD_PX = 6;
/**
 * Paints touching at most this many vertices run synchronously; larger ones are sliced. Chrome
 * submits ~100k layer vertices in ~28 ms of CPU (T-211 Log), so this is about 6 ms.
 */
export const SYNC_PAINT_MAX_VERTS = 20_000;
/**
 * Minimum time between mid-build GPU flushes (T-216). Flushing every slice queues raster
 * commands onto the GPU process faster than it can retire them on a busy/older discrete GPU,
 * backing up frame presentation for hundreds of ms even though no single main-thread task is
 * over budget. Flushing less often trades a slightly larger CPU-side stroke backlog (still
 * capped by SLICE_MS) for far less queued GPU work in flight.
 */
export const FLUSH_INTERVAL_MS = 24;

/** What the layer's pixels depend on, besides the view. */
export interface LayerContent {
  readonly features: readonly Feature[];
  /** Feature hidden while a draft continues it. */
  readonly editId: string | null;
}

/** [minX, minY, maxX, maxY] in image pixels. */
export type Box = readonly [number, number, number, number];

/** How the layer must change for new content. */
export type LayerDiff =
  | { readonly kind: 'none' }
  | { readonly kind: 'full' }
  /** Repaint inside this image-pixel box (union of old and new bounds of what changed). */
  | { readonly kind: 'dirty'; readonly box: Box };

const inLayer = (
  f: Feature | undefined,
  editId: string | null,
): f is Exclude<Feature, { kind: 'poi' }> => !!f && f.kind !== 'poi' && f.id !== editId;

function union(a: Box | null, b: Box): Box {
  return a
    ? [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])]
    : b;
}

/**
 * Compare two contents. Every edit makes a new features array but keeps untouched feature
 * objects, so changed features are found by reference, keyed by id. A feature counts as changed
 * when it was added, removed, replaced, or hidden/shown by a continuing draft; its old and new
 * bounds (if it is a line) join the dirty box. POIs are not in the layer and never dirty it.
 */
export function diffContent(prev: LayerContent | null, next: LayerContent): LayerDiff {
  if (!prev) return { kind: 'full' };
  if (prev.features === next.features && prev.editId === next.editId) return { kind: 'none' };
  const before = new Map(prev.features.map((f) => [f.id, f]));
  let box: Box | null = null;
  for (const f of next.features) {
    const old = before.get(f.id);
    before.delete(f.id);
    const wasIn = inLayer(old, prev.editId);
    const isIn = inLayer(f, next.editId);
    if (old === f && wasIn === isIn) continue;
    if (wasIn) box = union(box, featureBounds(old));
    if (isIn) box = union(box, featureBounds(f));
  }
  for (const old of before.values()) {
    if (inLayer(old, prev.editId)) box = union(box, featureBounds(old));
  }
  return box ? { kind: 'dirty', box } : { kind: 'none' };
}

/**
 * Whether a layer rendered at view `at` (covering the viewport plus `margin` on each side)
 * still covers the whole cw x ch viewport under view `v`.
 */
export function covers(at: View, v: View, cw: number, ch: number, margin: number): boolean {
  const k = v.s / at.s;
  // Viewport corners in the layer's screen space.
  const x0 = (0 - v.x) / k + at.x;
  const y0 = (0 - v.y) / k + at.y;
  const x1 = (cw - v.x) / k + at.x;
  const y1 = (ch - v.y) / k + at.y;
  return x0 >= -margin && y0 >= -margin && x1 <= cw + margin && y1 <= ch + margin;
}

/** One rasterization of the lines: a canvas and what it was painted from. */
interface Raster {
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  /** View it was rasterized at. */
  readonly at: View;
  readonly dpr: number;
  /** Canvas size key, `${cw}x${ch}@${dpr}`. */
  readonly key: string;
  /** Content its pixels show. */
  content: LayerContent;
}

/** A sliced full rebuild in progress. */
interface Build {
  readonly raster: Raster;
  /** Next index into raster.content.features to paint. */
  next: number;
}

/** Vertices of the layer's features in `content` whose bounds reach image box `box` (all if null). */
export function paintCost(content: LayerContent, box: Box | null): number {
  let n = 0;
  for (const f of content.features) {
    if (!inLayer(f, content.editId)) continue;
    if (box) {
      const b = featureBounds(f);
      if (b[2] < box[0] || b[3] < box[1] || b[0] > box[2] || b[1] > box[3]) continue;
    }
    n += f.pts.length;
  }
  return n;
}

export class LineLayer {
  /** What is on screen: the current raster, stale while a build runs. */
  private front: Raster | null = null;
  private build: Build | null = null;
  /** A canvas retired by the last swap, reused by the next raster. */
  private spare: { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null = null;
  /** 1x1 canvas used to flush a build's strokes after each slice (see flush). */
  private scratch: CanvasRenderingContext2D | null = null;
  /** Content of the latest draw call (patched into a build's raster when it swaps in). */
  private latest: LayerContent | null = null;
  /** Called after a sliced build has swapped in, so the canvas is redrawn. */
  onReady: (() => void) | null = null;
  /** CPU submit time of the last synchronous repaint, ms (GPU rasterization is not included). */
  lastPaintMs = 0;
  /** Counters, for tests and the perf log. `sliced` counts the full paints that were sliced. */
  readonly stats = { full: 0, dirty: 0, sliced: 0 };

  constructor(private readonly slicer: Slicer = new Slicer()) {}

  /** The view the on-screen raster was rasterized at, or null. */
  get renderedAt(): View | null {
    return this.front?.at ?? null;
  }

  /** Whether a sliced rebuild is in progress. */
  get building(): boolean {
    return this.build !== null;
  }

  /** Longest slice of the sliced rebuilds so far, ms (T-211 acceptance 1). */
  get maxSliceMs(): number {
    return this.slicer.stats.maxSliceMs;
  }

  /** Forget everything (new map, unmount): nothing of the old raster may be shown again. */
  reset(): void {
    this.slicer.cancel();
    this.build = null;
    this.front = null;
    this.latest = null;
  }

  /**
   * Draw the lines onto `target` for view v. Rasterizes everything when there is no raster yet,
   * the canvas size or DPR changed, or (only once settled) the zoom differs from the raster's or
   * a pan left the margin; repaints a dirty rect when features changed; otherwise just blits
   * (scaled/offset while zooming/panning). Large full paints, and dirty rects touching many
   * vertices, are sliced; the current raster stays on screen until the new one is complete.
   *
   * `panSettled` (T-216) mirrors `zoomSettled`: a continuous drag that crosses LAYER_MARGIN_PX
   * mid-gesture used to retrigger a full rebuild on every frame of the drag (each one superseding
   * the last before it could finish, since the viewport kept moving out from under it), which
   * measured well over the 50 ms budget on a real GPU. Defaults to true so every existing caller
   * (all of layer.test.ts) keeps the old immediate-rebuild behavior; Editor is the only caller
   * that passes false, while a pan gesture is still in flight.
   */
  draw(
    target: CanvasRenderingContext2D,
    v: View,
    dpr: number,
    cw: number,
    ch: number,
    content: LayerContent,
    zoomSettled: boolean,
    panSettled = true,
  ): void {
    this.latest = content;
    const key = `${cw}x${ch}@${dpr}`;
    const front = this.front;
    // Content first: small edits are patched into the raster on screen, even when it is about to
    // be (or is being) replaced, so drags stay correct on a stale raster.
    let contentRebuild = false;
    if (front) {
      const diff = diffContent(front.content, content);
      if (diff.kind === 'full') {
        contentRebuild = true;
      } else if (diff.kind === 'dirty') {
        const cost = paintCost(content, diff.box) + paintCost(front.content, diff.box);
        if (cost <= SYNC_PAINT_MAX_VERTS) {
          this.paintBox(front, content, diff.box);
          front.content = content;
        } else {
          // Many lines changed at once (accepting candidates, a restore): rebuild, showing the
          // old lines until then. A build already running picks the change up when it swaps.
          contentRebuild = !this.build;
        }
      }
    }
    const at = front?.at;
    const full =
      !front ||
      !at ||
      key !== front.key ||
      (at.s !== v.s && zoomSettled) ||
      (at.s === v.s && !covers(at, v, cw, ch, LAYER_MARGIN_PX) && panSettled);
    if (full) this.rebuild(v, dpr, cw, ch, content, key);
    else if (contentRebuild) this.rebuild(at, dpr, cw, ch, content, key);
    if (this.front) this.blit(target, this.front, v, dpr);
  }

  /** Whether the on-screen raster is showing a scaled (not yet re-rasterized) zoom level. */
  isScaled(v: View): boolean {
    return this.front !== null && this.front.at.s !== v.s;
  }

  /** Whether the on-screen raster no longer covers the viewport at the current pan (T-216). */
  isPanned(v: View, cw: number, ch: number): boolean {
    return (
      this.front !== null &&
      this.front.at.s === v.s &&
      !covers(this.front.at, v, cw, ch, LAYER_MARGIN_PX)
    );
  }

  private blit(target: CanvasRenderingContext2D, r: Raster, v: View, dpr: number): void {
    // Raster device px -> target device px. A stale raster may differ in zoom, and in DPR while
    // it is rebuilt after a DPR change.
    const k = v.s / r.at.s;
    const m = LAYER_MARGIN_PX;
    const scale = (k * dpr) / r.dpr;
    target.save();
    target.setTransform(
      scale,
      0,
      0,
      scale,
      dpr * (v.x - (m + r.at.x) * k),
      dpr * (v.y - (m + r.at.y) * k),
    );
    target.imageSmoothingEnabled = true;
    target.drawImage(r.canvas, 0, 0);
    target.restore();
  }

  /** Rasterize everything at view v: at once when small, otherwise as a sliced build. */
  private rebuild(
    v: View,
    dpr: number,
    cw: number,
    ch: number,
    content: LayerContent,
    key: string,
  ): void {
    const b = this.build;
    if (b) {
      // Already building at this size and scale, covering this view: let it finish. Content
      // changed since it started is patched in when it swaps.
      const r = b.raster;
      if (r.key === key && r.at.s === v.s && covers(r.at, v, cw, ch, LAYER_MARGIN_PX)) return;
      this.slicer.cancel();
      this.build = null;
      this.spare = { canvas: r.canvas, ctx: r.ctx };
    }
    const raster = this.newRaster(v, dpr, cw, ch, content, key);
    if (!raster) return;
    if (paintCost(content, null) > SYNC_PAINT_MAX_VERTS) {
      // Even the first raster of a map is sliced: its lines appear a few frames late rather
      // than block the thread.
      this.startBuild(raster);
      return;
    }
    const t0 = performance.now();
    this.paintFeatures(raster, content, 0, null, null);
    this.lastPaintMs = performance.now() - t0;
    this.stats.full++;
    this.swap(raster);
  }

  private startBuild(raster: Raster): void {
    const build: Build = { raster, next: 0 };
    this.build = build;
    let lastFlush = performance.now();
    this.slicer.run(
      (timeUp) => {
        build.next = this.paintFeatures(raster, raster.content, build.next, timeUp, null);
        const done = build.next >= raster.content.features.length;
        const now = performance.now();
        // Always flush the final slice, so the swap in onDone shows a fully rasterized canvas;
        // otherwise throttle so a burst of slices (e.g. re-triggered by rapid wheel zoom) doesn't
        // queue more GPU work than the GPU can retire before the build is superseded and its
        // canvas reused (see FLUSH_INTERVAL_MS).
        if (done || now - lastFlush >= FLUSH_INTERVAL_MS) {
          this.flush(raster);
          lastFlush = now;
        }
        return done;
      },
      () => {
        this.build = null;
        this.stats.full++;
        this.stats.sliced++;
        // Edits made while it was building are patched in before it is shown.
        // A large change is left to the next draw, which starts another build for it.
        const latest = this.latest;
        if (latest) {
          const diff = diffContent(raster.content, latest);
          if (
            diff.kind === 'dirty' &&
            paintCost(latest, diff.box) + paintCost(raster.content, diff.box) <=
              SYNC_PAINT_MAX_VERTS
          ) {
            this.paintBox(raster, latest, diff.box);
            raster.content = latest;
          }
        }
        this.swap(raster);
        this.onReady?.();
      },
    );
  }

  /**
   * Hand the slice's recorded strokes to the GPU now. Chrome records canvas drawing and rasterizes
   * it when the canvas is next used; left alone, a whole build would rasterize at the swap and
   * drop frames there. Drawing one pixel of it into a scratch canvas makes Chrome flush it.
   */
  private flush(r: Raster): void {
    if (!this.scratch) {
      const c = document.createElement('canvas');
      c.width = 1;
      c.height = 1;
      this.scratch = c.getContext('2d');
    }
    this.scratch?.drawImage(r.canvas, 0, 0, 1, 1, 0, 0, 1, 1);
  }

  private swap(raster: Raster): void {
    const old = this.front;
    this.front = raster;
    if (old && old.canvas !== raster.canvas) this.spare = { canvas: old.canvas, ctx: old.ctx };
  }

  /** A cleared raster for view v, reusing the spare canvas when there is one. */
  private newRaster(
    v: View,
    dpr: number,
    cw: number,
    ch: number,
    content: LayerContent,
    key: string,
  ): Raster | null {
    let c = this.spare;
    this.spare = null;
    if (!c) {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      c = { canvas, ctx };
    }
    const m = LAYER_MARGIN_PX;
    const w = Math.max(1, Math.round((cw + 2 * m) * dpr));
    const h = Math.max(1, Math.round((ch + 2 * m) * dpr));
    if (c.canvas.width !== w || c.canvas.height !== h) {
      c.canvas.width = w;
      c.canvas.height = h;
    } else {
      c.ctx.save();
      c.ctx.setTransform(1, 0, 0, 1, 0, 0);
      c.ctx.clearRect(0, 0, w, h);
      c.ctx.restore();
    }
    return { canvas: c.canvas, ctx: c.ctx, at: v, dpr, key, content };
  }

  private paintBox(r: Raster, content: LayerContent, box: Box): void {
    const { at, canvas: c, ctx } = r;
    // Image box -> layer device pixels, padded for stroke width, snapped outward to whole pixels
    // so the clip edge never cuts through a partially covered pixel.
    const m = LAYER_MARGIN_PX;
    const d = r.dpr;
    const pad = STROKE_PAD_PX * d;
    const x0 = Math.max(0, Math.floor(d * (box[0] * at.s + at.x + m) - pad));
    const y0 = Math.max(0, Math.floor(d * (box[1] * at.s + at.y + m) - pad));
    const x1 = Math.min(c.width, Math.ceil(d * (box[2] * at.s + at.x + m) + pad));
    const y1 = Math.min(c.height, Math.ceil(d * (box[3] * at.s + at.y + m) + pad));
    if (x1 <= x0 || y1 <= y0) return;
    this.stats.dirty++;
    const t0 = performance.now();
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(x0, y0, x1 - x0, y1 - y0);
    ctx.beginPath();
    ctx.rect(x0, y0, x1 - x0, y1 - y0);
    ctx.clip();
    this.paintFeatures(r, content, 0, null, [x0, y0, x1, y1]);
    ctx.restore();
    this.lastPaintMs = performance.now() - t0;
  }

  /**
   * Stroke content.features[from..] into r in feature order (only those reaching the device-px
   * rect, when given), stopping early once `timeUp` (when given) says the slice is over. Returns
   * the index of the first feature not yet painted.
   */
  private paintFeatures(
    r: Raster,
    content: LayerContent,
    from: number,
    timeUp: (() => boolean) | null,
    rect: Box | null,
  ): number {
    const { ctx, at } = r;
    const m = LAYER_MARGIN_PX;
    const d = r.dpr;
    ctx.save();
    // Image -> layer pixels: the layer's CSS origin is (-m, -m) in screen space.
    ctx.setTransform(d * at.s, 0, 0, d * at.s, d * (at.x + m), d * (at.y + m));
    // Zoomed out, joins are sub-pixel and bevel joins rasterize ~2x faster than round ones.
    ctx.lineJoin = at.s < BEVEL_BELOW_ZOOM ? 'bevel' : 'round';
    ctx.lineCap = 'round';
    // Only features whose padded bounds reach the rect, in image pixels.
    const pad = STROKE_PAD_PX / at.s;
    const [x0, y0, x1, y1] = rect ?? [0, 0, r.canvas.width, r.canvas.height];
    const bx0 = (x0 / d - m - at.x) / at.s - pad;
    const by0 = (y0 / d - m - at.y) / at.s - pad;
    const bx1 = (x1 / d - m - at.x) / at.s + pad;
    const by1 = (y1 / d - m - at.y) / at.s + pad;
    const list = content.features;
    let i = from;
    for (; i < list.length; i++) {
      // The clock is read every 16 features (~800 vertices, well under a millisecond).
      if (timeUp && i > from && (i - from) % 16 === 0 && timeUp()) break;
      const f = list[i];
      if (!inLayer(f, content.editId)) continue;
      const b = featureBounds(f);
      if (b[2] < bx0 || b[3] < by0 || b[0] > bx1 || b[1] > by1) continue;
      drawLineFeature(ctx, f, at.s);
    }
    ctx.restore();
    return i;
  }
}
