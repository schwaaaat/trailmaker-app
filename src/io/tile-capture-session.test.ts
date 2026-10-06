import { describe, expect, it, vi } from 'vitest';
import { createTileCaptureSession } from './tile-capture-session';
import type { TiledImagerySource } from './tile-service';
import type { TiledBoundaryPlan } from './tiled-capture';

const source: TiledImagerySource = {
  id: 'martin-county',
  name: 'Martin County',
  url: 'https://tiles.example/MapServer',
  host: 'tiles.example',
  tileSize: 256,
  levels: [{ z: 20, resolutionM: 0.15 }],
  coverage: { west: -1, south: -1, east: 1, north: 1 },
  attribution: 'Imagery: Martin County',
};
const plan = {
  z: 20,
  tileSize: 256,
  origin: { x: 0, y: 0 },
  cols: 4,
  rows: 1,
  width: 1024,
  height: 256,
  bbox: { west: -1, south: -1, east: 1, north: 1 },
  areaSqMeters: 100_000,
  tiles: [
    { z: 20, x: 0, y: 0, col: 0, row: 0 },
    { z: 20, x: 1, y: 0, col: 1, row: 0 },
    { z: 20, x: 2, y: 0, col: 2, row: 0 },
    { z: 20, x: 3, y: 0, col: 3, row: 0 },
  ],
} satisfies TiledBoundaryPlan;

describe('createTileCaptureSession', () => {
  it('samples at most three tiles and reports storage/time estimate', async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(new Uint8Array(100), {
          status: 200,
          headers: { 'content-type': 'image/jpeg' },
        }),
    );
    const session = createTileCaptureSession({
      source,
      plan,
      fetcher,
      save: async () => undefined,
      readManifest: async () => undefined,
    });
    const estimate = await session.estimate();
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(estimate.estimatedBytes).toBe(400);
    expect(estimate.estimatedSeconds).toBeGreaterThan(0);
  });

  it('persists fetched imagery locally and records failures as missing', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(new Uint8Array(100), {
          status: 200,
          headers: { 'content-type': 'image/jpeg' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(new Uint8Array(100), {
          status: 200,
          headers: { 'content-type': 'image/jpeg' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(new Uint8Array(100), {
          status: 200,
          headers: { 'content-type': 'image/jpeg' },
        }),
      )
      .mockResolvedValueOnce(new Response('', { status: 404 }));
    const save = vi.fn(async () => undefined);
    const capture = createTileCaptureSession({
      source,
      plan,
      fetcher,
      save,
      persistManifest: async () => undefined,
      readManifest: async () => undefined,
    });
    await capture.estimate();
    const result = await capture.download();
    expect(result.completed).toEqual([]);
    expect(result.missing.map(({ z, x, y }) => `${z}/${x}/${y}`)).toEqual(['20/3/0']);
    expect(save).toHaveBeenCalledTimes(3);
  });

  it('reuses the persisted manifest after reload and fetches only unfinished tiles', async () => {
    let savedManifest: import('./tile-store').TileDownloadManifest | undefined;
    const fetcher = vi.fn(
      async () =>
        new Response(new Uint8Array(100), {
          status: 200,
          headers: { 'content-type': 'image/jpeg' },
        }),
    );
    const shared = {
      source,
      plan,
      mapId: 'resume-map',
      fetcher,
      save: async () => undefined,
      readManifest: async () => savedManifest,
      persistManifest: async (manifest: import('./tile-store').TileDownloadManifest) => {
        savedManifest = manifest;
      },
    };
    const first = createTileCaptureSession(shared);
    await first.estimate();
    await first.download();
    expect(fetcher).toHaveBeenCalledTimes(4);

    const resumed = createTileCaptureSession(shared);
    const estimate = await resumed.estimate();
    expect(estimate.sampleCount).toBe(0);
    await resumed.download();
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it('estimates z21 when sampled cache tiles are missing and reports them in the download', async () => {
    const z21Plan: TiledBoundaryPlan = {
      ...plan,
      z: 21,
      tiles: plan.tiles.map((tile) => ({ ...tile, z: 21 })),
    };
    let requests = 0;
    const fetcher = vi.fn(async () => {
      requests++;
      if (requests === 3) {
        return new Response(new Uint8Array(100), {
          status: 200,
          headers: { 'content-type': 'image/jpeg' },
        });
      }
      return new Response('', { status: 404 });
    });
    const capture = createTileCaptureSession({
      source: { ...source, levels: [{ z: 21, resolutionM: 0.075 }] },
      plan: z21Plan,
      mapId: 'z21-map',
      fetcher,
      save: async () => undefined,
      readManifest: async () => undefined,
      persistManifest: async () => undefined,
    });
    const estimate = await capture.estimate();
    expect(estimate.sampleCount).toBe(1);
    const result = await capture.download();
    expect(result.missing.map((tile) => tile.x).sort()).toEqual([0, 1, 3]);
  });
});
