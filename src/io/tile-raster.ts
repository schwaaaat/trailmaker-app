import type { MapImage, RasterImage } from '../core/types';
import type { StoredProjectTile } from '../core/project';
import { MAX_WORKING_SIDE } from '../core/types';
import type { LoadedMap, TileLevel, TiledMapHandle, TiledRegionRaster } from '../ui/contract';
import { loadImageFile } from './image';
import {
  getTileDownload,
  getTileRecord,
  listTileRecords,
  putTileRecord,
  subscribeDetailTileChanges,
  tiledMapStorageId,
} from './tile-store';
import { planTiledBoundary, tileLevelPyramid } from './tiled-capture';
import { hasCompleteTiledMapStorage } from './tiled-map-state';

export interface RasterRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface RasterTileRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface TilePyramidCanvas {
  readonly width: number;
  readonly height: number;
  clear(): void;
  draw(source: unknown, sourceRect: RasterTileRect, destinationRect: RasterTileRect): void;
  encode(): Promise<Blob>;
}

export interface TilePyramidAdapter {
  getTile(level: number, col: number, row: number): Promise<Blob | null>;
  putTile(level: number, col: number, row: number, blob: Blob): Promise<void>;
  decode(blob: Blob): Promise<unknown>;
  createCanvas(width: number, height: number): TilePyramidCanvas;
  yieldToEventLoop(): Promise<void>;
}

interface CanvasSurface {
  readonly canvas: HTMLCanvasElement | OffscreenCanvas;
  readonly context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
}

function createCanvasSurface(width: number, height: number): CanvasSurface {
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d');
    if (context) return { canvas, context };
  }
  if (typeof document !== 'undefined') {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (context) return { canvas, context };
  }
  throw new Error('Canvas rendering is not supported in this environment.');
}

async function canvasBlob(
  canvas: HTMLCanvasElement | OffscreenCanvas,
  type = 'image/png',
): Promise<Blob> {
  if ('convertToBlob' in canvas && typeof canvas.convertToBlob === 'function') {
    return canvas.convertToBlob({ type });
  }
  return new Promise<Blob>((resolve, reject) => {
    (canvas as HTMLCanvasElement).toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('Could not encode tiled imagery overview.'));
    }, type);
  });
}

function browserTilePyramidAdapter(mapId: string): TilePyramidAdapter {
  return {
    getTile: async (level, col, row) => (await getTileRecord(mapId, level, col, row)) ?? null,
    putTile: (level, col, row, blob) => putTileRecord(mapId, level, col, row, blob),
    decode: async (blob) => {
      if (typeof createImageBitmap !== 'function') {
        throw new Error('This browser cannot decode offline map tiles.');
      }
      return createImageBitmap(blob);
    },
    createCanvas: (width, height) => {
      const { canvas, context } = createCanvasSurface(width, height);
      return {
        width,
        height,
        clear: () => context.clearRect(0, 0, width, height),
        draw: (source, sourceRect, destinationRect) => {
          context.drawImage(
            source as CanvasImageSource,
            sourceRect.x,
            sourceRect.y,
            sourceRect.width,
            sourceRect.height,
            destinationRect.x,
            destinationRect.y,
            destinationRect.width,
            destinationRect.height,
          );
        },
        encode: () => canvasBlob(canvas),
      };
    },
    yieldToEventLoop: () => new Promise((resolve) => setTimeout(resolve, 0)),
  };
}

