// Lane C. Tests for satellite capture tile math, 3x3 anchor grid accuracy, stitching, and project creation.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fitAnchors, forward } from '../core/geo/fit';
import { haversine } from '../core/geo/distance';
import * as imageModule from './image';
import { makeMap, makeProject } from '../state/fixtures.test.helper';
import {
  computeOptimalZoom,
  computeOptimalNaipZoom,
  planNaipRequests,
  isNaipCoverageFallbackNeeded,
  getAvailableZoomRange,
  getCaptureDimensions,
  generateProjectName,
  generateTileAnchors,
  groundResolution,
  latLonToWorldPx,
  worldPxToLatLon,
  captureSatelliteView,
  buildSatelliteProject,
  drawMissingTileGap,
  satelliteCaptureTestSeam,
  MAX_CAPTURE_LONG_SIDE,
  MAX_CAPTURE_TILES,
  MAX_NAIP_CAPTURE_LONG_SIDE,
  MAX_NAIP_EXPORT_REQUESTS,
  NAIP_EXPORT_IMAGE_SIZE,
  NAIP_GROUND_RESOLUTION_M,
  TILE_SIZE,
  type FramedBounds,
} from './satellite-capture';

describe('Web Mercator tile math', () => {
  it('round-trips lat/lon coordinates through world pixel space at multiple zooms', () => {
    const coords: [number, number][] = [
      [0, 0],
      [37.7749, -122.4194], // San Francisco
      [27.1234, -80.1234],  // Seabranch Preserve area
      [-33.8688, 151.2093], // Sydney
      [64.1466, -21.9426],  // Reykjavik
    ];

    for (const zoom of [0, 4, 10, 16]) {
      for (const [lat, lon] of coords) {
        const px = latLonToWorldPx([lat, lon], zoom);
        const [backLat, backLon] = worldPxToLatLon(px, zoom);
        expect(backLat).toBeCloseTo(lat, 5);
        expect(backLon).toBeCloseTo(lon, 5);
      }
    }
  });

  it('calculates expected ground resolution in m/px', () => {
    // Equator at zoom 0: ~156,543 m/px
    const eqZ0 = groundResolution(0, 0);
    expect(eqZ0).toBeCloseTo(156543, -2);

    // Lat 30 deg at zoom 16: ~2.06 m/px
    const z16 = groundResolution(30, 16);
    expect(z16).toBeGreaterThan(1.5);
    expect(z16).toBeLessThan(3.0);
  });
});

