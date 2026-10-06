// Lane B. Editor tools (card T-204): what clicks, drags and keys do in each tool. Port of the
// prototype's setTool/onClick/draftClick/draftUndo/cancelDraft/finishDraft/continueTrail, the
// vertex/anchor drag, the contextmenu vertex delete and the keyboard handler.
//
// Every project change is a store command (so undo/redo is exact). Drafting state lives in the
// store (`draft`); the drafting functions below are exported so panels (T-205) can call them.
// Draft operations run through one queue because a hop may be async (T-206 smart follow).
import { featureColorForInk } from '../../core/trace/color';
import { simplify } from '../../core/trace/simplify';
import { projectTrailPoint, type TrailPoint } from '../../core/topology';
import { DEFAULT_COLORS, type Project, type Px, type Rgb } from '../../core/types';
import {
  addAnchor,
  addFeature,
  deleteFeature,
  deleteVertex,
  moveAnchor,
  moveVertex,
  replaceTrailPoints,
} from '../../state/commands';
import {
  appStore,
  announce,
  checkpointHistory,
  edit,
  openVertexMenu,
  redo,
  requestFocus,
  restoreCancelledDrag,
  sealHistory,
  selectAnchor,
  selectFeature,
  setAnchorDragging,
  selectSecondFeature,
  setCandidateOn,
  setDraft,
  setHelpOpen,
  setJoinArmed,
  setKeyboardMode,
  setRegionTraceMode,
  setBoxSelectMode,
  setConnectSession,
  setTool,
  setVertexFocus,
  showToast,
  undo,
  undoCandidateSplit,
  type Draft,
  type HistoryCheckpoint,
  type Tool,
} from '../../state/store';
import {
  canSplitAt,
  joinSelected,
  splitHere,
  selectTrailsInRect,
  previewAutoJoin,
  cancelAutoJoin,
  applyAutoJoin,
} from '../../state/topology-actions';
import { moveVertexFocus, stepCount, stepVertexFocus } from '../../state/vertex-focus';
import { splitReviewedCandidate } from '../panels/candidate-split';
import { autoTraceRegion } from '../panels/trace-actions';
import type { DragTarget, Editor, EditorEvents, HopProvider, PointerAt } from './Editor';
import { isCancelled, isReported } from '../../state/worker-link';
import { hitCandidate, hitFeature, hitVertex } from './hit';
import { toScr, type Screen, type View } from './view';

/** Clicking within this many CSS px of the draft's last point finishes it (prototype). */
export const FINISH_HIT_PX = 9;
/** Clicking within this many CSS px of an area draft's first point closes it (prototype). */
export const CLOSE_HIT_PX = 10;
/** Douglas-Peucker tolerance applied to a finished draft, image px (prototype). */
export const FINISH_SIMPLIFY_PX = 0.6;

/** Tip line text per tool (prototype TIPS; its `gcp` is our `anchor`). */
export const TIPS = {
  cands:
    'Click a found line to include or leave it out, then add the selected lines as trails in the sidebar.',
  select:
    'Tap a point on the trail to select it (or press , / . to move between points). Then press S or pick Split here in the point’s menu. Right-click or long-press a point for its menu.',
  anchor:
    'Click a spot you can find on a real map: a trailhead, a junction, a parking lot corner. Then paste its coordinates in the sidebar.',
  trailSmart:
    'Click right on a trail line, then click further along it. The path follows the line’s color. Click the last point again or press Enter to finish.',
  trail:
    'Click to add points along the trail. Click the last point again or press Enter to finish.',
  point: 'Click to drop a point of interest, then name it and choose a type.',
  area: 'Click around the edge of an area. Click the first point or press Enter to close it.',
  ink: 'Click the trail line whose color you want to follow.',
  connect:
    'Choose a point on one trail, then a point on another. Pick a connector style in the sidebar. Escape cancels.',
} as const;

const TOUCH_TIPS: Record<Tool | 'trailSmart' | 'cands', string> = {
  cands: 'Tap a found line to include or leave it out, then add the selected lines in the sidebar.',
  select: 'Select trail. Tap a point or use , / .; press S or Split here. Long-press for its menu.',
  anchor: 'Tap a spot you can find on a real map, then paste its coordinates in the sidebar.',
  trailSmart: 'Tap a trail line, then tap further along it. The path follows its color.',
  trail: 'Tap to add points along the trail. Tap the last point again or use Finish trail.',
  point: 'Tap to drop a point of interest, then name it and choose a type.',
  area: 'Tap around the edge of an area. Tap the first point or use Close area.',
  ink: 'Tap the trail line whose color you want to follow.',
  connect: 'Tap a point on each trail, then choose how to connect them in the sidebar.',
};

/** The tip for the current state, or '' without a map. */
export function tipFor(s: {
  hasMap: boolean;
  tool: Tool;
  smartFollow: boolean;
  reviewing: boolean;
  coarsePointer?: boolean;
}): string {
  if (!s.hasMap) return '';
  if (s.coarsePointer) {
    if (s.reviewing && s.tool === 'select') return TOUCH_TIPS.cands;
    if (s.tool === 'trail') return TOUCH_TIPS[s.smartFollow ? 'trailSmart' : 'trail'];
    return TOUCH_TIPS[s.tool];
  }
  if (s.reviewing && s.tool === 'select') return TIPS.cands;
  if (s.tool === 'trail') return s.smartFollow ? TIPS.trailSmart : TIPS.trail;
  return TIPS[s.tool];
}

const state = () => appStore.getState();
const project = () => state().session?.project ?? null;

