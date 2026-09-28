// Lane C. Georeferenced overlay source preparation for MapLibre (card T-309).
import type { FeatureId, GeoFeature, GeoFit, LatLon, Px } from '../../core/types';
import { overlayMesh, overlayQuad } from '../../core/geo/fit';

export const DEFAULT_TPS_CELLS = 16;
export const OVERLAY_SOURCE_ID = 'trailmaker-overlay-source';
export const OVERLAY_LAYER_ID = 'trailmaker-overlay-layer';
export const FEATURES_SOURCE_ID = 'trailmaker-features-source';

export type MapLibreQuadCoordinates = [
  [number, number], // top-left [lng, lat]
  [number, number], // top-right [lng, lat]
  [number, number], // bottom-right [lng, lat]
  [number, number], // bottom-left [lng, lat]
];

export interface QuadOverlaySpec {
  readonly type: 'quad';
  readonly coordinates: MapLibreQuadCoordinates;
}

export interface MeshOverlaySpec {
  readonly type: 'mesh';
  readonly cells: number;
  readonly mesh: {
    readonly cols: number;
    readonly rows: number;
    readonly px: Px[];
    readonly ll: LatLon[];
  };
  readonly bounds: {
    readonly minLng: number;
    readonly minLat: number;
    readonly maxLng: number;
    readonly maxLat: number;
  };
  readonly coordinates: MapLibreQuadCoordinates;
}

export type OverlaySpec = QuadOverlaySpec | MeshOverlaySpec;

/**
 * Build the overlay specification for MapLibre:
 * - For similarity or affine fits: returns an exact 4-corner quad (top-left, top-right, bottom-right, bottom-left) in [lng, lat].
 * - For TPS fits: returns a grid mesh using overlayMesh with the default recommended 16 cells.
 */
export function buildOverlaySpec(
  fit: GeoFit,
  width: number,
  height: number,
  cells = DEFAULT_TPS_CELLS,
): OverlaySpec {
  if (fit.method === 'similarity' || fit.method === 'affine') {
    const quad = overlayQuad(fit, width, height);
    // overlayQuad returns [BL, BR, TR, TL] as [lat, lon]
    // MapLibre image/canvas coordinates expect [TL, TR, BR, BL] as [lng, lat]
    const coordinates: MapLibreQuadCoordinates = [
      [quad[3][1], quad[3][0]], // TL
      [quad[2][1], quad[2][0]], // TR
      [quad[1][1], quad[1][0]], // BR
      [quad[0][1], quad[0][0]], // BL
    ];
    return { type: 'quad', coordinates };
  }

  const clampedCells = Number.isFinite(cells) ? Math.min(64, Math.max(1, Math.round(cells))) : DEFAULT_TPS_CELLS;
  const mesh = overlayMesh(fit, width, height, clampedCells);

  let minLng = Infinity;
  let maxLng = -Infinity;
  let minLat = Infinity;
  let maxLat = -Infinity;

  for (const [lat, lon] of mesh.ll) {
    if (lon < minLng) minLng = lon;
    if (lon > maxLng) maxLng = lon;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }

  const coordinates: MapLibreQuadCoordinates = [
    [minLng, maxLat], // TL
    [maxLng, maxLat], // TR
    [maxLng, minLat], // BR
    [minLng, minLat], // BL
  ];

  return {
    type: 'mesh',
    cells: clampedCells,
    mesh,
    bounds: { minLng, minLat, maxLng, maxLat },
    coordinates,
  };
}

/**
 * Draw a single triangle textured from an image onto a 2D canvas context using affine transformation.
 */
export function drawTexturedTriangle(
  ctx: CanvasRenderingContext2D,
  image: CanvasImageSource,
  // 3 canvas points
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  // 3 source image points
  u0: number,
  v0: number,
  u1: number,
  v1: number,
  u2: number,
  v2: number,
): void {
  const delta = u0 * (v1 - v2) - u1 * (v0 - v2) + u2 * (v0 - v1);
  if (Math.abs(delta) < 1e-10) return;

  ctx.save();
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.closePath();
  ctx.clip();

  const a = (x0 * (v1 - v2) - x1 * (v0 - v2) + x2 * (v0 - v1)) / delta;
  const b = (y0 * (v1 - v2) - y1 * (v0 - v2) + y2 * (v0 - v1)) / delta;
  const c = (x0 * (u2 - u1) + x1 * (u0 - u2) + x2 * (u1 - u0)) / delta;
  const d = (y0 * (u2 - u1) + y1 * (u0 - u2) + y2 * (u1 - u0)) / delta;
  const e = (x0 * (u1 * v2 - u2 * v1) - x1 * (u0 * v2 - u2 * v0) + x2 * (u0 * v1 - u1 * v0)) / delta;
  const f = (y0 * (u1 * v2 - u2 * v1) - y1 * (u0 * v2 - u2 * v0) + y2 * (u0 * v1 - u1 * v0)) / delta;

  ctx.transform(a, b, c, d, e, f);
  ctx.drawImage(image, 0, 0);
  ctx.restore();
}

/**
 * Render a warped image over a TPS mesh onto a canvas corresponding to its geographic bounding box.
 */
