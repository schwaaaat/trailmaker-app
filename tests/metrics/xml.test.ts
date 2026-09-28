import { expect, test } from 'vitest';
import { parseKml, validateGpx } from './xml';

const gpx = (body: string) =>
  `<gpx xmlns="http://www.topografix.com/GPX/1/1" version="1.1" creator="Trailmaker">${body}</gpx>`;
test('GPX validates actual XSD types, ordering, required attributes and namespaces', () => {
  expect(
    validateGpx(
      gpx(
        '<wpt lat="38" lon="-78"><name>Trailhead</name></wpt><trk><name>Ridge</name><trkseg><trkpt lat="38" lon="-78"/></trkseg></trk>',
      ),
    ),
  ).toBe(true);
  expect(() => validateGpx(gpx('<wpt lat="91" lon="0"/>'))).toThrow();
  expect(() => validateGpx(gpx('<wpt lon="0"/>'))).toThrow();
  expect(() => validateGpx(gpx('<trk/><wpt lat="0" lon="0"/>'))).toThrow();
  expect(() => validateGpx(gpx('').replace('version="1.1"', 'version="1.0"'))).toThrow();
  expect(() => validateGpx('<gpx/>')).toThrow();
  expect(() => validateGpx(gpx('<broken>'))).toThrow();
});
test('KML parses coordinate groups and rejects malformed documents', () => {
  const kml = (body: string) =>
    `<kml xmlns="http://www.opengis.net/kml/2.2"><Document>${body}</Document></kml>`;
  expect(
    parseKml(
      kml(
        '<Placemark><LineString><coordinates>-78,38,0 -78.1,38.2</coordinates></LineString></Placemark>',
      ),
    ),
  ).toEqual([
    [
      [38, -78],
      [38.2, -78.1],
    ],
  ]);
  expect(() => parseKml(kml('<coordinates>nope,0</coordinates>'))).toThrow();
  expect(() => parseKml(kml('<coordinates>181,0</coordinates>'))).toThrow();
  expect(() => parseKml(kml('<broken>'))).toThrow();
  expect(() => parseKml('<other/>')).toThrow();
  expect(() => parseKml('<!DOCTYPE kml SYSTEM "https://example.com/external"><kml/>')).toThrow();
});