/* ------------------------------------------------------------------ queue */

let queue: Promise<void> = Promise.resolve();

/** Run draft work after everything queued before it. Errors are reported, never break the queue. */
function enqueue(work: () => void | Promise<void>): Promise<void> {
  queue = queue.then(work).catch((err: unknown) => {
    // A cancelled job is not an error; the worker link has already shown its own errors.
    if (isCancelled(err) || isReported(err)) return;
    showToast(err instanceof Error ? err.message : String(err));
  });
  return queue;
}

/** Resolves when all queued draft work (clicks, hops, finish/undo/cancel) has run. */
export function settled(): Promise<void> {
  return queue;
}

/* ------------------------------------------------------------------ drafting */

/** Start a trail/area draft at `at` (prototype draftClick's first click, without smart follow). */
function startDraft(kind: Draft['kind'], at: Px, ink: Rgb | null): void {
  const p = project();
  if (!p) return;
  const n = p.features.filter((f) => f.kind === kind).length + 1;
  const fallback = DEFAULT_COLORS[kind];
  setDraft({
    kind,
    pts: [at],
    cps: [1],
    ink,
    color: ink ? featureColorForInk(ink, fallback) : fallback,
    name: `${kind === 'area' ? 'Area' : 'Trail'} ${n}`,
    editId: null,
  });
}

function clampToImage([x, y]: Px): Px {
  const img = project()?.image;
  if (!img) return [x, y];
  return [Math.max(0, Math.min(img.width - 1, x)), Math.max(0, Math.min(img.height - 1, y))];
}

/** One click with the trail/area tool. `view` is the view when the click happened. */
async function draftClickNow(
  kind: Draft['kind'],
  at: PointerAt,
  view: View,
  hops: HopProvider | null,
): Promise<void> {
  const d = state().draft;
  if (!d) {
    if (!at.inside) return;
    if (!hops?.start) {
      startDraft(kind, at.px, null);
      return;
    }
    // Smart follow picks the ink and snaps the first point (T-206); the map may change meanwhile.
    const map = state().session?.map;
    let start: { at: Px; ink: Rgb | null };
    try {
      start = await hops.start(at.px, view, kind);
    } catch (err) {
      if (isCancelled(err)) return;
      throw err;
    }
    if (state().draft || state().session?.map !== map) return;
    startDraft(kind, start.at, start.ink);
    return;
  }
  const last = d.pts[d.pts.length - 1]!;
  const [lx, ly] = toScr(view, last);
  if (d.pts.length > 1 && Math.hypot(at.screen[0] - lx, at.screen[1] - ly) < FINISH_HIT_PX) {
    finishDraftNow();
    return;
  }
  if (d.kind === 'area' && d.pts.length > 2) {
    const [fx, fy] = toScr(view, d.pts[0]!);
    if (Math.hypot(at.screen[0] - fx, at.screen[1] - fy) < CLOSE_HIT_PX) {
      finishDraftNow();
      return;
    }
  }
  const to = clampToImage(at.px);
  let path: readonly Px[] | null = [to];
  if (hops) {
    try {
      path = await hops.hop(last, to, d, view);
    } catch (err) {
      // Superseded by a newer click or Esc: this click adds nothing.
      if (isCancelled(err)) return;
      throw err;
    }
    if (!path || !path.length) {
      showToast(
        'Too far to follow in one step, so a straight segment was added. Click in shorter hops.',
      );
      path = [to];
    }
  }
  // The draft may have been finished, cancelled or replaced while an async hop ran.
  const cur = state().draft;
  if (!cur || cur.cps !== d.cps) return;
  const pts = [...cur.pts, ...path];
  setDraft({ ...cur, pts, cps: [...cur.cps, pts.length] });
}

/** Finish the draft: simplify, enforce minimum points, then add (or replace) the feature. */
function finishDraftNow(): void {
  const d = state().draft;
  if (!d) return;
  // As in the prototype, the draft is gone whether or not the result is kept.
  setDraft(null);
  const min = d.kind === 'area' ? 3 : 2;
  const pts = simplify(d.pts, FINISH_SIMPLIFY_PX);
  if (pts.length < min) {
    showToast(
      d.kind === 'area' ? 'An area needs at least 3 points.' : 'A trail needs at least 2 points.',
    );
    return;
  }
  const p = project();
  if (!p) return;
  if (d.editId) {
    // The trail being continued may have been deleted meanwhile; then the draft is dropped.
    if (!p.features.some((f) => f.id === d.editId && f.kind === 'trail')) return;
    edit(replaceTrailPoints(p, d.editId, pts, d.ink), { feature: d.editId });
    return;
  }
  const spec =
    d.kind === 'area'
      ? { kind: 'area' as const, name: d.name, color: d.color, notes: '', pts }
      : { kind: 'trail' as const, name: d.name, color: d.color, notes: '', pts, ink: d.ink };
  const { command, id } = addFeature(p, spec);
  edit(command, { feature: id });
}

function draftUndoNow(): void {
  const d = state().draft;
  if (!d) return;
  const cps = d.cps.slice(0, -1);
  if (!cps.length) {
    setDraft(null);
    return;
  }
  setDraft({ ...d, pts: d.pts.slice(0, cps[cps.length - 1]), cps });
}

/** Queue one trail/area click (captured at event time). */
export function draftClick(
  kind: Draft['kind'],
  at: PointerAt,
  view: View,
  hops: HopProvider | null,
): Promise<void> {
  return enqueue(() => draftClickNow(kind, at, view, hops));
}

