import { describe, expect, it, vi } from 'vitest';
import {
  MARTIN_TILE_MAPSERVER_URL,
  parseTiledMapServer,
  inspectTiledMapServer,
  tiledBoundaryWithinCoverage,
  type ArcGisTileServiceJson,
} from './tile-service';

const martin: ArcGisTileServiceJson = {
  name: 'MC_Imagery',
  copyrightText: 'GPI Geospatial, Inc.',
  documentInfo: { Title: '2021 Imagery' },
  singleFusedMapCache: true,
  fullExtent: {
    xmin: -8983106.559,
    ymin: 3116499.117,
    xmax: -8912756.247,
    ymax: 3158127.232,
    spatialReference: { wkid: 102100, latestWkid: 3857 },
  },
  tileInfo: {
    rows: 256,
    cols: 256,
    origin: { x: -20037508.342789244, y: 20037508.342789244 },
    spatialReference: { wkid: 102100, latestWkid: 3857 },
    lods: [
      { level: 20, resolution: 0.149291070823808 },
      { level: 21, resolution: 0.0746455354119042 },
    ],
  },
};

describe('cached ArcGIS tile service metadata', () => {
  it('reads the first layer metadata for the reported acquisition year', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ...martin, layers: [{ id: 0 }] }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ description: 'Imagery flown in 2026.' }), { status: 200 }),
      );
    const source = await inspectTiledMapServer(MARTIN_TILE_MAPSERVER_URL, fetcher);
    expect(source.year).toBe(2026);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('parses the Martin County cached Web Mercator tile scheme and credit', () => {
    const source = parseTiledMapServer(MARTIN_TILE_MAPSERVER_URL, martin, {
      description: '3-inch orthoimagery flown January 27, 2026 through February 2, 2026.',
      copyrightText: 'GPI Geospatial, Inc.',
    });

    expect(source.id).toBe('martin-county');
    expect(source.tileSize).toBe(256);
    expect(source.levels).toEqual([
      { z: 20, resolutionM: 0.149291070823808 },
      { z: 21, resolutionM: 0.0746455354119042 },
    ]);
    expect(source.attribution).toContain('GPI Geospatial, Inc.');
    expect(source.year).toBe(2026);
    expect(source.attribution).toContain('as reported by the service');
    expect(source.coverage.west).toBeLessThan(-8_900_000);
  });

  it('checks that every drawn vertex lies in the cached service extent', () => {
    const source = parseTiledMapServer(MARTIN_TILE_MAPSERVER_URL, martin);
    expect(
      tiledBoundaryWithinCoverage(source, [
        [27.135, -80.172],
        [27.14, -80.17],
        [27.13, -80.18],
      ]),
    ).toBe(true);
    expect(
      tiledBoundaryWithinCoverage(source, [
        [27.135, -80.172],
        [40, -73],
        [27.13, -80.18],
      ]),
    ).toBe(false);
  });

  it('rejects non-cache, non-Web-Mercator, and unsupported tile dimensions', () => {
    expect(() =>
      parseTiledMapServer(MARTIN_TILE_MAPSERVER_URL, { ...martin, singleFusedMapCache: false }),
    ).toThrow(/cached/i);
    expect(() =>
      parseTiledMapServer(MARTIN_TILE_MAPSERVER_URL, {
        ...martin,
        tileInfo: { ...martin.tileInfo!, spatialReference: { wkid: 4326 } },
      }),
    ).toThrow(/Web Mercator/i);
    expect(() =>
      parseTiledMapServer(MARTIN_TILE_MAPSERVER_URL, {
        ...martin,
        tileInfo: { ...martin.tileInfo!, cols: 512 },
      }),
    ).toThrow(/256/i);
    expect(() =>
      parseTiledMapServer(MARTIN_TILE_MAPSERVER_URL, {
        ...martin,
        tileInfo: { ...martin.tileInfo!, origin: { x: 0, y: 0 } },
      }),
    ).toThrow(/origin/i);
  });
});
