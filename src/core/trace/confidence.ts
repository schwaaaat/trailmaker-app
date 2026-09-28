import type { JobHooks, Px, RasterImage, Rgb } from '../types';
import { rgbToHsl } from './color';

export interface CandidateConfidenceOptions {
  readonly tolerance: number;
  readonly minLengthPx: number;
}

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

/**
 * Estimate whether a traced path is a trail from evidence in its source raster.
 * The fixed weights combine path support, narrow stroke width, width consistency,
 * geometric smoothness and usable length. A broad filled region scores poorly even
 * if its boundary was traced cleanly; bridged gaps reduce support without erasing
 * the stronger geometric and narrow-stroke evidence.
 */
export function candidateConfidence(
  image: RasterImage,
  ink: Rgb,
  points: readonly Px[],
  lengthPx: number,
  options: CandidateConfidenceOptions,
  hooks?: JobHooks,
): number {
  if (points.length < 2 || !(lengthPx > 0) || !Number.isFinite(lengthPx)) return 0;
  const tolerance = Number.isFinite(options.tolerance) ? Math.max(0, options.tolerance) : 0;
  const spacing = Math.max(2, lengthPx / 255);
  let sampleCount = 0;
  let supportedCount = 0;
  let exactSupportedCount = 0;
  let widthsTotal = 0;
  let widthsSquared = 0;
  const chordX = points[points.length - 1]![0] - points[0]![0];
  const chordY = points[points.length - 1]![1] - points[0]![1];
  const matches = (x: number, y: number, threshold: number): boolean => {
    const px = Math.round(x);
    const py = Math.round(y);
    if (px < 0 || py < 0 || px >= image.width || py >= image.height) return false;
    const offset = (py * image.width + px) * 4;
    const dr = image.data[offset]! - ink[0];
    const dg = image.data[offset + 1]! - ink[1];
    const db = image.data[offset + 2]! - ink[2];
    return dr * dr + dg * dg + db * db <= threshold * threshold;
  };

  const addSample = (x: number, y: number, nx: number, ny: number): void => {
    sampleCount++;
    if ((sampleCount & 31) === 0) hooks?.throwIfCancelled();
    let found = false;
    let exactFound = false;
    for (let oy = -1; oy <= 1 && !found; oy++)
      for (let ox = -1; ox <= 1; ox++)
        if (matches(x + ox, y + oy, tolerance)) {
          found = true;
          break;
        }
    if (found) supportedCount++;
    for (let oy = -1; oy <= 1 && !exactFound; oy++)
      for (let ox = -1; ox <= 1; ox++)
        if (matches(x + ox, y + oy, Math.min(tolerance, 24))) {
          exactFound = true;
          break;
        }
    if (exactFound) exactSupportedCount++;

    let width = found ? 1 : 0;
    for (const direction of [-1, 1]) {
      for (let step = 1; step <= 8; step++) {
        if (!matches(x + nx * step * direction, y + ny * step * direction, tolerance)) break;
        width++;
      }
    }
    widthsTotal += width;
    widthsSquared += width * width;
  };

  for (let index = 1; index < points.length; index++) {
    const a = points[index - 1]!;
    const b = points[index]!;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const segmentLength = Math.hypot(dx, dy);
    if (!segmentLength) continue;
    const count = Math.max(1, Math.ceil(segmentLength / spacing));
    const nx = -dy / segmentLength;
    const ny = dx / segmentLength;
    for (let sample = 0; sample <= count; sample++) {
      const t = sample / count;
      addSample(a[0] + dx * t, a[1] + dy * t, nx, ny);
    }
  }
  if (!sampleCount) return 0;

  const support = supportedCount / sampleCount;
  const exactSupport = exactSupportedCount / sampleCount;
  const meanWidth = widthsTotal / sampleCount;
  const variance = Math.max(0, widthsSquared / sampleCount - meanWidth * meanWidth);
  const widthConsistency = 1 / (1 + Math.sqrt(variance) / Math.max(meanWidth, 1));
  const narrowStroke = Math.exp(-Math.max(0, meanWidth - 2) / 2);
  const straightness = clamp01(Math.sqrt(Math.hypot(chordX, chordY) / lengthPx));
  const lengthEvidence = clamp01(lengthPx / Math.max(1, options.minLengthPx * 4));
  const lineEvidence = clamp01(
    0.2 * support +
      0.53 * exactSupport +
      0.17 * narrowStroke +
      0.04 * widthConsistency +
      0.03 * straightness +
      0.03 * lengthEvidence,
  );
  const [, saturation, lightness] = rgbToHsl(ink);
  // Genuine trail ink in the fixture set forms a saturated, darker core; pale
  // antialias/label colors often produce plausible skeletons but have little such
  // evidence. This factor is deliberately soft so JPEG and blur variants survive.
  const colorQuality =
    clamp01((saturation - 0.25) / 0.45) * clamp01((0.78 - lightness) / 0.4);
  return clamp01(lineEvidence * (0.4 + 0.6 * colorQuality));
}
