import type { GeoFit, LatLon, Px } from '../../core/types';
import { forward, inverse } from '../../core/geo/fit';

export interface EsriTile {
  readonly z: number;
  readonly x: number;
  readonly y: number;
}
const R = 6378137;
const LIMIT = Math.PI * R;

export function tileZoom(
  metersPerPixel: number,
  viewScale: number,
  dpr: number,
  latitude: number,
  maxZoom: number,
): number {
  const groundMppDevice = metersPerPixel / (viewScale * dpr);
  const resolution = (156543.034 * Math.cos((latitude * Math.PI) / 180)) / groundMppDevice;
  return Math.max(0, Math.min(maxZoom, Math.round(Math.log2(resolution))));
}

export function tileAt(lon: number, lat: number, z: number): EsriTile {
  const n = 2 ** z;
  const x = Math.floor(((lon + 180) / 360) * n);
  const sin = Math.sin((Math.max(-85.05112878, Math.min(85.05112878, lat)) * Math.PI) / 180);
  const y = Math.floor((0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * n);
  return { z, x: Math.max(0, Math.min(n - 1, x)), y: Math.max(0, Math.min(n - 1, y)) };
}

export function tilesForFit(
  fit: GeoFit,
  width: number,
  height: number,
  z: number,
  limit = 64,
  region: readonly Px[] = [
    [0, 0],
    [width, 0],
    [width, height],
    [0, height],
  ],
): EsriTile[] {
  const range = tileRangeForFit(fit, width, height, z, region);
  const { x0, y0, x1, y1, center } = range;
  const count = (x1 - x0 + 1) * (y1 - y0 + 1);
  const all: EsriTile[] = [];
  if (count <= limit) {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) all.push({ z, x, y });
    return all;
  }
  // On an unusually large viewport, bound work while selecting the closest requested tiles.
  for (let radius = 0; all.length < limit && radius <= Math.max(x1 - x0, y1 - y0); radius++) {
    const left = Math.max(x0, center.x - radius),
      right = Math.min(x1, center.x + radius);
    const top = Math.max(y0, center.y - radius),
      bottom = Math.min(y1, center.y + radius);
    for (let x = left; x <= right && all.length < limit; x++) {
      if (center.y - radius >= y0 && center.y - radius <= y1)
        all.push({ z, x, y: center.y - radius });
      if (radius && center.y + radius >= y0 && center.y + radius <= y1 && all.length < limit)
        all.push({ z, x, y: center.y + radius });
    }
    for (let y = top + 1; y < bottom && all.length < limit; y++) {
      if (center.x - radius >= x0 && center.x - radius <= x1)
        all.push({ z, x: center.x - radius, y });
      if (radius && center.x + radius >= x0 && center.x + radius <= x1 && all.length < limit)
        all.push({ z, x: center.x + radius, y });
    }
  }
  return [...new Map(all.map((tile) => [`${tile.x}/${tile.y}`, tile])).values()];
}

export function coveringTilesForFit(
  fit: GeoFit,
  width: number,
  height: number,
  requestedZoom: number,
  limit = 64,
  region?: readonly Px[],
): { readonly z: number; readonly tiles: EsriTile[] } {
  let z = requestedZoom;
  while (z > 0) {
    const { x0, y0, x1, y1 } = tileRangeForFit(fit, width, height, z, region);
    if ((x1 - x0 + 1) * (y1 - y0 + 1) <= limit)
      return { z, tiles: tilesForFit(fit, width, height, z, limit, region) };
    z--;
  }
  return { z, tiles: tilesForFit(fit, width, height, z, limit, region) };
}

function tileRangeForFit(
  fit: GeoFit,
  width: number,
  height: number,
  z: number,
  region: readonly Px[] = [
    [0, 0],
    [width, 0],
    [width, height],
    [0, height],
  ],
): {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
  readonly center: EsriTile;
} {
  const corners = region.map(
    ([x, y]) => [Math.max(0, Math.min(width, x)), Math.max(0, Math.min(height, y))] as const,
  );
  const projected = corners.map((p) => forward(fit, p));
  const minLon = Math.min(...projected.map((p) => p[1])),
    maxLon = Math.max(...projected.map((p) => p[1]));
  const minLat = Math.max(-85.05112878, Math.min(...projected.map((p) => p[0])));
  const maxLat = Math.min(85.05112878, Math.max(...projected.map((p) => p[0])));
  const nw = tileAt(minLon, maxLat, z),
    se = tileAt(maxLon, minLat, z);
  const center = tileAt((minLon + maxLon) / 2, (minLat + maxLat) / 2, z);
  return { x0: nw.x, y0: nw.y, x1: se.x, y1: se.y, center };
}