/** Builds every coarser level from its previous level, yielding after each output tile. */
export async function buildOverviewPyramid(
  mapId: string,
  levels: readonly TileLevel[],
  tileSize: number,
  adapter: TilePyramidAdapter = browserTilePyramidAdapter(mapId),
): Promise<void> {
  if (!mapId) throw new Error('A tiled map id is required to build its overview pyramid.');
  if (!Number.isInteger(tileSize) || tileSize <= 0)
    throw new Error('Tile size must be a positive integer.');
  for (let levelIndex = 1; levelIndex < levels.length; levelIndex++) {
    const sourceLevel = levels[levelIndex - 1]!;
    const targetLevel = levels[levelIndex]!;
    for (let row = 0; row < targetLevel.rows; row++) {
      for (let col = 0; col < targetLevel.cols; col++) {
        const canvas = adapter.createCanvas(tileSize, tileSize);
        canvas.clear();
        const sourceX = col * tileSize * 2;
        const sourceY = row * tileSize * 2;
        const sourceRight = Math.min(sourceLevel.width, sourceX + tileSize * 2);
        const sourceBottom = Math.min(sourceLevel.height, sourceY + tileSize * 2);
        const firstCol = Math.floor(sourceX / tileSize);
        const lastCol = Math.floor(Math.max(sourceX, sourceRight - 1) / tileSize);
        const firstRow = Math.floor(sourceY / tileSize);
        const lastRow = Math.floor(Math.max(sourceY, sourceBottom - 1) / tileSize);

        for (let sourceRow = firstRow; sourceRow <= lastRow; sourceRow++) {
          for (let sourceCol = firstCol; sourceCol <= lastCol; sourceCol++) {
            const blob = await adapter.getTile(sourceLevel.level, sourceCol, sourceRow);
            if (!blob) continue;
            const image = await adapter.decode(blob);
            const left = Math.max(sourceX, sourceCol * tileSize);
            const top = Math.max(sourceY, sourceRow * tileSize);
            const right = Math.min(sourceRight, (sourceCol + 1) * tileSize);
            const bottom = Math.min(sourceBottom, (sourceRow + 1) * tileSize);
            canvas.draw(
              image,
              {
                x: left - sourceCol * tileSize,
                y: top - sourceRow * tileSize,
                width: right - left,
                height: bottom - top,
              },
              {
                x: (left - sourceX) / 2,
                y: (top - sourceY) / 2,
                width: (right - left) / 2,
                height: (bottom - top) / 2,
              },
            );
            if (
              image &&
              typeof image === 'object' &&
              'close' in image &&
              typeof image.close === 'function'
            ) {
              image.close();
            }
          }
        }

        await adapter.putTile(targetLevel.level, col, row, await canvas.encode());
        await adapter.yieldToEventLoop();
      }
    }
  }
}

async function renderTileRegion(
  mapId: string,
  levels: readonly TileLevel[],
  tileSize: number,
  rect: RasterRect,
  level: number,
  adapter = browserTilePyramidAdapter(mapId),
): Promise<{ readonly raster: RasterImage; readonly canvas: HTMLCanvasElement | OffscreenCanvas }> {
  if (level === -1) return renderDetailTileRegion(mapId, levels, tileSize, rect, adapter);
  const levelMetadata = levels.find((entry) => entry.level === level);
  if (!levelMetadata) throw new Error(`Tiled map level ${level} is not available.`);
  const divisor = 2 ** level;
  const startX = Math.max(0, Math.floor(rect.x / divisor));
  const startY = Math.max(0, Math.floor(rect.y / divisor));
  const endX = Math.min(levelMetadata.width, Math.ceil((rect.x + rect.width) / divisor));
  const endY = Math.min(levelMetadata.height, Math.ceil((rect.y + rect.height) / divisor));
  const width = Math.max(1, endX - startX);
  const height = Math.max(1, endY - startY);
  const { canvas, context } = createCanvasSurface(width, height);
  context.clearRect(0, 0, width, height);
  const firstCol = Math.floor(startX / tileSize);
  const lastCol = Math.floor(Math.max(startX, endX - 1) / tileSize);
  const firstRow = Math.floor(startY / tileSize);
  const lastRow = Math.floor(Math.max(startY, endY - 1) / tileSize);

  for (let row = firstRow; row <= lastRow; row++) {
    for (let col = firstCol; col <= lastCol; col++) {
      const blob = await adapter.getTile(level, col, row);
      if (!blob) continue;
      const image = (await adapter.decode(blob)) as CanvasImageSource;
      const left = Math.max(startX, col * tileSize);
      const top = Math.max(startY, row * tileSize);
      const right = Math.min(endX, (col + 1) * tileSize);
      const bottom = Math.min(endY, (row + 1) * tileSize);
      context.drawImage(
        image,
        left - col * tileSize,
        top - row * tileSize,
        right - left,
        bottom - top,
        left - startX,
        top - startY,
        right - left,
        bottom - top,
      );
      if (
        image &&
        typeof image === 'object' &&
        'close' in image &&
        typeof image.close === 'function'
      ) {
        image.close();
      }
    }
  }
  const data = context.getImageData(0, 0, width, height).data;
  return { raster: { width, height, data }, canvas };
}

