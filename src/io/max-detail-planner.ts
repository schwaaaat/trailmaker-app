import type { LatLon } from '../core/types';

export const DETAIL_ZOOM = 21;
export const DETAIL_TILE_SIZE = 256;
export const DETAIL_TILES_PER_EXPORT_SIDE = 8;
export const DETAIL_EXPORT_SIZE = DETAIL_TILE_SIZE * DETAIL_TILES_PER_EXPORT_SIDE;
export const MAX_DETAIL_EXPORTS_PER_OPERATION = 40;

const WEB_MERCATOR_CIRCUMFERENCE_M = 40_075_016.68557849;
const MAX_MERCATOR_LAT = 85.05112878;
const WORLD_PIXEL_SIZE = DETAIL_TILE_SIZE * 2 ** DETAIL_ZOOM;

export interface DetailExportCell {
  /** Export-cell column in the global 2048px z21 world grid. */
  readonly x: number;
  /** Export-cell row in the global 2048px z21 world grid. */
  readonly y: number;
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  /** ArcGIS REST bbox in EPSG:3857 meters: west, south, east, north. */
  readonly bbox3857: readonly [number, number, number, number];
  /** WGS84 bounds: west, south, east, north. */
  readonly bounds: {
    readonly west: number;
    readonly south: number;
    readonly east: number;
    readonly north: number;
  };
}

export interface PlannedDetailTile {
  /** Global cached tile column at z21. */
  readonly x: number;
  /** Global cached tile row at z21. */
  readonly y: number;
  /** Column and row within this export image. */
  readonly col: number;
  readonly row: number;
}

export interface DetailExportPlan {
  readonly cells: readonly DetailExportCell[];
  readonly totalExports: number;
  readonly areaSqMeters: number;
  readonly recommendedLimit: number;
  readonly exceedsRecommendedLimit: boolean;
}

interface Point {
  readonly x: number;
  readonly y: number;
}

export function detailWorldPixel([lat, lon]: LatLon): readonly [number, number] {
  const safeLat = Math.max(-MAX_MERCATOR_LAT, Math.min(MAX_MERCATOR_LAT, lat));
  const sin = Math.sin((safeLat * Math.PI) / 180);
  return [
    ((lon + 180) / 360) * WORLD_PIXEL_SIZE,
    (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * WORLD_PIXEL_SIZE,
  ];
}

export function worldPixelToDetailLatLon([x, y]: readonly [number, number]): LatLon {
  const lon = (x / WORLD_PIXEL_SIZE) * 360 - 180;
  const n = Math.PI - (2 * Math.PI * y) / WORLD_PIXEL_SIZE;
  const lat = (180 / Math.PI) * Math.atan(Math.sinh(n));
  return [lat, lon];
}

function worldPixelToMeters(x: number, y: number): readonly [number, number] {
  return [
    (x / WORLD_PIXEL_SIZE - 0.5) * WEB_MERCATOR_CIRCUMFERENCE_M,
    (0.5 - y / WORLD_PIXEL_SIZE) * WEB_MERCATOR_CIRCUMFERENCE_M,
  ];
}

function createCell(x: number, y: number): DetailExportCell {
  const left = x * DETAIL_EXPORT_SIZE;
  const top = y * DETAIL_EXPORT_SIZE;
  const [west] = worldPixelToMeters(left, top);
  const [, north] = worldPixelToMeters(left, top);
  const [east, south] = worldPixelToMeters(left + DETAIL_EXPORT_SIZE, top + DETAIL_EXPORT_SIZE);
  const [northLat, westLon] = worldPixelToDetailLatLon([left, top]);
  const [southLat, eastLon] = worldPixelToDetailLatLon([
    left + DETAIL_EXPORT_SIZE,
    top + DETAIL_EXPORT_SIZE,
  ]);
  return {
    x,
    y,
    left,
    top,
    width: DETAIL_EXPORT_SIZE,
    height: DETAIL_EXPORT_SIZE,
    bbox3857: [west, south, east, north],
    bounds: { west: westLon, south: southLat, east: eastLon, north: northLat },
  };
}

export function planDetailExportAt(focus: LatLon): DetailExportCell {
  const [x, y] = detailWorldPixel(focus);
  return createCell(Math.floor(x / DETAIL_EXPORT_SIZE), Math.floor(y / DETAIL_EXPORT_SIZE));
}

/** Returns the focus export plus its eight surrounding cells, ordered by distance to the focus. */
export function planDetailExportNeighborhood(focus: LatLon): readonly DetailExportCell[] {
  const center = planDetailExportAt(focus);
  const [focusX, focusY] = detailWorldPixel(focus);
  const neighbors = Array.from({ length: 9 }, (_, index) => {
    const dx = (index % 3) - 1;
    const dy = Math.floor(index / 3) - 1;
    return createCell(center.x + dx, center.y + dy);
  });
  return neighbors.sort((a, b) => {
    const distance = (cell: DetailExportCell) => {
      const x = Math.max(cell.left - focusX, 0, focusX - (cell.left + cell.width));
      const y = Math.max(cell.top - focusY, 0, focusY - (cell.top + cell.height));
      return Math.hypot(x, y);
    };
    const delta = distance(a) - distance(b);
    if (delta !== 0) return delta;
    if (a.x === center.x && a.y === center.y) return -1;
    if (b.x === center.x && b.y === center.y) return 1;
    return a.y - b.y || a.x - b.x;
  });
}

function pointInRect(point: Point, left: number, top: number, right: number, bottom: number) {
  return point.x >= left && point.x <= right && point.y >= top && point.y <= bottom;
}

function pointInPolygon(point: Point, polygon: readonly Point[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]!;
    const b = polygon[j]!;
    if (
      a.y > point.y !== b.y > point.y &&
      point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x
    ) {
      inside = !inside;
    }
  }
  return inside;
}