/** Finish the open draft (Enter, clicking the last point, switching tools). */
export function finishDraft(): Promise<void> {
  return enqueue(finishDraftNow);
}

/** Drop the open draft (Esc). */
export function cancelDraft(): Promise<void> {
  return enqueue(() => setDraft(null));
}

/** Undo the draft's last click (Backspace, or Undo while drafting). Undoing the first cancels. */
export function draftUndo(): Promise<void> {
  return enqueue(draftUndoNow);
}

/**
 * Re-open a trail as a draft that continues from its last point (prototype continueTrail).
 * Finishing replaces the trail's points as one undo step. An open draft is finished first.
 */
export function continueTrail(featureId: string): Promise<void> {
  return enqueue(() => {
    finishDraftNow();
    const f = project()?.features.find((x) => x.id === featureId);
    if (f?.kind !== 'trail') return;
    setTool('trail');
    setDraft({
      kind: 'trail',
      pts: [...f.pts],
      cps: [f.pts.length],
      ink: f.ink,
      color: f.color,
      name: f.name,
      editId: f.id,
    });
  });
}

/**
 * Switch tools. Leaving a drawing tool finishes its draft (prototype setTool), except for the
 * ink picker and for returning to the draft's own tool: the prototype also finished the draft
 * when the ink picker handed back to it, which ended a trail just for picking a color.
 */
export function chooseTool(tool: Tool): void {
  const s = state();
  if (s.draft && tool !== 'ink' && tool !== s.draft.kind) void finishDraft();
  setTool(tool);
}

/**
 * Undo (toolbar button and Ctrl+Z): the open draft's last click first, then a pending candidate
 * split under review (T-210), then the project.
 */
export function undoAction(): void {
  if (state().draft) void draftUndo();
  else if (state().reviewUndoStack.length) undoCandidateSplit();
  else undo();
}

/** Redo; does nothing while a draft is open. */
export function redoAction(): void {
  if (!state().draft) redo();
}

/* ------------------------------------------------------------------ keyboard */

/** What a key does. */
export type KeyAction =
  | 'undo'
  | 'redo'
  | 'finish'
  | 'cancel'
  | 'exitInk'
  | 'deselect'
  | 'draftUndo'
  | 'deleteSelected'
  | 'splitHere'
  | 'joinSelected'
  | 'undoSplit'
  | 'fit'
  | 'zoomIn'
  | 'zoomOut'
  | 'openHelp'
  /** Tab / Shift+Tab on the canvas (T-215): step keyboard vertex focus. Null past either end
   * releases focus instead, so plain Tab is left for the browser to move on. */
  | 'focusNextVertex'
  | 'focusPrevVertex'
  | 'stepFocusNextVertex'
  | 'stepFocusPrevVertex'
  | 'stepFocusNextVertex10'
  | 'stepFocusPrevVertex10'
  | 'releaseVertexFocus'
  | 'nudgeUp'
  | 'nudgeDown'
  | 'nudgeLeft'
  | 'nudgeRight'
  | 'deleteFocusedVertex'
  | 'panUp'
  | 'panDown'
  | 'panLeft'
  | 'panRight'
  | 'placeAtCenter'
  | 'cancelConnect'
  | 'connectFocusedPoint'
  | { readonly tool: Tool };

export interface KeyInput {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  /** Tag of the focused element (e.target), upper-case. */
  readonly targetTag: string;
  readonly targetEditable: boolean;
  /** Whether e.target is the mounted canvas itself (T-215): gates Tab and the arrow keys so they
   * don't hijack sidebar navigation or a slider's own arrow handling. */
  readonly targetIsCanvas: boolean;
}

export interface KeyContext {
  readonly hasMap: boolean;
  readonly drafting: boolean;
  readonly tool: Tool;
  readonly hasSelection: boolean;
  /** The selected trail has an interior vertex under the pointer right now (S splits it). */
  readonly canSplitHere: boolean;
  /** A second trail is shift-selected against the current one (J joins them). */
  readonly canJoin: boolean;
  /** A candidate split under review is waiting to be undone (T-210); Ctrl+Z prefers it. */
  readonly reviewCanUndo: boolean;
  /** A keyboard vertex focus (T-215) is set on the selected trail/area. */
  readonly hasVertexFocus: boolean;
  /** The selected feature has vertices Tab can step through (a trail or area, not a point). */
  readonly canFocusVertices: boolean;
  /** Enter with no draft open: the select tool places nothing; anchor, point, trail and area
   * place (or start tracing) one at the view centre instead (T-215). */
  readonly canPlaceAtCenter: boolean;
  /** A connect session can switch to Select so keyboard users can focus another trail. */
  readonly hasConnectSession?: boolean;
  /** The last canvas input was a key, not a pointer (T-215's store field of the same name).
   * While drafting, this is what tells Enter to add a point at the view centre instead of
   * finishing outright: a mouse-drafted trail still finishes on Enter as it always has. */
  readonly keyboardMode: boolean;
}

const TOOL_KEYS: Readonly<Record<string, Tool>> = {
  v: 'select',
  a: 'anchor',
  t: 'trail',
  p: 'point',
  r: 'area',
  c: 'connect',
};

/** The shortcut table (prototype keyboard handler, extended by T-215). Null means "not ours;
 * leave the key alone". */
