import type { LatLon } from '../core/types';
import {
  countPlannedTileKeys,
  createPoliteTileDownloader,
  tileDownloadKey,
} from './tile-downloader';
import type {
  TileDownloaderOptions,
  TileDownloadResult,
  TileFetchResponse,
} from './tile-downloader';
import {
  putTileDownload,
  putTileRecord,
  getTileDownload,
  requestPersistentTileStorage,
  tileStorageEstimate,
  tiledMapStorageId,
} from './tile-store';
import type { TileDownloadManifest } from './tile-store';
import type { TiledImagerySource } from './tile-service';
import type { PlannedMapTile, TiledBoundaryPlan } from './tiled-capture';

export interface TileCaptureEstimate {
  readonly sampleCount: number;
  readonly averageTileBytes: number;
  readonly estimatedBytes: number;
  readonly estimatedSeconds: number;
  readonly enoughSpace: boolean | null;
}

export interface TileCaptureSessionOptions {
  readonly source: TiledImagerySource;
  readonly plan: TiledBoundaryPlan;
  readonly mapId?: string;
  readonly boundary?: readonly LatLon[];
  readonly fetcher?: typeof fetch;
  readonly save?: (tile: PlannedMapTile, blob: Blob) => Promise<void>;
  readonly persistManifest?: (manifest: TileDownloadManifest) => Promise<void>;
  readonly readManifest?: (mapId: string) => Promise<TileDownloadManifest | undefined>;
  readonly afterDownload?: () => Promise<void>;
  readonly downloader?: Pick<TileDownloaderOptions<Blob>, 'sleep' | 'now' | 'random'>;
  readonly onProgress?: (complete: number, total: number, missing: number) => void;
}

function tileUrl(source: TiledImagerySource, tile: PlannedMapTile): string {
  return `${source.url}/tile/${tile.z}/${tile.y}/${tile.x}`;
}

async function fetchTile(
  fetcher: typeof fetch,
  source: TiledImagerySource,
  tile: PlannedMapTile,
): Promise<TileFetchResponse<Blob>> {
  const response = await fetcher(tileUrl(source, tile), { mode: 'cors', cache: 'force-cache' });
  if (!response.ok) {
    return { ok: false, status: response.status, retryAfter: response.headers.get('retry-after') };
  }
  const blob = await response.blob();
  if (!blob.type.startsWith('image/')) {
    return { ok: false, status: 502 };
  }
  return { ok: true, status: response.status, value: blob };
}

