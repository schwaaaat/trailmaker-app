import { openDB, type IDBPDatabase } from 'idb';
import type { LatLon } from '../core/types';
import type { PlannedMapTile } from './tiled-capture';

export const TILE_DB_NAME = 'trailmaker-tiled-imagery';
export const TILE_DB_VERSION = 2;
export const TILE_STORE_NAME = 'tiles';
export const TILE_DOWNLOAD_STORE_NAME = 'downloads';
export const DETAIL_DOWNLOAD_STORE_NAME = 'detail-downloads';

export interface DetailTileChange {
  readonly col: number;
  readonly row: number;
  readonly action: 'stored' | 'deleted';
}

export interface StoredTileRecord {
  readonly key: string;
  readonly mapId: string;
  readonly level: number;
  readonly col: number;
  readonly row: number;
  readonly data: Uint8Array;
  readonly mimeType: string;
  readonly byteLength: number;
}

export interface TileDownloadManifest {
  readonly mapId: string;
  readonly sourceId: string;
  readonly z: number;
  readonly tileSize: number;
  readonly origin: { readonly x: number; readonly y: number };
  readonly cols: number;
  readonly rows: number;
  readonly width: number;
  readonly height: number;
  readonly boundary: readonly LatLon[];
  readonly tiles: readonly PlannedMapTile[];
  readonly completedKeys: readonly string[];
  readonly missingKeys: readonly string[];
  readonly status: 'downloading' | 'paused' | 'complete' | 'cancelled';
  readonly updatedAt: string;
  readonly averageTileBytes?: number;
}

export interface DetailDownloadManifest {
  readonly mapId: string;
  readonly sourceId: string;
  readonly cells: readonly { readonly x: number; readonly y: number }[];
  readonly completedKeys: readonly string[];
  readonly missingKeys: readonly string[];
  readonly status: 'downloading' | 'paused' | 'complete' | 'cancelled';
  readonly updatedAt: string;
}

export interface DetailExportBudgetRecord {
  readonly mapId: string;
  readonly starts: readonly number[];
}

export const DETAIL_EXPORT_BUDGET_KEY = '__detail-budget:martin-county__';

export interface StorageEstimate {
  readonly usage?: number;
  readonly quota?: number;
}

export interface TileStorageEstimate {
  readonly estimatedBytes: number;
  readonly freeBytes: number;
  readonly requiredBytes: number;
  readonly enoughSpace: boolean;
}

/** Stable browser-storage key derived from the durable tiled source metadata. */
export function tiledMapStorageId(source: {
  readonly sourceId: string;
  readonly z: number;
  readonly tileSize: number;
  readonly origin: { readonly x: number; readonly y: number };
  readonly boundary: readonly LatLon[];
}): string {
  return `tiles:${encodeURIComponent(JSON.stringify([source.sourceId, source.z, source.tileSize, source.origin.x, source.origin.y, source.boundary]))}`;
}

let dbPromise: Promise<IDBPDatabase> | null = null;
const detailTileListeners = new Map<string, Set<(change: DetailTileChange) => void>>();

function notifyDetailTileChange(mapId: string, change: DetailTileChange): void {
  for (const listener of detailTileListeners.get(mapId) ?? []) {
    try {
      listener(change);
    } catch {
      // A rendering subscriber must not make a persisted tile write fail.
    }
  }
}

export function subscribeDetailTileChanges(
  mapId: string,
  listener: (change: DetailTileChange) => void,
): () => void {
  let listeners = detailTileListeners.get(mapId);
  if (!listeners) {
    listeners = new Set();
    detailTileListeners.set(mapId, listeners);
  }
  listeners.add(listener);
  return () => {
    listeners?.delete(listener);
    if (listeners?.size === 0) detailTileListeners.delete(mapId);
  };
}