export function keyAction(e: KeyInput, c: KeyContext): KeyAction | null {
  if (e.targetEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(e.targetTag)) return null;
  // "?" opens the shortcuts help regardless of whether a map is open (T-215 review): it's app
  // help, not a map tool, and the toolbar's own Keyboard shortcuts button works either way too.
  if (e.key === '?') return 'openHelp';
  if (!c.hasMap) return null;
  const k = e.key.toLowerCase();
  // A focused button handles its own Enter/Space.
  if (e.targetTag === 'BUTTON' && (k === 'enter' || k === ' ')) return null;
  if (e.ctrlKey || e.metaKey) {
    if (k === 'z') {
      return e.shiftKey
        ? 'redo'
        : c.drafting
          ? 'draftUndo'
          : c.reviewCanUndo
            ? 'undoSplit'
            : 'undo';
    }
    if (k === 'y' && e.ctrlKey && !e.shiftKey) return 'redo';
    return null;
  }
  if (e.altKey) return null;
  if (k === 'tab' && e.targetIsCanvas && c.tool === 'select' && c.canFocusVertices) {
    return e.shiftKey ? 'focusPrevVertex' : 'focusNextVertex';
  }
  if (e.targetIsCanvas && c.tool === 'select' && c.canFocusVertices) {
    if (k === ',' || k === '<')
      return k === '<' || e.shiftKey ? 'stepFocusPrevVertex10' : 'stepFocusPrevVertex';
    if (k === '.' || k === '>')
      return k === '>' || e.shiftKey ? 'stepFocusNextVertex10' : 'stepFocusNextVertex';
    if (k === '[') return 'stepFocusPrevVertex10';
    if (k === ']') return 'stepFocusNextVertex10';
  }
  // Arrows pan even while drafting (T-215 review: panning is how a keyboard user moves the
  // centre crosshair to the next point). Vertex focus never coexists with an open draft (it's
  // select-tool-only), so the nudge branch below is simply unreachable then.
  if (e.targetIsCanvas && k.startsWith('arrow')) {
    if (c.hasVertexFocus) {
      if (k === 'arrowup') return 'nudgeUp';
      if (k === 'arrowdown') return 'nudgeDown';
      if (k === 'arrowleft') return 'nudgeLeft';
      if (k === 'arrowright') return 'nudgeRight';
    } else {
      if (k === 'arrowup') return 'panUp';
      if (k === 'arrowdown') return 'panDown';
      if (k === 'arrowleft') return 'panLeft';
      if (k === 'arrowright') return 'panRight';
    }
  }
  if (k === 'enter') {
    if (c.drafting) return c.keyboardMode ? 'placeAtCenter' : 'finish';
    if (c.tool === 'connect' && c.hasVertexFocus) return 'connectFocusedPoint';
    return c.canPlaceAtCenter ? 'placeAtCenter' : null;
  }
  if (k === 'escape') {
    if (c.drafting) return 'cancel';
    if (c.tool === 'connect' || c.hasConnectSession) return 'cancelConnect';
    if (c.hasVertexFocus) return 'releaseVertexFocus';
    return c.tool === 'ink' ? 'exitInk' : 'deselect';
  }
  if (k === 'backspace') {
    if (c.drafting) return 'draftUndo';
    if (c.hasVertexFocus) return 'deleteFocusedVertex';
    return c.hasSelection ? 'deleteSelected' : null;
  }
  // Delete during a draft would remove the trail being continued (prototype order); ignore it.
  if (k === 'delete') {
    if (c.drafting) return null;
    if (c.hasVertexFocus) return 'deleteFocusedVertex';
    return c.hasSelection ? 'deleteSelected' : null;
  }
  if (k === 's' && c.canSplitHere) return 'splitHere';
  if (k === 'j' && c.canJoin) return 'joinSelected';
  const tool = TOOL_KEYS[k];
  if (tool) return { tool };
  if (k === 'f') return 'fit';
  if (k === '+' || k === '=') return 'zoomIn';
  if (k === '-') return 'zoomOut';
  return null;
}

/** CSS px an arrow key nudges the focused vertex; Shift multiplies it (T-215). */
export const NUDGE_PX = 1;
export const NUDGE_PX_BIG = 10;
/** CSS px an arrow key pans the view with no vertex focused; Shift multiplies it (T-215). */
export const PAN_PX = 40;
export const PAN_PX_BIG = 200;

/** Zoom step for +/- (prototype). */
export const KEY_ZOOM = 1.3;

/** Image-space direction of one nudge unit, before scaling by NUDGE_PX(_BIG) / view.s. */
const NUDGE_DELTA: Readonly<
  Record<'nudgeUp' | 'nudgeDown' | 'nudgeLeft' | 'nudgeRight', readonly [number, number]>
> = {
  nudgeUp: [0, -1],
  nudgeDown: [0, 1],
  nudgeLeft: [-1, 0],
  nudgeRight: [1, 0],
};

/**
 * Screen-space direction of one pan unit. Mirrors dragging the map: pressing an arrow moves the
 * view the way that arrow points, which is the opposite of the finger/cursor motion that would
 * produce the same result (drag left to reveal content on the right, so ArrowRight = drag-left).
 */
const PAN_DELTA: Readonly<
  Record<'panUp' | 'panDown' | 'panLeft' | 'panRight', readonly [number, number]>
> = {
  panUp: [0, 1],
  panDown: [0, -1],
  panLeft: [1, 0],
  panRight: [-1, 0],
};

/* ------------------------------------------------------------------ controller */

/** Wires one Editor's events and the window's keys to the tool behavior. */
export class Tools {
  private readonly offs: (() => void)[] = [];
  private dragCheckpoint: {
    readonly project: Project;
    readonly history: HistoryCheckpoint;
  } | null = null;
  /** Last known pointer position on the canvas, for the S (split here) shortcut. */
  private hoverScreen: Screen | null = null;
  private regionStart: Px | null = null;
  private boxCursor: Px | null = null;