function segmentIntersectsRect(
  a: Point,
  b: Point,
  left: number,
  top: number,
  right: number,
  bottom: number,
) {
  let tMin = 0;
  let tMax = 1;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  for (const [p, q] of [
    [-dx, a.x - left],
    [dx, right - a.x],
    [-dy, a.y - top],
    [dy, bottom - a.y],
  ] as const) {
    if (p === 0) {
      if (q < 0) return false;
      continue;
    }
    const t = q / p;
    if (p < 0) tMin = Math.max(tMin, t);
    else tMax = Math.min(tMax, t);
    if (tMin > tMax) return false;
  }
  return true;
}

function polygonIntersectsCell(polygon: readonly Point[], cell: DetailExportCell): boolean {
  const left = cell.left;
  const top = cell.top;
  const right = left + cell.width;
  const bottom = top + cell.height;
  if (polygon.some((point) => pointInRect(point, left, top, right, bottom))) return true;
  const corners = [
    { x: left, y: top },
    { x: right, y: top },
    { x: right, y: bottom },
    { x: left, y: bottom },
  ];
  if (corners.some((point) => pointInPolygon(point, polygon))) return true;
  return polygon.some((point, i) =>
    segmentIntersectsRect(point, polygon[(i + 1) % polygon.length]!, left, top, right, bottom),
  );
}

export function planDetailExports(
  boundary: readonly LatLon[],
  recommendedLimit = MAX_DETAIL_EXPORTS_PER_OPERATION,
): DetailExportPlan {
  if (boundary.length < 3) throw new Error('A maximum-detail boundary needs at least 3 points.');
  if (
    boundary.some(
      ([lat, lon]) =>
        !Number.isFinite(lat) ||
        !Number.isFinite(lon) ||
        Math.abs(lat) > MAX_MERCATOR_LAT ||
        Math.abs(lon) > 180,
    )
  ) {
    throw new Error('Boundary points must be finite WGS84 coordinates within Web Mercator.');
  }
  if (!Number.isInteger(recommendedLimit) || recommendedLimit < 1) {
    throw new Error('The recommended export limit must be a positive integer.');
  }

  const polygon = boundary.map((point) => {
    const [x, y] = detailWorldPixel(point);
    return { x, y };
  });
  const meanLatitude = boundary.reduce((sum, [lat]) => sum + lat, 0) / boundary.length;
  let twiceArea = 0;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i]!;
    const b = polygon[(i + 1) % polygon.length]!;
    twiceArea += a.x * b.y - b.x * a.y;
  }
  const projectedPixelSize = WEB_MERCATOR_CIRCUMFERENCE_M / WORLD_PIXEL_SIZE;
  const areaSqMeters =
    (Math.abs(twiceArea) / 2) *
    projectedPixelSize ** 2 *
    Math.cos((meanLatitude * Math.PI) / 180) ** 2;
  const minX = Math.min(...polygon.map(({ x }) => x));
  const maxX = Math.max(...polygon.map(({ x }) => x));
  const minY = Math.min(...polygon.map(({ y }) => y));
  const maxY = Math.max(...polygon.map(({ y }) => y));
  const firstX = Math.floor(minX / DETAIL_EXPORT_SIZE);
  const lastX = Math.floor(
    Math.max(minX, maxX - Number.EPSILON * WORLD_PIXEL_SIZE) / DETAIL_EXPORT_SIZE,
  );
  const firstY = Math.floor(minY / DETAIL_EXPORT_SIZE);
  const lastY = Math.floor(
    Math.max(minY, maxY - Number.EPSILON * WORLD_PIXEL_SIZE) / DETAIL_EXPORT_SIZE,
  );
  const cells: DetailExportCell[] = [];

  for (let y = firstY; y <= lastY; y++) {
    for (let x = firstX; x <= lastX; x++) {
      const cell = createCell(x, y);
      if (polygonIntersectsCell(polygon, cell)) cells.push(cell);
    }
  }

  cells.sort((a, b) => a.y - b.y || a.x - b.x);
  return {
    cells,
    totalExports: cells.length,
    areaSqMeters,
    recommendedLimit,
    exceedsRecommendedLimit: cells.length > recommendedLimit,
  };
}

export function detailExportTiles(cell: DetailExportCell): readonly PlannedDetailTile[] {
  return Array.from({ length: DETAIL_TILES_PER_EXPORT_SIDE ** 2 }, (_, index) => {
    const col = index % DETAIL_TILES_PER_EXPORT_SIDE;
    const row = Math.floor(index / DETAIL_TILES_PER_EXPORT_SIDE);
    return {
      x: cell.x * DETAIL_TILES_PER_EXPORT_SIDE + col,
      y: cell.y * DETAIL_TILES_PER_EXPORT_SIDE + row,
      col,
      row,
    };
  });
}
