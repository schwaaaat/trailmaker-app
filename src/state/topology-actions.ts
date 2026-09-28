// Lane B. Split/join/clean-up-junctions actions (card T-209): build a TopologyEdit from
// src/core/topology's pure functions and apply it as one undo step through the store.
import { hasUnsnappedEnds, joinTrails, snapTrailEnds, splitTrail } from '../core/topology';
import type { Feature, FeatureId, Px, Trail } from '../core/types';
import { applyTopologyEdit } from './commands';
import { appStore, edit, showToast } from './store';

const state = () => appStore.getState();
const project = () => state().session?.project ?? null;

/** "Clean up junctions" looks within this many screen px of the current zoom. */
export const CLEANUP_SNAP_SCREEN_PX = 8;
/** Image-pixel bounds the screen-px tolerance is clamped to at any zoom. */
export const CLEANUP_TOLERANCE_MIN_PX = 2;
export const CLEANUP_TOLERANCE_MAX_PX = 30;

/**
 * Image-pixel snap tolerance for a view whose scale is `scale` image px per screen px (an
 * unmounted editor, or the export hint with no view to ask, passes 1). Shared by the step-3
 * button and the export hint so the hint's own button always clears what it found.
 */
export function cleanupTolerancePx(scale: number): number {
  const px = CLEANUP_SNAP_SCREEN_PX / scale;
  return Math.min(CLEANUP_TOLERANCE_MAX_PX, Math.max(CLEANUP_TOLERANCE_MIN_PX, px));
}

const samePt = (a: Px, b: Px): boolean => a[0] === b[0] && a[1] === b[1];

/**
 * How many trail ends actually moved between the pre-edit features and a snap/split/join's
 * `updated` list. A trail that only gained a mid-line junction vertex has no moved end.
 */
export function countSnappedEnds(
  before: readonly Feature[],
  updated: readonly Feature[],
): number {
  let n = 0;
  for (const u of updated) {
    if (u.kind !== 'trail' || !u.pts.length) continue;
    const prev = before.find((f) => f.id === u.id);
    if (!prev || prev.kind !== 'trail' || !prev.pts.length) continue;
    if (!samePt(prev.pts[0]!, u.pts[0]!)) n++;
    if (!samePt(prev.pts[prev.pts.length - 1]!, u.pts[u.pts.length - 1]!)) n++;
  }
  return n;
}

/** Whether vertex `index` of feature `f` can be split (an interior vertex of a trail). */
export function canSplitAt(f: Feature | undefined, index: number): boolean {
  return !!f && f.kind === 'trail' && index > 0 && index < f.pts.length - 1;
}

/** Split the trail `featureId` at vertex `index` (T-209 "Split here": context menu or S). */
export function splitHere(featureId: FeatureId, index: number): void {
  const p = project();
  const f = p?.features.find((x) => x.id === featureId);
  if (!p || !f || !canSplitAt(f, index)) return;
  const result = splitTrail(f as Trail, index, `f${p.seq}`);
  const second = result.updated[1]!;
  edit(applyTopologyEdit(p, result), { feature: second.id });
}

/** Join the selected trail with the shift-clicked second trail (T-209 "Join trails" or J). */
export function joinSelected(): void {
  const p = project();
  const s = state();
  const a = p?.features.find((x) => x.id === s.selectedFeatureId);
  const b = p?.features.find((x) => x.id === s.secondSelectedFeatureId);
  if (!p || !a || !b || a.kind !== 'trail' || b.kind !== 'trail' || a.id === b.id) return;
  const result = joinTrails(a, b);
  edit(applyTopologyEdit(p, result), { feature: a.id });
}

/** "Clean up junctions" (the step-3 button, or the export hint's button). */
export function cleanupJunctions(tolerancePx: number): void {
  const p = project();
  if (!p) return;
  const result = snapTrailEnds(p.features, { tolerancePx });
  if (!result.updated.length) {
    showToast('Nothing to clean up');
    return;
  }
  const n = countSnappedEnds(p.features, result.updated);
  edit(applyTopologyEdit(p, result));
  showToast(`Joined ${n} trail end${n === 1 ? '' : 's'}`);
}

let hintMemo: {
  features: readonly Feature[];
  tolerancePx: number;
  result: boolean;
} | null = null;

/**
 * Whether cleaning up junctions at `tolerancePx` would change anything (the export hint).
 * Uses T-112's early-exit detector, which agrees with snapTrailEnds without building trails
 * (D-023 item 3), and is memoized on the features array reference.
 */
export function needsCleanup(features: readonly Feature[], tolerancePx: number): boolean {
  if (
    hintMemo &&
    hintMemo.features === features &&
    hintMemo.tolerancePx === tolerancePx
  ) {
    return hintMemo.result;
  }
  const result = hasUnsnappedEnds(features, { tolerancePx });
  hintMemo = { features, tolerancePx, result };
  return result;
}