async function renderDetailTileRegion(
  mapId: string,
  levels: readonly TileLevel[],
  tileSize: number,
  rect: RasterRect,
  adapter: TilePyramidAdapter = browserTilePyramidAdapter(mapId),
): Promise<{
  readonly raster: TiledRegionRaster;
  readonly canvas: HTMLCanvasElement | OffscreenCanvas;
}> {
  const detailLevel = levels.find((entry) => entry.level === -1);
  if (!detailLevel) throw new Error('Tiled map level -1 is not available.');
  const startX = Math.max(0, Math.floor(rect.x * 2));
  const startY = Math.max(0, Math.floor(rect.y * 2));
  const endX = Math.min(detailLevel.width, Math.ceil((rect.x + rect.width) * 2));
  const endY = Math.min(detailLevel.height, Math.ceil((rect.y + rect.height) * 2));
  const width = Math.max(1, endX - startX);
  const height = Math.max(1, endY - startY);
  const base = await renderTileRegion(mapId, levels, tileSize, rect, 0, adapter);
  const { canvas, context } = createCanvasSurface(width, height);
  context.clearRect(0, 0, width, height);
  const baseOriginX = Math.max(0, Math.floor(rect.x));
  const baseOriginY = Math.max(0, Math.floor(rect.y));
  context.drawImage(
    base.canvas,
    0,
    0,
    base.raster.width,
    base.raster.height,
    baseOriginX * 2 - startX,
    baseOriginY * 2 - startY,
    base.raster.width * 2,
    base.raster.height * 2,
  );

  const detailCoverage = new Uint8Array(width * height);
  const firstCol = Math.floor(startX / tileSize);
  const lastCol = Math.floor(Math.max(startX, endX - 1) / tileSize);
  const firstRow = Math.floor(startY / tileSize);
  const lastRow = Math.floor(Math.max(startY, endY - 1) / tileSize);
  for (let row = firstRow; row <= lastRow; row++) {
    for (let col = firstCol; col <= lastCol; col++) {
      const blob = await adapter.getTile(-1, col, row);
      if (!blob) continue;
      const image = (await adapter.decode(blob)) as CanvasImageSource;
      const left = Math.max(startX, col * tileSize);
      const top = Math.max(startY, row * tileSize);
      const right = Math.min(endX, (col + 1) * tileSize);
      const bottom = Math.min(endY, (row + 1) * tileSize);
      context.drawImage(
        image,
        left - col * tileSize,
        top - row * tileSize,
        right - left,
        bottom - top,
        left - startX,
        top - startY,
        right - left,
        bottom - top,
      );
      for (let y = top - startY; y < bottom - startY; y++) {
        detailCoverage.fill(255, y * width + left - startX, y * width + right - startX);
      }
      if (
        image &&
        typeof image === 'object' &&
        'close' in image &&
        typeof image.close === 'function'
      ) {
        image.close();
      }
    }
  }

  const data = context.getImageData(0, 0, width, height).data;
  return { raster: { width, height, data, detailCoverage }, canvas };
}

/** Creates a Lane B-readable tile handle over persisted local tiles. */
export function createTiledMapHandle(
  mapId: string,
  levels: readonly TileLevel[],
  tileSize: number,
  overviewScale: number,
): TiledMapHandle {
  const cache = new Map<string, Promise<ImageBitmap | null>>();
  const decodedBitmaps = new Set<ImageBitmap>();
  const detailListeners = new Set<
    (rect: {
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
    }) => void
  >();
  let invalidated = false;
  let unsubscribeDetailTiles = () => {};
  const decode = async (level: number, col: number, row: number): Promise<ImageBitmap | null> => {
    if (invalidated) return null;
    const key = `${level}/${col}/${row}`;
    let promise = cache.get(key);
    if (!promise) {
      promise = (async () => {
        const blob = await getTileRecord(mapId, level, col, row);
        if (!blob || typeof createImageBitmap !== 'function') return null;
        const bitmap = await createImageBitmap(blob);
        if (invalidated || cache.get(key) !== promise) {
          bitmap.close();
          return null;
        }
        decodedBitmaps.add(bitmap);
        return bitmap;
      })();
      cache.set(key, promise);
      if (cache.size > 64) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) {
          const evicted = cache.get(oldest);
          cache.delete(oldest);
          void evicted?.then((bitmap) => {
            if (!bitmap) return;
            decodedBitmaps.delete(bitmap);
            bitmap.close();
          });
        }
      }
    }
    return promise;
  };
  const adapter = browserTilePyramidAdapter(mapId);
  const handle: TiledMapHandle = {
    levels,
    tileSize,
    overviewScale,
    getTileBitmap: decode,
    subscribeDetailChanged: (listener) => {
      detailListeners.add(listener);
      return () => detailListeners.delete(listener);
    },
    readRegion: async (rect, level) => {
      if (invalidated) return emptyTiledRegion(rect, levels, level);
      const region = await renderTileRegion(mapId, levels, tileSize, rect, level, adapter);
      return invalidated ? emptyTiledRegion(rect, levels, level) : region.raster;
    },
  };
  unsubscribeDetailTiles = subscribeDetailTileChanges(mapId, ({ col, row }) => {
    const key = `-1/${col}/${row}`;
    const old = cache.get(key);
    cache.delete(key);
    void old?.then((bitmap) => {
      if (!bitmap) return;
      decodedBitmaps.delete(bitmap);
      bitmap.close();
    });
    const changed = {
      x: (col * tileSize) / 2,
      y: (row * tileSize) / 2,
      width: tileSize / 2,
      height: tileSize / 2,
    };
    for (const listener of detailListeners) listener(changed);
  });
  invalidators.set(handle, () => {
    if (invalidated) return;
    invalidated = true;
    for (const bitmap of decodedBitmaps) bitmap.close();
    decodedBitmaps.clear();
    cache.clear();
    unsubscribeDetailTiles();
    detailListeners.clear();
  });
  return handle;
}