export function createTileCaptureSession(options: TileCaptureSessionOptions) {
  const { source, plan } = options;
  const fetcher = options.fetcher ?? fetch;
  const mapId =
    options.mapId ??
    tiledMapStorageId({
      sourceId: source.id,
      z: plan.z,
      tileSize: plan.tileSize,
      origin: plan.origin,
      boundary: options.boundary ?? [],
    });
  const save = options.save ?? ((tile, blob) => putTileRecord(mapId, 0, tile.col, tile.row, blob));
  const persistManifest = options.persistManifest ?? putTileDownload;
  const readManifest = options.readManifest ?? getTileDownload;
  const updateStatus = async (status: TileDownloadManifest['status']) => {
    try {
      const manifest = await readManifest(mapId);
      if (manifest)
        await persistManifest({ ...manifest, status, updatedAt: new Date().toISOString() });
    } catch {
      // Keep pause/cancel responsive if browser storage is unavailable.
    }
  };
  let averageTileBytes = 0;
  const sampledTileKeys = new Set<string>();
  let controller: ReturnType<typeof createPoliteTileDownloader<Blob>> | null = null;

  const estimate = async (): Promise<TileCaptureEstimate> => {
    const savedManifest = await readManifest(mapId);
    if (savedManifest?.averageTileBytes) {
      averageTileBytes = savedManifest.averageTileBytes;
      for (const key of savedManifest.completedKeys) sampledTileKeys.add(key);
      const completedCount = countPlannedTileKeys(plan.tiles, savedManifest.completedKeys);
      const estimatedBytes = Math.ceil(averageTileBytes * plan.tiles.length);
      let enoughSpace: boolean | null = null;
      if (typeof navigator !== 'undefined' && navigator.storage?.estimate) {
        enoughSpace = tileStorageEstimate(
          estimatedBytes,
          await navigator.storage.estimate(),
        ).enoughSpace;
      }
      return {
        sampleCount: 0,
        averageTileBytes,
        estimatedBytes,
        estimatedSeconds: Math.max(1, (plan.tiles.length - completedCount) / 5),
        enoughSpace,
      };
    }
    const samples = plan.tiles.slice(0, Math.min(3, plan.tiles.length));
    if (!samples.length) throw new Error('The boundary does not include any imagery tiles.');
    let byteTotal = 0;
    let successfulSamples = 0;
    for (const [index, tile] of samples.entries()) {
      const response = await fetchTile(fetcher, source, tile);
      if (!response.ok || !response.value) {
        if (response.status === 404) {
          if (index < samples.length - 1) await new Promise((resolve) => setTimeout(resolve, 200));
          continue;
        }
        throw new Error(`Could not sample a tile (HTTP ${response.status}).`);
      }
      byteTotal += response.value.size;
      successfulSamples++;
      await save(tile, response.value);
      sampledTileKeys.add(tileDownloadKey(tile));
      if (index < samples.length - 1) await new Promise((resolve) => setTimeout(resolve, 200));
    }
    if (!successfulSamples)
      throw new Error(
        'All sample tiles were unavailable, so the download size cannot be estimated.',
      );
    averageTileBytes = byteTotal / successfulSamples;
    const estimatedBytes = Math.ceil(averageTileBytes * plan.tiles.length);
    let enoughSpace: boolean | null = null;
    if (typeof navigator !== 'undefined' && navigator.storage?.estimate) {
      const storage = await navigator.storage.estimate();
      enoughSpace = tileStorageEstimate(estimatedBytes, storage).enoughSpace;
    }
    return {
      sampleCount: successfulSamples,
      averageTileBytes,
      estimatedBytes,
      estimatedSeconds: Math.max(1, plan.tiles.length / 5),
      enoughSpace,
    };
  };

  const download = async (): Promise<TileDownloadResult> => {
    if (!averageTileBytes) throw new Error('Estimate the tile download before starting it.');
    await requestPersistentTileStorage();
    const savedManifest = await readManifest(mapId);
    const completedKeys: string[] = Array.from(
      new Set([...sampledTileKeys, ...(savedManifest?.completedKeys ?? [])]),
    );
    const missingKeys: string[] = [];
    const manifest = (): TileDownloadManifest => ({
      mapId,
      sourceId: source.id,
      z: plan.z,
      tileSize: plan.tileSize,
      origin: plan.origin,
      cols: plan.cols,
      rows: plan.rows,
      width: plan.width,
      height: plan.height,
      boundary: options.boundary ?? [],
      tiles: plan.tiles,
      completedKeys,
      missingKeys,
      status: 'downloading',
      updatedAt: new Date().toISOString(),
      averageTileBytes,
    });
    await persistManifest(manifest());
    controller = createPoliteTileDownloader<Blob>(
      plan.tiles,
      (tile) => fetchTile(fetcher, source, tile),
      {
        ...options.downloader,
        completedKeys,
        onTileComplete: async (tile, blob) => {
          await save(tile, blob);
          completedKeys.push(tileDownloadKey(tile));
          await persistManifest(manifest());
        },
        onTileMissing: async (tile) => {
          missingKeys.push(tileDownloadKey(tile));
          await persistManifest(manifest());
        },
        ...(options.onProgress ? { onProgress: options.onProgress } : {}),
      },
    );
    const result = await controller.promise;
    await persistManifest({
      ...manifest(),
      status: result.cancelled ? 'cancelled' : result.missing.length ? 'paused' : 'complete',
    });
    controller = null;
    if (!result.cancelled && options.afterDownload) await options.afterDownload();
    return result;
  };

  return {
    mapId,
    estimate,
    download,
    pause: () => {
      controller?.pause();
      void updateStatus('paused');
    },
    resume: () => {
      controller?.resume();
      void updateStatus('downloading');
    },
    cancel: () => {
      controller?.cancel();
      void updateStatus('cancelled');
    },
  };
}
