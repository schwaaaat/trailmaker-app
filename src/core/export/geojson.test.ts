import { describe, expect, it } from 'vitest';
import { ALL_DOCS, EMPTY, MIXED, ODD, OPTS, OPTS_KM, expectGolden } from './__golden__/docs';
import { geoJsonParts, toGeoJson } from './geojson';

describe('toGeoJson', () => {
  it('matches the golden file', () => {
    expectGolden('mixed.geojson', toGeoJson(MIXED, OPTS));
  });

  it('writes an RFC 7946 FeatureCollection with [lon, lat] 7-decimal positions', () => {
    const fc = JSON.parse(toGeoJson(MIXED, OPTS));
    expect(fc.type).toBe('FeatureCollection');
    expect(fc.name).toBe(MIXED.name);
    expect(fc.features.map((f: { geometry: { type: string } }) => f.geometry.type)).toStrictEqual([
      'LineString',
      'Polygon',
      'Point',
      'Point',
    ]);
    const [trail, area, trailhead] = fc.features;
    expect(trail.geometry.coordinates[0]).toStrictEqual([-119.5581235, 37.7271346]);
    const ring = area.geometry.coordinates[0];
    expect(ring).toHaveLength(4);
    expect(ring[3]).toStrictEqual(ring[0]);
    expect(trailhead.geometry.coordinates).toStrictEqual([-119.5578, 37.7327]);
  });

  it('writes the prototype properties and omits undefined ones', () => {
    const fc = JSON.parse(toGeoJson(MIXED, OPTS_KM));
    const [trail, area, trailhead, tap] = fc.features.map((f: { properties: unknown }) => f.properties);
    expect(trail).toStrictEqual({
      name: MIXED.features[0]!.name,
      kind: 'trail',
      description: 'Steep granite steps.\nBring water.\nLength: 1.23 km',
      stroke: '#D9480F',
      length_m: 1235,
    });
    expect(area).toStrictEqual({
      name: 'Emerald Pool',
      kind: 'area',
      description: 'Perimeter: 845 m',
      stroke: '#3A7D44',
      length_m: 845,
    });
    expect(trailhead).toStrictEqual({
      name: 'Happy Isles Trailhead',
      kind: 'Trailhead',
      description: 'Shuttle stop 16',
      'marker-color': '#1F6FB2',
    });
    expect(tap).toStrictEqual({ name: 'Tap & "fountain"', kind: 'Water', 'marker-color': '#1F6FB2' });
  });

  it('writes an empty collection and keeps odd text intact (JSON escapes it)', () => {
    expect(JSON.parse(toGeoJson(EMPTY, OPTS)).features).toStrictEqual([]);
    const fc = JSON.parse(toGeoJson(ODD, OPTS));
    expect(fc.features[0].properties.name).toBe('Tab\tand bell\u0007');
    expect(fc.features[1].geometry.coordinates).toStrictEqual([0, -1e-7]);
  });
});

describe('geoJsonParts (T-211)', () => {
  it.each(Object.entries(ALL_DOCS))(
    '%s joins to exactly JSON.stringify(collection, null, 1)',
    (_name, doc) => {
      const text = [...geoJsonParts(doc, OPTS)].join('');
      expect(text).toBe(JSON.stringify(JSON.parse(text), null, 1));
      expect(text).toBe(toGeoJson(doc, OPTS));
    },
  );

  it('yields a head, one part per feature and a tail; newlines in names stay escaped', () => {
    const doc = { ...MIXED, name: 'Line\nbreak "q"' };
    const parts = [...geoJsonParts(doc, OPTS)];
    expect(parts).toHaveLength(MIXED.features.length + 2);
    const text = parts.join('');
    expect(JSON.parse(text).name).toBe('Line\nbreak "q"');
    expect(text).toBe(JSON.stringify(JSON.parse(text), null, 1));
  });
});