const invalidators = new WeakMap<TiledMapHandle, () => void>();

/** Drops decoded full-detail imagery so a deleted map cannot keep serving cached tiles. */
export function invalidateTiledMapHandle(handle: TiledMapHandle | null | undefined): void {
  if (handle) invalidators.get(handle)?.();
}

function emptyTiledRegion(
  rect: RasterRect,
  levels: readonly TileLevel[],
  level: number,
): TiledRegionRaster {
  const metadata = levels.find((entry) => entry.level === level);
  const divisor = 2 ** level;
  const startX = Math.max(0, Math.floor(rect.x / divisor));
  const startY = Math.max(0, Math.floor(rect.y / divisor));
  const endX = Math.min(metadata?.width ?? 0, Math.ceil((rect.x + rect.width) / divisor));
  const endY = Math.min(metadata?.height ?? 0, Math.ceil((rect.y + rect.height) / divisor));
  const width = Math.max(1, endX - startX);
  const height = Math.max(1, endY - startY);
  return {
    width,
    height,
    data: new Uint8ClampedArray(width * height * 4),
    ...(level === -1 ? { detailCoverage: new Uint8Array(width * height) } : {}),
  };
}

/** Loads a tiled map's overview as the editor display while preserving full-resolution map pixels. */
export async function loadTiledMap(
  image: MapImage,
  mapId: string,
  maxOverviewSide = 4096,
): Promise<LoadedMap> {
  if (image.source.kind !== 'tiles') throw new Error('The map image is not a tiled map.');
  const pyramidLevels = tileLevelPyramid(
    image.width,
    image.height,
    image.source.tileSize,
    maxOverviewSide,
  );
  const levels: readonly TileLevel[] = [
    {
      level: -1,
      width: image.width * 2,
      height: image.height * 2,
      cols: Math.ceil((image.width * 2) / image.source.tileSize),
      rows: Math.ceil((image.height * 2) / image.source.tileSize),
    },
    ...pyramidLevels,
  ];
  const overview = levels.at(-1)!;
  const rendered = await renderTileRegion(
    mapId,
    levels,
    image.source.tileSize,
    { x: 0, y: 0, width: image.width, height: image.height },
    overview.level,
  );
  const blob = await canvasBlob(rendered.canvas);
  const loaded = await loadImageFile(blob, image.fileName);
  return {
    ...loaded,
    meta: {
      ...loaded.meta,
      ...image,
      sha256: loaded.meta.sha256,
    },
    original: blob,
    tiles: createTiledMapHandle(mapId, levels, image.source.tileSize, 1 / 2 ** overview.level),
  };
}

/** Restores a tiled project bundle, or opens its saved overview when the bundle was omitted. */
export async function restoreTiledProjectMap(
  image: MapImage,
  overview: Blob,
  embeddedTiles: readonly StoredProjectTile[] = [],
): Promise<LoadedMap> {
  if (image.source.kind !== 'tiles') throw new Error('The project image is not tiled imagery.');
  const mapId = tiledMapStorageId(image.source);
  for (const tile of embeddedTiles) {
    await putTileRecord(
      mapId,
      tile.level,
      tile.col,
      tile.row,
      new Blob([tile.bytes as unknown as BlobPart], { type: tile.mimeType }),
    );
  }
  const plan = planTiledBoundary(image.source.boundary, image.source.z, {
    tileSize: image.source.tileSize,
  });
  const sourceMatchesPlan =
    plan.origin.x === image.source.origin.x &&
    plan.origin.y === image.source.origin.y &&
    plan.width === image.width &&
    plan.height === image.height &&
    plan.tiles.length === image.source.tileCount;
  const levels = tileLevelPyramid(image.width, image.height, image.source.tileSize);
  const [records, manifest] = await Promise.all([listTileRecords(mapId), getTileDownload(mapId)]);
  if (
    sourceMatchesPlan &&
    hasCompleteTiledMapStorage({
      tiles: plan.tiles,
      levels,
      storedKeys: records.map(({ level, col, row }) => `${level}/${col}/${row}`),
      overviewAvailable: overview.size > 0,
      ...(!embeddedTiles.length && manifest ? { manifest } : {}),
    })
  ) {
    return loadTiledMap(image, mapId);
  }
  const loaded = await loadImageFile(overview, image.fileName);
  return { ...loaded, meta: image, original: overview, tiles: null };
}

export function overviewSideAllowed(levels: readonly TileLevel[]): boolean {
  const largest = levels.at(-1);
  return !!largest && Math.max(largest.width, largest.height) <= MAX_WORKING_SIDE;
}
