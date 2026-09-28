import { describe, expect, it } from 'vitest';
import type { RasterImage, Rgb } from '../types';
import { pickInk, snapToInk } from './ink';
// @ts-expect-error Copied prototype helpers are untyped and test-only.
import * as prototype from './__prototype__/astar.js';

function raster(width: number, height: number, color: Rgb = [255, 255, 255]): RasterImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = color[0];
    data[i * 4 + 1] = color[1];
    data[i * 4 + 2] = color[2];
    data[i * 4 + 3] = 255;
  }
  return { width, height, data };
}
function setPixel(img: RasterImage, x: number, y: number, color: Rgb): void {
  const i = (y * img.width + x) * 4;
  img.data[i] = color[0];
  img.data[i + 1] = color[1];
  img.data[i + 2] = color[2];
  img.data[i + 3] = 255;
}
function prototypeImage(img: RasterImage) {
  return { W: img.width, H: img.height, data: img.data };
}

describe('ink picking and snapping', () => {
  it('matches prototype dominant ink scoring and fallback', () => {
    const img = raster(60, 50);
    for (let x = 10; x < 50; x++) for (let y = 24; y <= 26; y++) setPixel(img, x, y, [205, 48, 48]);
    for (const [at, radius] of [
      [[30, 24], 4],
      [[12.4, 27.2], 8],
      [[0, 0], 3],
    ] as const) {
      expect(pickInk(img, at, radius)).toEqual(
        prototype.prototypePickInk(prototypeImage(img), at[0], at[1], radius),
      );
    }
    const uniform = raster(12, 12, [8, 20, 40]);
    expect(pickInk(uniform, [5, 5], 4)).toEqual([8, 20, 40]);
  });
  it('clamps radius and uses the prototype snap score, returning null outside tolerance', () => {
    const img = raster(40, 40);
    setPixel(img, 20, 20, [200, 10, 20]);
    setPixel(img, 21, 20, [205, 12, 18]);
    for (const radius of [0, 2, 14, 80]) {
      const actual = snapToInk(img, [20.7, 19.8], [200, 10, 20], 10, radius);
      expect(actual).toEqual(
        prototype.prototypeSnap(prototypeImage(img), 20.7, 19.8, [200, 10, 20], 10, radius),
      );
    }
    expect(snapToInk(img, [5, 5], [0, 0, 0], 1, 5)).toBeNull();
  });
});