  constructor(private readonly editor: Editor) {
    this.offs.push(
      editor.on('click', (e) => this.onClick(e)),
      editor.on('dragStart', (e) => this.onDrag(e, 'start')),
      editor.on('drag', (e) => this.onDrag(e, 'move')),
      editor.on('dragEnd', (e) => this.onDrag(e, 'end')),
      editor.on('contextmenu', (e) => this.onContextMenu(e)),
      editor.on('cursor', (e) => (this.hoverScreen = e?.screen ?? null)),
      // A press on the canvas is mouse (or touch) input: drop keyboard modality so the centre
      // crosshair (T-215) doesn't linger over a pointer-driven session.
      editor.on('pointerdown', () => setKeyboardMode(false)),
      appStore.subscribe((s, prev) => {
        if (s.boxSelectMode !== prev.boxSelectMode || s.session?.map !== prev.session?.map) {
          this.regionStart = null;
          this.boxCursor = null;
          editor.setRegionSelection(null);
        }
      }),
    );
    const onKey = (e: KeyboardEvent) => this.onKey(e);
    // Capture Escape and tool keys before a focused panel or toolbar button can consume them.
    window.addEventListener('keydown', onKey, true);
    this.offs.push(() => window.removeEventListener('keydown', onKey, true));
  }

  destroy(): void {
    for (const off of this.offs.splice(0)) off();
  }

  private addAnchorAt(p: NonNullable<ReturnType<typeof project>>, px: Px): void {
    const { command, id } = addAnchor(p, px);
    edit(command, { anchor: id });
    requestFocus('anchor', id);
  }

  private addPointAt(p: NonNullable<ReturnType<typeof project>>, px: Px): void {
    const n = p.features.filter((f) => f.kind === 'poi').length + 1;
    const { command, id } = addFeature(p, {
      kind: 'poi',
      name: `Point ${n}`,
      color: DEFAULT_COLORS.poi,
      notes: '',
      at: px,
      poiType: 'Waypoint',
    });
    edit(command, { feature: id });
    requestFocus('feature-name', id);
  }

  private onClick(e: EditorEvents['click']): void {
    if (e.target?.kind === 'region') {
      if (e.target.purpose === 'select' && state().boxSelectMode) {
        if (this.regionStart) this.finishBox(this.regionStart, e.px);
        else {
          this.regionStart = e.px;
          this.boxCursor = e.px;
          this.editor.setRegionSelection({ from: e.px, to: e.px });
          showToast('Choose the opposite corner, or drag a rectangle.');
        }
      }
      return;
    }
    const s = state();
    const p = s.session?.project;
    if (!p) return;
    if (s.vertexMenu) openVertexMenu(null);
    switch (s.tool) {
      case 'select': {
        if (e.target?.kind === 'anchor') {
          selectAnchor(e.target.id);
          return;
        }
        // Reviewing auto-trace results: a click toggles the candidate under it, Alt-click splits
        // it at that point (T-210).
        if (s.candidates) {
          const c = hitCandidate(s.candidates, this.editor.view, e.screen);
          if (c && e.altKey) {
            splitReviewedCandidate(c.id, e.px, this.editor.view.s);
            return;
          }
          if (c) {
            setCandidateOn(c.id, !c.on);
            return;
          }
        }
        const hit = hitFeature(p.features, this.editor.view, e.screen);
        if (s.joinArmed) {
          setJoinArmed(false);
          if (hit?.kind === 'trail' && s.selectedFeatureId && hit.id !== s.selectedFeatureId) {
            selectSecondFeature(hit.id);
            joinSelected();
            return;
          }
        }
        // Shift-click a second, different trail while one is already selected: arm "Join trails"
        // (T-209). Any other shift-click falls through to a plain select, which drops the arm.
        if (e.shiftKey && hit?.kind === 'trail' && s.selectedFeatureId) {
          const primary = p.features.find((x) => x.id === s.selectedFeatureId);
          if (primary?.kind === 'trail' && primary.id !== hit.id) {
            selectSecondFeature(hit.id);
            return;
          }
        }
        selectFeature(hit?.id ?? null);
        return;
      }
      case 'anchor': {
        if (e.target?.kind === 'anchor') {
          selectAnchor(e.target.id);
          return;
        }
        if (!e.inside) return;
        this.addAnchorAt(p, e.px);
        return;
      }
      case 'point': {
        if (!e.inside) return;
        this.addPointAt(p, e.px);
        return;
      }
      case 'connect': {
        const connect = s.connectSession ?? {
          points: [],
          mode: null,
          connector: null,
          drawing: false,
        };
        if (connect.mode === 'draw' && connect.drawing && connect.points.length === 2) {
          if (!e.inside) return;
          const path = connect.connector ?? [connect.points[0]!.point, connect.points[1]!.point];
          setConnectSession({
            ...connect,
            connector: [...path.slice(0, -1), e.px, path[path.length - 1]!],
          });
          return;
        }
        if (connect.mode) return;
        if (!e.inside) return;
        const target = e.target?.kind === 'vertex' ? e.target : null;
        const hit = target
          ? p.features.find((f) => f.id === target.featureId)
          : hitFeature(p.features, this.editor.view, e.screen);
        if (!hit || hit.kind !== 'trail') {
          showToast('Choose a point on a trail');
          return;
        }
        const point: TrailPoint =
          target && target.featureId === hit.id
            ? {
                trailId: hit.id,
                segmentIndex: Math.min(target.index, hit.pts.length - 2),
                point: hit.pts[target.index]!,
              }
            : projectTrailPoint(hit, e.px);
        if (!connect.points.length) {
          setConnectSession({ points: [point], mode: null, connector: null, drawing: false });
          return;
        }
        const first = connect.points[0]!;
        if (
          Math.hypot(first.point[0] - point.point[0], first.point[1] - point.point[1]) <
          8 / this.editor.view.s
        ) {
          showToast('Choose points farther apart');
          return;
        }
        setConnectSession({ points: [first, point], mode: null, connector: null, drawing: false });
        return;
      }
      case 'trail':
      case 'area':
        // A new click supersedes the hop still tracing (acceptance: hops are cancellable).
        this.editor.hopProvider?.cancel?.();
        void draftClick(s.tool, e, this.editor.view, this.editor.hopProvider);
        return;
      case 'ink':
        // The ink picker is wired by T-206 (smart follow / auto-trace color picking).
        return;
    }
  }

