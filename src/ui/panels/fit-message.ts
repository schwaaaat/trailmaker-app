// Lane B. The step-2 fit message (card T-205): the prototype's renderFit texts and tones, as a
// pure function of the fit result so every state is table-testable.
import type { FitResult, ResolvedFitMethod } from '../../core/types';
import { hasOutlier } from '../../state/outliers';

/** Residual as the prototype prints it: "±<1 m", "±12 m", "±1.4 km". */
export function fmtRes(m: number): string {
  if (m < 1) return '±<1 m';
  if (m < 1000) return `±${Math.round(m)} m`;
  return `±${(m / 1000).toFixed(1)} km`;
}

const METHOD_NAMES: Readonly<Record<ResolvedFitMethod, string>> = {
  similarity: 'scale and rotate',
  affine: 'stretch to fit',
  tps: 'rubber sheet',
};

export interface FitMessage {
  readonly text: string;
  /** 'good' / 'warn' color the message box; null is a plain hint. */
  readonly tone: 'good' | 'warn' | null;
}

/** Rms above which a fit is called loose (prototype). */
const LOOSE_RMS_M = 60;

/** The fit message for the current anchors (prototype renderFit). */
export function fitMessage(
  fit: FitResult | null,
  anchorCount: number,
  hasMap: boolean,
): FitMessage {
  if (!hasMap || !fit) return { text: '', tone: null };
  if (!fit.ok) {
    if (fit.reason === 'degenerate') {
      return {
        text: 'These anchors sit on top of each other. Spread them across the map.',
        tone: null,
      };
    }
    if (anchorCount === 0) return { text: '', tone: null };
    return {
      text: `Add ${fit.need} more anchor${fit.need === 1 ? '' : 's'} with coordinates to place the map.`,
      tone: null,
    };
  }
  const mpp = fit.metersPerPixel;
  const scale = mpp >= 1 ? `${mpp.toFixed(1)} m` : `${Math.round(mpp * 100)} cm`;
  let text = `Placed using ${METHOD_NAMES[fit.method]}. About ${scale} per map pixel.`;
  if (fit.mirrored) {
    return {
      text: 'The anchors describe a mirror image. Latitude and longitude may be swapped on one of them.',
      tone: 'warn',
    };
  }
  if (fit.implausibleScale) {
    return {
      text: `${text} That scale looks wrong for a park map; check each anchor’s coordinates.`,
      tone: 'warn',
    };
  }
  if (!fit.checked && anchorCount >= 4 && fit.requested !== 'similarity')
    return {
      text: 'These anchors do not spread far enough across the map to check a stretch in every direction. Add an anchor farther from their line to confirm the fit.',
      tone: 'good',
    };
  if (!fit.checked)
    return { text: `${text} Add another anchor so the fit can be checked.`, tone: 'good' };
  text += ` Anchors agree within ${fmtRes(fit.rms).replace('±', '')} on average.`;
  // Same rule as the red badges and pins: leave-one-out when available (T-208).
  const oddOneOut = hasOutlier(fit);
  if (fit.rms > LOOSE_RMS_M || oddOneOut) {
    text += oddOneOut
      ? ' The red anchor is the odd one out: re-check its spot or coordinates.'
      : ' That’s loose. If the map is hand-drawn, try the rubber sheet method with more anchors.';
    return { text, tone: 'warn' };
  }
  return { text, tone: 'good' };
}
