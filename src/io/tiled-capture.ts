import type { LatLon } from '../core/types';
import type { TileLevel } from '../ui/contract';

export const CACHED_TILE_SIZE = 256;
export const DEFAULT_TILE_ZOOM = 20;
export const MAX_TILE_ZOOM = 21;
export const TILE_BOUNDARY_BUFFER_METERS = 20;
const WEB_MERCATOR_CIRCUMFERENCE = 40_075_016.68557849;

export interface TiledCaptureOptions {
  readonly tileSize?: number;
  readonly bufferMeters?: number;
}

export interface PlannedMapTile {
  readonly z: number;
  /** ArcGIS cached tile column in the world grid. */
  readonly x: number;
  /** ArcGIS cached tile row in the world grid (origin at the north-west). */
  readonly y: number;
  /** Tile column relative to the planned image origin. */
  readonly col: number;
  /** Tile row relative to the planned image origin. */
  readonly row: number;
}

export interface TiledBoundaryPlan {
  readonly z: number;
  readonly tileSize: number;
  /** World pixels at z for image Px [0,0]. */
  readonly origin: { readonly x: number; readonly y: number };
  readonly width: number;
  readonly height: number;
  readonly cols: number;
  readonly rows: number;
  readonly tiles: readonly PlannedMapTile[];
  readonly bbox: {
    readonly west: number;
    readonly south: number;
    readonly east: number;
    readonly north: number;
  };
  readonly areaSqMeters: number;
}

interface Point2 {
  readonly x: number;
  readonly y: number;
}
interface Rect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

function toWorldPixel([lat, lon]: LatLon, z: number, tileSize: number): Point2 {
  const safeLat = Math.max(-85.05112878, Math.min(85.05112878, lat));
  const worldSize = tileSize * 2 ** z;
  const sin = Math.sin((safeLat * Math.PI) / 180);
  return {
    x: ((lon + 180) / 360) * worldSize,
    y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * worldSize,
  };
}

function pointInRect(point: Point2, rect: Rect): boolean {
  return (
    point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom
  );
}

function pointInPolygon(point: Point2, polygon: readonly Point2[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]!;
    const b = polygon[j]!;
    const crosses = a.y > point.y !== b.y > point.y;
    if (crosses && point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

function pointRectDistance(point: Point2, rect: Rect): number {
  const dx = Math.max(rect.left - point.x, 0, point.x - rect.right);
  const dy = Math.max(rect.top - point.y, 0, point.y - rect.bottom);
  return Math.hypot(dx, dy);
}

function pointSegmentDistance(point: Point2, a: Point2, b: Point2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return Math.hypot(point.x - a.x, point.y - a.y);
  const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared));
  return Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy));
}

function segmentIntersectsRect(a: Point2, b: Point2, rect: Rect): boolean {
  let t0 = 0;
  let t1 = 1;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const clip = (p: number, q: number): boolean => {
    if (p === 0) return q >= 0;
    const t = q / p;
    if (p < 0) {
      if (t > t1) return false;
      t0 = Math.max(t0, t);
    } else {
      if (t < t0) return false;
      t1 = Math.min(t1, t);
    }
    return true;
  };
  return (
    clip(-dx, a.x - rect.left) &&
    clip(dx, rect.right - a.x) &&
    clip(-dy, a.y - rect.top) &&
    clip(dy, rect.bottom - a.y)
  );
}

function segmentNearRect(a: Point2, b: Point2, rect: Rect, buffer: number): boolean {
  if (segmentIntersectsRect(a, b, rect)) return true;
  const corners = [
    { x: rect.left, y: rect.top },
    { x: rect.right, y: rect.top },
    { x: rect.right, y: rect.bottom },
    { x: rect.left, y: rect.bottom },
  ];
  if (Math.min(pointRectDistance(a, rect), pointRectDistance(b, rect)) <= buffer) return true;
  return corners.some((corner) => pointSegmentDistance(corner, a, b) <= buffer);
}

function polygonIntersectsBufferedRect(
  polygon: readonly Point2[],
  rect: Rect,
  buffer: number,
): boolean {
  const corners = [
    { x: rect.left, y: rect.top },
    { x: rect.right, y: rect.top },
    { x: rect.right, y: rect.bottom },
    { x: rect.left, y: rect.bottom },
  ];
  if (polygon.some((point) => pointInRect(point, rect))) return true;
  if (corners.some((point) => pointInPolygon(point, polygon))) return true;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i]!;
    const b = polygon[(i + 1) % polygon.length]!;
    if (segmentNearRect(a, b, rect, buffer)) return true;
  }
  return false;
}

function polygonAreaSqMeters(polygon: readonly LatLon[]): number {
  const centerLat = polygon.reduce((sum, [lat]) => sum + lat, 0) / polygon.length;
  const groundScale = Math.cos((centerLat * Math.PI) / 180);
  const projected = polygon.map(([lat, lon]) => {
    const x = (lon * WEB_MERCATOR_CIRCUMFERENCE) / 360;
    const safeLat = Math.max(-85.05112878, Math.min(85.05112878, lat));
    const y =
      (Math.log(Math.tan(Math.PI / 4 + (safeLat * Math.PI) / 360)) * WEB_MERCATOR_CIRCUMFERENCE) /
      (2 * Math.PI);
    return { x, y };
  });
  let twiceArea = 0;
  for (let i = 0; i < projected.length; i++) {
    const a = projected[i]!;
    const b = projected[(i + 1) % projected.length]!;
    twiceArea += a.x * b.y - b.x * a.y;
  }
  return (Math.abs(twiceArea) / 2) * groundScale ** 2;
}