  private finishBox(from: Px, to: Px): void {
    const rect = {
      x: Math.min(from[0], to[0]),
      y: Math.min(from[1], to[1]),
      width: Math.abs(to[0] - from[0]),
      height: Math.abs(to[1] - from[1]),
    };
    this.editor.setRegionSelection(null);
    this.regionStart = null;
    this.boxCursor = null;
    if (rect.width < 2 || rect.height < 2) {
      showToast('Choose a larger rectangle to select trails.');
      return;
    }
    selectTrailsInRect(rect);
    setBoxSelectMode(false);
  }

  private onDrag(
    e: PointerAt & { readonly target: DragTarget; readonly cancelled?: boolean },
    phase: 'start' | 'move' | 'end',
  ): void {
    const p = project();
    if (!p) return;
    if (e.target.kind === 'region') {
      if (phase === 'start') this.regionStart = e.target.start;
      const start = this.regionStart ?? e.target.start;
      if (phase !== 'end') {
        this.editor.setRegionSelection({ from: start, to: e.px });
      } else {
        this.editor.setRegionSelection(null);
        this.regionStart = null;
        if (e.target.purpose === 'select') {
          if (!e.cancelled && state().boxSelectMode) this.finishBox(start, e.px);
          else setBoxSelectMode(false);
          return;
        }
        setRegionTraceMode(false);
        if (!e.cancelled) {
          const rect = {
            x: Math.min(start[0], e.px[0]),
            y: Math.min(start[1], e.px[1]),
            width: Math.abs(e.px[0] - start[0]),
            height: Math.abs(e.px[1] - start[1]),
          };
          if (rect.width >= 2 && rect.height >= 2) void autoTraceRegion(rect);
          else showToast('Drag a larger rectangle around the trails to trace.');
        }
      }
      return;
    }
    if (phase === 'end' && e.cancelled) {
      if (this.dragCheckpoint) {
        restoreCancelledDrag(this.dragCheckpoint.project, this.dragCheckpoint.history);
        this.dragCheckpoint = null;
      } else if (e.target.kind === 'anchor') {
        setAnchorDragging(false);
      }
      return;
    }
    // One undo step per drag: never merge into an earlier edit with the same key.
    if (phase === 'start') {
      this.dragCheckpoint = { project: p, history: checkpointHistory() };
      sealHistory();
      if (e.target.kind === 'anchor') {
        selectAnchor(e.target.id);
        // Leave-one-out residuals wait until the pin is dropped (T-208).
        setAnchorDragging(true);
      }
    }
    const t = e.target;
    if (t.kind === 'anchor') {
      if (p.anchors.some((a) => a.id === t.id)) edit(moveAnchor(p, t.id, e.px));
    } else if (p.features.some((f) => f.id === t.featureId)) {
      edit(moveVertex(p, t.featureId, t.index, e.px));
    }
    if (phase === 'end') {
      sealHistory();
      this.dragCheckpoint = null;
      if (t.kind === 'anchor') setAnchorDragging(false);
    }
  }

  /** Right-click a vertex of the selected trail/area: open the menu (delete, split). T-209. */
  private onContextMenu(e: EditorEvents['contextmenu']): void {
    const s = state();
    const p = s.session?.project;
    if (!p || s.tool !== 'select') {
      openVertexMenu(null);
      return;
    }
    const f = p.features.find((x) => x.id === s.selectedFeatureId);
    const index = hitVertex(f, this.editor.view, e.screen);
    if (!f || f.kind === 'poi' || index < 0) {
      openVertexMenu(null);
      return;
    }
    openVertexMenu({
      featureId: f.id,
      index,
      canSplit: canSplitAt(f, index),
      client: this.editor.imageToClient(f.pts[index]!),
    });
  }

