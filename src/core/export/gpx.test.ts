import { describe, expect, it } from 'vitest';
import { validateGpx } from '../../../tests/metrics/xml';
import { ALL_DOCS, MIXED, ODD, OPTS, OPTS_KM, POIS_ONLY, TRAIL, expectGolden } from './__golden__/docs';
import { gpxParts, toGpx } from './gpx';

const trkpts = (gpx: string) =>
  [...gpx.matchAll(/<trkpt lat="([^"]+)" lon="([^"]+)"\/>/g)].map((m) => [m[1], m[2]]);

describe('toGpx', () => {
  it.each(Object.entries(ALL_DOCS))('%s validates against the GPX 1.1 XSD', (_name, doc) => {
    expect(validateGpx(toGpx(doc, OPTS))).toBe(true);
    expect(validateGpx(toGpx(doc, OPTS_KM))).toBe(true);
  });

  it('matches the golden files', () => {
    expectGolden('mixed.gpx', toGpx(MIXED, OPTS));
    expectGolden('odd-km.gpx', toGpx(ODD, OPTS_KM));
  });

  it('is deterministic and takes <time> from opts', () => {
    const a = toGpx(MIXED, OPTS);
    expect(toGpx(MIXED, OPTS)).toBe(a);
    expect(a).toContain(`<time>${OPTS.time}</time>`);
    expect(toGpx(MIXED, { ...OPTS, time: '2027-01-01T00:00:00.000Z' })).not.toBe(a);
  });

  it('writes waypoints before tracks, with the POI table sym and type', () => {
    const gpx = toGpx(MIXED, OPTS);
    expect(gpx.indexOf('<wpt')).toBeLessThan(gpx.indexOf('<trk>'));
    expect(gpx).toContain(
      '<wpt lat="37.7327000" lon="-119.5578000"><name>Happy Isles Trailhead</name><desc>Shuttle stop 16</desc><sym>Trailhead</sym><type>Trailhead</type></wpt>',
    );
    // No notes: no <desc>.
    expect(gpx).toContain(
      '<name>Tap &amp; &quot;fountain&quot;</name><sym>Drinking Water</sym><type>Water</type>',
    );
  });

  it('writes one track per trail and area, with escaped text, style color and a closed area ring', () => {
    const gpx = toGpx(MIXED, OPTS);
    expect(gpx.match(/<trk>/g)).toHaveLength(2);
    expect(gpx).toContain('<name>Mist Trail &lt;&amp;&quot;&apos;&gt; \u{1F97E}</name>');
    expect(gpx).toContain(
      '<desc>Steep granite steps.\nBring water.\nLength: 0.77 mi</desc><type>Trail</type>',
    );
    expect(gpx).toContain('<gpx_style:color>D9480F</gpx_style:color><gpx_style:width>4</gpx_style:width>');
    expect(gpx).toContain('<desc>Perimeter: 0.53 mi</desc><type>Area</type>');
    expect(gpx).toContain('<gpx_style:color>3A7D44</gpx_style:color>');
    const pts = trkpts(gpx);
    expect(pts.slice(0, 3)).toStrictEqual([
      ['37.7271346', '-119.5581235'],
      ['37.7265000', '-119.5512000'],
      ['37.7259100', '-119.5435778'],
    ]);
    const ring = pts.slice(3);
    expect(ring).toHaveLength(4);
    expect(ring[3]).toStrictEqual(ring[0]);
  });

  it('drops XML-illegal characters and normalizes colors', () => {
    const gpx = toGpx(ODD, OPTS);
    expect(gpx).not.toContain('\u0000');
    expect(gpx).not.toContain('\u0007');
    expect(gpx).toContain('<name>Tab\tand bell</name>');
    expect(gpx).toContain('<gpx_style:color>AABBCC</gpx_style:color>');
    expect(gpx).toContain('<wpt lat="-0.0000001" lon="0.0000000">');
  });

  it('writes a document with only waypoints', () => {
    const gpx = toGpx(POIS_ONLY, OPTS);
    expect(gpx).not.toContain('<trk>');
    expect(gpx.match(/<wpt /g)).toHaveLength(2);
  });

  it('includes route classification and travel direction in track descriptions', () => {
    const doc = {
      name: 'Routes',
      features: [
        {
          ...TRAIL,
          id: 'one-way-1',
          route: { kind: 'one-way' as const },
        },
        {
          ...TRAIL,
          id: 'loop-1',
          route: { kind: 'loop' as const, direction: 'clockwise' as const },
        },
      ],
    };
    const gpx = toGpx(doc, OPTS);
    expect(validateGpx(gpx)).toBe(true);
    expect(gpx).toContain('<desc>Steep granite steps.\nBring water.\nRoute: One-way\nLength: 0.77 mi</desc>');
    expect(gpx).toContain('<desc>Steep granite steps.\nBring water.\nRoute: Loop (clockwise)\nLength: 0.77 mi</desc>');
  });
});

describe('gpxParts (T-211)', () => {
  it('yields a header, one part per feature and a footer, joining to toGpx', () => {
    const parts = [...gpxParts(MIXED, OPTS)];
    expect(parts).toHaveLength(MIXED.features.length + 2);
    expect(parts.join('')).toBe(toGpx(MIXED, OPTS));
  });
});
