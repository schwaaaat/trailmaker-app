import { describe, expect, it, vi } from 'vitest';
import type { JobHooks, Px, RasterImage, Rgb } from '../types';
import { JOB_CANCELLED } from '../types';
import { refineLine } from './refine';

const RED: Rgb = [205, 48, 48];

function raster(width = 220, height = 100): RasterImage {
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
  if (x < 0 || y < 0 || x >= img.width || y >= img.height) return;
  const i = (y * img.width + x) * 4;
  img.data[i] = color[0];
  img.data[i + 1] = color[1];
  img.data[i + 2] = color[2];
  img.data[i + 3] = 255;
}

function horizontal(img: RasterImage, y: number, color: Rgb, dashed = false): void {
  for (let x = 8; x < img.width - 8; x++) {
    if (dashed && x % 18 >= 13) continue;
    for (let dy = -1; dy <= 1; dy++) paint(img, x, y + dy, color);
  }
}

function greenField(withTrail: boolean): RasterImage {
  const img = raster(220, 100);
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const i = (y * img.width + x) * 4;
      const noise = ((x * 19 + y * 23) % 7) - 3;
      img.data[i] = 92 + noise;
      img.data[i + 1] = 137 + noise;
      img.data[i + 2] = 76 + noise;
    }
  }
  if (withTrail) {
    for (let x = 8; x < img.width - 8; x++) {
      paint(img, x, 50, [38 + (x % 3), 44 + (x % 3), 39 + (x % 3)]);
    }
  }
  return img;
}

function distanceToLine(p: Px, a: Px, b: Px): number {
  const dx = b[0] - a[0],
    dy = b[1] - a[1];
  const t = Math.max(
    0,
    Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy)),
  );
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

