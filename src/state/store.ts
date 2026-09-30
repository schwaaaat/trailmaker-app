// Lane B. The app store (card T-201): the Session plus UI state, and the only path by which
// the Project changes (edit/undo/redo through History). Port of the prototype's `S` object.
// No React here; hooks.ts wraps this store for components.
import { createStore } from 'zustand/vanilla';
import { fitAnchors } from '../core/geo/fit';
import { withLooResiduals } from '../core/geo/loo';
import type {
  Anchor,
  AnchorId,
  AutoTraceCandidate,
  FeatureId,
  FitMethod,
  FitResult,
  HexColor,
  HistoryCommand,
  ImageId,
  Project,
  Px,
  Rgb,
} from '../core/types';
import type { Session } from '../ui/contract';
import { baseOf, type EditRefusal } from './commands';
import { History } from './history';
import type { CandidateSplitFocus } from './candidate-split-focus';
import { clampVertexFocus, type VertexFocus } from './vertex-focus';
import type { TrailPoint } from '../core/topology';

export type { CandidateSplitFocus } from './candidate-split-focus';
export type { VertexFocus } from './vertex-focus';

/** Editor tools (prototype: select, gcp, trail, point, area, ink). */
export type Tool = 'select' | 'anchor' | 'trail' | 'point' | 'area' | 'ink' | 'connect';

export interface ConnectSession {
  readonly points: readonly TrailPoint[];
  readonly mode: 'straight' | 'follow' | 'draw' | null;
  readonly connector: readonly Px[] | null;
  readonly drawing: boolean;
}

/** A trail or area being drawn. Not part of the undoable project (prototype `S.draft`). */
export interface Draft {
  readonly kind: 'trail' | 'area';
  /** Vertices so far. */
  readonly pts: readonly Px[];
  /** pts.length after each click, so draft-undo can drop a whole smart-follow hop. */
  readonly cps: readonly number[];
  /** Ink being followed, or null. */
  readonly ink: Rgb | null;
  readonly color: HexColor;
  readonly name: string;
  /** Trail being continued, or null for a new feature. */
  readonly editId: FeatureId | null;
}

/** An auto-trace candidate under review. Not persisted. */
export interface ReviewCandidate extends AutoTraceCandidate {
  /** Ticked for acceptance. */
  readonly on: boolean;
  /** Name the accepted trail gets. */
  readonly name: string;
  /** Color the accepted trail gets. */
  readonly color: HexColor;
}

/** A transient message. id changes on every toast so identical messages re-show. */
export interface Toast {
  readonly id: number;
  readonly message: string;
  readonly ms: number;
}

/** Undo/redo availability, mirrored into the store so components can react to it. */
export interface HistoryStatus {
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly undoLabel: string | null;
  readonly redoLabel: string | null;
}

/** Right-click menu on a trail/area vertex (T-209): delete it, or split the trail there. */
export interface VertexMenu {
  readonly featureId: FeatureId;
  readonly index: number;
  /** Interior vertex of a trail: splitting is offered. */
  readonly canSplit: boolean;
  /** Page coordinates to anchor the floating menu at. */
  readonly client: { readonly x: number; readonly y: number };
}

/** A request for a panel to focus one of its inputs (the anchors list, the feature name field). */
export interface FocusRequest {
  readonly target: 'anchor' | 'feature-name';
  readonly id: string;
  /** Increments on every request, so asking twice for the same id re-focuses. */
  readonly n: number;
}

/** A long worker job shown inline with progress and Cancel (scan colors, find trails). */
export interface JobStatus {
  readonly kind: 'scan' | 'auto';
  readonly jobId: string;
  /** 0..1. */
  readonly fraction: number;
  /** Human-readable stage, e.g. "Finding Red lines (1 of 2)". */
  readonly stage: string;
}

