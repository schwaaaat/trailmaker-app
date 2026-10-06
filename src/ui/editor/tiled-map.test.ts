import { describe, expect, it, vi } from 'vitest';
import {
  ByteLru,
  regionTransform,
  tileLevelForView,
  tilesForChangedRegion,
  tilesForRegion,
} from './tiled-map';
import type { TileLevel } from '../contract';

const levels: TileLevel[] = [
  { level: 0, width: 40000, height: 30000, cols: 157, rows: 118 },
  { level: 1, width: 20000, height: 15000, cols: 79, rows: 59 },
  { level: 2, width: 10000, height: 7500, cols: 40, rows: 30 },
  { level: 3, width: 5000, height: 3750, cols: 20, rows: 15 },
];

describe('tiled map helpers', () => {
  it('selects a matching level and uses finer levels as the view zooms in', () => {
    expect(tileLevelForView(levels, 1, 1)).toBe(0);
    expect(tileLevelForView(levels, 0.25, 1)).toBe(2);
    expect(tileLevelForView(levels, 4, 1)).toBe(0);
  });

  it('enumerates intersecting tile coordinates in full-resolution Px space', () => {
    expect(tilesForRegion(levels[1]!, 256, { x: 500, y: 600, width: 400, height: 700 })).toEqual([
      { level: 1, col: 0, row: 1 },
      { level: 1, col: 1, row: 1 },
      { level: 1, col: 0, row: 2 },
      { level: 1, col: 1, row: 2 },
    ]);
    expect(
      tilesForRegion(levels[0]!, 256, { x: 50000, y: 50000, width: 100, height: 100 }),
    ).toEqual([]);
  });

  it('maps patch-local points through the requested pyramid level', () => {
    const patch = regionTransform({ x: 1202, y: 803 }, 2);
    expect(patch.toLocal([1204, 804])).toEqual([1, 1]);
    expect(patch.toMap([1, 1])).toEqual([1204, 804]);
  });

  it('selects and maps negative levels using the same level math', () => {
    const withDetail: TileLevel[] = [
      { level: -1, width: 80000, height: 60000, cols: 313, rows: 235 },
      ...levels,
    ];
    expect(tileLevelForView(withDetail, 2, 1)).toBe(-1);

    const patch = regionTransform({ x: 5, y: 7 }, -1);
    expect(patch.toLocal([6, 8])).toEqual([2, 2]);
    expect(patch.toMap([2, 2])).toEqual([6, 8]);
  });

  it('enumerates all detail tiles touched by fractional half-open level-0 bounds', () => {
    const detail: TileLevel = {
      level: -1,
      width: 2000,
      height: 1600,
      cols: 8,
      rows: 7,
    };
    expect(tilesForChangedRegion(detail, 256, { x: 127.75, y: 0, width: 0.5, height: 1 })).toEqual([
      { level: -1, col: 0, row: 0 },
      { level: -1, col: 1, row: 0 },
    ]);
    expect(tilesForChangedRegion(detail, 256, { x: 128, y: 128, width: 0.5, height: 0.5 })).toEqual(
      [{ level: -1, col: 1, row: 1 }],
    );
  });

  it('evicts least-recently-used decoded bytes and disposes each bitmap once', () => {
    const dispose = vi.fn();
    const cache = new ByteLru<string>(10, dispose);
    cache.set('a', 'A', 6);
    cache.set('b', 'B', 4);
    expect(cache.get('a')).toBe('A');
    cache.set('c', 'C', 5);
    expect(cache.bytes).toBe(5);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBeUndefined();
    expect(dispose).toHaveBeenCalledWith('B');
    cache.clear();
    expect(cache.bytes).toBe(0);
    expect(dispose).toHaveBeenCalledTimes(3);
  });

  it('does not dispose an owned bitmap when its cache entry is refreshed', () => {
    const dispose = vi.fn();
    const cache = new ByteLru<object>(10, dispose);
    const bitmap = {};
    cache.set('tile', bitmap, 5);
    cache.set('tile', bitmap, 5);
    expect(dispose).not.toHaveBeenCalled();
    cache.clear();
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});
