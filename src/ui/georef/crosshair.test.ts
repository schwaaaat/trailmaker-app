import { describe, expect, it, vi } from 'vitest';
import type { FitResult, GeoFit } from '../../core/types';
import { BasemapCrosshair, computeParkMapMatch } from './crosshair';

function makeMockFit(): GeoFit {
  return {
    ok: true,
    method: 'affine',
    requested: 'auto',
    frame: { lat0: 0, lon0: 0, kx: 1, ky: 1, cx: 0, cy: 0, scale: 1 },
    model: { kind: 'affine', affine: [1, 0, 0, 0, 1, 0] },
    anchorCount: 4,
    residuals: {},
    rms: 0,
    checked: true,
    looResiduals: null,
    metersPerPixel: 1,
    mirrored: false,
    implausibleScale: false,
  };
}

describe('crosshair', () => {
  it('computes park-map match via inverse() and respects image boundaries', () => {
    const fit = makeMockFit();
    // Normal inside point
    const match = computeParkMapMatch([0, 0], fit, { width: 1000, height: 800 });
    expect(match).not.toBeNull();

    // Out-of-bounds point returns null
    const outMatch = computeParkMapMatch([99999, 99999], fit, { width: 1000, height: 800 });
    expect(outMatch).toBeNull();

    // null when fit is not ok
    const badFit: FitResult = { ok: false, reason: 'degenerate', anchorCount: 1, need: 4 };
    expect(computeParkMapMatch([0, 0], badFit, { width: 1000, height: 800 })).toBeNull();
  });

  it('updates basemap crosshair marker on forward() and destroys when px is null', () => {
    const crosshair = new BasemapCrosshair();
    const fit = makeMockFit();

    const mockMarker = {
      setLngLat: vi.fn().mockReturnThis(),
      addTo: vi.fn().mockReturnThis(),
      remove: vi.fn().mockReturnThis(),
    };

    class MockMarkerClass {
      constructor() {
        return mockMarker;
      }
    }

    const mockMap = {} as import('maplibre-gl').Map;
    const mockMapLibre = {
      Marker: MockMarkerClass as unknown as typeof import('maplibre-gl').Marker,
    } as typeof import('maplibre-gl');

    crosshair.update([100, 200], fit, mockMap, mockMapLibre);
    expect(mockMarker.setLngLat).toHaveBeenCalled();
    expect(mockMarker.addTo).toHaveBeenCalledWith(mockMap);

    // Update with another point
    crosshair.update([150, 250], fit, mockMap, mockMapLibre);
    expect(mockMarker.setLngLat).toHaveBeenCalledTimes(2);

    // Update with null removes marker
    crosshair.update(null, fit, mockMap, mockMapLibre);
    expect(mockMarker.remove).toHaveBeenCalled();
  });
});
