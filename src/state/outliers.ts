// Lane B. Which anchor is the "odd one out" (card T-208). With leave-one-out residuals, an
// anchor is flagged when its LOO residual exceeds max(OUTLIER_MIN_M, 2.2 x median LOO residual);
// otherwise the plain-residual rule `isOutlier` (T-101) applies. Used by the anchor badges, the
// fit message and the red pin, so all three agree.
import { isOutlier } from '../core/geo/fit';
import { OUTLIER_MIN_M, OUTLIER_RMS_FACTOR, type AnchorId, type GeoFit } from '../core/types';

function median(values: readonly number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** The LOO residual above which an anchor is flagged, or null without LOO residuals. */
export function looOutlierLimit(fit: GeoFit): number | null {
  const values = fit.looResiduals ? Object.values(fit.looResiduals) : [];
  if (!values.length) return null;
  return Math.max(OUTLIER_MIN_M, OUTLIER_RMS_FACTOR * median(values));
}

/** Whether an anchor should be flagged (red badge and pin). */
export function anchorOutlier(fit: GeoFit, id: AnchorId): boolean {
  const loo = fit.looResiduals?.[id];
  const limit = looOutlierLimit(fit);
  if (loo !== undefined && limit !== null) return loo > limit;
  return isOutlier(fit, id);
}

/** Whether any anchor of the fit is flagged. */
export function hasOutlier(fit: GeoFit): boolean {
  const ids = new Set([...Object.keys(fit.residuals), ...Object.keys(fit.looResiduals ?? {})]);
  for (const id of ids) if (anchorOutlier(fit, id)) return true;
  return false;
}