export function getTileDb(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    dbPromise = openDB(TILE_DB_NAME, TILE_DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(TILE_STORE_NAME)) {
          const tiles = db.createObjectStore(TILE_STORE_NAME, { keyPath: 'key' });
          tiles.createIndex('mapId', 'mapId');
        }
        if (!db.objectStoreNames.contains(TILE_DOWNLOAD_STORE_NAME)) {
          db.createObjectStore(TILE_DOWNLOAD_STORE_NAME, { keyPath: 'mapId' });
        }
        if (!db.objectStoreNames.contains(DETAIL_DOWNLOAD_STORE_NAME)) {
          db.createObjectStore(DETAIL_DOWNLOAD_STORE_NAME, { keyPath: 'mapId' });
        }
      },
    }).catch((error) => {
      dbPromise = null;
      throw error;
    });
  }
  return dbPromise;
}

function tileRecordKey(mapId: string, level: number, col: number, row: number): string {
  return `${mapId}/${level}/${col}/${row}`;
}

async function blobBytes(blob: Blob): Promise<Uint8Array> {
  if (typeof blob.arrayBuffer === 'function') {
    return new Uint8Array(await blob.arrayBuffer());
  }
  return new Promise<Uint8Array>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error ?? new Error('Could not read tile data.'));
    reader.readAsArrayBuffer(blob);
  });
}

export async function putTileRecord(
  mapId: string,
  level: number,
  col: number,
  row: number,
  blob: Blob,
): Promise<void> {
  if (
    !mapId ||
    !Number.isInteger(level) ||
    level < -1 ||
    !Number.isInteger(col) ||
    col < 0 ||
    !Number.isInteger(row) ||
    row < 0
  ) {
    throw new Error('Invalid tiled imagery record key.');
  }
  const record: StoredTileRecord = {
    key: tileRecordKey(mapId, level, col, row),
    mapId,
    level,
    col,
    row,
    data: await blobBytes(blob),
    mimeType: blob.type || 'image/jpeg',
    byteLength: blob.size,
  };
  await (await getTileDb()).put(TILE_STORE_NAME, record);
  if (level === -1) notifyDetailTileChange(mapId, { col, row, action: 'stored' });
}

export async function getTileRecord(
  mapId: string,
  level: number,
  col: number,
  row: number,
): Promise<Blob | undefined> {
  const record = (await (
    await getTileDb()
  ).get(TILE_STORE_NAME, tileRecordKey(mapId, level, col, row))) as StoredTileRecord | undefined;
  return record
    ? new Blob([record.data as unknown as BlobPart], { type: record.mimeType })
    : undefined;
}

export async function listTileRecords(mapId: string): Promise<StoredTileRecord[]> {
  const db = await getTileDb();
  const records = (await db.getAllFromIndex(TILE_STORE_NAME, 'mapId', mapId)) as StoredTileRecord[];
  return records.sort((a, b) => a.level - b.level || a.row - b.row || a.col - b.col);
}

export async function putTileDownload(manifest: TileDownloadManifest): Promise<void> {
  await (await getTileDb()).put(TILE_DOWNLOAD_STORE_NAME, manifest);
}

export async function getTileDownload(mapId: string): Promise<TileDownloadManifest | undefined> {
  return (await (await getTileDb()).get(TILE_DOWNLOAD_STORE_NAME, mapId)) as
    TileDownloadManifest | undefined;
}

export async function putDetailDownload(manifest: DetailDownloadManifest): Promise<void> {
  await (await getTileDb()).put(DETAIL_DOWNLOAD_STORE_NAME, manifest);
}

export async function getDetailDownload(
  mapId: string,
): Promise<DetailDownloadManifest | undefined> {
  return (await (await getTileDb()).get(DETAIL_DOWNLOAD_STORE_NAME, mapId)) as
    DetailDownloadManifest | undefined;
}

export async function getDetailExportBudget(): Promise<DetailExportBudgetRecord | undefined> {
  return (await (await getTileDb()).get(DETAIL_DOWNLOAD_STORE_NAME, DETAIL_EXPORT_BUDGET_KEY)) as
    DetailExportBudgetRecord | undefined;
}

