// Lane B. Port of prototype Core.kml.
import type {
  ExportDocument,
  ExportOptions,
  GeoFeature,
  HexColor,
  KmlOverlay,
  LatLon,
} from '../types';
import { f7, featureColor, featureDescription, geometryPath, xmlEscape as esc } from './format';
import { kmlIconHref } from './symbols';

/** "#RRGGBB" -> KML "aabbggrr" (prototype kmlColor). */
const kmlColor = (hex: HexColor, alpha = 'ff'): string =>
  alpha + hex.slice(5, 7) + hex.slice(3, 5) + hex.slice(1, 3);

const coords = (ll: readonly LatLon[]): string =>
  ll.map(([lat, lon]) => `${f7(lon)},${f7(lat)},0`).join(' ');

type ProvenanceDocument = ExportDocument & {
  readonly imageAttribution?: string;
  readonly acquisitionYear?: number;
};

/** The <Style> for one feature: line color + 0x55 fill, or the POI icon. */
function styleOf(f: GeoFeature): string {
  const id = esc('s-' + f.id);
  const color = featureColor(f);
  if (f.kind === 'poi') {
    return (
      `<Style id="${id}"><IconStyle><color>${kmlColor(color)}</color><scale>1.1</scale>` +
      `<Icon><href>${kmlIconHref(f.poiType)}</href></Icon></IconStyle></Style>\n`
    );
  }
  return (
    `<Style id="${id}"><LineStyle><color>${kmlColor(color)}</color><width>4</width></LineStyle>` +
    `<PolyStyle><color>${kmlColor(color, '55')}</color></PolyStyle></Style>\n`
  );
}

/** The <Placemark> for one feature. */
function placemarkOf(f: GeoFeature, opts: ExportOptions): string {
  const id = esc('s-' + f.id);
  const name = `<name>${esc(f.name)}</name>`;
  if (f.kind === 'poi') {
    const [lat, lon] = f.ll;
    const desc = f.notes ? `<description>${esc(f.notes)}</description>` : '';
    return (
      `<Placemark>${name}${desc}<styleUrl>#${id}</styleUrl>` +
      `<ExtendedData><Data name="type"><value>${esc(f.poiType)}</value></Data></ExtendedData>` +
      `<Point><coordinates>${f7(lon)},${f7(lat)},0</coordinates></Point></Placemark>\n`
    );
  }
  const head =
    `<Placemark>${name}<description>${esc(featureDescription(f, opts.units))}</description>` +
    `<styleUrl>#${id}</styleUrl>`;
  if (f.kind === 'trail') {
    return (
      `${head}<LineString><tessellate>1</tessellate><altitudeMode>clampToGround</altitudeMode>` +
      `<coordinates>${coords(f.ll)}</coordinates></LineString></Placemark>\n`
    );
  }
  return (
    `${head}<Polygon><tessellate>1</tessellate><outerBoundaryIs><LinearRing>` +
    `<coordinates>${coords(geometryPath(f))}</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>\n`
  );
}

const FOLDERS = [
  { kind: 'trail', open: '<Folder><name>Trails</name><open>1</open>\n' },
  { kind: 'area', open: '<Folder><name>Areas</name>\n' },
  { kind: 'poi', open: '<Folder><name>Points of interest</name>\n' },
] as const;

/**
 * The KML document as a sequence of small strings, in document order: header, one style per
 * feature, the non-empty Trails / Areas / Points of interest folders (one placemark per yield),
 * the optional GroundOverlay, footer. Lets buildKmz stream and check for cancellation between
 * pieces (D-014); toKml joins them.
 */
export function* kmlParts(
  doc: ExportDocument,
  opts: ExportOptions,
  overlay: KmlOverlay | null,
): Generator<string, void, undefined> {
  yield '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:gx="http://www.google.com/kml/ext/2.2">\n' +
    `<Document><name>${esc(doc.name)}</name><open>1</open>\n`;
  const provenance = doc as ProvenanceDocument;
  if (provenance.imageAttribution) {
    const year = provenance.acquisitionYear === undefined
      ? ''
      : ` (acquired ${provenance.acquisitionYear})`;
    yield `<description>${esc(`${provenance.imageAttribution}${year}`)}</description>\n`;
  }
  for (const f of doc.features) yield styleOf(f);
  for (const folder of FOLDERS) {
    if (!doc.features.some((f) => f.kind === folder.kind)) continue;
    yield folder.open;
    for (const f of doc.features) if (f.kind === folder.kind) yield placemarkOf(f, opts);
    yield '</Folder>\n';
  }
  if (overlay) {
    const quad = overlay.quad.map(([lat, lon]) => `${f7(lon)},${f7(lat)}`).join(' ');
    yield '<GroundOverlay><name>Original park map</name><visibility>1</visibility>' +
      `<color>ccffffff</color><drawOrder>0</drawOrder><Icon><href>${esc(overlay.href)}</href></Icon>` +
      `<gx:LatLonQuad><coordinates>${quad}</coordinates></gx:LatLonQuad></GroundOverlay>\n`;
  }
  yield '</Document>\n</kml>\n';
}

/** Styled KML 2.2 with Trails / Areas / Points of interest folders and an optional GroundOverlay (gx:LatLonQuad). */
export function toKml(doc: ExportDocument, opts: ExportOptions, overlay: KmlOverlay | null): string {
  let out = '';
  for (const part of kmlParts(doc, opts, overlay)) out += part;
  return out;
}