export interface AppState {
  /** Open map + project, or null before a map is opened. */
  readonly session: Session | null;
  readonly tool: Tool;
  /** Drawing tool to return to after the ink picker (prototype prevTool). */
  readonly prevTool: Tool;
  readonly selectedFeatureId: FeatureId | null;
  readonly selectedAnchorId: AnchorId | null;
  /** A second trail shift-clicked to arm "Join trails" (T-209), or null. */
  readonly secondSelectedFeatureId: FeatureId | null;
  /** Touch join mode: the next tapped trail joins the selected trail (T-219). */
  /** Optional so hand-built state fixtures in other lanes remain structurally valid. */
  readonly joinArmed?: boolean;
  /** Active panel in the narrow georeferencing stage, coordinated with Lane C (T-219/T-315). */
  /** Optional so hand-built state fixtures in other lanes remain structurally valid. */
  readonly stageView?: 'map' | 'basemap' | 'overlay';
  /** Right-click vertex menu (T-209), or null when closed. */
  readonly vertexMenu: VertexMenu | null;
  /** Keyboard vertex focus on the selected trail/area (T-215: Tab/arrows/Delete), or null. */
  readonly vertexFocus: VertexFocus | null;
  /**
   * The last canvas input was a key, not a pointer (T-215). Drives the view-centre crosshair
   * that shows where Enter places a point; a click or drag clears it.
   */
  readonly keyboardMode: boolean;
  readonly draft: Draft | null;
  /** Auto-trace candidates awaiting review, or null when not reviewing. */
  readonly candidates: readonly ReviewCandidate[] | null;
  /** Busy overlay text, or null when idle. */
  readonly busy: string | null;
  /**
   * Cancels the job behind the busy overlay (its Cancel button), or null when not cancellable.
   * Optional so hand-built AppState literals in other lanes' tests still type-check.
   */
  readonly busyCancel?: (() => void) | null;
  readonly toast: Toast | null;
  readonly focusRequest: FocusRequest | null;
  /** Worker handle of the current map's raster, once loaded. */
  readonly imageId: ImageId | null;
  /** The running scan / auto-trace job, or null. */
  readonly job: JobStatus | null;
  /** What the ink picker tool is picking for (prototype inkFor). */
  readonly inkFor: 'trace' | 'chip' | null;
  /** Ink picked automatically from the last draft's first click (swatch display; not persisted). */
  readonly lastInk: Rgb | null;
  /** An anchor pin is being dragged: the fit skips leave-one-out work until it ends (T-208). */
  readonly anchorDragging: boolean;
  /** "Join colors that continue each other" in Find trails (T-210); a UI preference, not persisted. */
  readonly mergeAcrossColors: boolean;
  /**
   * Candidate lists this review has split from, most recent last (T-210 "Undo split").
   * Cleared on a new find, discard, accept, or openSession; never touches project history.
   */
  readonly reviewUndoStack: readonly (readonly ReviewCandidate[])[];
  /**
   * Bumped only by `setCandidates` (a fresh find-trails result, or clearing on accept/discard),
   * not by in-review edits like a split or tick (T-216). Lets the review list's row-batching
   * reset for a new review without resetting on every tick/split.
   */
  readonly reviewEpoch: number;
  /** Keyboard split-point focus within a candidate under review (T-217). */
  readonly candidateSplitFocus?: CandidateSplitFocus | null;
  readonly history: HistoryStatus;
  /** The keyboard shortcuts help dialog (T-215) is open. */
  readonly helpOpen: boolean;
  /** Request to open satellite capture framing overlay (card T-318, D-031). */
  readonly satelliteCaptureRequested?: boolean;
  /** Live preview of a simplified/smoothed trail or area before Apply (T-222). */
  readonly simplifyPreview?: { readonly featureId: FeatureId; readonly pts: readonly Px[] } | null;
  /**
   * The app-wide polite live region (T-215): undo/redo and vertex-focus changes, so screen
   * readers hear them without a visible toast. `id` changes on every announcement so repeating
   * the same text still gets read.
   */
  readonly announcement: { readonly id: number; readonly text: string } | null;
  readonly connectSession?: ConnectSession | null;
}

