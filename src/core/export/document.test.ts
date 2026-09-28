import { describe, expect, it } from 'vitest';
import { haversine } from '../geo/distance';
import { fitAnchors } from '../geo/fit';
import { PROJECT_VERSION, type Anchor, Feature, GeoFit, LatLon, Project, Px } from '../types';
import { validateGpx } from '../../../tests/metrics/xml';
import { exportDocumentSteps, toExportDocument } from './document';
import { drain } from './steps';
import { toGpx } from './gpx';

// Real T-101 fit and T-102 distance: toExportDocument is wiring, checked end to end.

// Pixels map linearly to lat/lon, so an affine fit reproduces it exactly.
const truth = ([x, y]: Px): LatLon => [37.7 - y * 1e-5, -119.6 + x * 1e-5];
const corners: Px[] = [
  [0, 0],
  [100, 0],
  [100, 100],
  [0, 100],
];
const anchors: Anchor[] = corners.map((px, i) => ({ id: `g${i}`, px, ll: truth(px), source: 'paste' }));
const fitResult = fitAnchors(anchors, 100, 100, 'affine');
if (!fitResult.ok) throw new Error('fixture fit failed');
const FIT: GeoFit = fitResult;
const near = (ll: readonly LatLon[]) => ll.map(([a, b]) => [+a.toFixed(9), +b.toFixed(9)]);

const trail = (id: string, pts: Px[]): Feature => ({
  kind: 'trail',
  id,
  name: id,
  color: '#D9480F',
  notes: '',
  pts,
  ink: null,
});
const poi = (id: string, at: Px): Feature => ({
  kind: 'poi',
  id,
  name: id,
  color: '#1F6FB2',
  notes: 'n',
  at,
  poiType: 'Parking',
});
const area = (id: string): Feature => ({
  kind: 'area',
  id,
  name: id,
  color: '#3A7D44',
  notes: '',
  pts: [
    [0, 0],
    [10, 0],
    [10, 10],
  ],
});

function project(features: Feature[], name = 'Loop park'): Project {
  return {
    version: PROJECT_VERSION,
    name,
    image: {
      fileName: 'map',
      width: 100,
      height: 100,
      originalWidth: 100,
      originalHeight: 100,
      source: { kind: 'image', mimeType: 'image/png' },
      sha256: '0'.repeat(64),
    },
    anchors: [],
    fitMethod: 'auto',
    features,
    units: 'mi',
    trace: { smartFollow: true, tolerance: 60, ink: null },
    autoTrace: { chips: [], gapPx: 24, minLengthPct: 4 },
    seq: 1,
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('toExportDocument', () => {
  it('orders trails, areas, POIs (each in creation order) and resolves lat/lon and lengths', () => {
    const p = project([
      poi('p1', [1, 2]),
      area('a1'),
      trail('t1', [
        [0, 0],
        [3, 4],
      ]),
      poi('p2', [5, 6]),
      trail('t2', [
        [7, 8],
        [9, 10],
        [11, 12],
      ]),
    ]);
    const doc = toExportDocument(p, FIT);
    expect(doc.name).toBe('Loop park');
    expect(doc.features.map((f) => f.id)).toStrictEqual(['t1', 't2', 'a1', 'p1', 'p2']);
    const [t1, t2, a1, p1] = doc.features;
    if (t1?.kind !== 'trail' || a1?.kind !== 'area' || p1?.kind !== 'poi') throw new Error('kinds');
    const { ll: t1ll, lengthM: t1len, ...t1rest } = t1;
    expect(t1rest).toStrictEqual(p.features[2]);
    expect(t1len).toBeCloseTo(haversine(truth([0, 0]), truth([3, 4])), 6);
    expect(near(t1ll)).toStrictEqual(near([truth([0, 0]), truth([3, 4])]));
    if (t2?.kind !== 'trail') throw new Error('kinds');
    expect(t2.lengthM).toBeCloseTo(haversine(t2.ll[0]!, t2.ll[1]!) + haversine(t2.ll[1]!, t2.ll[2]!), 9);
    // Areas: open ring in ll (writers close it), measured closed (perimeter).
    expect(near(a1.ll)).toStrictEqual(near(a1.pts.map(truth)));
    const [a, b, c] = a1.ll as [LatLon, LatLon, LatLon];
    expect(a1.lengthM).toBeCloseTo(haversine(a, b) + haversine(b, c) + haversine(c, a), 9);
    // Independent sanity check: 10 px = 1e-4 deg, so ~8.8 m east, ~11.1 m south, ~14.2 m back.
    expect(a1.lengthM).toBeGreaterThan(33);
    expect(a1.lengthM).toBeLessThan(35);
    const { ll: p1ll, ...p1rest } = p1;
    expect(p1rest).toStrictEqual(p.features[0]);
    expect(near([p1ll])).toStrictEqual(near([truth([1, 2])]));
    expect('lengthM' in p1).toBe(false);
  });

  it('names an unnamed project "Park map" (prototype)', () => {
    expect(toExportDocument(project([], ''), FIT)).toStrictEqual({ name: 'Park map', features: [] });
  });

  it('feeds the writers: project -> fit -> GPX valid against the XSD', () => {
    const doc = toExportDocument(
      project([area('a1'), trail('t1', [[0, 0], [50, 50], [99, 20]]), poi('p1', [4, 4])]),
      FIT,
    );
    const gpx = toGpx(doc, { units: 'km', time: '2026-09-24T12:00:00.000Z' });
    expect(validateGpx(gpx)).toBe(true);
    expect(gpx).toContain('<trkpt lat="37.7000000" lon="-119.6000000"/>');
  });
});

describe('exportDocumentSteps (T-211)', () => {
  it('yields once per feature and returns what toExportDocument returns', () => {
    const p = project([trail('t1', [[0, 0], [10, 10]]), poi('p1', [5, 5]), area('a1')]);
    const steps = exportDocumentSteps(p, FIT);
    let n = 0;
    let r = steps.next();
    for (; !r.done; r = steps.next()) n++;
    expect(n).toBe(p.features.length);
    expect(r.value).toStrictEqual(toExportDocument(p, FIT));
    expect(drain(exportDocumentSteps(p, FIT))).toStrictEqual(r.value);
  });
});
