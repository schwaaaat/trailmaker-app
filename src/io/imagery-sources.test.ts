import { describe, expect, it } from 'vitest';
import {
  IMAGERY_SOURCES,
  achievableImageryResolution,
  containsFrame,
  deriveImageryCredit,
  parseArcGisService,
  planServiceRequests,
  selectImagerySources,
  isMostlyBlank,
  type ArcGisServiceJson,
} from './imagery-sources';

const martin: ArcGisServiceJson = {
  name: 'MC_Imagery',
  description: 'Flight season was from January 27, 2026 through February 2, 2026 for all areas.',
  copyrightText: 'GPI Geospatial, Inc.',
  documentInfo: { Title: '2021 Imagery' },
  fullExtent: {
    xmin: -8983106,
    ymin: 3116499,
    xmax: -8912756,
    ymax: 3158127,
    spatialReference: { wkid: 102100, latestWkid: 3857 },
  },
  spatialReference: { wkid: 3857 },
  maxImageWidth: 2048,
  maxImageHeight: 2048,
  layers: [{ id: 0, name: 'Current_Imagery' }],
};

describe('local ArcGIS imagery sources', () => {
  it('finds a captureable near-0.25 m/px resolution for a 3 km frame', () => {
    const resolution = achievableImageryResolution(
      { west: 0, south: 0, east: 1500, north: 3000 },
      0.0762,
      [2048, 2048],
      { maxLongSide: 12_000, maxRequests: 16 },
    );
    expect(resolution).toBeGreaterThanOrEqual(0.25);
    expect(resolution).toBeLessThan(0.31);
    expect(Math.ceil(3000 / resolution)).toBeLessThanOrEqual(12_000);
    expect(
      Math.ceil(Math.ceil(1500 / resolution) / 2048) *
        Math.ceil(Math.ceil(3000 / resolution) / 2048),
    ).toBeLessThanOrEqual(16);
  });
  it('registers Martin County with its live 3857 extent and source resolution', () => {
    const source = IMAGERY_SOURCES.find((item) => item.id === 'martin-county');
    expect(source?.coverage.west).toBeCloseTo(-8983106.559, 2);
    expect(source?.coverage.east).toBeCloseTo(-8912756.247, 2);
    expect(source?.nominalResolutionM).toBeCloseTo(0.0762);
    expect(source?.kind).toBe('mapserver-export');
  });

  it('lists only sources that contain the entire framed box and orders sharpest first', () => {
    expect(
      selectImagerySources({ west: -8924700, south: 3140300, east: -8924500, north: 3140500 }).map(
        (s) => s.id,
      )[0],
    ).toBe('martin-county');
    expect(
      containsFrame(IMAGERY_SOURCES[0]!.coverage, { west: 0, south: 0, east: 1, north: 1 }),
    ).toBe(false);
  });

  it('parses MapServer metadata, date, extent and maximum export size', () => {
    const parsed = parseArcGisService(
      'https://example.test/arcgis/rest/services/Imagery/Local/MapServer',
      martin,
    );
    expect(parsed.kind).toBe('mapserver-export');
    expect(parsed.year).toBe(2026);
    expect(parsed.attribution).toBe(
      'Imagery: GPI Geospatial, Inc. via ArcGIS (January 27, 2026 through February 2, 2026)',
    );
    expect(parsed.maxSize).toEqual([2048, 2048]);
  });

  it('parses the live FDEP 2018 ImageServer metadata in Florida GDL Albers', () => {
    const fdep = parseArcGisService(
      'https://ca.dep.state.fl.us/image/rest/services/FDOT_Yearly_Aerials/Aerial_Imagery_2018/ImageServer',
      {
        name: 'FDOT_Yearly_Aerials/Aerial_Imagery_2018',
        copyright: 'FDEP',
        fullExtent: {
          xmin: 328952.287,
          ymin: 58482.538,
          xmax: 792824.296,
          ymax: 743538.596,
          spatialReference: { wkid: 3087 },
        },
        spatialReference: { wkid: 3087 },
        maxImageWidth: 15000,
        maxImageHeight: 4100,
        pixelSizeX: 0.0762,
        pixelSizeY: 0.0762,
      },
    );
    expect(fdep.kind).toBe('imageserver-export');
    expect(fdep.year).toBe(2018);
    expect(fdep.attribution).toBe('Imagery: FDEP via ArcGIS (2018)');
    expect(fdep.coverage.west).toBeLessThan(-9_000_000);
    expect(fdep.coverage.east).toBeLessThan(-8_000_000);
  });

  it('plans Web Mercator export requests within service limits and resolution', () => {
    const requests = planServiceRequests(
      { west: 0, south: 0, east: 500, north: 500 },
      0.1,
      [2048, 2048],
      0.0762,
    );
    expect(requests.length).toBeGreaterThan(1);
    expect(requests.every((r) => r.width <= 2048 && r.height <= 2048)).toBe(true);
    expect(requests.every((r) => r.pixelSize >= 0.0762)).toBe(true);
    expect(requests.map((r) => [r.x, r.y, r.width, r.height])).toContainEqual([0, 0, 2048, 2048]);
  });

  it('derives date attribution and rejects token services or non-Web-Mercator extents', () => {
    expect(deriveImageryCredit('Local', 'City Aerials', '2023-2024')).toEqual({
      attribution: 'Imagery: City Aerials via Local (2023-2024)',
      year: 2023,
    });
    expect(() =>
      parseArcGisService('https://x.test/s/ImageServer', {
        ...martin,
        error: { code: 499, message: 'Token Required' },
      }),
    ).toThrow(/token/i);
    expect(() =>
      parseArcGisService('https://x.test/s/ImageServer', {
        ...martin,
        spatialReference: { wkid: 26917 },
        fullExtent: { ...martin.fullExtent!, spatialReference: { wkid: 26917 } },
      }),
    ).toThrow(/Unsupported service spatial reference/i);
  });

  it('flags transparent and uniform samples as blank while retaining textured imagery', () => {
    expect(isMostlyBlank([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])).toBe(true);
    expect(isMostlyBlank([255, 255, 255, 255, 255, 255, 255, 255])).toBe(true);
    expect(isMostlyBlank([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255])).toBe(false);
  });
});