describe('Framed bounds & zoom calculation', () => {
  const seabranchBounds: FramedBounds = {
    north: 27.15,
    south: 27.12,
    west: -80.16,
    east: -80.13,
  };

  it('computes capture dimensions within limits', () => {
    const dims = getCaptureDimensions(seabranchBounds, 14);
    expect(dims.width).toBeGreaterThan(0);
    expect(dims.height).toBeGreaterThan(0);
    expect(dims.tileCount).toBeGreaterThan(0);
    expect(dims.metersPerPixel).toBeGreaterThan(0);
  });

  it('enforces output limits: <= 8192 px long side and <= 256 tiles', () => {
    // Huge statewide area
    const hugeBounds: FramedBounds = {
      north: 31.0,
      south: 24.5,
      west: -87.6,
      east: -80.0,
    };

    const zoom = computeOptimalZoom(hugeBounds, MAX_CAPTURE_LONG_SIDE, MAX_CAPTURE_TILES);
    const dims = getCaptureDimensions(hugeBounds, zoom);

    expect(Math.max(dims.width, dims.height)).toBeLessThanOrEqual(MAX_CAPTURE_LONG_SIDE);
    expect(dims.tileCount).toBeLessThanOrEqual(MAX_CAPTURE_TILES);
  });

  it('provides available zoom range with default at optimal zoom', () => {
    const range = getAvailableZoomRange(seabranchBounds);
    expect(range.defaultZoom).toBeGreaterThanOrEqual(range.minZoom);
    expect(range.defaultZoom).toBeLessThanOrEqual(range.maxZoom);
    expect(range.maxZoom).toBeLessThanOrEqual(16);
  });

  it('plans NAIP at 0.3 m ground resolution and respects mosaic caps', () => {
    const zoom = computeOptimalNaipZoom(seabranchBounds);
    const dims = getCaptureDimensions(seabranchBounds, zoom);
    const requests = planNaipRequests(dims);
    expect(dims.metersPerPixel).toBeCloseTo(NAIP_GROUND_RESOLUTION_M, 1);
    expect(Math.max(dims.width, dims.height)).toBeLessThanOrEqual(MAX_NAIP_CAPTURE_LONG_SIDE);
    expect(requests.length).toBeLessThanOrEqual(MAX_NAIP_EXPORT_REQUESTS);
    expect(requests.every((request) => request.width <= NAIP_EXPORT_IMAGE_SIZE && request.height <= NAIP_EXPORT_IMAGE_SIZE)).toBe(true);
    expect(requests.at(-1)?.bbox[0]).toBeLessThan(requests.at(-1)?.bbox[2] ?? 0);
    expect(requests.at(-1)?.bbox[1]).toBeLessThan(requests.at(-1)?.bbox[3] ?? 0);
  });

  it.each([
    { name: 'Seabranch', lon: -80.1768, lat: 27.1382 },
    { name: 'western US', lon: -112.95, lat: 37.29 },
  ])('plans NAIP requests in EPSG:3857 metres near $name', ({ lon, lat }) => {
    const bounds: FramedBounds = {
      north: lat + 0.005,
      south: lat - 0.005,
      west: lon - 0.005,
      east: lon + 0.005,
    };
    const zoom = 16;
    const dims = getCaptureDimensions(bounds, zoom);
    const requests = planNaipRequests(dims);
    const [centerX, centerY] = latLonToWorldPx([lat, lon], 0);
    const worldMeters = 40075016.686;
    const expectedX = centerX * worldMeters / TILE_SIZE - worldMeters / 2;
    const expectedY = worldMeters / 2 - centerY * worldMeters / TILE_SIZE;
    const halfWidthM = (bounds.east - bounds.west) * Math.PI / 180 * 6378137 / 2;
    const halfHeightM = 6378137 * Math.log(Math.tan(Math.PI / 4 + bounds.north * Math.PI / 360)) - expectedY;

    expect(requests.length).toBeGreaterThan(0);
    for (const { bbox } of requests) {
      expect(bbox[0]).toBeGreaterThan(expectedX - halfWidthM - 2);
      expect(bbox[2]).toBeLessThan(expectedX + halfWidthM + 2);
      expect(bbox[1]).toBeGreaterThan(expectedY - halfHeightM - 2);
      expect(bbox[3]).toBeLessThan(expectedY + halfHeightM + 2);
    }
  });

  it('falls back when any NAIP export request is missing', () => {
    expect(isNaipCoverageFallbackNeeded(0)).toBe(false);
    expect(isNaipCoverageFallbackNeeded(1)).toBe(true);
  });
});