/** Plans a compact virtual raster containing only cache tiles that touch the polygon plus its buffer. */
export function planTiledBoundary(
  boundary: readonly LatLon[],
  z: number,
  options: TiledCaptureOptions = {},
): TiledBoundaryPlan {
  const tileSize = options.tileSize ?? CACHED_TILE_SIZE;
  const bufferMeters = options.bufferMeters ?? TILE_BOUNDARY_BUFFER_METERS;
  if (!Number.isInteger(z) || z < 0 || z > MAX_TILE_ZOOM) {
    throw new Error(
      `Unsupported tile zoom ${z}; expected an integer from 0 through ${MAX_TILE_ZOOM}.`,
    );
  }
  if (!Number.isInteger(tileSize) || tileSize <= 0)
    throw new Error('Tile size must be a positive integer.');
  if (!Number.isFinite(bufferMeters) || bufferMeters < 0)
    throw new Error('Boundary buffer must be a non-negative number.');
  if (boundary.length < 3) throw new Error('A tiled map boundary must have at least 3 points.');
  if (
    boundary.some(
      ([lat, lon]) =>
        !Number.isFinite(lat) ||
        !Number.isFinite(lon) ||
        Math.abs(lat) > 85.05112878 ||
        Math.abs(lon) > 180,
    )
  ) {
    throw new Error('Boundary points must be finite WGS84 coordinates within Web Mercator.');
  }

  const polygon = boundary.map((point) => toWorldPixel(point, z, tileSize));
  const xs = polygon.map(({ x }) => x);
  const ys = polygon.map(({ y }) => y);
  const centerLat = boundary.reduce((sum, [lat]) => sum + lat, 0) / boundary.length;
  const projectedBufferMeters =
    bufferMeters / Math.max(0.01, Math.cos((centerLat * Math.PI) / 180));
  const bufferPixels = (projectedBufferMeters * tileSize * 2 ** z) / WEB_MERCATOR_CIRCUMFERENCE;
  const minWorldTile = 0;
  const maxWorldTile = 2 ** z - 1;
  const minCol = Math.max(minWorldTile, Math.floor((Math.min(...xs) - bufferPixels) / tileSize));
  const minRow = Math.max(minWorldTile, Math.floor((Math.min(...ys) - bufferPixels) / tileSize));
  const maxCol = Math.min(
    maxWorldTile,
    Math.floor((Math.max(...xs) + bufferPixels - Number.EPSILON) / tileSize),
  );
  const maxRow = Math.min(
    maxWorldTile,
    Math.floor((Math.max(...ys) + bufferPixels - Number.EPSILON) / tileSize),
  );
  const cols = maxCol - minCol + 1;
  const rows = maxRow - minRow + 1;
  const tiles: PlannedMapTile[] = [];

  for (let y = minRow; y <= maxRow; y++) {
    for (let x = minCol; x <= maxCol; x++) {
      const rect = {
        left: x * tileSize,
        top: y * tileSize,
        right: (x + 1) * tileSize,
        bottom: (y + 1) * tileSize,
      };
      if (!polygonIntersectsBufferedRect(polygon, rect, bufferPixels)) continue;
      tiles.push({ z, x, y, col: x - minCol, row: y - minRow });
    }
  }

  const bbox = {
    west: ((minCol * tileSize) / (tileSize * 2 ** z)) * 360 - 180,
    east: (((maxCol + 1) * tileSize) / (tileSize * 2 ** z)) * 360 - 180,
    north:
      (Math.atan(Math.sinh(Math.PI * (1 - (2 * minRow * tileSize) / (tileSize * 2 ** z)))) * 180) /
      Math.PI,
    south:
      (Math.atan(Math.sinh(Math.PI * (1 - (2 * (maxRow + 1) * tileSize) / (tileSize * 2 ** z)))) *
        180) /
      Math.PI,
  };

  return {
    z,
    tileSize,
    origin: { x: minCol * tileSize, y: minRow * tileSize },
    width: cols * tileSize,
    height: rows * tileSize,
    cols,
    rows,
    tiles,
    bbox,
    areaSqMeters: polygonAreaSqMeters(boundary),
  };
}

/** Returns full-resolution and downsampled tile-level metadata through a bounded overview. */
export function tileLevelPyramid(
  width: number,
  height: number,
  tileSize = CACHED_TILE_SIZE,
  maxOverviewSide = 4096,
): TileLevel[] {
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    throw new Error('Tiled map dimensions must be positive integers.');
  }
  if (!Number.isInteger(tileSize) || tileSize <= 0)
    throw new Error('Tile size must be a positive integer.');
  if (!Number.isInteger(maxOverviewSide) || maxOverviewSide <= 0)
    throw new Error('Overview side must be a positive integer.');
  const levels: TileLevel[] = [];
  for (let level = 0; ; level++) {
    const divisor = 2 ** level;
    const levelWidth = Math.ceil(width / divisor);
    const levelHeight = Math.ceil(height / divisor);
    levels.push({
      level,
      width: levelWidth,
      height: levelHeight,
      cols: Math.ceil(levelWidth / tileSize),
      rows: Math.ceil(levelHeight / tileSize),
    });
    if (Math.max(levelWidth, levelHeight) <= maxOverviewSide) break;
    if (level >= 30) throw new Error('Tiled map overview exceeds supported pyramid depth.');
  }
  return levels;
}
