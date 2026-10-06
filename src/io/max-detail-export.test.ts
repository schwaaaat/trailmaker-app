import { describe, expect, it } from 'vitest';
import { buildDetailExportUrl, detailExportLocalTiles } from './max-detail-export';
import { planDetailExportAt } from './max-detail-planner';

describe('maximum-detail export requests', () => {
  it('requests one globally aligned 2048px EPSG:3857 image', () => {
    const cell = planDetailExportAt([27.135, -80.172]);
    const url = buildDetailExportUrl(
      cell,
      'https://geoweb.martin.fl.us/arcgis/rest/services/Imagery/MC_Imagery/MapServer',
    );

    expect(url.pathname.endsWith('/MapServer/export')).toBe(true);
    expect(url.searchParams.get('bbox')).toBe(cell.bbox3857.join(','));
    expect(url.searchParams.get('bboxSR')).toBe('3857');
    expect(url.searchParams.get('imageSR')).toBe('3857');
    expect(url.searchParams.get('size')).toBe('2048,2048');
    expect(url.searchParams.get('format')).toBe('jpg');
    expect(url.searchParams.get('f')).toBe('image');
  });

  it('maps global z21 tiles to local doubled level-0 tile coordinates', () => {
    const cell = planDetailExportAt([27.135, -80.172]);
    const firstGlobalX = cell.x * 8;
    const firstGlobalY = cell.y * 8;
    const origin = {
      x: (firstGlobalX / 2) * 256,
      y: (firstGlobalY / 2) * 256,
    };
    const tiles = detailExportLocalTiles(cell, {
      origin,
      sourceZoom: 20,
      width: 1024,
      height: 1024,
      tileSize: 256,
    });

    expect(tiles).toHaveLength(64);
    expect(tiles[0]).toMatchObject({ col: 0, row: 0 });
    expect(tiles[63]).toMatchObject({ col: 7, row: 7 });
  });
});