describe('Acceptance 4: 3x3 anchor grid accuracy on 3 km capture at 30° latitude', () => {
  it('proves forward(fit, px) is within 0.5 m of true tile-math position at 25 sample points', () => {
    const centerLat = 30.0;
    const centerLon = -80.0;

    // 3 km area in degrees
    const dLat = 3000 / 111320;
    const dLon = 3000 / (111320 * Math.cos((centerLat * Math.PI) / 180));

    const bounds: FramedBounds = {
      north: centerLat + dLat / 2,
      south: centerLat - dLat / 2,
      west: centerLon - dLon / 2,
      east: centerLon + dLon / 2,
    };

    const zoom = 16;
    const dims = getCaptureDimensions(bounds, zoom);

    // Generate the 9 anchors (3x3 grid)
    const anchors = generateTileAnchors(dims);
    expect(anchors).toHaveLength(9);
    expect(anchors.every((a) => a.source === 'basemap')).toBe(true);

    // Compute fit using Trailmaker's geo fit engine ('auto' -> 'affine')
    const fit = fitAnchors(anchors, dims.width, dims.height, 'auto');
    expect(fit.ok).toBe(true);
    if (!fit.ok) throw new Error('Fit failed');

    // Check 25 sample points on a 5x5 grid across the entire 3 km image
    let maxErrorMeters = 0;
    const sampleErrors: number[] = [];

    for (let row = 0; row < 5; row++) {
      for (let col = 0; col < 5; col++) {
        const u = col / 4;
        const v = row / 4;

        const px: [number, number] = [
          Math.round(u * dims.width),
          Math.round(v * dims.height),
        ];

        // World coordinates of the sampled pixel on the stitched capture
        const wx = dims.xMin + px[0];
        const wy = dims.yMin + px[1];
        const trueLatLon = worldPxToLatLon([wx, wy], zoom);

        // Projected LatLon from fit
        const fitLatLon = forward(fit, px);

        const errorMeters = haversine(fitLatLon, trueLatLon);
        sampleErrors.push(errorMeters);
        if (errorMeters > maxErrorMeters) {
          maxErrorMeters = errorMeters;
        }

        // Must be within 0.5 meters
        expect(errorMeters).toBeLessThan(0.5);
      }
    }

    expect(sampleErrors).toHaveLength(25);
    // Typical max error across 3 km at 30 deg is < 0.1 m
    expect(maxErrorMeters).toBeLessThan(0.5);
  });

  it('keeps a 3x3 anchor grid accurate at NAIP resolution', () => {
    const centerLat = 30;
    const dLat = 3000 / 111320;
    const dLon = 3000 / (111320 * Math.cos((centerLat * Math.PI) / 180));
    const bounds: FramedBounds = {
      north: centerLat + dLat / 2,
      south: centerLat - dLat / 2,
      west: -80 - dLon / 2,
      east: -80 + dLon / 2,
    };
    const zoom = computeOptimalNaipZoom(bounds);
    const dims = getCaptureDimensions(bounds, zoom);
    const anchors = generateTileAnchors(dims);
    const fit = fitAnchors(anchors, dims.width, dims.height, 'auto');
    expect(fit.ok).toBe(true);
    if (!fit.ok) throw new Error('NAIP anchor fit failed');
    for (let row = 0; row < 5; row++) {
      for (let col = 0; col < 5; col++) {
        const px: [number, number] = [Math.round(col * dims.width / 4), Math.round(row * dims.height / 4)];
        expect(haversine(forward(fit, px), worldPxToLatLon([dims.xMin + px[0], dims.yMin + px[1]], zoom))).toBeLessThan(0.5);
      }
    }
  });
});

describe('Project naming & attribution', () => {
  const bounds: FramedBounds = {
    north: 27.15,
    south: 27.12,
    west: -80.16,
    east: -80.13,
  };

  it('formats filename with place name when provided', () => {
    const name = generateProjectName(bounds, 'Seabranch Preserve', '2026-09-29');
    expect(name).toBe('Satellite Seabranch Preserve 2026-09-29');
  });

  it('formats filename with lat,lon when no place name is provided', () => {
    const name = generateProjectName(bounds, '', '2026-09-29');
    expect(name).toBe('Satellite 27.1350,-80.1450 2026-09-29');
  });
});