const history = new History();
export type HistoryCheckpoint = ReturnType<History['checkpoint']>;

function historyStatus(): HistoryStatus {
  return {
    canUndo: history.canUndo,
    canRedo: history.canRedo,
    undoLabel: history.undoLabel,
    redoLabel: history.redoLabel,
  };
}

const initialState: AppState = {
  session: null,
  tool: 'select',
  prevTool: 'trail',
  selectedFeatureId: null,
  selectedAnchorId: null,
  secondSelectedFeatureId: null,
  joinArmed: false,
  stageView: 'map',
  vertexMenu: null,
  vertexFocus: null,
  keyboardMode: false,
  draft: null,
  candidates: null,
  busy: null,
  busyCancel: null,
  toast: null,
  focusRequest: null,
  imageId: null,
  job: null,
  inkFor: null,
  lastInk: null,
  anchorDragging: false,
  mergeAcrossColors: true,
  reviewUndoStack: [],
  reviewEpoch: 0,
  candidateSplitFocus: null,
  history: historyStatus(),
  helpOpen: false,
  satelliteCaptureRequested: false,
  simplifyPreview: null,
  announcement: null,
  connectSession: null,
};

/** The one app store. */
export const appStore = createStore<AppState>()(() => initialState);

/* ---------------------------------------------------------------- session & history */

/** Replace the whole session (open file, restore autosave). Clears history and transient UI state. */
export function openSession(session: Session): void {
  history.clear();
  appStore.setState({
    session,
    selectedFeatureId: null,
    selectedAnchorId: null,
    secondSelectedFeatureId: null,
    joinArmed: false,
    stageView: 'map',
    vertexMenu: null,
    vertexFocus: null,
    draft: null,
    candidates: null,
    reviewUndoStack: [],
    candidateSplitFocus: null,
    connectSession: null,
    busy: null,
    busyCancel: null,
    job: null,
    anchorDragging: false,
    satelliteCaptureRequested: false,
    inkFor: null,
    lastInk: null,
    simplifyPreview: null,
    history: historyStatus(),
  });
}

/**
 * Store a new project after a history operation, dropping selections that no longer exist.
 * The vertex menu always closes (its index may no longer point at the same vertex).
 */
function commitProject(project: Project, extra: Partial<AppState> = {}): void {
  const s = appStore.getState();
  if (!s.session) return;
  const selectedFeatureId =
    extra.selectedFeatureId !== undefined ? extra.selectedFeatureId : s.selectedFeatureId;
  const selectedAnchorId =
    extra.selectedAnchorId !== undefined ? extra.selectedAnchorId : s.selectedAnchorId;
  const secondSelectedFeatureId =
    extra.secondSelectedFeatureId !== undefined
      ? extra.secondSelectedFeatureId
      : s.secondSelectedFeatureId;
  const resolvedFeatureId = project.features.some((f) => f.id === selectedFeatureId)
    ? selectedFeatureId
    : null;
  // Revalidate against the new project, then drop it if it no longer belongs to the resulting
  // selection: a stale vertex focus pointing at a different (or deselected) feature would draw
  // its ring on the wrong trail.
  const clampedFocus = clampVertexFocus(
    extra.vertexFocus !== undefined ? extra.vertexFocus : s.vertexFocus,
    project.features,
  );
  appStore.setState({
    ...extra,
    session: { ...s.session, project },
    selectedFeatureId: resolvedFeatureId,
    selectedAnchorId: project.anchors.some((a) => a.id === selectedAnchorId)
      ? selectedAnchorId
      : null,
    secondSelectedFeatureId: project.features.some((f) => f.id === secondSelectedFeatureId)
      ? secondSelectedFeatureId
      : null,
    vertexMenu: null,
    vertexFocus: clampedFocus && clampedFocus.featureId === resolvedFeatureId ? clampedFocus : null,
    simplifyPreview: null,
    history: historyStatus(),
  });
}

