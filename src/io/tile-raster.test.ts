import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildOverviewPyramid, type TilePyramidAdapter } from './tile-raster';
import type { TileLevel } from '../ui/contract';
import {
  createTiledMapHandle,
  invalidateTiledMapHandle,
  restoreTiledProjectMap,
} from './tile-raster';
import { deleteTileLevel, putTileRecord, resetTileStoreForTests } from './tile-store';
import { planTiledBoundary } from './tiled-capture';
import * as imageModule from './image';
import { makeMap, makeProject } from '../state/fixtures.test.helper';

function mockAdapter(sourceTiles: ReadonlySet<string>): TilePyramidAdapter {
  const draws: string[] = [];
  const saves: string[] = [];
  return {
    async getTile(level, col, row) {
      return sourceTiles.has(`${level}/${col}/${row}`)
        ? new Blob([`tile-${level}-${col}-${row}`])
        : null;
    },
    async putTile(level, col, row) {
      saves.push(`${level}/${col}/${row}`);
    },
    async decode(blob) {
      return blob;
    },
    createCanvas(width, height) {
      return {
        width,
        height,
        clear: vi.fn(),
        draw(source, _sourceRect, _destRect) {
          draws.push(awaitText(source as Blob));
        },
        async encode() {
          return new Blob(['overview'], { type: 'image/png' });
        },
      };
    },
    yieldToEventLoop: async () => {},
    get draws() {
      return draws;
    },
    get saves() {
      return saves;
    },
  } as TilePyramidAdapter & { draws: string[]; saves: string[] };
}

function awaitText(blob: Blob): string {
  return `image:${blob.size}`;
}

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
});

