import type { Feature, FeatureId, GeoFit, LatLon } from '../types';
import { haversine } from './distance';
import { forward } from './fit';

const VERTICES_PER_STEP = 5_000;

/**
 * Project feature paths and sum their lengths in bounded pieces for the UI time slicer.
 * Each yield follows at most 5,000 projected vertices, including when one feature is very long.
 */
export function* featureLengthSteps(
  fit: GeoFit,
  features: readonly Feature[],
): Generator<void, ReadonlyMap<FeatureId, number>, undefined> {
  const lengths = new Map<FeatureId, number>();
  for (const feature of features) {
    if (feature.kind === 'poi') continue;
    let first: LatLon | undefined;
    let previous: LatLon | undefined;
    let length = 0;
    let verticesSinceYield = 0;
    for (const point of feature.pts) {
      const current = forward(fit, point);
      first ??= current;
      if (previous) length += haversine(previous, current);
      previous = current;
      if (++verticesSinceYield === VERTICES_PER_STEP) {
        yield;
        verticesSinceYield = 0;
      }
    }
    if (feature.kind === 'area' && previous && first) length += haversine(previous, first);
    lengths.set(feature.id, length);
    if (verticesSinceYield > 0) yield;
  }
  return lengths;
}
