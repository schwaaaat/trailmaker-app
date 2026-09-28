import { describe, expect, it, vi } from 'vitest';
import { fitAnchors, forward } from '../../core/geo/fit';
import type { Anchor, FeatureId, GeoFeature, PoiType } from '../../core/types';
import {
  buildOverlaySpec,
  debounce,
  DEFAULT_TPS_CELLS,
  drawTexturedTriangle,
  featuresToGeoJson,
  renderMeshToCanvas,
} from './overlaySource';

describe('overlaySource', () => {
  const anchors: Anchor[] = [
    { id: 'a1' as never, px: [0, 0], ll: [38.0, -78.0], source: 'paste' },
    { id: 'a2' as never, px: [1000, 0], ll: [38.0, -77.0], source: 'paste' },
    { id: 'a3' as never, px: [1000, 800], ll: [37.0, -77.0], source: 'paste' },
    { id: 'a4' as never, px: [0, 800], ll: [37.0, -78.0], source: 'paste' },
  ];

  it('selects quad overlay spec for similarity and affine fits', () => {
    const similarityFit = fitAnchors(anchors, 1000, 800, 'similarity');
    expect(similarityFit.ok).toBe(true);
    if (!similarityFit.ok) return;

    const spec = buildOverlaySpec(similarityFit, 1000, 800);
    expect(spec.type).toBe('quad');
    expect(spec.coordinates).toHaveLength(4);
    // [TL, TR, BR, BL] in [lng, lat]
    const [tl, tr, br, bl] = spec.coordinates;
    const expTL = forward(similarityFit, [0, 0]);
    const expTR = forward(similarityFit, [1000, 0]);
    const expBR = forward(similarityFit, [1000, 800]);
    const expBL = forward(similarityFit, [0, 800]);

    expect(tl[0]).toBeCloseTo(expTL[1], 5);
    expect(tl[1]).toBeCloseTo(expTL[0], 5);
    expect(tr[0]).toBeCloseTo(expTR[1], 5);
    expect(tr[1]).toBeCloseTo(expTR[0], 5);
    expect(br[0]).toBeCloseTo(expBR[1], 5);
    expect(br[1]).toBeCloseTo(expBR[0], 5);
    expect(bl[0]).toBeCloseTo(expBL[1], 5);
    expect(bl[1]).toBeCloseTo(expBL[0], 5);

    const affineFit = fitAnchors(anchors, 1000, 800, 'affine');
    expect(affineFit.ok).toBe(true);
    if (!affineFit.ok) return;

    const affineSpec = buildOverlaySpec(affineFit, 1000, 800);
    expect(affineSpec.type).toBe('quad');
    expect(affineSpec.coordinates).toHaveLength(4);
    const [atl, atr, abr, abl] = affineSpec.coordinates;
    expect(atl[0]).toBeCloseTo(-78.0, 3);
    expect(atl[1]).toBeCloseTo(38.0, 3);
    expect(atr[0]).toBeCloseTo(-77.0, 3);
    expect(atr[1]).toBeCloseTo(38.0, 3);
    expect(abr[0]).toBeCloseTo(-77.0, 3);
    expect(abr[1]).toBeCloseTo(37.0, 3);
    expect(abl[0]).toBeCloseTo(-78.0, 3);
    expect(abl[1]).toBeCloseTo(37.0, 3);
  });

  it('selects mesh overlay spec with 16 cells default for TPS fit', () => {
    const tpsFit = fitAnchors(anchors, 1000, 800, 'tps');
    expect(tpsFit.ok).toBe(true);
    if (!tpsFit.ok) return;

    const spec = buildOverlaySpec(tpsFit, 1000, 800);
    expect(spec.type).toBe('mesh');
    if (spec.type !== 'mesh') return;

    expect(spec.cells).toBe(DEFAULT_TPS_CELLS);
    expect(spec.mesh.cols).toBe(DEFAULT_TPS_CELLS);
    expect(spec.mesh.rows).toBeGreaterThan(0);
    expect(spec.coordinates).toHaveLength(4);
    expect(spec.bounds.minLng).toBeCloseTo(-78.0, 3);
    expect(spec.bounds.maxLng).toBeCloseTo(-77.0, 3);
    expect(spec.bounds.minLat).toBeCloseTo(37.0, 3);
    expect(spec.bounds.maxLat).toBeCloseTo(38.0, 3);
  });

  it('clamps TPS cell counts to 1..64', () => {
    const tpsFit = fitAnchors(anchors, 1000, 800, 'tps');
    if (!tpsFit.ok) return;

    const minSpec = buildOverlaySpec(tpsFit, 1000, 800, -10);
    expect(minSpec.type).toBe('mesh');
    if (minSpec.type === 'mesh') {
      expect(minSpec.cells).toBe(1);
    }

    const maxSpec = buildOverlaySpec(tpsFit, 1000, 800, 200);
    expect(maxSpec.type).toBe('mesh');
    if (maxSpec.type === 'mesh') {
      expect(maxSpec.cells).toBe(64);
    }
  });

  it('converts GeoFeatures to GeoJSON FeatureCollection with selection state', () => {
    const features: GeoFeature[] = [
      {
        id: 't1' as FeatureId,
        kind: 'trail',
        name: 'Ridge Trail',
        color: '#ff0000',
        notes: '',
        ink: null,
        pts: [
          [10, 10],
          [20, 20],
        ],
        ll: [
          [38.1, -78.1],
          [38.2, -78.2],
        ],
        lengthM: 1500,
      },
      {
        id: 'a1' as FeatureId,
        kind: 'area',
        name: 'Meadow',
        color: '#00ff00',
        notes: '',
        pts: [
          [0, 0],
          [10, 0],
          [10, 10],
        ],
        ll: [
          [38.0, -78.0],
          [38.1, -78.0],
          [38.1, -78.1],
        ],
        lengthM: 3000,
      },
      {
        id: 'p1' as FeatureId,
        kind: 'poi',
        name: 'Lookout',
        color: '#0000ff',
        notes: '',
        at: [50, 50],
        ll: [38.3, -78.3],
        poiType: 'viewpoint' as PoiType,
      },
    ];

    const fc = featuresToGeoJson(features, 't1' as FeatureId);
    expect(fc.type).toBe('FeatureCollection');
    expect(fc.features).toHaveLength(3);

    // Trail
    const trail = fc.features[0]!;
    expect(trail.geometry.type).toBe('LineString');
    if (trail.geometry.type === 'LineString') {
      expect(trail.geometry.coordinates).toEqual([
        [-78.1, 38.1],
        [-78.2, 38.2],
      ]);
    }
    expect(trail.properties.name).toBe('Ridge Trail');
    expect(trail.properties.color).toBe('#ff0000');
    expect(trail.properties.selected).toBe(true);

    // Area (closed polygon ring)
    const area = fc.features[1]!;
    expect(area.geometry.type).toBe('Polygon');
    if (area.geometry.type === 'Polygon') {
      const ring = area.geometry.coordinates[0]!;
      expect(ring[0]).toEqual(ring[ring.length - 1]);
    }
    expect(area.properties.selected).toBe(false);

    // POI
    const poi = fc.features[2]!;
    expect(poi.geometry.type).toBe('Point');
    if (poi.geometry.type === 'Point') {
      expect(poi.geometry.coordinates).toEqual([-78.3, 38.3]);
    }
    expect(poi.properties.poiType).toBe('viewpoint');
    expect(poi.properties.selected).toBe(false);
  });

  it('draws textured triangles and renders mesh onto canvas', () => {
    const mockCtx = {
      save: vi.fn(),
      restore: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      closePath: vi.fn(),
      clip: vi.fn(),
      transform: vi.fn(),
      drawImage: vi.fn(),
      clearRect: vi.fn(),
    };

    const mockCanvas = {
      width: 500,
      height: 400,
      getContext: vi.fn(() => mockCtx as unknown as CanvasRenderingContext2D),
    } as unknown as HTMLCanvasElement;

    const mockImage = {} as CanvasImageSource;

    drawTexturedTriangle(
      mockCtx as unknown as CanvasRenderingContext2D,
      mockImage,
      0, 0, 10, 0, 0, 10,
      0, 0, 5, 0, 0, 5,
    );
    expect(mockCtx.save).toHaveBeenCalled();
    expect(mockCtx.clip).toHaveBeenCalled();
    expect(mockCtx.transform).toHaveBeenCalled();
    expect(mockCtx.drawImage).toHaveBeenCalledWith(mockImage, 0, 0);
    expect(mockCtx.restore).toHaveBeenCalled();

    const tpsFit = fitAnchors(anchors, 1000, 800, 'tps');
    if (!tpsFit.ok) return;
    const spec = buildOverlaySpec(tpsFit, 1000, 800, 2);
    if (spec.type !== 'mesh') return;

    renderMeshToCanvas(spec, mockImage, mockCanvas);
    expect(mockCtx.clearRect).toHaveBeenCalledWith(0, 0, 500, 400);
    expect(mockCtx.drawImage).toHaveBeenCalled();
  });

  it('debounces function execution, handles cancellation and flush', () => {
    vi.useFakeTimers();

    const fn = vi.fn();
    const debounced = debounce(fn, 150);

    debounced(1);
    debounced(2);
    expect(fn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(149);
    expect(fn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith(2);

    // Cancel test
    debounced(3);
    debounced.cancel();
    vi.advanceTimersByTime(200);
    expect(fn).toHaveBeenCalledTimes(1);

    // Flush test
    debounced(4);
    debounced.flush();
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenCalledWith(4);

    vi.useRealTimers();
  });
});