describe('refineLine (T-327)', () => {
  it('leaves a blank corridor byte-for-byte on the hand line and marks every section unrefined', () => {
    const pts: Px[] = [
      [10, 42],
      [70, 45],
      [130, 41],
      [200, 44],
    ];
    const result = refineLine(raster(), pts, 10, RED, 45, []);
    expect(result.pts).toEqual(pts);
    expect(result.segments.length).toBeGreaterThan(0);
    expect(result.segments.every((segment) => !segment.refined && segment.confidence < 0.6)).toBe(
      true,
    );
    expect(result.segments[0]!.from).toBe(0);
    expect(result.segments.at(-1)!.to).toBe(pts.length - 1);
  });

  it('follows solid ink inside the corridor while keeping the hand endpoints', () => {
    const img = raster();
    horizontal(img, 50, RED);
    const pts: Px[] = [
      [10, 54],
      [100, 54],
      [210, 54],
    ];
    const result = refineLine(img, pts, 8, RED, 45, []);

    expect(result.pts[0]).toEqual(pts[0]);
    expect(result.pts.at(-1)).toEqual(pts.at(-1));
    expect(result.segments.some((segment) => segment.refined && segment.confidence >= 0.6)).toBe(
      true,
    );
    expect(
      Math.min(...result.pts.slice(1, -1).map((p) => Math.abs(p[1] - 50))),
    ).toBeLessThanOrEqual(2);
    expect(result.pts.every((p) => distanceToLine(p, pts[0]!, pts.at(-1)!) <= 8.1)).toBe(true);
  });

  it('simplifies refined pixels at 0.9 px and keeps segment indexes contiguous', () => {
    const img = raster(540, 100);
    horizontal(img, 50, RED);
    const hand: Px[] = [
      [10, 53],
      [530, 53],
    ];
    const result = refineLine(img, hand, 8, RED, 45, []);

    expect(result.pts.length).toBeLessThan(80);
    expect(result.pts[0]).toEqual(hand[0]);
    expect(result.pts.at(-1)).toEqual(hand[1]);
    expect(result.segments.length).toBeGreaterThan(1);
    result.segments.forEach((segment, index) => {
      expect(segment.from).toBeGreaterThanOrEqual(0);
      expect(segment.to).toBeLessThan(result.pts.length);
      expect(segment.from).toBeLessThanOrEqual(segment.to);
      if (index > 0) expect(segment.from).toBe(result.segments[index - 1]!.to);
    });
    expect(result.segments[0]!.from).toBe(0);
    expect(result.segments.at(-1)!.to).toBe(result.pts.length - 1);
  });

  it('samples the followed ink when request ink is null', () => {
    const img = raster();
    horizontal(img, 50, RED);
    const result = refineLine(
      img,
      [
        [10, 50],
        [210, 50],
      ],
      8,
      null,
      45,
      [],
    );
    expect(result.ink).toEqual(RED);
    expect(result.segments.some((segment) => segment.refined)).toBe(true);
  });

  it('finds a thin trail three pixels off the hand line on a noisy green field', () => {
    const img = greenField(true);
    const pts: Px[] = [
      [10, 53],
      [210, 53],
    ];
    const result = refineLine(img, pts, 8, null, 45, []);
    expect(result.ink[0]).toBeLessThan(60);
    expect(result.segments.some((segment) => segment.refined)).toBe(true);
    // Endpoints and the few pixels needed to transition from them stay user-controlled.
    const interior = result.pts.slice(3, -3);
    expect(
      interior.filter((p) => Math.abs(p[1] - 50) <= 1).length / interior.length,
    ).toBeGreaterThanOrEqual(0.9);
  });

  it('keeps a hand line on uniform noisy vegetation when no distinct ink exists', () => {
    const pts: Px[] = [
      [10, 52],
      [80, 50],
      [150, 53],
      [210, 51],
    ];
    const result = refineLine(greenField(false), pts, 8, null, 45, []);
    expect(result.pts).toEqual(pts);
    expect(result.segments.every((segment) => !segment.refined)).toBe(true);
  });

  it('bridges dashed gaps and stays on the hand route at a same-colour crossing', () => {
    const img = raster();
    horizontal(img, 50, RED, true);
    for (let y = 8; y < 92; y++) {
      if (y % 18 < 13) {
        for (let dx = -1; dx <= 1; dx++) paint(img, 110 + dx, y, RED);
      }
    }
    const pts: Px[] = [
      [10, 53],
      [110, 53],
      [210, 53],
    ];
    const result = refineLine(img, pts, 9, RED, 45, []);
    const center = result.pts.filter((p) => p[0] > 40 && p[0] < 180);
    expect(result.segments.some((segment) => segment.refined)).toBe(true);
    expect(Math.max(...center.map((p) => Math.abs(p[1] - 50)))).toBeLessThanOrEqual(2);
  });

  it('keeps pinned shared junction vertices at their exact image coordinates', () => {
    const img = raster();
    horizontal(img, 50, RED);
    const pts: Px[] = [
      [10, 50],
      [100, 54],
      [210, 50],
    ];
    const result = refineLine(img, pts, 8, RED, 45, [1]);
    const junction = result.pts.findIndex(([x, y]) => x === 100 && y === 54);
    expect(junction).toBeGreaterThanOrEqual(0);
    expect(result.pts.filter(([x, y]) => x === 100 && y === 54)).toHaveLength(1);
    expect(result.segments.some((segment) => segment.to === junction)).toBe(true);
    expect(result.segments.some((segment) => segment.from === junction)).toBe(true);
  });

  it('reports progress and honors cancellation', () => {
    const img = raster();
    horizontal(img, 50, RED);
    const progress = vi.fn();
    const hooks: JobHooks = {
      progress,
      throwIfCancelled: () => {
        throw Object.assign(new Error('cancelled'), { name: JOB_CANCELLED });
      },
    };
    expect(() =>
      refineLine(
        img,
        [
          [10, 50],
          [210, 50],
        ],
        8,
        RED,
        45,
        [],
        hooks,
      ),
    ).toThrowError(expect.objectContaining({ name: JOB_CANCELLED }));

    const fractions: number[] = [];
    refineLine(
      img,
      [
        [10, 50],
        [210, 50],
      ],
      8,
      RED,
      45,
      [],
      {
        progress: (fraction) => fractions.push(fraction),
        throwIfCancelled: () => {},
      },
    );
    expect(fractions.length).toBeGreaterThan(1);
    expect(fractions[0]).toBe(0);
    expect(fractions.at(-1)).toBe(1);
  });
});
