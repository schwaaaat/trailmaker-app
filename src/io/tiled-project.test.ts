import { describe, expect, it } from 'vitest';
import { createProjectForTiledMap } from './tiled-project';
import type { MapImage } from '../core/types';
import type { TiledImagerySource } from './tile-service';
import type { TiledBoundaryPlan } from './tiled-capture';

const image: MapImage = {
  fileName: 'Seabranch',
  width: 512,
  height: 256,
  originalWidth: 512,
  originalHeight: 256,
  source: {
    kind: 'tiles',
    sourceId: 'martin-county',
    z: 20,
    tileSize: 256,
    origin: { x: 134_217_472, y: 134_217_600 },
    boundary: [
      [27, -80],
      [27.1, -80],
      [27.1, -79.9],
    ],
    tileCount: 2,
  },
  sha256: '00',
  attribution: 'Imagery: Martin County',
};
const source: TiledImagerySource = {
  id: 'martin-county',
  name: 'Seabranch',
  url: 'https://tiles.example/MapServer',
  host: 'tiles.example',
  tileSize: 256,
  levels: [{ z: 20, resolutionM: 0.15 }],
  coverage: { west: -1, south: -1, east: 1, north: 1 },
  attribution: 'Imagery: Martin County',
};
const plan: TiledBoundaryPlan = {
  z: 20,
  tileSize: 256,
  origin: { x: 134_217_472, y: 134_217_600 },
  width: 512,
  height: 256,
  cols: 2,
  rows: 1,
  tiles: [],
  bbox: { west: -1, south: -1, east: 1, north: 1 },
  areaSqMeters: 10_000,
};

describe('createProjectForTiledMap', () => {
  it('creates nine exact anchors and an editable boundary feature', () => {
    const project = createProjectForTiledMap(
      image,
      source,
      plan,
      image.source.kind === 'tiles' ? image.source.boundary : [],
    );
    expect(project.anchors).toHaveLength(9);
    expect(project.anchors[4]?.px).toEqual([256, 128]);
    expect(project.anchors[4]?.ll?.[0]).toBeCloseTo(0, 4);
    expect(project.features[0]).toMatchObject({ kind: 'area', name: 'Park boundary' });
    expect(project.image.source.kind).toBe('tiles');
  });
});