export function tileLatLon(tile: EsriTile, u: number, v: number): LatLon {
  const n = 2 ** tile.z,
    x = (tile.x + u) / n,
    y = (tile.y + v) / n;
  return [(Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI, x * 360 - 180];
}

export function tileCornersInImage(fit: GeoFit, tile: EsriTile): readonly (Px | null)[] {
  return [
    tileLatLon(tile, 0, 0),
    tileLatLon(tile, 1, 0),
    tileLatLon(tile, 1, 1),
    tileLatLon(tile, 0, 1),
  ].map((ll) => inverse(fit, ll));
}

/** Draw a source-image triangle into image-Px coordinates, preserving the caller's view CTM. */
function affineForTriangle(
  source: readonly [Px, Px, Px],
  target: readonly [Px, Px, Px],
): readonly [number, number, number, number, number, number] | null {
  const [s0, s1, s2] = source,
    [d0, d1, d2] = target;
  const sx1 = s1[0] - s0[0],
    sy1 = s1[1] - s0[1],
    sx2 = s2[0] - s0[0],
    sy2 = s2[1] - s0[1];
  const det = sx1 * sy2 - sx2 * sy1;
  if (Math.abs(det) < 1e-9) return null;
  const dx1 = d1[0] - d0[0],
    dy1 = d1[1] - d0[1],
    dx2 = d2[0] - d0[0],
    dy2 = d2[1] - d0[1];
  const a = (dx1 * sy2 - dx2 * sy1) / det,
    c = (-dx1 * sx2 + dx2 * sx1) / det;
  const b = (dy1 * sy2 - dy2 * sy1) / det,
    d = (-dy1 * sx2 + dy2 * sx1) / det;
  const e = d0[0] - a * s0[0] - c * s0[1],
    f = d0[1] - b * s0[0] - d * s0[1];
  return [a, b, c, d, e, f];
}

/** Draw an affine tile using its NW, NE and SW image-Px corners (no clipping). */
export function drawAffineTile(
  ctx: CanvasRenderingContext2D,
  image: CanvasImageSource,
  width: number,
  height: number,
  nw: Px,
  ne: Px,
  sw: Px,
): void {
  const matrix = affineForTriangle(
    [
      [0, 0],
      [width, 0],
      [0, height],
    ],
    [nw, ne, sw],
  );
  if (!matrix) return;
  ctx.save();
  ctx.transform(...matrix);
  ctx.drawImage(image, 0, 0);
  ctx.restore();
}

function inflateTriangle(target: readonly [Px, Px, Px], amount: number): readonly [Px, Px, Px] {
  const cx = (target[0][0] + target[1][0] + target[2][0]) / 3;
  const cy = (target[0][1] + target[1][1] + target[2][1]) / 3;
  return target.map(([x, y]) => {
    const dx = x - cx,
      dy = y - cy,
      length = Math.hypot(dx, dy) || 1;
    return [x + (dx / length) * amount, y + (dy / length) * amount] as Px;
  }) as unknown as readonly [Px, Px, Px];
}

export function drawWarpTriangle(
  ctx: CanvasRenderingContext2D,
  image: CanvasImageSource,
  source: readonly [Px, Px, Px],
  target: readonly [Px, Px, Px],
  padding = 0,
): void {
  const [d0, d1, d2] = padding ? inflateTriangle(target, padding) : target;
  const matrix = affineForTriangle(source, [d0, d1, d2]);
  if (!matrix) return;
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(d0[0], d0[1]);
  ctx.lineTo(d1[0], d1[1]);
  ctx.lineTo(d2[0], d2[1]);
  ctx.closePath();
  ctx.clip();
  ctx.transform(...matrix);
  ctx.drawImage(image, 0, 0);
  ctx.restore();
}

/** Web Mercator tile bounds in metres, useful for stable coverage enumeration. */
export function tileMercatorBounds(tile: EsriTile): readonly [number, number, number, number] {
  const n = 2 ** tile.z,
    size = (2 * LIMIT) / n;
  const x0 = -LIMIT + tile.x * size,
    y1 = LIMIT - tile.y * size;
  return [x0, y1 - size, x0 + size, y1];
}

export class TileLru<T> {
  private readonly items = new Map<string, T>();
  constructor(private readonly capacity = 256) {}
  get(key: string): T | undefined {
    const v = this.items.get(key);
    if (v !== undefined) {
      this.items.delete(key);
      this.items.set(key, v);
    }
    return v;
  }
  set(key: string, value: T): void {
    this.items.delete(key);
    this.items.set(key, value);
    while (this.items.size > this.capacity) {
      const oldest = this.items.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      const evicted = this.items.get(oldest);
      if (evicted && typeof ImageBitmap !== 'undefined' && evicted instanceof ImageBitmap)
        evicted.close();
      this.items.delete(oldest);
    }
  }
  get size(): number {
    return this.items.size;
  }
}
