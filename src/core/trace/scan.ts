import type { ColorScanResult, JobHooks, RasterImage, Rgb, ScannedColor } from '../types';
import { colorDistance, nameColor, rgbToHsl } from './color';

/** Find and rank colors that appear as thin lines in the raster. */
export function scanColors(img: RasterImage, hooks?: JobHooks): ColorScanResult {
  const { data, width, height } = img;
  hooks?.throwIfCancelled();
  hooks?.progress(0, 'Sampling colors');
  if (width < 1 || height < 1) {
    hooks?.progress(1, 'Color scan complete');
    return { colors: [] };
  }
  const started = performance.now();
  let lastCheck = started;
  const check = (fraction: number, stage: string, force = false): void => {
    const now = performance.now();
    if (force || now - lastCheck >= 45) {
      hooks?.throwIfCancelled();
      hooks?.progress(fraction, stage);
      lastCheck = now;
    }
  };
  const factor = Math.max(1, Math.ceil(Math.max(width, height) / 1600));
  const sampleWidth = Math.floor(width / factor);
  const sampleHeight = Math.floor(height / factor);
  const sampleCount = sampleWidth * sampleHeight;
  if (!sampleCount) {
    hooks?.progress(1, 'Color scan complete');
    return { colors: [] };
  }

  const quantized = new Uint16Array(sampleCount);
  const histogram = new Uint32Array(4096);
  for (let y = 0, sample = 0; y < sampleHeight; y++) {
    let pixel = y * factor * width * 4;
    for (let x = 0; x < sampleWidth; x++, sample++, pixel += factor * 4) {
      const bin =
        ((data[pixel]! >> 4) << 8) | ((data[pixel + 1]! >> 4) << 4) | (data[pixel + 2]! >> 4);
      quantized[sample] = bin;
      histogram[bin] = histogram[bin]! + 1;
    }
    check(0.25 * ((y + 1) / sampleHeight), 'Building histogram');
  }
  check(0.25, 'Histogram complete', true);

  const bins: number[] = [];
  for (let bin = 0; bin < histogram.length; bin++) if (histogram[bin]) bins.push(bin);
  bins.sort((a, b) => histogram[b]! - histogram[a]!);
  const binCluster = new Int16Array(4096);
  binCluster.fill(-1);
  const means = new Float64Array(90 * 3);
  const weights = new Float64Array(90);
  let clusterCount = 0;
  for (const bin of bins) {
    const red = ((bin >> 8) & 15) * 16 + 8;
    const green = ((bin >> 4) & 15) * 16 + 8;
    const blue = (bin & 15) * 16 + 8;
    const weight = histogram[bin]!;
    let best = -1,
      bestDistanceSquared = Infinity;
    for (let cluster = 0; cluster < clusterCount; cluster++) {
      const offset = cluster * 3;
      const dr = means[offset]! - red,
        dg = means[offset + 1]! - green,
        db = means[offset + 2]! - blue;
      const distanceSquared = dr * dr + dg * dg + db * db;
      if (distanceSquared < bestDistanceSquared) {
        bestDistanceSquared = distanceSquared;
        best = cluster;
      }
    }
    if (best < 0 || (bestDistanceSquared > 34 * 34 && clusterCount < 90)) {
      best = clusterCount++;
      const offset = best * 3;
      means[offset] = red;
      means[offset + 1] = green;
      means[offset + 2] = blue;
      weights[best] = weight;
    } else {
      const offset = best * 3,
        total = weights[best]! + weight;
      means[offset] = (means[offset]! * weights[best]! + red * weight) / total;
      means[offset + 1] = (means[offset + 1]! * weights[best]! + green * weight) / total;
      means[offset + 2] = (means[offset + 2]! * weights[best]! + blue * weight) / total;
      weights[best] = total;
    }
    binCluster[bin] = best;
  }
  check(0.4, 'Color clusters ready', true);

  const counts = new Float64Array(clusterCount);
  const edges = new Float64Array(clusterCount);
  const sums = new Float64Array(clusterCount * 3);
  const tilesWide = Math.ceil(sampleWidth / 32);
  const tileCount = tilesWide * Math.ceil(sampleHeight / 32);
  const tileCounts = new Uint32Array(tileCount * clusterCount);
  const tileEdges = new Uint32Array(tileCount * clusterCount);
  for (let y = 0, sample = 0; y < sampleHeight; y++) {
    for (let x = 0; x < sampleWidth; x++, sample++) {
      const cluster = binCluster[quantized[sample]!]!;
      counts[cluster] = counts[cluster]! + 1;
      const pixel = (y * factor * width + x * factor) * 4,
        sum = cluster * 3;
      sums[sum] = sums[sum]! + data[pixel]!;
      sums[sum + 1] = sums[sum + 1]! + data[pixel + 1]!;
      sums[sum + 2] = sums[sum + 2]! + data[pixel + 2]!;
      const tile = ((y >> 5) * tilesWide + (x >> 5)) * clusterCount + cluster;
      tileCounts[tile] = tileCounts[tile]! + 1;
      const edge =
        (x > 0 && binCluster[quantized[sample - 1]!] !== cluster) ||
        (x < sampleWidth - 1 && binCluster[quantized[sample + 1]!] !== cluster) ||
        (y > 0 && binCluster[quantized[sample - sampleWidth]!] !== cluster) ||
        (y < sampleHeight - 1 && binCluster[quantized[sample + sampleWidth]!] !== cluster);
      if (edge) {
        edges[cluster] = edges[cluster]! + 1;
        tileEdges[tile] = tileEdges[tile]! + 1;
      }
    }
    check(0.4 + 0.5 * ((y + 1) / sampleHeight), 'Measuring line thinness');
  }
  check(0.9, 'Line measurements ready', true);

  const candidates: ScannedColor[] = [];
  for (let cluster = 0; cluster < clusterCount; cluster++) {
    const count = counts[cluster]!;
    if (!count) continue;
    const offset = cluster * 3;
    const rgb: Rgb = [
      Math.round(sums[offset]! / count),
      Math.round(sums[offset + 1]! / count),
      Math.round(sums[offset + 2]! / count),
    ];
    const share = count / sampleCount;
    const globalThinness = edges[cluster]! / count;
    let localThinness = 0;
    // A color can serve both a thin trail and a filled region. Only fall back to local
    // patches when the global cluster is too filled to pass the prototype's thinness filter.
    if (globalThinness < 0.3) {
      for (let tile = cluster; tile < tileCounts.length; tile += clusterCount) {
        const tileCount = tileCounts[tile]!;
        if (tileCount >= 8) localThinness = Math.max(localThinness, tileEdges[tile]! / tileCount);
      }
    }
    const thinness = globalThinness >= 0.3 ? globalThinness : localThinness;
    const [, saturation, lightness] = rgbToHsl(rgb);
    if (share < 0.0003 || share > 0.25 || thinness < 0.3) continue;
    if (lightness > 0.86 && saturation < 0.3) continue;
    candidates.push({
      rgb,
      name: nameColor(rgb),
      share,
      thinness,
      saturation,
      lightness,
      score: share * thinness * (0.35 + saturation),
      likely: saturation > 0.3 && thinness > 0.45 && lightness < 0.8,
    });
  }
  candidates.sort((a, b) => b.score - a.score);
  const kept: ScannedColor[] = [];
  for (const candidate of candidates) {
    if (kept.some((existing) => colorDistance(existing.rgb, candidate.rgb) < 48)) continue;
    kept.push(candidate);
    if (kept.length === 10) break;
  }
  hooks?.progress(1, 'Color scan complete');
  return { colors: kept };
}
