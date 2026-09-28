// Lane B. Canvas drawing for the editor, ported from the prototype's render/drawFeature/
// drawPin/drawDraft/drawCands/label. Draws a plain RenderModel; knows nothing of the store.
import { normalizeColor } from '../../core/export/format';
import {
  DEFAULT_COLORS,
  type Anchor,
  type AnchorId,
  type Feature,
  type Px,
} from '../../core/types';
import type { CandidateSplitFocus, Draft, ReviewCandidate, VertexFocus } from '../../state/store';
import type { Screen, View } from './view';

const BLAZE = '#F2B531';
const INK = '#17231C';
const DANGER = '#B5352A';
const FOCUS_WHITE = '#ffffff';
const FONT = '"Atkinson Hyperlegible", system-ui, sans-serif';
/** Above this zoom the map is drawn with nearest-neighbour pixels (prototype). */
export const SMOOTHING_MAX_ZOOM = 1.6;

export interface RenderModel {
  /** Map bitmap in working-raster pixels, or null before a map is open. */
  readonly image: CanvasImageSource | null;
  readonly features: readonly Feature[];
  readonly selectedFeatureId: string | null;
  /** Trail shift-selected to join with the selected one (T-209), or null. */
  readonly secondSelectedFeatureId: string | null;
  readonly draft: Draft | null;
  /** Last pointer position on the canvas (draft rubber band), or null. */
  readonly cursor: Screen | null;
  readonly candidates: readonly ReviewCandidate[] | null;
  /** Candidate split point currently being keyboard-positioned in the Trace panel (T-217). */
  readonly focusedCandidateSplit?: CandidateSplitFocus | null;
  readonly anchors: readonly Anchor[];
  readonly selectedAnchorId: AnchorId | null;
  /** True for anchors the fit flags as outliers (drawn red). */
  readonly isOutlier: (id: AnchorId) => boolean;
  /** Keyboard vertex focus (T-215: Tab/arrows), or null. Drawn as a ring distinct from selection
   * handles so a keyboard user can tell which vertex arrows and Delete act on. */
  readonly focusedVertex: VertexFocus | null;
  /** Show the view-centre crosshair (T-215): keyboard modality, a placement tool, no open draft. */
  readonly centerCrosshair: boolean;
}

type Ctx = CanvasRenderingContext2D;

/**
 * Draw one frame. The canvas is sized cssW*dpr x cssH*dpr. `lines` draws the unselected
 * trails/areas (the Editor passes its cached LineLayer); by default they are stroked directly.
 */
export function renderFrame(
  ctx: Ctx,
  m: RenderModel,
  v: View,
  dpr: number,
  lines: ((ctx: Ctx) => void) | null = null,
): void {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  if (!m.image) return;
  ctx.setTransform(dpr * v.s, 0, 0, dpr * v.s, dpr * v.x, dpr * v.y);
  ctx.imageSmoothingEnabled = v.s < SMOOTHING_MAX_ZOOM;
  ctx.shadowColor = 'rgba(0,0,0,.25)';
  ctx.shadowBlur = 12 / v.s;
  ctx.drawImage(m.image, 0, 0);
  ctx.shadowBlur = 0;
  ctx.shadowColor = 'transparent';

  const editId = m.draft?.editId ?? null;
  const sel = m.features.find((f) => f.id === m.selectedFeatureId && f.id !== editId);
  if (lines) {
    lines(ctx);
  } else {
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    for (const f of m.features) {
      if (f.kind !== 'poi' && f.id !== editId && f !== sel) drawLineFeature(ctx, f, v.s);
    }
  }

  // Screen space: the selected line on top of the others, then points, then overlays.
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  // With a layer, the selection is also in it (D-012): draw the live copy without a second fill.
  if (sel && sel.kind !== 'poi') drawFeature(ctx, v, sel, true, !lines);
  const second = m.features.find(
    (f): f is LineFeature =>
      f.id === m.secondSelectedFeatureId && f.kind === 'trail' && f.id !== editId,
  );
  if (second) drawJoinCandidate(ctx, v, second);
  for (const f of m.features) {
    if (f.kind === 'poi' && f.id !== editId && f !== sel) drawFeature(ctx, v, f, false);
  }
  if (sel?.kind === 'poi') drawFeature(ctx, v, sel, true);
  if (m.candidates) drawCandidates(ctx, v, m.candidates, m.focusedCandidateSplit ?? null);
  if (m.draft) drawDraft(ctx, v, m.draft, m.cursor);
  m.anchors.forEach((a, i) =>
    drawPin(ctx, v, a, i, a.id === m.selectedAnchorId, m.isOutlier(a.id)),
  );
  if (m.focusedVertex) drawVertexFocus(ctx, v, m.features, m.focusedVertex);
  if (m.centerCrosshair) drawCenterCrosshair(ctx, ctx.canvas.width / dpr, ctx.canvas.height / dpr);
}

/**
 * Ring around the keyboard-focused vertex (T-215): a white halo and a dark core so it stays
 * >= 3:1 against arbitrary map imagery either way, distinct from the plain selection handles.
 */