export async function putDetailExportBudget(starts: readonly number[]): Promise<void> {
  await (
    await getTileDb()
  ).put(DETAIL_DOWNLOAD_STORE_NAME, {
    mapId: DETAIL_EXPORT_BUDGET_KEY,
    starts,
  } satisfies DetailExportBudgetRecord);
}

export async function listResumableTileDownloads(): Promise<TileDownloadManifest[]> {
  const db = await getTileDb();
  const manifests = (await db.getAll(TILE_DOWNLOAD_STORE_NAME)) as TileDownloadManifest[];
  return manifests
    .filter((manifest) => manifest.status === 'paused' || manifest.status === 'downloading')
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function deleteTiledMap(mapId: string): Promise<void> {
  const db = await getTileDb();
  const tx = db.transaction(
    [TILE_STORE_NAME, TILE_DOWNLOAD_STORE_NAME, DETAIL_DOWNLOAD_STORE_NAME],
    'readwrite',
  );
  const records = (await tx
    .objectStore(TILE_STORE_NAME)
    .index('mapId')
    .getAll(mapId)) as StoredTileRecord[];
  const keys = records.map(({ key }) => key);
  await Promise.all([
    ...keys.map((key) => tx.objectStore(TILE_STORE_NAME).delete(key)),
    tx.objectStore(TILE_DOWNLOAD_STORE_NAME).delete(mapId),
    tx.objectStore(DETAIL_DOWNLOAD_STORE_NAME).delete(mapId),
    tx.done,
  ]);
  for (const record of records) {
    if (record.level === -1) {
      notifyDetailTileChange(mapId, { col: record.col, row: record.row, action: 'deleted' });
    }
  }
}

export async function deleteTileLevel(mapId: string, level: number): Promise<void> {
  if (!mapId || !Number.isInteger(level) || level < -1) {
    throw new Error('Invalid tiled imagery level.');
  }
  const db = await getTileDb();
  const tx = db.transaction(
    level === -1 ? [TILE_STORE_NAME, DETAIL_DOWNLOAD_STORE_NAME] : TILE_STORE_NAME,
    'readwrite',
  );
  const records = (await tx
    .objectStore(TILE_STORE_NAME)
    .index('mapId')
    .getAll(mapId)) as StoredTileRecord[];
  const matching = records.filter((record) => record.level === level);
  await Promise.all([
    ...matching.map(({ key }) => tx.objectStore(TILE_STORE_NAME).delete(key)),
    ...(level === -1 ? [tx.objectStore(DETAIL_DOWNLOAD_STORE_NAME).delete(mapId)] : []),
    tx.done,
  ]);
  if (level === -1) {
    for (const record of matching) {
      notifyDetailTileChange(mapId, { col: record.col, row: record.row, action: 'deleted' });
    }
  }
}

export function tileStorageEstimate(
  estimatedBytes: number,
  estimate: StorageEstimate,
  safetyFactor = 1.5,
): TileStorageEstimate {
  const quota = Math.max(0, estimate.quota ?? 0);
  const usage = Math.max(0, estimate.usage ?? 0);
  const freeBytes = Math.max(0, quota - usage);
  const requiredBytes = Math.ceil(Math.max(0, estimatedBytes) * safetyFactor);
  return {
    estimatedBytes: Math.ceil(Math.max(0, estimatedBytes)),
    freeBytes,
    requiredBytes,
    enoughSpace: freeBytes >= requiredBytes,
  };
}

export async function requestPersistentTileStorage(): Promise<boolean> {
  if (typeof navigator === 'undefined' || !navigator.storage?.persist) return false;
  try {
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

export async function resetTileStoreForTests(): Promise<void> {
  if (dbPromise) {
    const db = await dbPromise.catch(() => null);
    db?.close();
    dbPromise = null;
  }
}
