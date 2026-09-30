import { describe, expect, it } from 'vitest';
import { parseKml } from '../../../tests/metrics/xml';
import {
  ALL_DOCS,
  EMPTY,
  MIXED,
  ODD,
  OPTS,
  OVERLAY,
  POIS_ONLY,
  TRAILS_ONLY,
  expectGolden,
} from './__golden__/docs';
import type { GeoFeature, LatLon } from '../types';
import { toKml } from './kml';

const r7 = (v: number) => Number(v.toFixed(7));

describe('toKml', () => {
  it.each(Object.entries(ALL_DOCS))('%s parses as KML 2.2, with and without an overlay', (_n, doc) => {
    expect(() => parseKml(toKml(doc, OPTS, null))).not.toThrow();
    expect(() => parseKml(toKml(doc, OPTS, OVERLAY))).not.toThrow();
  });

  it('matches the golden files', () => {
    expectGolden('mixed.kml', toKml(MIXED, OPTS, null));
    expectGolden('mixed-overlay.kml', toKml(MIXED, OPTS, OVERLAY));
    expectGolden('odd.kml', toKml(ODD, { ...OPTS, units: 'km' }, null));
  });

  it('writes escaped imagery attribution and acquisition year in the document description', () => {
    const doc = {
      ...MIXED,
      imageAttribution: 'Imagery: USDA & USGS',
      acquisitionYear: 2024,
    };
    const kml = toKml(doc, OPTS, null);
    expect(kml).toContain('<description>Imagery: USDA &amp; USGS (acquired 2024)</description>');
    expect(() => parseKml(kml)).not.toThrow();
  });

  it('writes lon,lat,0 coordinates that round-trip, with a closed area ring and the overlay quad', () => {
    const expected = (f: GeoFeature): readonly LatLon[] =>
      f.kind === 'poi' ? [f.ll] : f.kind === 'area' ? [...f.ll, f.ll[0]!] : f.ll;
    const round = (ll: readonly LatLon[]) => ll.map(([a, b]) => [r7(a), r7(b)]);
    // Document order: trails folder, areas folder, points folder, overlay.
    expect(parseKml(toKml(MIXED, OPTS, OVERLAY))).toStrictEqual([
      ...MIXED.features.map((f) => round(expected(f))),
      round(OVERLAY.quad),
    ]);
    const kml = toKml(MIXED, OPTS, OVERLAY);
    expect(kml).toContain('<coordinates>-119.5581235,37.7271346,0 ');
    expect(kml).toContain(
      '<gx:LatLonQuad><coordinates>-119.5600000,37.7200000 -119.5400000,37.7200000 -119.5400000,37.7350000 -119.5600000,37.7350000</coordinates></gx:LatLonQuad>',
    );
    expect(kml).toContain('<color>ccffffff</color>');
    expect(kml).toContain('<Icon><href>files/map.jpg</href></Icon>');
  });

  it('styles features in aabbggrr with 0x55 area fill and POI icons from the table', () => {
    const kml = toKml(MIXED, OPTS, null);
    expect(kml).toContain(
      '<Style id="s-f1"><LineStyle><color>ff0F48D9</color><width>4</width></LineStyle><PolyStyle><color>550F48D9</color></PolyStyle></Style>',
    );
    expect(kml).toContain('<PolyStyle><color>55447D3A</color></PolyStyle>');
    expect(kml).toContain(
      '<Style id="s-f3"><IconStyle><color>ffB26F1F</color><scale>1.1</scale><Icon><href>https://maps.google.com/mapfiles/kml/shapes/hiker.png</href></Icon></IconStyle></Style>',
    );
    expect(kml).toContain('shapes/placemark_circle.png');
    expect(kml).toContain('<styleUrl>#s-f1</styleUrl>');
    expect(kml).toContain('<ExtendedData><Data name="type"><value>Water</value></Data></ExtendedData>');
    expect(kml).toContain('<name>Yosemite &lt;Valley&gt; &amp; &quot;Mist&quot;</name>');
  });

  it('writes only the non-empty folders', () => {
    const folders = (kml: string) => [...kml.matchAll(/<Folder><name>([^<]+)<\/name>/g)].map((m) => m[1]);
    expect(folders(toKml(MIXED, OPTS, null))).toStrictEqual(['Trails', 'Areas', 'Points of interest']);
    expect(folders(toKml(TRAILS_ONLY, OPTS, null))).toStrictEqual(['Trails']);
    expect(folders(toKml(POIS_ONLY, OPTS, null))).toStrictEqual(['Points of interest']);
    expect(folders(toKml(EMPTY, OPTS, null))).toStrictEqual([]);
    expect(toKml(EMPTY, OPTS, null)).not.toContain('GroundOverlay');
  });

  it('normalizes colors and drops XML-illegal characters', () => {
    const kml = toKml(ODD, OPTS, null);
    expect(kml).not.toContain('\u0000');
    expect(kml).not.toContain('\u0007');
    expect(kml).toContain('<color>ffCCBBAA</color>');
    // Invalid POI color falls back to the POI default #1F6FB2.
    expect(kml).toContain('<color>ffB26F1F</color>');
  });
});
