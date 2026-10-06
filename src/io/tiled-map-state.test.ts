import { describe, expect, it } from 'vitest';
import type { TileLevel } from '../ui/contract';
import type { PlannedMapTile } from './tiled-capture';
import { hasCompleteTiledMapStorage } from './tiled-map-state';

const tiles: PlannedMapTile[] = [
  { z: 20, x: 5, y: 7, col: 0, row: 0 },
  { z: 20, x: 6, y: 7, col: 1, row: 0 },
];
const levels: TileLevel[] = [
  { level: 0, width: 512, height: 256, cols: 2, rows: 1 },
  { level: 1, width: 256, height: 128, cols: 1, rows: 1 },
];
const stored = ['0/0/0', '0/1/0', '1/0/0'];
const manifest = {
  status: 'complete' as const,
  tiles,
  completedKeys: ['20/5/7', '20/6/7'],
  missingKeys: [],
};

describe('tiled map restore readiness', () => {
  it('requires the expected plan, every source tile, and every overview tile', () => {
    expect(
      hasCompleteTiledMapStorage({
        tiles,
        levels,
        storedKeys: stored,
        manifest,
        overviewAvailable: true,
      }),
    ).toBe(true);
  });

  it('rejects a sampled or partial tile set even when records exist', () => {
    expect(
      hasCompleteTiledMapStorage({
        tiles,
        levels,
        storedKeys: ['0/0/0', '1/0/0'],
        manifest,
        overviewAvailable: true,
      }),
    ).toBe(false);
  });

  it('rejects missing overview pyramid tiles', () => {
    expect(
      hasCompleteTiledMapStorage({
        tiles,
        levels,
        storedKeys: ['0/0/0', '0/1/0'],
        manifest,
        overviewAvailable: true,
      }),
    ).toBe(false);
  });

  it('rejects full-detail restore when the saved overview is unavailable', () => {
    expect(
      hasCompleteTiledMapStorage({
        tiles,
        levels,
        storedKeys: stored,
        manifest,
        overviewAvailable: false,
      }),
    ).toBe(false);
  });

  it('rejects incomplete or mismatched download manifests', () => {
    expect(
      hasCompleteTiledMapStorage({
        tiles,
        levels,
        storedKeys: stored,
        manifest: { ...manifest, status: 'paused' },
        overviewAvailable: true,
      }),
    ).toBe(false);
    expect(
      hasCompleteTiledMapStorage({
        tiles,
        levels,
        storedKeys: stored,
        manifest: { ...manifest, completedKeys: ['20/5/7'] },
        overviewAvailable: true,
      }),
    ).toBe(false);
    expect(
      hasCompleteTiledMapStorage({
        tiles,
        levels,
        storedKeys: stored,
        manifest: { ...manifest, tiles: [tiles[0]!] },
        overviewAvailable: true,
      }),
    ).toBe(false);
  });

  it('accepts complete embedded tiles without a download manifest', () => {
    expect(
      hasCompleteTiledMapStorage({ tiles, levels, storedKeys: stored, overviewAvailable: true }),
    ).toBe(true);
  });
});