  private onKey(e: KeyboardEvent): void {
    const s = state();
    const boxTyping =
      e.target instanceof HTMLElement &&
      (e.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName));
    if (
      !s.helpOpen &&
      !boxTyping &&
      s.session &&
      !s.draft &&
      !s.job &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.altKey
    ) {
      if (e.key.toLowerCase() === 'b') {
        e.preventDefault();
        setBoxSelectMode(!s.boxSelectMode);
        this.editor.element?.focus();
        setKeyboardMode(true);
        return;
      }
      if (
        s.boxJoinPreview &&
        (e.key === 'Escape' || (e.key === 'Enter' && e.target === this.editor.element))
      ) {
        e.preventDefault();
        if (e.key === 'Escape') cancelAutoJoin();
        else applyAutoJoin();
        return;
      }
      if (
        !s.boxSelectMode &&
        s.tool === 'select' &&
        (s.selectedTrailIds?.length ?? 0) >= 2 &&
        e.key.toLowerCase() === 'j'
      ) {
        e.preventDefault();
        previewAutoJoin(this.editor.view.s);
        return;
      }
      if (s.boxSelectMode) {
        if (e.key === 'Escape') {
          e.preventDefault();
          setBoxSelectMode(false);
          return;
        }
        if (e.target === this.editor.element && e.key === 'Enter') {
          e.preventDefault();
          if (this.regionStart && this.boxCursor) this.finishBox(this.regionStart, this.boxCursor);
          else {
            this.regionStart = this.editor.centerPointerAt().px;
            this.boxCursor = this.regionStart;
            this.editor.setRegionSelection({ from: this.regionStart, to: this.boxCursor });
            announce(
              'First box corner set. Use arrows to size the rectangle, then Enter to select trails.',
            );
          }
          return;
        }
        if (
          e.target === this.editor.element &&
          this.regionStart &&
          this.boxCursor &&
          e.key.startsWith('Arrow')
        ) {
          e.preventDefault();
          const step = (e.shiftKey ? 100 : 20) / this.editor.view.s;
          const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
          const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
          const p = s.session.project;
          this.boxCursor = [
            Math.max(0, Math.min(p.image.width, this.boxCursor[0] + dx)),
            Math.max(0, Math.min(p.image.height, this.boxCursor[1] + dy)),
          ];
          this.editor.setRegionSelection({ from: this.regionStart, to: this.boxCursor });
          announce(
            `Box ${Math.round(Math.abs(this.boxCursor[0] - this.regionStart[0]))} by ${Math.round(Math.abs(this.boxCursor[1] - this.regionStart[1]))} map pixels.`,
          );
          return;
        }
      }
    }
    if (s.regionTraceMode && e.key === 'Escape') {
      e.preventDefault();
      setRegionTraceMode(false);
      this.regionStart = null;
      this.editor.setRegionSelection(null);
      return;
    }
    const target = e.target instanceof HTMLElement ? e.target : null;
    const typing =
      target !== null &&
      (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
    if (
      s.regionTraceMode &&
      !s.helpOpen &&
      !typing &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.altKey &&
      e.key.toLowerCase() === 'v'
    ) {
      e.preventDefault();
      const region = this.editor.visibleMapRegion;
      setRegionTraceMode(false);
      this.regionStart = null;
      this.editor.setRegionSelection(null);
      if (region) void autoTraceRegion(region);
      return;
    }
    // The help dialog (T-215) traps its own keys (focusTrap.ts, capture phase + stopPropagation);
    // this bubble-phase listener shouldn't also fire a tool shortcut underneath it.
    if (s.helpOpen) return;
    // The vertex menu (T-209) takes Esc before the window handler's own deselect.
    if (s.vertexMenu && e.key === 'Escape') {
      e.preventDefault();
      openVertexMenu(null);
      return;
    }
    const selected = s.session?.project.features.find((x) => x.id === s.selectedFeatureId);
    const focus = s.vertexFocus;
    const focusedIndex = focus && selected && focus.featureId === selected.id ? focus.index : -1;
    const hoverIndex =
      s.tool === 'select' && this.hoverScreen
        ? hitVertex(selected, this.editor.view, this.hoverScreen)
        : -1;
    // A focused vertex (keyboard) takes priority over whatever the mouse last hovered (T-215).
    const activeIndex = focusedIndex >= 0 ? focusedIndex : hoverIndex;
    const action = keyAction(
      {
        key: e.key,
        ctrlKey: e.ctrlKey,
        metaKey: e.metaKey,
        shiftKey: e.shiftKey,
        altKey: e.altKey,
        targetTag: target?.tagName ?? '',
        targetEditable: target?.isContentEditable ?? false,
        targetIsCanvas: target !== null && target === this.editor.element,
      },
      {
        hasMap: s.session !== null,
        drafting: s.draft !== null,
        tool: s.tool,
        hasSelection: s.selectedFeatureId !== null,
        canSplitHere: selected ? canSplitAt(selected, activeIndex) : false,
        canJoin: s.tool === 'select' && s.secondSelectedFeatureId !== null,
        reviewCanUndo: s.reviewUndoStack.length > 0,
        hasVertexFocus: focusedIndex >= 0,
        canFocusVertices: stepCount(selected) > 0,
        canPlaceAtCenter:
          !s.draft &&
          (s.tool === 'anchor' || s.tool === 'point' || s.tool === 'trail' || s.tool === 'area'),
        hasConnectSession: s.connectSession !== null,
        keyboardMode: s.keyboardMode,
      },
    );
    if (action === null) return;
    e.preventDefault();
    if (typeof action === 'object') {
      chooseTool(action.tool);
      return;
    }
    switch (action) {
      case 'cancelConnect':
        e.stopPropagation();
        this.editor.hopProvider?.cancel?.();
        setConnectSession(null);
        return;
      case 'connectFocusedPoint': {
        const trail = selected;
        if (!trail || trail.kind !== 'trail' || focusedIndex < 0) return;
        const segmentIndex = Math.min(focusedIndex, trail.pts.length - 2);
        const point: TrailPoint = {
          trailId: trail.id,
          segmentIndex,
          point: trail.pts[focusedIndex]!,
        };
        const existing = state().connectSession;
        if (!existing?.points.length)
          setConnectSession({ points: [point], mode: null, connector: null, drawing: false });
        else if (
          Math.hypot(
            existing.points[0]!.point[0] - point.point[0],
            existing.points[0]!.point[1] - point.point[1],
          ) >=
          8 / this.editor.view.s
        ) {
          setConnectSession({
            ...existing,
            points: [existing.points[0]!, point],
            mode: null,
            connector: null,
            drawing: false,
          });
        }
        return;
      }
      case 'undo':
        undo();
        return;
      case 'redo':
        redoAction();
        return;
      case 'draftUndo':
        this.editor.hopProvider?.cancel?.();
        void draftUndo();
        return;
      case 'finish':
        void finishDraft();
        return;
      case 'cancel':
        this.editor.hopProvider?.cancel?.();
        void cancelDraft();
        return;
      case 'exitInk':
        chooseTool(s.prevTool);
        return;
      case 'deselect':
        selectFeature(null);
        return;
      case 'deleteSelected': {
        const p = project();
        const id = s.selectedFeatureId;
        if (p && id && p.features.some((f) => f.id === id)) edit(deleteFeature(p, id));
        return;
      }
      case 'splitHere':
        if (selected && activeIndex >= 0) splitHere(selected.id, activeIndex);
        return;
      case 'joinSelected':
        joinSelected();
        return;
      case 'undoSplit':
        undoCandidateSplit();
        return;
      case 'fit':
        this.editor.fitView();
        return;
      case 'zoomIn':
        this.editor.zoomBy(KEY_ZOOM);
        return;
      case 'zoomOut':
        this.editor.zoomBy(1 / KEY_ZOOM);
        return;
      case 'openHelp':
        setHelpOpen(true);
        return;
      case 'focusNextVertex':
        sealHistory();
        setKeyboardMode(true);
        setVertexFocus(stepVertexFocus(focus, selected, 1));
        return;
      case 'stepFocusNextVertex':
        sealHistory();
        setKeyboardMode(true);
        setVertexFocus(moveVertexFocus(focus, selected, 1));
        return;
      case 'stepFocusNextVertex10':
        sealHistory();
        setKeyboardMode(true);
        setVertexFocus(moveVertexFocus(focus, selected, 1, 10));
        return;
      case 'focusPrevVertex':
        sealHistory();
        setKeyboardMode(true);
        setVertexFocus(stepVertexFocus(focus, selected, -1));
        return;
      case 'stepFocusPrevVertex':
        sealHistory();
        setKeyboardMode(true);
        setVertexFocus(moveVertexFocus(focus, selected, -1));
        return;
      case 'stepFocusPrevVertex10':
        sealHistory();
        setKeyboardMode(true);
        setVertexFocus(moveVertexFocus(focus, selected, -1, 10));
        return;
      case 'releaseVertexFocus':
        sealHistory();
        setVertexFocus(null);
        return;
      case 'nudgeUp':
      case 'nudgeDown':
      case 'nudgeLeft':
      case 'nudgeRight':
        setKeyboardMode(true);
        this.nudgeFocusedVertex(action, e.shiftKey);
        return;
      case 'deleteFocusedVertex':
        this.deleteFocusedVertex();
        return;
      case 'panUp':
      case 'panDown':
      case 'panLeft':
      case 'panRight': {
        setKeyboardMode(true);
        const step = e.shiftKey ? PAN_PX_BIG : PAN_PX;
        const [dx, dy] = PAN_DELTA[action];
        this.editor.panBy(dx * step, dy * step);
        return;
      }
      case 'placeAtCenter': {
        const p = project();
        if (!p) return;
        setKeyboardMode(true);
        const at = this.editor.centerPointerAt();
        // An open trail/area draft (T-215 review): add a point at the view centre through the
        // normal click path, whose own "click near the last point" check doubles as "press
        // Enter again without panning to finish" -- the DraftBar's Finish button still finishes
        // outright from anywhere, keyboard-reachable like every other panel control.
        if (s.draft) {
          this.editor.hopProvider?.cancel?.();
          void draftClick(s.draft.kind, at, this.editor.view, this.editor.hopProvider);
          return;
        }
        if (s.tool === 'anchor') this.addAnchorAt(p, clampToImage(at.px));
        else if (s.tool === 'point') this.addPointAt(p, clampToImage(at.px));
        else if (s.tool === 'trail' || s.tool === 'area') {
          void draftClick(s.tool, at, this.editor.view, this.editor.hopProvider);
        }
        return;
      }
    }
  }