/**
 * Run an edit. A refusal is shown as a toast instead. `select` optionally changes the
 * selection in the same state update. Returns whether the edit was applied.
 */
export function edit(
  cmd: HistoryCommand | EditRefusal,
  select: { feature?: FeatureId | null; anchor?: AnchorId | null } = {},
): boolean {
  if ('error' in cmd) {
    showToast(cmd.error);
    return false;
  }
  const session = appStore.getState().session;
  if (!session) throw new Error('No session is open');
  const base = baseOf(cmd);
  if (base && base !== session.project) {
    throw new Error(`Stale command "${cmd.label}": build it from the current project`);
  }
  const extra: Partial<AppState> = {};
  if (select.feature !== undefined) Object.assign(extra, { selectedFeatureId: select.feature });
  if (select.anchor !== undefined) Object.assign(extra, { selectedAnchorId: select.anchor });
  commitProject(history.execute(session.project, cmd), extra);
  return true;
}

/** Undo one step. Returns false (and toasts, as the prototype does) when there is nothing to undo. */
export function undo(): boolean {
  const session = appStore.getState().session;
  const label = history.undoLabel;
  const project = session ? history.undo(session.project) : null;
  if (!project) {
    showToast('Nothing to undo');
    return false;
  }
  commitProject(project);
  announce(label ? `Undid ${label}` : 'Undid last change');
  return true;
}

/** Redo one step. Returns false when there is nothing to redo. */
export function redo(): boolean {
  const session = appStore.getState().session;
  const label = history.redoLabel;
  const project = session ? history.redo(session.project) : null;
  if (!project) {
    showToast('Nothing to redo');
    return false;
  }
  commitProject(project);
  announce(label ? `Redid ${label}` : 'Redid last change');
  return true;
}

/** End the current coalescing run (call on blur of a text field or at the end of a drag). */
export function sealHistory(): void {
  history.seal();
}

/** Snapshot undo and redo state before a gesture whose continuation may be cancelled. */
export function checkpointHistory(): HistoryCheckpoint {
  return history.checkpoint();
}

/** Restore the project and exact history stacks after a drag turns into a pinch. */
export function restoreCancelledDrag(project: Project, restoreHistory: HistoryCheckpoint): void {
  if (!appStore.getState().session) return;
  restoreHistory();
  commitProject(project, { anchorDragging: false });
}

/* ---------------------------------------------------------------- UI state */

/** Set the active tool; drawing tools are remembered as prevTool (the ink picker returns there). */
export function setTool(tool: Tool): void {
  const draws = tool === 'trail' || tool === 'point' || tool === 'area';
  appStore.setState({
    ...(draws ? { prevTool: tool } : {}),
    tool,
  });
}

export function setConnectSession(connectSession: ConnectSession | null): void {
  appStore.setState({ connectSession });
}

let focusSeq = 0;

/** Ask the panel owning `target` to focus its input for `id` (consumed by T-205 panels). */
export function requestFocus(target: FocusRequest['target'], id: string): void {
  appStore.setState({ focusRequest: { target, id, n: ++focusSeq } });
}

/** Select a feature. Changing the primary selection drops any armed join, open vertex menu and
 * keyboard vertex focus (T-215): a focus ring belongs to the feature it was stepped onto. */
export function selectFeature(id: FeatureId | null): void {
  appStore.setState({
    selectedFeatureId: id,
    secondSelectedFeatureId: null,
    joinArmed: false,
    vertexMenu: null,
    vertexFocus: null,
    simplifyPreview: null,
  });
}

/** Set or clear the live simplify preview for a feature (T-222). */
export function setSimplifyPreview(
  preview: { readonly featureId: FeatureId; readonly pts: readonly Px[] } | null,
): void {
  appStore.setState({ simplifyPreview: preview });
}

