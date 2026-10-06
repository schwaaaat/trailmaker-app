// Lane B. Port of prototype Core.geojson.
import type { ExportDocument, ExportOptions, GeoFeature, LatLon } from '../types';
import { featureColor, featureDescription, geometryPath } from './format';

const pos = ([lat, lon]: LatLon): [number, number] => [+lon.toFixed(7), +lat.toFixed(7)];

function geoJsonFeature(f: GeoFeature, opts: ExportOptions) {
  const isPoi = f.kind === 'poi';
  // JSON.stringify omits the undefined properties, as in the prototype.
  const properties = {
    name: f.name,
    kind: isPoi ? f.poiType : f.kind,
    route: f.kind === 'trail' && f.route ? f.route.kind : undefined,
    direction: f.kind === 'trail' && f.route && f.route.kind === 'loop' ? f.route.direction : undefined,
    description: featureDescription(f, opts.units) || undefined,
    stroke: isPoi ? undefined : featureColor(f),
    'marker-color': isPoi ? featureColor(f) : undefined,
    length_m: isPoi ? undefined : Math.round(f.lengthM),
  };
  const geometry =
    f.kind === 'poi'
      ? { type: 'Point', coordinates: pos(f.ll) }
      : f.kind === 'trail'
        ? { type: 'LineString', coordinates: f.ll.map(pos) }
        : { type: 'Polygon', coordinates: [geometryPath(f).map(pos)] };
  return { type: 'Feature', properties, geometry };
}

/**
 * The GeoJSON text as a sequence of strings (the head, one per feature, the tail), identical when
 * joined to `JSON.stringify(collection, null, 1)`. Lets the app build a download in time slices
 * (card T-211); toGeoJson joins them.
 */
export function* geoJsonParts(
  doc: ExportDocument,
  opts: ExportOptions,
): Generator<string, void, undefined> {
  const head = JSON.stringify({ type: 'FeatureCollection', name: doc.name }, null, 1);
  // Reopen the object after "name" to append the features member.
  const open = head.slice(0, -2) + ',\n "features": ';
  if (!doc.features.length) {
    yield open + '[]\n}';
    return;
  }
  yield open + '[\n';
  const last = doc.features.length - 1;
  for (let i = 0; i <= last; i++) {
    // A feature sits two levels deep (one space each). JSON.stringify escapes newlines inside
    // strings, so every raw newline is structure and takes the indent.
    const text = JSON.stringify(geoJsonFeature(doc.features[i]!, opts), null, 1);
    yield '  ' + text.replace(/\n/g, '\n  ') + (i < last ? ',\n' : '\n');
  }
  yield ' ]\n}';
}

/** RFC 7946 FeatureCollection with simplestyle properties (stroke, marker-color). */
export function toGeoJson(doc: ExportDocument, opts: ExportOptions): string {
  let out = '';
  for (const part of geoJsonParts(doc, opts)) out += part;
  return out;
}