function drawVertexFocus(
  ctx: Ctx,
  v: View,
  features: readonly Feature[],
  focus: VertexFocus,
): void {
  const f = features.find((x) => x.id === focus.featureId);
  if (!f || f.kind === 'poi' || focus.index >= f.pts.length) return;
  const [x, y] = scr(v, f.pts[focus.index]!);
  ctx.beginPath();
  ctx.arc(x, y, 10, 0, 7);
  ctx.strokeStyle = FOCUS_WHITE;
  ctx.lineWidth = 4;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(x, y, 10, 0, 7);
  ctx.strokeStyle = INK;
  ctx.lineWidth = 2;
  ctx.stroke();
}

/** Crosshair at the canvas centre (T-215): where Enter places the next point with the keyboard. */
function drawCenterCrosshair(ctx: Ctx, cw: number, ch: number): void {
  const x = cw / 2;
  const y = ch / 2;
  const r = 9;
  for (const [color, width] of [
    [FOCUS_WHITE, 4],
    [INK, 1.5],
  ] as const) {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(x - r, y);
    ctx.lineTo(x + r, y);
    ctx.moveTo(x, y - r);
    ctx.lineTo(x, y + r);
    ctx.stroke();
  }
}

type LineFeature = Exclude<Feature, { readonly kind: 'poi' }>;

// Features are immutable (every edit replaces the object), so paths and bounds are cached
// per object and survive pans, zooms and unrelated edits.
const paths = new WeakMap<Feature, Path2D>();
const bounds = new WeakMap<Feature, readonly [number, number, number, number]>();

/** The feature as a Path2D in image pixels (areas closed). */
function imagePath(f: LineFeature): Path2D {
  let p = paths.get(f);
  if (!p) {
    p = new Path2D();
    const path = p;
    f.pts.forEach(([x, y], i) => (i ? path.lineTo(x, y) : path.moveTo(x, y)));
    if (f.kind === 'area') p.closePath();
    paths.set(f, p);
  }
  return p;
}

/** [minX, minY, maxX, maxY] of a feature in image pixels. */
export function featureBounds(f: Feature): readonly [number, number, number, number] {
  let b = bounds.get(f);
  if (!b) {
    const pts = f.kind === 'poi' ? [f.at] : f.pts;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const [x, y] of pts) {
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    }
    b = [x0, y0, x1, y1];
    bounds.set(f, b);
  }
  return b;
}

/**
 * Prototype look for an unselected trail/area: 25% area fill, white casing, color line.
 * Draws in the current transform, which must map image pixels (scale s) to the device.
 */
export function drawLineFeature(ctx: Ctx, f: LineFeature, s: number): void {
  if (!f.pts.length) return;
  const color = normalizeColor(f.color, DEFAULT_COLORS[f.kind]);
  const p = imagePath(f);
  if (f.kind === 'area') {
    ctx.fillStyle = color + '40';
    ctx.fill(p);
  }
  ctx.strokeStyle = 'rgba(255,255,255,.92)';
  ctx.lineWidth = 6.5 / s;
  ctx.stroke(p);
  ctx.strokeStyle = color;
  ctx.lineWidth = 3.5 / s;
  ctx.stroke(p);
}

function pathOf(ctx: Ctx, v: View, pts: readonly Px[], close: boolean): void {
  const { s, x: ox, y: oy } = v;
  ctx.beginPath();
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]!;
    if (i) ctx.lineTo(p[0] * s + ox, p[1] * s + oy);
    else ctx.moveTo(p[0] * s + ox, p[1] * s + oy);
  }
  if (close) ctx.closePath();
}

const scr = (v: View, p: Px): Screen => [p[0] * v.s + v.x, p[1] * v.s + v.y];

const JOIN_CANDIDATE = '#2B6CB0';

/** The trail shift-selected as the second half of a join (T-209): a dashed blue halo. */
function drawJoinCandidate(ctx: Ctx, v: View, f: LineFeature): void {
  pathOf(ctx, v, f.pts, false);
  ctx.setLineDash([5, 5]);
  ctx.strokeStyle = JOIN_CANDIDATE;
  ctx.lineWidth = 7;
  ctx.stroke();
  ctx.setLineDash([]);
}

function drawFeature(ctx: Ctx, v: View, f: Feature, sel: boolean, fill = true): void {
  const color = normalizeColor(f.color, DEFAULT_COLORS[f.kind]);
  if (f.kind === 'poi') {
    const [px, py] = scr(v, f.at);
    if (sel) {
      ctx.fillStyle = BLAZE;
      ctx.beginPath();
      ctx.arc(px, py, 13, 0, 7);
      ctx.fill();
    }
    ctx.fillStyle = color;
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(px, py, 7.5, 0, 7);
    ctx.fill();
    ctx.stroke();
    label(ctx, f.name, px + 12, py - 10, sel);
    return;
  }
  const close = f.kind === 'area';
  if (close && fill) {
    pathOf(ctx, v, f.pts, true);
    ctx.fillStyle = color + '40';
    ctx.fill();
  }
  if (sel) {
    pathOf(ctx, v, f.pts, close);
    ctx.strokeStyle = BLAZE;
    ctx.lineWidth = 11;
    ctx.stroke();
  }
  pathOf(ctx, v, f.pts, close);
  ctx.strokeStyle = 'rgba(255,255,255,.92)';
  ctx.lineWidth = 6.5;
  ctx.stroke();
  ctx.strokeStyle = color;
  ctx.lineWidth = 3.5;
  ctx.stroke();
  if (sel) {
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = INK;
    ctx.lineWidth = 1.5;
    for (const p of f.pts) {
      const [a, b] = scr(v, p);
      ctx.beginPath();
      ctx.rect(a - 3.5, b - 3.5, 7, 7);
      ctx.fill();
      ctx.stroke();
    }
    const [a, b] = scr(v, f.pts[Math.floor(f.pts.length / 2)]!);
    label(ctx, f.name, a + 10, b - 10, true);
  }
}