  /** Move the keyboard-focused vertex by one nudge unit (T-215); Shift takes the large step. */
  private nudgeFocusedVertex(
    action: 'nudgeUp' | 'nudgeDown' | 'nudgeLeft' | 'nudgeRight',
    big: boolean,
  ): void {
    const focus = state().vertexFocus;
    const p = project();
    if (!p || !focus) return;
    const f = p.features.find((x) => x.id === focus.featureId);
    if (!f || f.kind === 'poi' || focus.index >= f.pts.length) return;
    const step = (big ? NUDGE_PX_BIG : NUDGE_PX) / this.editor.view.s;
    const [dx, dy] = NUDGE_DELTA[action];
    const [x, y] = f.pts[focus.index]!;
    edit(moveVertex(p, f.id, focus.index, clampToImage([x + dx * step, y + dy * step])));
  }

  /** Delete the keyboard-focused vertex (T-215). The store reclamps focus onto the vertex that
   * lands at the same index, or clears it when that was the trail/area's last removable point
   * (deleteVertex's own refusal toast explains why). */
  private deleteFocusedVertex(): void {
    const focus = state().vertexFocus;
    const p = project();
    if (!p || !focus) return;
    sealHistory();
    edit(deleteVertex(p, focus.featureId, focus.index));
  }
}
