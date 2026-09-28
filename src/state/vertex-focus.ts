// Lane B. Keyboard vertex focus (card T-215): which vertex of the selected trail/area Tab and
// the arrow keys act on. Kept separate from mouse hover so a keyboard-only user can step through
// and nudge a trail's points without a pointer. Pure and store-shaped, not canvas-shaped, so it
// lives next to the other command/selection helpers rather than under ui/editor.
import type { Feature, FeatureId } from '../core/types';

export interface VertexFocus {
  readonly featureId: FeatureId;
  readonly index: number;
}

/**
 * Vertices Tab can step through for a feature. A point of interest is moved as a whole (there is
 * nothing to step into), so it reports zero.
 */
export function stepCount(f: Feature | undefined): number {
  return f && f.kind !== 'poi' ? f.pts.length : 0;
}

/**
 * Tab (dir 1) or Shift+Tab (dir -1) from the current focus onto `feature`'s vertices. Null past
 * either end, which releases focus so Tab moves on to the next focusable element.
 */
export function stepVertexFocus(
  focus: VertexFocus | null,
  feature: Feature | undefined,
  dir: 1 | -1,
): VertexFocus | null {
  const n = stepCount(feature);
  if (!feature || n === 0) return null;
  const at = focus && focus.featureId === feature.id ? focus.index : dir > 0 ? -1 : n;
  const next = at + dir;
  if (next < 0 || next >= n) return null;
  return { featureId: feature.id, index: next };
}

/**
 * Revalidate focus after an edit, undo/redo or selection change: null once the feature is gone,
 * turned into (or always was) a point of interest, or the index no longer exists.
 */
export function clampVertexFocus(
  focus: VertexFocus | null,
  features: readonly Feature[],
): VertexFocus | null {
  if (!focus) return null;
  const f = features.find((x) => x.id === focus.featureId);
  if (!f || f.kind === 'poi' || focus.index >= f.pts.length) return null;
  return focus;
}