describe('Tile stitching & missing tile handling', () => {
  beforeEach(() => {
    satelliteCaptureTestSeam.createCanvas = (_w, _h) => {
      const ctx = {
        fillStyle: '',
        strokeStyle: '',
        lineWidth: 1,
        fillRect: vi.fn(),
        strokeRect: vi.fn(),
        beginPath: vi.fn(),
        moveTo: vi.fn(),
        lineTo: vi.fn(),
        stroke: vi.fn(),
        drawImage: vi.fn(),
        save: vi.fn(),
        restore: vi.fn(),
      };
      return {
        getContext: () => ctx as unknown as CanvasRenderingContext2D,
        convertToBlob: async () => new Blob(['fake-png'], { type: 'image/png' }),
        toBlob: (cb: (b: Blob) => void) => cb(new Blob(['fake-png'], { type: 'image/png' })),
      };
    };
  });

  afterEach(() => {
    satelliteCaptureTestSeam.createCanvas = null;
  });

  it('renders a distinct non-silent gap pattern for missing tiles', () => {
    const mockCtx = {
      save: vi.fn(),
      restore: vi.fn(),
      fillRect: vi.fn(),
      strokeRect: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      stroke: vi.fn(),
      fillStyle: '',
      strokeStyle: '',
      lineWidth: 0,
    };

    drawMissingTileGap(mockCtx as unknown as CanvasRenderingContext2D, 100, 200, TILE_SIZE);

    expect(mockCtx.save).toHaveBeenCalled();
    expect(mockCtx.fillRect).toHaveBeenCalledWith(100, 200, TILE_SIZE, TILE_SIZE);
    expect(mockCtx.fillStyle).not.toBe('#000000'); // NOT silent black!
    expect(mockCtx.stroke).toHaveBeenCalled();
    expect(mockCtx.restore).toHaveBeenCalled();
  });

  it('captures satellite tiles and builds project with anchors and attribution', async () => {
    // Small bounds creating 2x2 tiles
    const bounds: FramedBounds = {
      north: 27.135,
      south: 27.130,
      west: -80.145,
      east: -80.140,
    };

    let fetchedCount = 0;
    const mockTileLoader = async () => {
      fetchedCount++;
      return null; // triggers clear missing tile gap drawing
    };

    const progressReports: number[] = [];
    const result = await captureSatelliteView({
      bounds,
      zoom: 14,
      tileLoader: mockTileLoader,
      placeName: 'Test Park',
      date: '2026-09-29',
      onProgress: (p) => progressReports.push(p.loaded),
    });

    expect(fetchedCount).toBeGreaterThan(0);
    expect(result.blob).toBeInstanceOf(Blob);
    expect(result.width).toBeGreaterThan(0);
    expect(result.height).toBeGreaterThan(0);
    expect(result.anchors).toHaveLength(9);
    expect(result.attribution).toContain('USGS The National Map');
    expect(result.projectName).toBe('Satellite Test Park 2026-09-29');
    expect(result.missingTiles).toBeGreaterThan(0);
    expect(progressReports.length).toBeGreaterThan(0);

    // Build project from result
    vi.spyOn(imageModule, 'loadImageFile').mockResolvedValue(
      makeMap(
        makeProject({
          name: result.projectName,
          image: {
            fileName: result.fileName,
            width: result.width,
            height: result.height,
            originalWidth: result.width,
            originalHeight: result.height,
            source: { kind: 'image', mimeType: 'image/png' },
            sha256: 'mock-sha',
          },
        })
      )
    );

    const { project, map } = await buildSatelliteProject(result, '2026-09-29T12:00:00.000Z');
    expect(project.name).toBe('Satellite Test Park 2026-09-29');
    expect(project.anchors).toHaveLength(9);
    expect(project.anchors[0]?.source).toBe('basemap');
    expect(project.image.attribution).toBe('Imagery: USGS The National Map');
    expect(project.image.acquisitionYear).toBeUndefined();
    expect((map.meta as { attribution?: string }).attribution).toBe('Imagery: USGS The National Map');
  });

  it('captures NAIP with exact anchors and USDA attribution', async () => {
    const bounds = { north: 27.135, south: 27.130, west: -80.145, east: -80.140 };
    let requests = 0;
    const result = await captureSatelliteView({
      bounds,
      providerId: 'naip',
      naipYearLoader: async () => 2024,
      naipRequestLoader: async (_bbox, size) => {
        requests++;
        expect(size[0]).toBeLessThanOrEqual(NAIP_EXPORT_IMAGE_SIZE);
        expect(size[1]).toBeLessThanOrEqual(NAIP_EXPORT_IMAGE_SIZE);
        return {} as CanvasImageSource;
      },
    });
    expect(requests).toBeGreaterThan(0);
    expect(result.source).toBe('naip');
    expect(result.anchors).toHaveLength(9);
    expect(result.attribution).toBe('Imagery: USDA NAIP via USGS The National Map');
    expect(result.acquisitionYear).toBe(2024);
    const opened = await buildSatelliteProject(result, '2026-09-29T12:00:00.000Z');
    expect(opened.project.image.attribution).toBe(result.attribution);
    expect(opened.project.image.acquisitionYear).toBe(2024);
    expect(opened.map.meta).toMatchObject(opened.project.image);
  });

  it('falls back to USGS on empty NAIP exports and reports the reason', async () => {
    const result = await captureSatelliteView({
      bounds: { north: 27.135, south: 27.130, west: -80.145, east: -80.140 },
      providerId: 'naip',
      naipRequestLoader: async () => null,
      tileLoader: async () => null,
    });
    expect(result.source).toBe('usgs');
    expect(result.fallbackReason).toBe('NAIP not available here; using USGS 2.1 m');
  });

  it('respects AbortSignal cancellation', async () => {
    const controller = new AbortController();
    controller.abort();

    const bounds: FramedBounds = {
      north: 27.135,
      south: 27.130,
      west: -80.145,
      east: -80.140,
    };

    await expect(
      captureSatelliteView({
        bounds,
        signal: controller.signal,
      })
    ).rejects.toThrow();
  });
});
