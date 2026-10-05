import { describe, expect, it } from 'vitest';
import { fitAnchors, forward, inverse } from '../../core/geo/fit';
import type { Anchor } from '../../core/types';
import {
  drawAffineTile,
  coveringTilesForFit,
  tileAt,
  tileLatLon,
  tileZoom,
  tilesForFit,
  tileCornersInImage,
  TileLru,
} from './esriBackdrop';

function syntheticFit(
  method: 'similarity' | 'affine' | 'tps',
  width = 1000,
  height = 800,
  metersPerPixel = 0.3,
) {
  const anchors: Anchor[] = [];
  const radius = 6378137;
  const lon0 = -80.1,
    lat0 = 27.1;
  const mx0 = (lon0 * Math.PI * radius) / 180;
  const my0 = radius * Math.log(Math.tan(Math.PI / 4 + (lat0 * Math.PI) / 360));
  for (let y = 0; y < 3; y++)
    for (let x = 0; x < 3; x++) {
      const px = [(x * width) / 2, (y * height) / 2] as const;
      const mx = mx0 + px[0] * metersPerPixel,
        my = my0 - px[1] * metersPerPixel;
      anchors.push({
        id: `${x}-${y}`,
        px,
        source: 'paste',
        ll: [
          ((2 * Math.atan(Math.exp(my / radius)) - Math.PI / 2) * 180) / Math.PI,
          (mx / radius) * (180 / Math.PI),
        ],
      });
    }
  const fit = fitAnchors(anchors, width, height, method);
  if (!fit.ok) throw new Error('synthetic fit failed');
  return fit;
}

describe('Esri editor backdrop math (T-324)', () => {
  it('clamps zoom and maps lon/lat into bounded XYZ tiles', () => {
    const fit = syntheticFit('affine');
    const zoomIn = tileZoom(fit.metersPerPixel, 4, 2, fit.frame.lat0, 19);
    const zoomOut = tileZoom(fit.metersPerPixel, 0.25, 2, fit.frame.lat0, 19);
    expect(zoomIn).toBeGreaterThan(zoomOut);
    expect(tileZoom(1e9, 1, 1, 0, 19)).toBe(0);
    expect(tileZoom(0.01, 10, 1, 0, 19)).toBe(19);
    expect(tileAt(-80, 27, 19)).toMatchObject({
      z: 19,
      x: expect.any(Number),
      y: expect.any(Number),
    });
    expect(tileAt(-180, 90, 19).y).toBe(0);
  });

  it.each(['similarity', 'affine', 'tps'] as const)(
    'maps tile locations through %s fit within half an image pixel',
    (method) => {
      const fit = syntheticFit(method);
      const ll = forward(fit, [500, 400]);
      const tile = tileAt(ll[1], ll[0], 19);
      const n = 2 ** tile.z;
      const u = ((ll[1] + 180) / 360) * n - tile.x;
      const mercY = Math.log(Math.tan(Math.PI / 4 + (ll[0] * Math.PI) / 360));
      const v = (0.5 - mercY / (2 * Math.PI)) * n - tile.y;
      const [lat, lon] = tileLatLon(tile, u, v);
      expect(Number.isFinite(lat) && Number.isFinite(lon)).toBe(true);
      const corners = tileCornersInImage(fit, tile);
      expect(corners).toHaveLength(4);
      expect(corners.every((p) => p === null || p.every(Number.isFinite))).toBe(true);
      const back = inverse(fit, [lat, lon]);
      expect(back).not.toBeNull();
      expect(Math.hypot(back![0] - 500, back![1] - 400)).toBeLessThan(0.5);
    },
  );

  it('caps the requested tile cover and evicts least recently used bitmaps', () => {
    const fit = syntheticFit('affine');
    expect(tilesForFit(fit, 1000, 800, 19, 64).length).toBeLessThanOrEqual(64);
    const lru = new TileLru<number>(2);
    lru.set('a', 1);
    lru.set('b', 2);
    lru.get('a');
    lru.set('c', 3);
    expect(lru.get('a')).toBe(1);
    expect(lru.get('b')).toBeUndefined();
  });

  it('keeps a fit-to-screen 3000x2200 map at 2 m/px within 64 tiles', () => {
    const fit = syntheticFit('affine', 3000, 2200, 2);
    const fitScale = Math.min(1000 / 3000, 700 / 2200);
    const requestedZ = tileZoom(fit.metersPerPixel, fitScale, 2, fit.frame.lat0, 19);
    expect(tilesForFit(fit, 3000, 2200, requestedZ, 10_000).length).toBeGreaterThan(64);
    const { z, tiles } = coveringTilesForFit(fit, 3000, 2200, requestedZ, 64);
    expect(z).toBeLessThan(requestedZ);
    expect(tiles.length).toBeGreaterThan(0);
    expect(tiles.length).toBeLessThanOrEqual(64);
  });

  it('draws each affine tile once without clipping', () => {
    const calls = { draw: 0, clip: 0 };
    const ctx = {
      save() {},
      restore() {},
      transform() {},
      drawImage() {
        calls.draw++;
      },
      clip() {
        calls.clip++;
      },
    } as unknown as CanvasRenderingContext2D;
    const tile = { width: 256, height: 256 } as CanvasImageSource & {
      width: number;
      height: number;
    };
    drawAffineTile(ctx, tile, 256, 256, [10, 20], [266, 20], [10, 276]);
    expect(calls).toEqual({ draw: 1, clip: 0 });
  });
});
