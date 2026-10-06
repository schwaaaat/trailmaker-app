import { inverse } from '../../core/geo/fit';
import type { GeoFit, LatLon, Px } from '../../core/types';

const EARTH_MEAN_RADIUS_METERS = 6_371_008.8;
const DEGREES_TO_RADIANS = Math.PI / 180;
const RADIANS_TO_DEGREES = 180 / Math.PI;

export interface DeviceLocationFix {
  readonly location: LatLon;
  readonly accuracyMeters: number;
}

export interface MapLocationOverlay {
  readonly center: Px;
  /** A sampled accuracy-circle boundary in level-0 map pixel coordinates. */
  readonly accuracyBoundary: readonly Px[];
}

function destinationPoint(
  [latitude, longitude]: LatLon,
  distanceMeters: number,
  bearingRadians: number,
): LatLon {
  const angularDistance = distanceMeters / EARTH_MEAN_RADIUS_METERS;
  const lat1 = latitude * DEGREES_TO_RADIANS;
  const lon1 = longitude * DEGREES_TO_RADIANS;
  const sinLat2 =
    Math.sin(lat1) * Math.cos(angularDistance) +
    Math.cos(lat1) * Math.sin(angularDistance) * Math.cos(bearingRadians);
  const lat2 = Math.asin(Math.max(-1, Math.min(1, sinLat2)));
  const lon2 =
    lon1 +
    Math.atan2(
      Math.sin(bearingRadians) * Math.sin(angularDistance) * Math.cos(lat1),
      Math.cos(angularDistance) - Math.sin(lat1) * Math.sin(lat2),
    );
  return [lat2 * RADIANS_TO_DEGREES, lon2 * RADIANS_TO_DEGREES];
}

/** Maps a local GPS fix and its accuracy circle through the current georeferencing fit. */
export function locationToMapOverlay(
  fit: GeoFit,
  fix: DeviceLocationFix,
  segments = 32,
): MapLocationOverlay | null {
  if (
    !Number.isFinite(fix.location[0]) ||
    !Number.isFinite(fix.location[1]) ||
    !Number.isFinite(fix.accuracyMeters) ||
    fix.accuracyMeters < 0 ||
    !Number.isInteger(segments) ||
    segments < 8
  ) {
    return null;
  }
  const center = inverse(fit, fix.location);
  if (!center) return null;
  const accuracyBoundary: Px[] = [];
  for (let i = 0; i < segments; i++) {
    const location = destinationPoint(
      fix.location,
      fix.accuracyMeters,
      (i / segments) * Math.PI * 2,
    );
    const point = inverse(fit, location);
    if (!point) return null;
    accuracyBoundary.push(point);
  }
  return { center, accuracyBoundary };
}