/** Arm the touch join flow or clear it after the next map tap (T-219). */
export function setJoinArmed(joinArmed: boolean): void {
  appStore.setState({ joinArmed });
}

/** Choose a map, basemap or overlay pane in the narrow stage (T-219/T-315). */
export function setStageView(stageView: NonNullable<AppState['stageView']>): void {
  appStore.setState({ stageView });
}

/** Request opening satellite capture framing overlay (card T-318). */
export function requestSatelliteCapture(requested = true): void {
  appStore.setState({ satelliteCaptureRequested: requested });
}

/** Clear the satellite capture request flag (card T-318). */
export function clearSatelliteCaptureRequest(): void {
  appStore.setState({ satelliteCaptureRequested: false });
}

export function selectAnchor(id: AnchorId | null): void {
  appStore.setState({ selectedAnchorId: id });
}

/**
 * Set (or with null, clear) keyboard vertex focus (T-215/T-223). Announces
 * "Point n of m" through the live region when focus lands on a vertex; clearing it stays quiet
 * so leaving the canvas or deselecting doesn't spam the region.
 */
export function setVertexFocus(focus: VertexFocus | null): void {
  appStore.setState({ vertexFocus: focus });
  if (!focus) return;
  const f = appStore.getState().session?.project.features.find((x) => x.id === focus.featureId);
  const n = f && f.kind !== 'poi' ? f.pts.length : 0;
  if (n) announce(`Point ${focus.index + 1} of ${n}`);
}

/** T-215: a keydown the tools recognise sets this; a canvas click or drag clears it. */
export function setKeyboardMode(v: boolean): void {
  if (appStore.getState().keyboardMode !== v) appStore.setState({ keyboardMode: v });
}

/** Open (or close) the keyboard shortcuts help dialog (T-215, the "?" key). */
export function setHelpOpen(v: boolean): void {
  appStore.setState({ helpOpen: v });
}

/** Arm (or disarm, with null) "Join trails" against a shift-clicked second trail (T-209). */
export function selectSecondFeature(id: FeatureId | null): void {
  appStore.setState({ secondSelectedFeatureId: id });
}

/** Open (or close, with null) the right-click vertex menu (T-209). */
export function openVertexMenu(menu: VertexMenu | null): void {
  appStore.setState({ vertexMenu: menu });
}

export function setDraft(draft: Draft | null): void {
  appStore.setState({ draft });
}

/** Replace the whole review list (a fresh find, a discard, or after accept). Clears the split undo stack. */
export function setCandidates(candidates: readonly ReviewCandidate[] | null): void {
  appStore.setState((s) => ({
    candidates,
    reviewUndoStack: [],
    reviewEpoch: s.reviewEpoch + 1,
    candidateSplitFocus: null,
  }));
}

/** Set keyboard focus for a candidate split point and announce its one-based position. */
export function setCandidateSplitFocus(focus: CandidateSplitFocus | null): void {
  const candidates = appStore.getState().candidates;
  const candidate = focus ? candidates?.find((item) => item.id === focus.candidateId) : null;
  if (focus && (!candidate || focus.index <= 0 || focus.index >= candidate.pts.length - 1)) {
    return;
  }
  appStore.setState({ candidateSplitFocus: focus });
  if (focus && candidate) announce(`Split point ${focus.index + 1} of ${candidate.pts.length}`);
}

/** Tick or untick one candidate under review. */
export function setCandidateOn(id: string, on: boolean): void {
  const list = appStore.getState().candidates;
  if (!list) return;
  appStore.setState({ candidates: list.map((c) => (c.id === id ? { ...c, on } : c)) });
}

/** "Join colors that continue each other" in Find trails (T-210). */
export function setMergeAcrossColors(v: boolean): void {
  appStore.setState({ mergeAcrossColors: v });
}

/**
 * Replace one reviewed candidate with the two `splitCandidateAt` produced (T-210), pushing the
 * prior list onto the review-only undo stack.
 */