export function renderMeshToCanvas(
  spec: MeshOverlaySpec,
  image: CanvasImageSource,
  targetCanvas: HTMLCanvasElement,
): void {
  const ctx = targetCanvas.getContext('2d');
  if (!ctx) return;

  const w = targetCanvas.width;
  const h = targetCanvas.height;
  ctx.clearRect(0, 0, w, h);

  const { mesh, bounds } = spec;
  const lngSpan = bounds.maxLng - bounds.minLng || 1;
  const latSpan = bounds.maxLat - bounds.minLat || 1;

  function toCanvas(ll: LatLon): [number, number] {
    const x = ((ll[1] - bounds.minLng) / lngSpan) * w;
    const y = ((bounds.maxLat - ll[0]) / latSpan) * h;
    return [x, y];
  }

  for (let r = 0; r < mesh.rows; r++) {
    for (let c = 0; c < mesh.cols; c++) {
      const tlIdx = r * (mesh.cols + 1) + c;
      const trIdx = tlIdx + 1;
      const blIdx = (r + 1) * (mesh.cols + 1) + c;
      const brIdx = blIdx + 1;

      const pxTL = mesh.px[tlIdx]!;
      const pxTR = mesh.px[trIdx]!;
      const pxBL = mesh.px[blIdx]!;
      const pxBR = mesh.px[brIdx]!;

      const [xTL, yTL] = toCanvas(mesh.ll[tlIdx]!);
      const [xTR, yTR] = toCanvas(mesh.ll[trIdx]!);
      const [xBL, yBL] = toCanvas(mesh.ll[blIdx]!);
      const [xBR, yBR] = toCanvas(mesh.ll[brIdx]!);

      // Triangle 1: TL, TR, BL
      drawTexturedTriangle(
        ctx,
        image,
        xTL,
        yTL,
        xTR,
        yTR,
        xBL,
        yBL,
        pxTL[0],
        pxTL[1],
        pxTR[0],
        pxTR[1],
        pxBL[0],
        pxBL[1],
      );

      // Triangle 2: TR, BR, BL
      drawTexturedTriangle(
        ctx,
        image,
        xTR,
        yTR,
        xBR,
        yBR,
        xBL,
        yBL,
        pxTR[0],
        pxTR[1],
        pxBR[0],
        pxBR[1],
        pxBL[0],
        pxBL[1],
      );
    }
  }
}

export interface GeoJsonFeatureCollection {
  readonly type: 'FeatureCollection';
  readonly features: readonly GeoJsonFeature[];
}

export interface GeoJsonFeature {
  readonly type: 'Feature';
  readonly id: string;
  readonly properties: {
    readonly id: string;
    readonly kind: 'trail' | 'area' | 'poi';
    readonly name: string;
    readonly color: string;
    readonly selected: boolean;
    readonly poiType?: string | undefined;
  };
  readonly geometry:
    | { readonly type: 'LineString'; readonly coordinates: readonly [number, number][] }
    | { readonly type: 'Polygon'; readonly coordinates: readonly (readonly [number, number][])[] }
    | { readonly type: 'Point'; readonly coordinates: readonly [number, number] };
}

/**
 * Convert GeoFeatures (from toExportDocument) into a GeoJSON FeatureCollection for MapLibre.
 * Coordinates are formatted as [longitude, latitude].
 */
export function featuresToGeoJson(
  features: readonly GeoFeature[],
  selectedFeatureId: FeatureId | null,
): GeoJsonFeatureCollection {
  const geojsonFeatures: GeoJsonFeature[] = [];

  for (const f of features) {
    const isSelected = f.id === selectedFeatureId;
    if (f.kind === 'trail') {
      if (f.ll.length < 2) continue;
      geojsonFeatures.push({
        type: 'Feature',
        id: f.id,
        properties: {
          id: f.id,
          kind: 'trail',
          name: f.name,
          color: f.color,
          selected: isSelected,
        },
        geometry: {
          type: 'LineString',
          coordinates: f.ll.map(([lat, lon]) => [lon, lat]),
        },
      });
    } else if (f.kind === 'area') {
      if (f.ll.length < 3) continue;
      const ring = f.ll.map(([lat, lon]): [number, number] => [lon, lat]);
      // Ensure polygon ring is closed
      if (ring[0]![0] !== ring[ring.length - 1]![0] || ring[0]![1] !== ring[ring.length - 1]![1]) {
        ring.push([ring[0]![0], ring[0]![1]]);
      }
      geojsonFeatures.push({
        type: 'Feature',
        id: f.id,
        properties: {
          id: f.id,
          kind: 'area',
          name: f.name,
          color: f.color,
          selected: isSelected,
        },
        geometry: {
          type: 'Polygon',
          coordinates: [ring],
        },
      });
    } else if (f.kind === 'poi') {
      geojsonFeatures.push({
        type: 'Feature',
        id: f.id,
        properties: {
          id: f.id,
          kind: 'poi',
          name: f.name,
          color: f.color,
          selected: isSelected,
          poiType: f.poiType,
        },
        geometry: {
          type: 'Point',
          coordinates: [f.ll[1], f.ll[0]],
        },
      });
    }
  }

  return {
    type: 'FeatureCollection',
    features: geojsonFeatures,
  };
}

export interface DebouncedFn<T extends (...args: unknown[]) => void> {
  (...args: Parameters<T>): void;
  cancel(): void;
  flush(): void;
}

/**
 * Simple, cancellable debounce utility.
 */
export function debounce<T extends (...args: unknown[]) => void>(
  fn: T,
  waitMs: number,
): DebouncedFn<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastArgs: Parameters<T> | null = null;

  const debounced = (...args: Parameters<T>) => {
    lastArgs = args;
    if (timer !== null) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      timer = null;
      if (lastArgs) {
        fn(...lastArgs);
        lastArgs = null;
      }
    }, waitMs);
  };

  debounced.cancel = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    lastArgs = null;
  };

  debounced.flush = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (lastArgs) {
      fn(...lastArgs);
      lastArgs = null;
    }
  };

  return debounced;
}
