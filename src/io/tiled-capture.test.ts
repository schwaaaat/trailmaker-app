import { describe, expect, it } from 'vitest';
import { planTiledBoundary, tileLevelPyramid } from './tiled-capture';

const seabranchC: readonly [number, number][] = [
  [27.15, -80.19],
  [27.15, -80.15],
  [27.147, -80.15],
  [27.147, -80.187],
  [27.133, -80.187],
  [27.133, -80.15],
  [27.13, -80.15],
  [27.13, -80.19],
];

describe('tiled capture planning', () => {
  it('plans only tiles intersecting the buffered polygon, not its whole bbox', () => {
    const plan = planTiledBoundary(seabranchC, 20);
    const bboxTileCount = plan.cols * plan.rows;

    expect(plan.tiles.length).toBeGreaterThan(0);
    expect(plan.tiles.length).toBeLessThanOrEqual(bboxTileCount * 0.6);
    expect(plan.width).toBe(plan.cols * 256);
    expect(plan.height).toBe(plan.rows * 256);
    expect(plan.origin.x % 256).toBe(0);
    expect(plan.origin.y % 256).toBe(0);
    expect(plan.tiles.every((tile) => tile.col >= 0 && tile.col < plan.cols)).toBe(true);
    expect(plan.tiles.every((tile) => tile.row >= 0 && tile.row < plan.rows)).toBe(true);
    expect(plan.tiles.every((tile) => tile.z === 20)).toBe(true);
  });

  it('includes a 20 m buffer and changes tile density at z21', () => {
    const unbuffered = planTiledBoundary(seabranchC, 20, { bufferMeters: 0 });
    const buffered = planTiledBoundary(seabranchC, 20, { bufferMeters: 20 });
    const z21 = planTiledBoundary(seabranchC, 21, { bufferMeters: 20 });

    expect(buffered.tiles.length).toBeGreaterThan(unbuffered.tiles.length);
    expect(z21.tiles.length).toBeGreaterThan(buffered.tiles.length * 3);
    expect(z21.origin.x).toBeGreaterThan(buffered.origin.x * 1.9);
    expect(z21.origin.y).toBeGreaterThan(buffered.origin.y * 1.9);
  });

  it('rejects boundaries with fewer than three points and invalid zooms', () => {
    expect(() =>
      planTiledBoundary(
        [
          [27, -80],
          [27.1, -80.1],
        ],
        20,
      ),
    ).toThrow(/at least 3/i);
    expect(() => planTiledBoundary(seabranchC, 22)).toThrow(/zoom/i);
  });

  it('builds levels down through the largest overview no wider or taller than 4096 px', () => {
    const levels = tileLevelPyramid(30_000, 24_000);

    expect(levels[0]).toEqual({ level: 0, width: 30_000, height: 24_000, cols: 118, rows: 94 });
    const overview = levels.at(-1)!;
    expect(Math.max(overview.width, overview.height)).toBeLessThanOrEqual(4096);
    expect(Math.max(levels.at(-2)!.width, levels.at(-2)!.height)).toBeGreaterThan(4096);
    expect(levels.every((level, index) => level.level === index)).toBe(true);
  });
});
