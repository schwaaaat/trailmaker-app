// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  parseGpx,
  MAX_DISPLAY_POINTS,
  LARGE_POINT_COUNT_THRESHOLD,
  LARGE_FILE_THRESHOLD_BYTES,
  FAST_GPX_THRESHOLD_BYTES,
  hasXmlIncompatibilities,
  decodeXmlEntities,
  cleanTagText,
} from './gpx';

describe('GPX Parser (card T-312)', () => {
  const SAMPLE_GPX_1_1 = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Test App" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata>
    <name>Park Survey</name>
  </metadata>
  <wpt lat="38.5971" lon="-78.3952">
    <name>Trailhead Marker</name>
    <desc>Parking lot entrance</desc>
    <ele>450.5</ele>
    <time>2026-05-01T10:00:00Z</time>
  </wpt>
  <wpt lat="38.6010" lon="-78.3900">
    <name>Summit Vista</name>
  </wpt>
  <rte>
    <name>Ridge Loop</name>
    <rtept lat="38.5980" lon="-78.3940">
      <name>Junction 1</name>
    </rtept>
    <rtept lat="38.5990" lon="-78.3930" />
  </rte>
  <trk>
    <name>Main Creek Trail</name>
    <trkseg>
      <trkpt lat="38.5975" lon="-78.3950">
        <name>Bridge Crossing</name>
      </trkpt>
      <trkpt lat="38.5978" lon="-78.3945">
        <ele>455.0</ele>
      </trkpt>
      <trkpt lat="38.5982" lon="-78.3941" />
    </trkseg>
  </trk>
</gpx>`;

  const SAMPLE_GPX_1_0 = `<?xml version="1.0" encoding="ISO-8859-1"?>
<gpx version="1.0" creator="Old GPS Device" xmlns="http://www.topografix.com/GPX/1/0">
  <name>Old Track</name>
  <wpt lat="37.7749" lon="-122.4194">
    <name>Old Landmark</name>
  </wpt>
  <trk>
    <name>Path 10</name>
    <trkseg>
      <trkpt lat="37.7750" lon="-122.4190" />
      <trkpt lat="37.7755" lon="-122.4185" />
    </trkseg>
  </trk>
</gpx>`;

  it('parses GPX 1.1 with waypoints, routes, and tracks', () => {
    const res = parseGpx(SAMPLE_GPX_1_1, 'survey.gpx');
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.fileName).toBe('survey.gpx');
    expect(res.totalPointsInFile).toBe(7);
    expect(res.wasDecimated).toBe(false);

    // Waypoints
    const wpts = res.points.filter((p) => p.kind === 'wpt');
    expect(wpts).toHaveLength(2);
    expect(wpts[0]!.name).toBe('Trailhead Marker');
    expect(wpts[0]!.ll).toEqual([38.5971, -78.3952]);
    expect(wpts[0]!.desc).toBe('Parking lot entrance');
    expect(wpts[0]!.ele).toBe(450.5);
    expect(wpts[0]!.time).toBe('2026-05-01T10:00:00Z');

    expect(wpts[1]!.name).toBe('Summit Vista');

    // Route points
    const rtepts = res.points.filter((p) => p.kind === 'rtept');
    expect(rtepts).toHaveLength(2);
    expect(rtepts[0]!.name).toBe('Junction 1');
    expect(rtepts[1]!.name).toBe('Ridge Loop pt 2');

    // Track points
    const trkpts = res.points.filter((p) => p.kind === 'trkpt');
    expect(trkpts).toHaveLength(3);
    expect(trkpts[0]!.name).toBe('Bridge Crossing');
    expect(trkpts[1]!.name).toBe('Main Creek Trail pt 2');
    expect(trkpts[1]!.ele).toBe(455.0);
    expect(trkpts[2]!.name).toBe('Main Creek Trail pt 3');

    // Polylines
    expect(res.tracks).toHaveLength(2);
    expect(res.tracks[0]!.name).toBe('Ridge Loop');
    expect(res.tracks[0]!.points).toHaveLength(2);
    expect(res.tracks[1]!.name).toBe('Main Creek Trail');
    expect(res.tracks[1]!.points).toHaveLength(3);
  });

  it('parses GPX 1.0 successfully', () => {
    const res = parseGpx(SAMPLE_GPX_1_0, 'old.gpx');
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.points).toHaveLength(3);
    const wpt = res.points.find((p) => p.kind === 'wpt');
    expect(wpt?.name).toBe('Old Landmark');
    expect(wpt?.ll).toEqual([37.7749, -122.4194]);

    const trkpts = res.points.filter((p) => p.kind === 'trkpt');
    expect(trkpts).toHaveLength(2);
    expect(trkpts[0]!.name).toBe('Path 10 pt 1');
  });

  it('handles unnamespaced GPX XML', () => {
    const xml = `<gpx><wpt lat="10.5" lon="20.5"><name>Unnamespaced</name></wpt></gpx>`;
    const res = parseGpx(xml);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.points).toHaveLength(1);
    expect(res.points[0]!.name).toBe('Unnamespaced');
  });

  it('safely handles empty or whitespace input without throwing', () => {
    expect(parseGpx('')).toEqual({ ok: false, error: 'The GPX file is empty.' });
    expect(parseGpx('   \n  \t ')).toEqual({ ok: false, error: 'The GPX file is empty.' });
  });

  it('safely handles malformed XML without throwing', () => {
    const badXml = `<gpx><wpt lat="10" lon="20"><name>Unclosed</wpt>`;
    const res = parseGpx(badXml);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/Invalid GPX file/i);
  });

  it('rejects XML documents that are not GPX', () => {
    const svgXml = `<svg xmlns="http://www.w3.org/2000/svg"><circle cx="5" cy="5" r="5"/></svg>`;
    const res = parseGpx(svgXml);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/root element must be <gpx>/i);
  });

  it('rejects GPX with zero valid coordinates', () => {
    const xml = `<gpx><wpt notlat="abc" notlon="xyz"><name>Broken</name></wpt></gpx>`;
    const res = parseGpx(xml);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/No valid waypoints/i);
  });

  it(
    'decimates files exceeding the 50k point threshold',
    () => {
      const pointCount = LARGE_POINT_COUNT_THRESHOLD + 100;
      // Build a synthetic GPX with 2 waypoints and >50k trackpoints
      let body = '<gpx version="1.1"><wpt lat="1" lon="1"><name>Important Landmark</name></wpt><trk><trkseg>';
      for (let i = 0; i < pointCount; i++) {
        body += `<trkpt lat="${(i * 0.0001).toFixed(5)}" lon="0" />`;
      }
      body += '</trkseg></trk></gpx>';

      const res = parseGpx(body, 'huge.gpx');
      expect(res.ok).toBe(true);
      if (!res.ok) return;

      expect(res.wasDecimated).toBe(true);
      expect(res.totalPointsInFile).toBe(pointCount + 1);
      expect(res.points.length).toBeLessThanOrEqual(MAX_DISPLAY_POINTS);
      expect(res.notice).toContain('decimated');

      // Waypoint must still be preserved
      const wpt = res.points.find((p) => p.kind === 'wpt');
      expect(wpt).toBeDefined();
      expect(wpt?.name).toBe('Important Landmark');
    },
    15000,
  );

  it('decimates files exceeding the 10 MB threshold even with moderate point count', () => {
    // 5000 points with fileSizeBytes passed as >10 MB
    let body = '<gpx version="1.1"><trk><trkseg>';
    for (let i = 0; i < 5000; i++) {
      body += `<trkpt lat="${(i * 0.001).toFixed(4)}" lon="0" />`;
    }
    body += '</trkseg></trk></gpx>';

    const res = parseGpx(body, 'heavy.gpx', LARGE_FILE_THRESHOLD_BYTES + 1024);
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.wasDecimated).toBe(true);
    expect(res.totalPointsInFile).toBe(5000);
    expect(res.notice).toBeDefined();
  });
});

describe('GPX Fast Path Differential Parity (T-313 Review)', () => {
  const CORPUS: Record<string, string> = {
    'standard-1.1': `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Survey" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><name>Survey Track</name></metadata>
  <wpt lat="38.5971" lon="-78.3952">
    <name>Trailhead Marker</name>
    <desc>Parking lot entrance</desc>
    <ele>450.5</ele>
    <time>2026-05-01T10:00:00Z</time>
  </wpt>
  <wpt lat="38.6010" lon="-78.3900">
    <name>Summit Vista</name>
  </wpt>
  <rte>
    <name>Ridge Loop</name>
    <rtept lat="38.5980" lon="-78.3940">
      <name>Junction 1</name>
    </rtept>
    <rtept lat="38.5990" lon="-78.3930" />
  </rte>
  <trk>
    <name>Main Creek Trail</name>
    <trkseg>
      <trkpt lat="38.5975" lon="-78.3950">
        <name>Bridge Crossing</name>
      </trkpt>
      <trkpt lat="38.5978" lon="-78.3945">
        <ele>455.0</ele>
      </trkpt>
      <trkpt lat="38.5982" lon="-78.3941" />
    </trkseg>
  </trk>
</gpx>`,

    'standard-1.0': `<?xml version="1.0" encoding="ISO-8859-1"?>
<gpx version="1.0" creator="Old GPS Device" xmlns="http://www.topografix.com/GPX/1/0">
  <name>Old Track</name>
  <wpt lat="37.7749" lon="-122.4194">
    <name>Old Landmark</name>
  </wpt>
  <trk>
    <name>Path 10</name>
    <trkseg>
      <trkpt lat="37.7750" lon="-122.4190" />
      <trkpt lat="37.7755" lon="-122.4185" />
    </trkseg>
  </trk>
</gpx>`,

    'xml-entities': `<gpx version="1.1">
  <wpt lat="38.5000" lon="-78.5000">
    <name>Fox &amp; Hollow &quot;Overlook&quot; &apos;Summit&apos;</name>
    <desc>&lt;Scenic Area&gt; &#65;&#x42;</desc>
    <ele>500.25</ele>
    <time>2026-05-01T10:00:00Z</time>
  </wpt>
  <rte>
    <name>A &amp; B Route</name>
    <rtept lat="38.5100" lon="-78.5100">
      <name>Waypoint &amp; Checkpoint</name>
    </rtept>
  </rte>
  <trk>
    <name>Tom &amp; Jerry Trail</name>
    <trkseg>
      <trkpt lat="38.5200" lon="-78.5200">
        <name>Point &lt;A&gt; &amp; &lt;B&gt;</name>
        <desc>Rocky &amp; Steep</desc>
      </trkpt>
    </trkseg>
  </trk>
</gpx>`,

    cdata: `<gpx version="1.1">
  <wpt lat="38.1000" lon="-78.1000">
    <name><![CDATA[Ridge <North> & Spur]]></name>
    <desc><![CDATA[Detailed description with <b>bold</b> and &amp; entities]]></desc>
  </wpt>
  <rte>
    <name><![CDATA[Route with <special> characters]]></name>
    <rtept lat="38.2000" lon="-78.2000">
      <name><![CDATA[Checkpoint #1 & Star]]></name>
    </rtept>
  </rte>
  <trk>
    <name><![CDATA[Track with [CDATA]]]></name>
    <trkseg>
      <trkpt lat="38.3000" lon="-78.3000">
        <desc><![CDATA[Point desc in CDATA]]></desc>
      </trkpt>
    </trkseg>
  </trk>
</gpx>`,

    comments: `<!-- Root comment containing fake <wpt lat="99.999" lon="99.999"><name>Hidden Phantom</name></wpt> -->
<gpx version="1.1">
  <!-- Comment before wpt -->
  <wpt lat="38.3000" lon="-78.3000">
    <name>Real Waypoint</name>
  </wpt>
  <!-- Comment between elements <trk><trkseg><trkpt lat="88.88" lon="88.88"/></trkseg></trk> -->
  <trk>
    <name>Real Track</name>
    <!-- Comment inside track before trkseg -->
    <trkseg>
      <!-- Comment inside trkseg -->
      <trkpt lat="38.4000" lon="-78.4000">
        <name>Real Point 1</name>
      </trkpt>
      <!-- Comment between points <trkpt lat="77.77" lon="77.77"><name>Ghost</name></trkpt> -->
      <trkpt lat="38.4500" lon="-78.4500" />
    </trkseg>
  </trk>
</gpx>`,

    'namespace-prefixes': `<gpx:gpx version="1.1" xmlns:gpx="http://www.topografix.com/GPX/1/1">
  <gpx:wpt lat="38.6000" lon="-78.6000">
    <gpx:name>Prefixed Waypoint</gpx:name>
    <gpx:desc>Prefixed Desc</gpx:desc>
    <gpx:ele>100.5</gpx:ele>
    <gpx:time>2026-05-01T12:00:00Z</gpx:time>
  </gpx:wpt>
  <gpx:rte>
    <gpx:name>Prefixed Route</gpx:name>
    <gpx:rtept lat="38.6500" lon="-78.6500">
      <gpx:name>Prefixed Rte Pt</gpx:name>
    </gpx:rtept>
  </gpx:rte>
  <gpx:trk>
    <gpx:name>Prefixed Track</gpx:name>
    <gpx:trkseg>
      <gpx:trkpt lat="38.7000" lon="-78.7000">
        <gpx:name>Prefixed Trk Pt</gpx:name>
      </gpx:trkpt>
    </gpx:trkseg>
  </gpx:trk>
</gpx:gpx>`,

    'spaced-attributes': `<gpx version="1.1">
  <wpt lat = "38.8000" lon = "-78.8000" >
    <name>Spaced Wpt</name>
  </wpt>
  <rte>
    <name>Spaced Rte</name>
    <rtept lat= '38.8500' lon= '-78.8500' />
  </rte>
  <trk>
    <name>Spaced Trk</name>
    <trkseg>
      <trkpt lat ="38.9000" lon ="-78.9000" />
    </trkseg>
  </trk>
</gpx>`,

    'multi-segment-track': `<gpx version="1.1">
  <trk>
    <name>Single Segment Track</name>
    <trkseg>
      <trkpt lat="38.1000" lon="-78.1000" />
      <trkpt lat="38.1500" lon="-78.1500" />
    </trkseg>
  </trk>
  <trk>
    <name>Multi Segment Track</name>
    <trkseg>
      <trkpt lat="38.2000" lon="-78.2000" />
    </trkseg>
    <trkseg>
      <trkpt lat="38.3000" lon="-78.3000" />
      <trkpt lat="38.3500" lon="-78.3500" />
    </trkseg>
  </trk>
</gpx>`,

    'comprehensive-mixed': `<!-- Top-level comment with fake <wpt lat="0" lon="0"/> -->
<gpx:gpx version="1.1" xmlns:gpx="http://www.topografix.com/GPX/1/1">
  <gpx:wpt lat = "38.9100" lon = "-78.9100">
    <gpx:name><![CDATA[Fox & Hollow]]></gpx:name>
    <gpx:desc>Near &quot;Old Mill&quot; &amp; Pond</gpx:desc>
    <gpx:ele>250.0</gpx:ele>
    <gpx:time>2026-05-01T15:30:00Z</gpx:time>
  </gpx:wpt>
  <!-- Comment between wpt and trk -->
  <gpx:trk>
    <gpx:name>Big Loop &amp; Summit</gpx:name>
    <gpx:trkseg>
      <gpx:trkpt lat= '38.9200' lon= '-78.9200'>
        <gpx:name><![CDATA[Point 1 <Start>]]></gpx:name>
        <gpx:ele>260.5</gpx:ele>
      </gpx:trkpt>
      <!-- Comment inside trkseg with fake <trkpt lat="99" lon="99"/> -->
      <gpx:trkpt lat ="38.9300" lon ="-78.9300" />
    </gpx:trkseg>
    <gpx:trkseg>
      <gpx:trkpt lat="38.9400" lon="-78.9400" />
    </gpx:trkseg>
  </gpx:trk>
</gpx:gpx>`,
  };

  for (const [name, xml] of Object.entries(CORPUS)) {
    it(`produces deep-equal parity between fast and dom engines for ${name}`, () => {
      const fastResult = parseGpx(xml, { fileName: `${name}.gpx`, forceEngine: 'fast' });
      const domResult = parseGpx(xml, { fileName: `${name}.gpx`, forceEngine: 'dom' });

      expect(fastResult.ok).toBe(true);
      expect(domResult.ok).toBe(true);
      if (!fastResult.ok || !domResult.ok) return;

      expect(fastResult).toEqual(domResult);
    });
  }

  describe('dispatch and XML incompatibility detection', () => {
    it('exports FAST_GPX_THRESHOLD_BYTES as 250,000', () => {
      expect(FAST_GPX_THRESHOLD_BYTES).toBe(250_000);
    });

    it('detects XML incompatibilities accurately', () => {
      expect(hasXmlIncompatibilities('<gpx><wpt lat="1" lon="2"/></gpx>')).toBe(false);
      expect(hasXmlIncompatibilities('<gpx><name>Fox &amp; Hollow</name></gpx>')).toBe(true);
      expect(hasXmlIncompatibilities('<gpx><name><![CDATA[test]]></name></gpx>')).toBe(true);
      expect(hasXmlIncompatibilities('<!-- comment --><gpx/>')).toBe(true);
      expect(hasXmlIncompatibilities('<gpx:gpx><gpx:wpt lat="1" lon="2"/></gpx:gpx>')).toBe(true);
      expect(hasXmlIncompatibilities('<gpx><wpt lat = "1" lon = "2"/></gpx>')).toBe(true);
      expect(hasXmlIncompatibilities('<gpx><wpt lat= "1" lon="2"/></gpx>')).toBe(true);
      expect(hasXmlIncompatibilities('<gpx><wpt lat="1" lon= "2"/></gpx>')).toBe(true);
    });

    it('decodes XML entities helper properly', () => {
      expect(decodeXmlEntities('A &amp; B &lt;C&gt; &quot;D&quot; &apos;E&apos; &#65; &#x42;')).toBe(
        'A & B <C> "D" \'E\' A B',
      );
      expect(decodeXmlEntities('plain string')).toBe('plain string');
    });

    it('cleans tag text with CDATA and entities properly', () => {
      expect(cleanTagText('<![CDATA[Fox & Hollow]]>')).toBe('Fox & Hollow');
      expect(cleanTagText('  Fox &amp; Hollow  ')).toBe('Fox & Hollow');
      expect(cleanTagText('<![CDATA[Trail <North>]]> &amp; Loop')).toBe('Trail <North> & Loop');
    });

    it('dispatches to fast parser for clean files exceeding FAST_GPX_THRESHOLD_BYTES', () => {
      const cleanSmall = `<gpx version="1.1"><trk><trkseg><trkpt lat="38.0" lon="-78.0"/></trkseg></trk></gpx>`;
      // Force threshold byte size via fileSizeBytes option
      const res = parseGpx(cleanSmall, { fileSizeBytes: FAST_GPX_THRESHOLD_BYTES + 10 });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.points).toHaveLength(1);
    });

    it('falls back to DOMParser when file exceeds threshold but contains XML entities', () => {
      const entityXml = `<gpx version="1.1"><wpt lat="38.0" lon="-78.0"><name>Fox &amp; Hollow</name></wpt></gpx>`;
      // With byte size > FAST_GPX_THRESHOLD_BYTES, it falls back to DOMParser because of &amp;
      const res = parseGpx(entityXml, { fileSizeBytes: FAST_GPX_THRESHOLD_BYTES + 10 });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.points[0]!.name).toBe('Fox & Hollow');
    });

    it('falls back to DOMParser when file exceeds threshold but contains comments', () => {
      const commentXml = `<!-- comment with <wpt lat="99" lon="99"/> --><gpx version="1.1"><wpt lat="38.0" lon="-78.0"/></gpx>`;
      const res = parseGpx(commentXml, { fileSizeBytes: FAST_GPX_THRESHOLD_BYTES + 10 });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.points).toHaveLength(1);
      expect(res.points[0]!.ll).toEqual([38.0, -78.0]);
    });

    it('honors explicit forceEngine overrides', () => {
      const xml = `<gpx version="1.1"><wpt lat="38.0" lon="-78.0"><name>Test</name></wpt></gpx>`;
      const fast = parseGpx(xml, { forceEngine: 'fast' });
      const dom = parseGpx(xml, { forceEngine: 'dom' });
      expect(fast.ok).toBe(true);
      expect(dom.ok).toBe(true);
      expect(fast).toEqual(dom);
    });
  });
});