afterEach(async () => {
  await resetTileStoreForTests();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

class MemoryCanvas {
  readonly pixels: Uint8ClampedArray;

  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    this.pixels = new Uint8ClampedArray(width * height * 4);
  }

  getContext() {
    const canvasWidth = this.width;
    const canvasHeight = this.height;
    const pixels = this.pixels;
    return {
      clearRect(x: number, y: number, width: number, height: number) {
        for (let row = Math.max(0, y); row < Math.min(canvasHeight, y + height); row++) {
          pixels.fill(
            0,
            row * canvasWidth * 4 + Math.max(0, x) * 4,
            row * canvasWidth * 4 + Math.min(canvasWidth, x + width) * 4,
          );
        }
      },
      drawImage(source: unknown, ...args: number[]) {
        const [x, y, width, height] = args.length === 8 ? args.slice(4) : args.slice(5);
        const color =
          source instanceof MemoryCanvas
            ? source.pixels.slice(0, 4)
            : ((source as { color?: Uint8ClampedArray }).color ??
              new Uint8ClampedArray([1, 2, 3, 255]));
        for (
          let row = Math.max(0, y ?? 0);
          row < Math.min(canvasHeight, (y ?? 0) + (height ?? 0));
          row++
        ) {
          for (
            let col = Math.max(0, x ?? 0);
            col < Math.min(canvasWidth, (x ?? 0) + (width ?? 0));
            col++
          ) {
            pixels.set(color, (row * canvasWidth + col) * 4);
          }
        }
      },
      getImageData() {
        return { data: pixels };
      },
    };
  }
}

describe('tiled imagery overview pyramid', () => {
  it('downsamples available source tiles into overview tiles and yields between tiles', async () => {
    const adapter = mockAdapter(
      new Set(['0/0/0', '0/1/0', '0/0/1', '0/1/1']),
    ) as TilePyramidAdapter & {
      draws: string[];
      saves: string[];
    };
    const yieldTask = vi.fn(async () => {});
    adapter.yieldToEventLoop = yieldTask;
    const levels: TileLevel[] = [
      { level: 0, width: 512, height: 512, cols: 2, rows: 2 },
      { level: 1, width: 256, height: 256, cols: 1, rows: 1 },
    ];

    await buildOverviewPyramid('map-one', levels, 256, adapter);

    expect(adapter.draws).toHaveLength(4);
    expect(adapter.saves).toEqual(['1/0/0']);
    expect(yieldTask).toHaveBeenCalledOnce();
  });

  it('keeps missing source areas transparent while building the overview', async () => {
    const adapter = mockAdapter(new Set(['0/0/0'])) as TilePyramidAdapter & {
      draws: string[];
      saves: string[];
    };
    const levels: TileLevel[] = [
      { level: 0, width: 512, height: 512, cols: 2, rows: 2 },
      { level: 1, width: 256, height: 256, cols: 1, rows: 1 },
    ];

    await buildOverviewPyramid('map-one', levels, 256, adapter);
    expect(adapter.draws).toHaveLength(1);
    expect(adapter.saves).toEqual(['1/0/0']);
  });
});

describe('tiled map restore and invalidation', () => {
  it('opens an overview-only map when storage has only a sampled tile', async () => {
    const boundary = [
      [27.135, -80.174],
      [27.135, -80.17],
      [27.132, -80.17],
      [27.132, -80.174],
    ] as const;
    const plan = planTiledBoundary(boundary, 20);
    const image = {
      fileName: 'Martin County tiled imagery',
      width: plan.width,
      height: plan.height,
      originalWidth: plan.width,
      originalHeight: plan.height,
      source: {
        kind: 'tiles' as const,
        sourceId: 'martin-county',
        z: 20,
        tileSize: plan.tileSize,
        origin: plan.origin,
        boundary,
        tileCount: plan.tiles.length,
      },
      sha256: 'a'.repeat(64),
      attribution: 'Martin County',
    };
    const mapId = (await import('./tile-store')).tiledMapStorageId(image.source);
    const first = plan.tiles[0]!;
    await putTileRecord(mapId, 0, first.col, first.row, new Blob(['sampled tile']));
    const overview = new Blob(['saved overview'], { type: 'image/png' });
    const fallback = makeMap(makeProject());
    vi.spyOn(imageModule, 'loadImageFile').mockResolvedValue(fallback);

    const restored = await restoreTiledProjectMap(image, overview);

    expect(restored.tiles).toBeNull();
    expect(restored.meta).toBe(image);
    expect(restored.original).toBe(overview);
  });

  it('closes cached bitmaps and stops serving stale detail after tile deletion', async () => {
    const bitmap = { close: vi.fn() } as unknown as ImageBitmap;
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async () => bitmap),
    );
    await putTileRecord('cached-map', 0, 0, 0, new Blob(['tile']));
    const levels: TileLevel[] = [{ level: 0, width: 256, height: 256, cols: 1, rows: 1 }];
    const handle = createTiledMapHandle('cached-map', levels, 256, 1);

    expect(await handle.getTileBitmap(0, 0, 0)).toBe(bitmap);
    invalidateTiledMapHandle(handle);

    expect(bitmap.close).toHaveBeenCalledOnce();
    expect(await handle.getTileBitmap(0, 0, 0)).toBeNull();
  });

  it('announces sparse detail changes and invalidates cached detail immediately on deletion', async () => {
    const bitmap = { close: vi.fn() } as unknown as ImageBitmap;
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async () => bitmap),
    );
    const levels: TileLevel[] = [
      { level: -1, width: 512, height: 512, cols: 2, rows: 2 },
      { level: 0, width: 256, height: 256, cols: 1, rows: 1 },
    ];
    const handle = createTiledMapHandle('detail-map', levels, 256, 1);
    const changes: Array<{ x: number; y: number; width: number; height: number }> = [];
    const unsubscribe = handle.subscribeDetailChanged?.((rect) => changes.push(rect));

    await putTileRecord('detail-map', -1, 0, 0, new Blob(['detail']));
    expect(await handle.getTileBitmap(-1, 0, 0)).toBe(bitmap);
    await deleteTileLevel('detail-map', -1);

    expect(changes).toEqual([
      { x: 0, y: 0, width: 128, height: 128 },
      { x: 0, y: 0, width: 128, height: 128 },
    ]);
    expect(bitmap.close).toHaveBeenCalledOnce();
    expect(await handle.getTileBitmap(-1, 0, 0)).toBeNull();
    unsubscribe?.();
    invalidateTiledMapHandle(handle);
  });

  it('reads real detail where present and level-0 fallback with an accurate coverage mask elsewhere', async () => {
    vi.stubGlobal('OffscreenCanvas', MemoryCanvas);
    vi.stubGlobal('createImageBitmap', async (blob: Blob) => {
      const isDetail = blob.type === 'image/jpeg';
      return {
        width: 256,
        height: 256,
        color: new Uint8ClampedArray(isDetail ? [200, 0, 0, 255] : [0, 100, 0, 255]),
        close: vi.fn(),
      };
    });
    await putTileRecord('detail-read', 0, 0, 0, new Blob(['base'], { type: 'image/png' }));
    await putTileRecord('detail-read', -1, 0, 0, new Blob(['detail'], { type: 'image/jpeg' }));
    const levels: TileLevel[] = [
      { level: -1, width: 512, height: 512, cols: 2, rows: 2 },
      { level: 0, width: 256, height: 256, cols: 1, rows: 1 },
    ];
    const handle = createTiledMapHandle('detail-read', levels, 256, 1);

    const region = await handle.readRegion({ x: 0, y: 0, width: 129, height: 1 }, -1);

    expect(region.width).toBe(258);
    expect(region.detailCoverage?.[0]).toBe(255);
    expect(region.detailCoverage?.[257]).toBe(0);
    expect(region.data[0]).toBe(200);
    expect(region.data[257 * 4 + 1]).toBe(100);
    invalidateTiledMapHandle(handle);
  });
});
