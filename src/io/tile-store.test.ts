import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  deleteTiledMap,
  deleteTileLevel,
  getTileDownload,
  getDetailDownload,
  getDetailExportBudget,
  getTileRecord,
  listTileRecords,
  listResumableTileDownloads,
  putTileDownload,
  putDetailDownload,
  putDetailExportBudget,
  putTileRecord,
  resetTileStoreForTests,
  subscribeDetailTileChanges,
  tileStorageEstimate,
  type TileDownloadManifest,
} from './tile-store';

const manifest: TileDownloadManifest = {
  mapId: 'map-one',
  sourceId: 'martin-county',
  z: 20,
  tileSize: 256,
  origin: { x: 512, y: 768 },
  cols: 2,
  rows: 1,
  width: 512,
  height: 256,
  boundary: [
    [27.1, -80.1],
    [27.1, -80],
    [27, -80],
  ],
  tiles: [
    { z: 20, x: 2, y: 3, col: 0, row: 0 },
    { z: 20, x: 3, y: 3, col: 1, row: 0 },
  ],
  completedKeys: ['20/2/3'],
  missingKeys: [],
  status: 'paused',
  updatedAt: '2026-10-04T00:00:00.000Z',
};

describe('tiled imagery storage', () => {
  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
  });

  afterEach(async () => {
    await resetTileStoreForTests();
  });

  it('stores JPEG tiles by map, level and tile position and lists completed data', async () => {
    const blob = new Blob(['jpeg-one'], { type: 'image/jpeg' });
    await putTileRecord('map-one', 0, 0, 0, blob);
    await putTileRecord('map-one', 1, 0, 0, new Blob(['overview'], { type: 'image/jpeg' }));
    await putTileRecord('map-two', 0, 0, 0, new Blob(['other'], { type: 'image/jpeg' }));

    const restored = await getTileRecord('map-one', 0, 0, 0);
    expect(restored?.type).toBe('image/jpeg');
    const restoredText = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(new TextDecoder().decode(reader.result as ArrayBuffer));
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(restored!);
    });
    expect(restoredText).toBe('jpeg-one');
    expect(
      (await listTileRecords('map-one')).map(({ level, col, row }) => [level, col, row]),
    ).toEqual([
      [0, 0, 0],
      [1, 0, 0],
    ]);
  });

  it('persists paused download manifests for reload and resumes from completed tile keys', async () => {
    await putTileDownload(manifest);
    await putTileDownload({ ...manifest, mapId: 'map-complete', status: 'complete' });

    expect(await getTileDownload('map-one')).toEqual(manifest);
    expect(await listResumableTileDownloads()).toEqual([manifest]);
    await deleteTiledMap('map-one');
    expect(await getTileDownload('map-one')).toBeUndefined();
  });

  it('persists maximum-detail export progress separately from cached-tile downloads', async () => {
    await putTileDownload(manifest);
    const detailManifest = {
      mapId: 'map-one',
      sourceId: 'martin-county',
      cells: [{ x: 12, y: 34 }],
      completedKeys: ['12/34'],
      missingKeys: [],
      status: 'paused' as const,
      updatedAt: '2026-10-04T00:00:00.000Z',
    };
    await putDetailDownload(detailManifest);
    await putDetailExportBudget([10, 20]);

    expect(await getDetailDownload('map-one')).toEqual(detailManifest);
    expect(await getDetailExportBudget()).toMatchObject({ starts: [10, 20] });
    expect(await getTileDownload('map-one')).toEqual(manifest);
  });

  it('deletes every level for one map without touching another map', async () => {
    await putTileRecord('map-one', 0, 0, 0, new Blob(['one']));
    await putTileRecord('map-two', 0, 0, 0, new Blob(['two']));
    await deleteTiledMap('map-one');

    expect(await listTileRecords('map-one')).toEqual([]);
    expect(await listTileRecords('map-two')).toHaveLength(1);
  });

  it('stores sparse level -1 detail and announces its removal without deleting level 0', async () => {
    const changes: string[] = [];
    const unsubscribe = subscribeDetailTileChanges('map-one', (change) => {
      changes.push(`${change.action}/${change.col}/${change.row}`);
    });
    await putTileRecord('map-one', 0, 0, 0, new Blob(['base']));
    await putTileRecord('map-one', -1, 2, 3, new Blob(['detail']));
    await putDetailDownload({
      mapId: 'map-one',
      sourceId: 'martin-county',
      cells: [{ x: 0, y: 0 }],
      completedKeys: ['0/0'],
      missingKeys: [],
      status: 'complete',
      updatedAt: '2026-10-04T00:00:00.000Z',
    });
    expect(await getTileRecord('map-one', -1, 2, 3)).toBeDefined();

    await deleteTileLevel('map-one', -1);
    unsubscribe();

    expect((await listTileRecords('map-one')).map(({ level }) => level)).toEqual([0]);
    expect(await getDetailDownload('map-one')).toBeUndefined();
    expect(changes).toEqual(['stored/2/3', 'deleted/2/3']);
  });

  it('warns when available storage is under 1.5 times the estimate', () => {
    expect(tileStorageEstimate(100, { usage: 50, quota: 200 })).toEqual({
      estimatedBytes: 100,
      freeBytes: 150,
      requiredBytes: 150,
      enoughSpace: true,
    });
    expect(tileStorageEstimate(101, { usage: 50, quota: 200 }).enoughSpace).toBe(false);
  });
});