export function splitCandidateInReview(next: readonly ReviewCandidate[]): void {
  const list = appStore.getState().candidates;
  if (!list) return;
  appStore.setState((s) => ({
    candidates: next,
    reviewUndoStack: [...s.reviewUndoStack, list],
    candidateSplitFocus: null,
  }));
}

/** "Undo split" (T-210): restore the review list from before the last split. Does nothing if empty. */
export function undoCandidateSplit(): boolean {
  const stack = appStore.getState().reviewUndoStack;
  if (!stack.length) return false;
  appStore.setState({
    candidates: stack[stack.length - 1]!,
    reviewUndoStack: stack.slice(0, -1),
    candidateSplitFocus: null,
  });
  return true;
}

/** Show (or with null, hide) the busy overlay; `cancel` adds a Cancel button that calls it. */
export function setBusy(text: string | null, cancel: (() => void) | null = null): void {
  appStore.setState({ busy: text, busyCancel: text === null ? null : cancel });
}

let toastSeq = 0;

/** Show a transient message (prototype default 3.6 s). */
export function showToast(message: string, ms = 3600): void {
  appStore.setState({ toast: { id: ++toastSeq, message, ms } });
}

export function clearToast(): void {
  appStore.setState({ toast: null });
}

let announceSeq = 0;

/** Speak `text` through the app-wide polite live region (T-215), without a visible toast. */
export function announce(text: string): void {
  appStore.setState({ announcement: { id: ++announceSeq, text } });
}

/* ---------------------------------------------------------------- selectors */

/** Leave-one-out residuals are computed from this many anchors with coordinates (T-208). */
export const LOO_MIN_ANCHORS = 4;

/** Mark the start or end of an anchor drag (Tools). LOO is recomputed once the drag ends. */
export function setAnchorDragging(dragging: boolean): void {
  if (appStore.getState().anchorDragging !== dragging)
    appStore.setState({ anchorDragging: dragging });
}

let fitMemo: {
  anchors: readonly Anchor[];
  method: FitMethod;
  width: number;
  height: number;
  /** The plain fit. */
  base: FitResult;
  /** base with leave-one-out residuals, once computed (never during a drag). */
  loo: FitResult | null;
} | null = null;

/**
 * The georeference for the current project, or null with no session. Memoized: recomputed
 * only when the anchors array, fit method or image size change.
 *
 * When the fit is ok and >= LOO_MIN_ANCHORS anchors have coordinates, the result carries
 * leave-one-out residuals (T-208). They cost one refit per anchor, so while an anchor is
 * dragged the plain fit is returned (drag frames stay at vsync, D-012); the LOO version is
 * computed once, from the cached plain fit, when the drag ends.
 */
export function selectFit(state: AppState): FitResult | null {
  const p = state.session?.project;
  if (!p) return null;
  const { anchors, fitMethod: method } = p;
  const { width, height } = p.image;
  if (
    !fitMemo ||
    fitMemo.anchors !== anchors ||
    fitMemo.method !== method ||
    fitMemo.width !== width ||
    fitMemo.height !== height
  ) {
    fitMemo = {
      anchors,
      method,
      width,
      height,
      base: fitAnchors(anchors, width, height, method),
      loo: null,
    };
  }
  const { base } = fitMemo;
  if (!base.ok || state.anchorDragging) return base;
  if (anchors.filter((a) => a.ll !== null).length < LOO_MIN_ANCHORS) return base;
  // Refit the others with the model actually in use: with requested 'auto', three remaining
  // anchors would drop to a similarity and misreport an affine map by tens of metres
  // (T-208 Request 1 asks Lane A to do this inside withLooResiduals).
  fitMemo.loo ??= {
    ...withLooResiduals({ ...base, requested: base.method }, anchors, width, height),
    requested: base.requested,
  };
  return fitMemo.loo;
}

/** The current project, or null. */
export const selectProject = (s: AppState): Project | null => s.session?.project ?? null;
