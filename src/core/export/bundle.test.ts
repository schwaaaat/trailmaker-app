import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import type { ExportDocument, GeoFeature } from '../types';
import { BUNDLE_CHUNK_BYTES, buildExportZip, exportZipSteps } from './bundle';
import { EMPTY, MIXED, OPTS, OVERLAY } from './__golden__/docs';
import { toGeoJson } from './geojson';
import { toGpx } from './gpx';
import { toKml } from './kml';
import { buildKmz } from './kmz';

describe('buildExportZip', () => {
  it('bundles GPX, KML (no overlay), the given KMZ and GeoJSON under the slugged name', () => {
    const kmz = buildKmz({
      doc: MIXED,
      options: OPTS,
      overlayImage: { bytes: new Uint8Array([1, 2, 3]), ext: 'jpg' },
      quad: OVERLAY.quad,
    });
    const files = unzipSync(buildExportZip(MIXED, OPTS, kmz));
    expect(Object.keys(files)).toStrictEqual([
      'yosemite-valley-mist.gpx',
      'yosemite-valley-mist.kml',
      'yosemite-valley-mist.kmz',
      'yosemite-valley-mist.geojson',
    ]);
    expect(strFromU8(files['yosemite-valley-mist.gpx']!)).toBe(toGpx(MIXED, OPTS));
    expect(strFromU8(files['yosemite-valley-mist.kml']!)).toBe(toKml(MIXED, OPTS, null));
    expect(files['yosemite-valley-mist.kmz']).toStrictEqual(kmz);
    expect(strFromU8(files['yosemite-valley-mist.geojson']!)).toBe(toGeoJson(MIXED, OPTS));
  });

  it('is deterministic and falls back to park-map for an unusable name', () => {
    const kmz = new Uint8Array([9]);
    const a = buildExportZip({ ...EMPTY, name: '!!!' }, OPTS, kmz);
    expect(a).toStrictEqual(buildExportZip({ ...EMPTY, name: '!!!' }, OPTS, kmz));
    expect(Object.keys(unzipSync(a))[0]).toBe('park-map.gpx');
  });
});

describe('exportZipSteps (T-211)', () => {
  const big: ExportDocument = {
    name: 'Big park',
    features: Array.from(
      { length: 400 },
      (_, i): GeoFeature => ({
        kind: 'trail',
        id: `t${i}`,
        name: `Trail ${i}`,
        color: '#D9480F',
        notes: '',
        ink: null,
        pts: [],
        ll: Array.from({ length: 50 }, (_, k) => [37 + i * 1e-4 + k * 1e-6, -119 - k * 1e-6] as const),
        lengthM: 100 + i,
      }),
    ),
  };

  it('takes many small steps, never deflating more than a chunk per step, and matches buildExportZip', () => {
    const kmz = new Uint8Array(3 * BUNDLE_CHUNK_BYTES + 5).map((_, i) => i % 251);
    const steps = exportZipSteps(big, OPTS, kmz);
    let n = 0;
    let r = steps.next();
    for (; !r.done; r = steps.next()) n++;
    // At least one step per feature per text file, plus the stored KMZ in 4 chunks.
    expect(n).toBeGreaterThan(3 * big.features.length + 4);
    expect(r.value).toStrictEqual(buildExportZip(big, OPTS, kmz));
    const files = unzipSync(r.value);
    expect(strFromU8(files['big-park.gpx']!)).toBe(toGpx(big, OPTS));
    expect(strFromU8(files['big-park.kml']!)).toBe(toKml(big, OPTS, null));
    expect(strFromU8(files['big-park.geojson']!)).toBe(toGeoJson(big, OPTS));
    expect(files['big-park.kmz']).toStrictEqual(kmz);
  });
});