function label(ctx: Ctx, text: string, x: number, y: number, strong: boolean): void {
  if (!text) return;
  ctx.font = `${strong ? 700 : 400} 13px ${FONT}`;
  const w = ctx.measureText(text).width;
  ctx.fillStyle = 'rgba(23,35,28,.86)';
  ctx.beginPath();
  ctx.roundRect(x - 5, y - 13, w + 10, 19, 5);
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.fillText(text, x, y + 1);
}

function drawDraft(ctx: Ctx, v: View, d: Draft, cursor: Screen | null): void {
  if (!d.pts.length) return;
  const color = normalizeColor(d.color, DEFAULT_COLORS[d.kind]);
  if (d.pts.length > 1) {
    pathOf(ctx, v, d.pts, false);
    ctx.strokeStyle = BLAZE;
    ctx.lineWidth = 9;
    ctx.stroke();
    ctx.strokeStyle = color;
    ctx.lineWidth = 3.5;
    ctx.stroke();
  }
  const first = d.pts[0]!;
  const last = d.pts[d.pts.length - 1]!;
  if (cursor) {
    const [a, b] = scr(v, last);
    ctx.setLineDash([6, 6]);
    ctx.strokeStyle = INK;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(a, b);
    ctx.lineTo(cursor[0], cursor[1]);
    if (d.kind === 'area' && d.pts.length > 2) ctx.lineTo(...scr(v, first));
    ctx.stroke();
    ctx.setLineDash([]);
  }
  [first, last].forEach((p, i) => {
    const [a, b] = scr(v, p);
    ctx.fillStyle = i ? BLAZE : '#fff';
    ctx.strokeStyle = INK;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(a, b, 5.5, 0, 7);
    ctx.fill();
    ctx.stroke();
  });
}

function drawCandidates(
  ctx: Ctx,
  v: View,
  cands: readonly ReviewCandidate[],
  focus: CandidateSplitFocus | null,
): void {
  for (const c of cands) {
    pathOf(ctx, v, c.pts, false);
    if (c.on) {
      ctx.strokeStyle = BLAZE;
      ctx.lineWidth = 9;
      ctx.stroke();
      ctx.strokeStyle = normalizeColor(c.color, DEFAULT_COLORS.trail);
      ctx.lineWidth = 3.5;
      ctx.stroke();
      ctx.setLineDash([2, 9]);
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;
      ctx.stroke();
    } else {
      ctx.setLineDash([5, 5]);
      ctx.strokeStyle = 'rgba(40,40,40,.65)';
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    ctx.setLineDash([]);
    if (focus?.candidateId === c.id && focus.index > 0 && focus.index < c.pts.length - 1) {
      const [x, y] = scr(v, c.pts[focus.index]!);
      ctx.beginPath();
      ctx.arc(x, y, 11, 0, 7);
      ctx.fillStyle = FOCUS_WHITE;
      ctx.fill();
      ctx.strokeStyle = INK;
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(x, y, 6, 0, 7);
      ctx.fillStyle = BLAZE;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(x, y, 2, 0, 7);
      ctx.fillStyle = INK;
      ctx.fill();
    }
  }
}

function drawPin(ctx: Ctx, v: View, a: Anchor, i: number, sel: boolean, bad: boolean): void {
  const [x, y] = scr(v, a.px);
  const has = a.ll !== null;
  ctx.save();
  ctx.translate(x, y);
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.bezierCurveTo(-4, -8, -11, -12, -11, -21);
  ctx.arc(0, -21, 11, Math.PI, 0);
  ctx.bezierCurveTo(11, -12, 4, -8, 0, 0);
  ctx.closePath();
  ctx.fillStyle = has ? (bad ? DANGER : BLAZE) : 'rgba(255,255,255,.9)';
  ctx.fill();
  ctx.lineWidth = sel ? 3 : 1.6;
  ctx.strokeStyle = sel ? INK : 'rgba(23,35,28,.8)';
  if (!has) ctx.setLineDash([3, 3]);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = has && bad ? '#fff' : '#231A00';
  ctx.font = `700 12px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.fillText(String(i + 1), 0, -17);
  ctx.beginPath();
  ctx.arc(0, 0, 2.2, 0, 7);
  ctx.fillStyle = INK;
  ctx.fill();
  ctx.restore();
}
