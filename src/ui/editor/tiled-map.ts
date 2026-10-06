import type { TileLevel } from '../contract';
import type { Px } from '../../core/types';

export interface TileAddress {
  readonly level: number;
  readonly col: number;
  readonly row: number;
}

export function regionTransform(rect: { x: number; y: number }, level: number) {
  const decimation = 2 ** level;
  // TiledMapHandle.readRegion starts at floor(rect / 2^level) in the pyramid.
  const origin: Px = [Math.floor(rect.x / decimation), Math.floor(rect.y / decimation)];
  return {
    toLocal: ([x, y]: Px): Px => [x / decimation - origin[0], y / decimation - origin[1]],
    toMap: ([x, y]: Px): Px => [(x + origin[0]) * decimation, (y + origin[1]) * decimation],
  };
}

/** Choose the coarsest available level whose pixels remain close to one device pixel. */
export function tileLevelForView(
  levels: readonly TileLevel[],
  viewScale: number,
  dpr: number,
): number | null {
  if (!levels.length || viewScale <= 0 || dpr <= 0) return null;
  const target = Math.log2(1 / (viewScale * dpr));
  return levels.reduce((best, candidate) =>
    Math.abs(candidate.level - target) < Math.abs(best.level - target) ? candidate : best,
  ).level;
}

/** Enumerate tiles intersecting a full-resolution Px rectangle, clipped to map bounds. */
export function tilesForRegion(
  level: TileLevel,
  tileSize: number,
  rect: { x: number; y: number; width: number; height: number },
): TileAddress[] {
  if (tileSize <= 0 || rect.width <= 0 || rect.height <= 0) return [];
  const scale = 2 ** level.level;
  const x0 = Math.max(0, Math.floor(rect.x / scale / tileSize));
  const y0 = Math.max(0, Math.floor(rect.y / scale / tileSize));
  const x1 = Math.min(level.cols - 1, Math.floor((rect.x + rect.width - 1) / scale / tileSize));
  const y1 = Math.min(level.rows - 1, Math.floor((rect.y + rect.height - 1) / scale / tileSize));
  const tiles: TileAddress[] = [];
  for (let row = y0; row <= y1; row++)
    for (let col = x0; col <= x1; col++) tiles.push({ level: level.level, col, row });
  return tiles;
}

/** Enumerate tiles touched by a half-open level-0 rectangle, including fractional boundaries. */
export function tilesForChangedRegion(
  level: TileLevel,
  tileSize: number,
  rect: { x: number; y: number; width: number; height: number },
): TileAddress[] {
  if (
    tileSize <= 0 ||
    !Number.isFinite(rect.x + rect.y + rect.width + rect.height) ||
    rect.width <= 0 ||
    rect.height <= 0
  ) {
    return [];
  }
  const coverage = tileSize * 2 ** level.level;
  const x0 = Math.max(0, Math.floor(rect.x / coverage));
  const y0 = Math.max(0, Math.floor(rect.y / coverage));
  const x1 = Math.min(level.cols - 1, Math.ceil((rect.x + rect.width) / coverage) - 1);
  const y1 = Math.min(level.rows - 1, Math.ceil((rect.y + rect.height) / coverage) - 1);
  const tiles: TileAddress[] = [];
  for (let row = y0; row <= y1; row++)
    for (let col = x0; col <= x1; col++) tiles.push({ level: level.level, col, row });
  return tiles;
}

/** Byte-capped LRU. The cache owns values and calls dispose when entries leave it. */
export class ByteLru<T> {
  private readonly values = new Map<string, { value: T; bytes: number }>();
  private byteCount = 0;

  constructor(
    readonly byteLimit: number,
    private readonly dispose: (value: T) => void,
  ) {}

  get(key: string): T | undefined {
    const entry = this.values.get(key);
    if (!entry) return undefined;
    this.values.delete(key);
    this.values.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T, bytes: number): void {
    const existing = this.values.get(key);
    if (existing?.value === value) {
      this.byteCount -= existing.bytes;
      this.values.delete(key);
      this.values.set(key, { value, bytes });
      this.byteCount += bytes;
      while (this.byteCount > this.byteLimit) {
        const oldest = this.values.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        this.delete(oldest);
      }
      return;
    }
    this.delete(key);
    if (bytes > this.byteLimit || this.byteLimit <= 0) {
      this.dispose(value);
      return;
    }
    this.values.set(key, { value, bytes });
    this.byteCount += bytes;
    while (this.byteCount > this.byteLimit) {
      const oldest = this.values.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.delete(oldest);
    }
  }

  delete(key: string): void {
    const entry = this.values.get(key);
    if (!entry) return;
    this.values.delete(key);
    this.byteCount -= entry.bytes;
    this.dispose(entry.value);
  }

  clear(): void {
    for (const key of this.values.keys()) this.delete(key);
  }

  get bytes(): number {
    return this.byteCount;
  }
}

export const tileBitmapBytes = (bitmap: Pick<ImageBitmap, 'width' | 'height'>): number =>
  bitmap.width * bitmap.height * 4;

export const tileCacheLimit = (viewportWidth: number): number =>
  (viewportWidth < 600 ? 96 : 256) * 1024 * 1024;
