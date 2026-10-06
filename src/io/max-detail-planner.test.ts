import { describe, expect, it } from 'vitest';
import {
  DETAIL_EXPORT_SIZE,
  DETAIL_TILE_SIZE,
  detailExportTiles,
  detailWorldPixel,
  planDetailExports,
  planDetailExportAt,
  planDetailExportNeighborhood,
  worldPixelToDetailLatLon,
} from './max-detail-planner';

describe('maximum-detail export grid', () => {
  it('snaps a focus point to one stable 8 by 8 export cell', () => {
    const focus: [number, number] = [27.135, -80.172];
    const cell = planDetailExportAt(focus);
    const [x, y] = detailWorldPixel(focus);

    expect(cell.left).toBe(Math.floor(x / DETAIL_EXPORT_SIZE) * DETAIL_EXPORT_SIZE);
    expect(cell.top).toBe(Math.floor(y / DETAIL_EXPORT_SIZE) * DETAIL_EXPORT_SIZE);
    expect(cell.width).toBe(DETAIL_EXPORT_SIZE);
    expect(cell.height).toBe(DETAIL_EXPORT_SIZE);
    expect(planDetailExportAt(focus)).toEqual(cell);
  });

  it('cuts every export into 64 non-overlapping z21 tiles', () => {
    const cell = planDetailExportAt([27.135, -80.172]);
    const tiles = detailExportTiles(cell);

    expect(tiles).toHaveLength(64);
    expect(new Set(tiles.map(({ x, y }) => `${x}/${y}`)).size).toBe(64);
    expect(tiles[0]).toMatchObject({ x: cell.x * 8, y: cell.y * 8, col: 0, row: 0 });
    expect(tiles[63]).toMatchObject({
      x: cell.x * 8 + 7,
      y: cell.y * 8 + 7,
      col: 7,
      row: 7,
    });
    expect(DETAIL_TILE_SIZE * 8).toBe(DETAIL_EXPORT_SIZE);
  });

  it('orders the focus export and its eight neighbours nearest first', () => {
    const focus: [number, number] = [27.135, -80.172];
    const center = planDetailExportAt(focus);
    const cells = planDetailExportNeighborhood(focus);

    expect(cells).toHaveLength(9);
    expect(cells[0]).toEqual(center);
    expect(new Set(cells.map(({ x, y }) => `${x}/${y}`)).size).toBe(9);
  });

  it('plans a 0.1 km² boundary within eight exports and reports the 40-export warning', () => {
    const center = detailWorldPixel([27.135, -80.172]);
    const boundaryCenter: readonly [number, number] = [
      center[0],
      Math.floor(center[1] / DETAIL_EXPORT_SIZE) * DETAIL_EXPORT_SIZE + DETAIL_EXPORT_SIZE / 2,
    ];
    const boundary = [
      worldPixelToDetailLatLon([boundaryCenter[0] - 6000, boundaryCenter[1] - 900]),
      worldPixelToDetailLatLon([boundaryCenter[0] + 6000, boundaryCenter[1] - 900]),
      worldPixelToDetailLatLon([boundaryCenter[0] + 6000, boundaryCenter[1] + 900]),
      worldPixelToDetailLatLon([boundaryCenter[0] - 6000, boundaryCenter[1] + 900]),
    ] as const;
    const plan = planDetailExports(boundary);

    expect(plan.cells.length).toBeGreaterThan(0);
    expect(plan.cells.length).toBeLessThanOrEqual(8);
    expect(plan.areaSqMeters).toBeGreaterThan(90_000);
    expect(plan.areaSqMeters).toBeLessThan(110_000);
    expect(plan.exceedsRecommendedLimit).toBe(false);
    expect(new Set(plan.cells.map(({ x, y }) => `${x}/${y}`)).size).toBe(plan.cells.length);

    const largeBoundary = [
      worldPixelToDetailLatLon([center[0] - 20_000, center[1] - 20_000]),
      worldPixelToDetailLatLon([center[0] + 20_000, center[1] - 20_000]),
      worldPixelToDetailLatLon([center[0] + 20_000, center[1] + 20_000]),
      worldPixelToDetailLatLon([center[0] - 20_000, center[1] + 20_000]),
    ] as const;
    expect(planDetailExports(largeBoundary).exceedsRecommendedLimit).toBe(true);
  });
});
