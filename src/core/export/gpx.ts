// Lane B. Port of prototype Core.gpx.
import type { ExportDocument, ExportOptions } from '../types';
import { f7, featureColor, featureDescription, geometryPath, xmlEscape as esc } from './format';
import { POI_SYMBOLS } from './symbols';

const HEADER =
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<gpx version="1.1" creator="Trailmaker" xmlns="http://www.topografix.com/GPX/1/1"' +
  ' xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"' +
  ' xmlns:gpx_style="http://www.topografix.com/GPX/gpx_style/0/2"' +
  ' xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">\n';

/**
 * The GPX document as a sequence of small strings in document order: header, one <wpt> per POI,
 * one <trk> per trail/area, footer. Lets the app build a download in time slices (card T-211);
 * toGpx joins them.
 */
export function* gpxParts(doc: ExportDocument, opts: ExportOptions): Generator<string, void, undefined> {
  yield HEADER + `<metadata><name>${esc(doc.name)}</name><time>${esc(opts.time)}</time></metadata>\n`;
  // The schema puts every <wpt> before any <trk>.
  for (const f of doc.features) {
    if (f.kind !== 'poi') continue;
    const [lat, lon] = f.ll;
    const desc = f.notes ? `<desc>${esc(f.notes)}</desc>` : '';
    yield `<wpt lat="${f7(lat)}" lon="${f7(lon)}"><name>${esc(f.name)}</name>${desc}` +
      `<sym>${esc(POI_SYMBOLS[f.poiType].gpx)}</sym><type>${esc(f.poiType)}</type></wpt>\n`;
  }
  for (const f of doc.features) {
    if (f.kind === 'poi') continue;
    const color = featureColor(f).slice(1);
    let o =
      `<trk><name>${esc(f.name)}</name><desc>${esc(featureDescription(f, opts.units))}</desc>` +
      `<type>${f.kind === 'area' ? 'Area' : 'Trail'}</type>` +
      `<extensions><gpx_style:line><gpx_style:color>${color}</gpx_style:color>` +
      `<gpx_style:width>4</gpx_style:width></gpx_style:line></extensions>\n<trkseg>\n`;
    for (const [lat, lon] of geometryPath(f)) o += `<trkpt lat="${f7(lat)}" lon="${f7(lon)}"/>\n`;
    yield o + '</trkseg></trk>\n';
  }
  yield '</gpx>\n';
}

/** GPX 1.1: <wpt> per POI, <trk> per trail/area with gpx_style color. Must validate against the GPX 1.1 XSD. */
export function toGpx(doc: ExportDocument, opts: ExportOptions): string {
  let out = '';
  for (const part of gpxParts(doc, opts)) out += part;
  return out;
}
