import { describe, expect, it } from 'vitest';
import type { JobHooks, Px, RasterImage, Rgb } from '../types';
import { JOB_CANCELLED } from '../types';
import { tracePath } from './astar';
// @ts-expect-error Copied prototype functions are untyped and test-only.
import * as prototype from './__prototype__/astar.js';

function raster(width: number, height: number): RasterImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = 255;
    data[i * 4 + 1] = 255;
    data[i * 4 + 2] = 255;
    data[i * 4 + 3] = 255;
  }
  return { width, height, data };
}
function paint(img: RasterImage, x: number, y: number, color: Rgb): void {
  const i = (y * img.width + x) * 4;
  img.data[i] = color[0];
  img.data[i + 1] = color[1];
  img.data[i + 2] = color[2];
}
function prototypeImage(img: RasterImage) {
  return { W: img.width, H: img.height, data: img.data };
}

describe('A* smart-follow characterization', () => {
  it('matches prototype paths on horizontal and curved ink paths', () => {
    const img = raster(180, 120),
      red: Rgb = [205, 48, 48];
    for (let x = 12; x <= 160; x++) {
      const y = 35 + Math.round(18 * Math.sin(((x - 12) / 148) * Math.PI));
      for (let dy = -1; dy <= 1; dy++) paint(img, x, y + dy, red);
    }
    const cases: [Px, Px][] = [
      [
        [12, 35],
        [160, 35],
      ],
      [
        [35, 46],
        [90, 53],
      ],
      [
        [90, 53],
        [160, 35],
      ],
    ];
    for (const [a, b] of cases) {
      expect(tracePath(img, a, b, red, 60)).toEqual(
        prototype.prototypeTrace(prototypeImage(img), a, b, red, 60),
      );
    }
  });
  it('uses exact endpoints, handles no-op hops, and rejects oversized windows', () => {
    const img = raster(100, 80),
      red: Rgb = [205, 48, 48];
    for (let x = 5; x < 95; x++) paint(img, x, 40, red);
    expect(tracePath(img, [5, 40], [94, 40], red, 60)).toEqual([
      [5, 40],
      [94, 40],
    ]);
    expect(tracePath(img, [5, 40], [5, 40], red, 60)).toEqual([[5, 40]]);
    const huge = raster(2000, 2000);
    expect(tracePath(huge, [0, 0], [1999, 1999], red, 60)).toBeNull();
    expect(tracePath(img, [-1, 40], [94, 40], red, 60)).toBeNull();
  });
  it('keeps solid, dashed, and crossing-line fixture paths within two pixels', () => {
    const red: Rgb = [205, 48, 48],
      blue: Rgb = [35, 96, 195];
    const cases = ['solid', 'dashed', 'crossing'] as const;
    for (const kind of cases) {
      const img = raster(180, 100),
        truth: Px[] = [];
      for (let x = 10; x <= 170; x++) {
        truth.push([x, 30]);
        if (kind !== 'dashed' || x % 16 < 10) paint(img, x, 30, red);
      }
      if (kind === 'crossing') for (let y = 5; y <= 65; y++) paint(img, 90, y, blue);
      const path = tracePath(img, truth[0]!, truth.at(-1)!, red, 60);
      expect(path).not.toBeNull();
      const pointLineDistance = (p: Px, line: readonly Px[]) => {
        let best = Infinity;
        for (let i = 1; i < line.length; i++) {
          const [ax, ay] = line[i - 1]!,
            [bx, by] = line[i]!;
          const dx = bx - ax,
            dy = by - ay;
          const t = Math.max(
            0,
            Math.min(1, ((p[0] - ax) * dx + (p[1] - ay) * dy) / (dx * dx + dy * dy || 1)),
          );
          best = Math.min(best, Math.hypot(p[0] - ax - t * dx, p[1] - ay - t * dy));
        }
        return best;
      };
      const hausdorff = (from: readonly Px[], to: readonly Px[]) =>
        Math.max(
          ...from.map((point) => pointLineDistance(point, to)),
          ...to.map((point) => pointLineDistance(point, from)),
        );
      expect(hausdorff(path!, truth)).toBeLessThanOrEqual(2);
    }
  });
  it('checks cancellation at entry and reports progress while searching', () => {
    const img = raster(100, 80),
      red: Rgb = [205, 48, 48];
    for (let x = 5; x < 95; x++) paint(img, x, 40, red);
    const cancelled: JobHooks = {
      progress: () => {},
      throwIfCancelled: () => {
        throw Object.assign(new Error('cancelled'), { name: JOB_CANCELLED });
      },
    };
    expect(() => tracePath(img, [5, 40], [94, 40], red, 60, cancelled)).toThrowError(
      expect.objectContaining({ name: JOB_CANCELLED }),
    );
    const fractions: number[] = [];
    const hooks: JobHooks = {
      progress: (fraction) => fractions.push(fraction),
      throwIfCancelled: () => {},
    };
    expect(tracePath(img, [5, 40], [94, 40], red, 60, hooks)).not.toBeNull();
    expect(fractions[0]).toBe(0);
    expect(fractions.at(-1)).toBe(1);
  });
  it('honors cancellation during a large cost pass', () => {
    const img = raster(1400, 1400),
      red: Rgb = [205, 48, 48];
    let checks = 0;
    const hooks: JobHooks = {
      progress: () => {},
      throwIfCancelled: () => {
        checks++;
        if (checks > 1)
          throw Object.assign(new Error('cancelled during scan'), { name: JOB_CANCELLED });
      },
    };
    expect(() => tracePath(img, [20, 20], [1380, 1380], red, 60, hooks)).toThrowError(
      expect.objectContaining({ name: JOB_CANCELLED }),
    );
    expect(checks).toBeGreaterThan(1);
  });
});
