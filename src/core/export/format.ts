// Lane B. Port of prototype fmtLen / descOf / slug / esc / f7, plus color normalization.
import { DEFAULT_COLORS, type GeoFeature, type HexColor, type LatLon, type Units } from '../types';

/** "0.42 mi" / "1.3 mi" / "420 m" / "1.25 km", exactly as the prototype's fmtLen. */
export function formatLength(meters: number, units: Units): string {
  if (units === 'mi') return (meters / 1609.344).toFixed(meters < 1609 ? 2 : 1) + ' mi';
  return meters < 1000 ? Math.round(meters) + ' m' : (meters / 1000).toFixed(2) + ' km';
}

/** Notes plus "Length: …" (trail) or "Perimeter: …" (area), newline-joined; POIs get notes only. */
export function featureDescription(f: GeoFeature, units: Units): string {
  const measure =
    f.kind === 'trail'
      ? 'Length: ' + formatLength(f.lengthM, units)
      : f.kind === 'area'
        ? 'Perimeter: ' + formatLength(f.lengthM, units)
        : '';
  return [f.notes, measure].filter(Boolean).join('\n');
}

/** File-name slug: lower-case, non-alphanumerics to "-", trimmed; "park-map" if empty. */
export function slugify(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return slug || 'park-map';
}

const XML_ENTITIES: Readonly<Record<string, string>> = {
  '<': '&lt;',
  '>': '&gt;',
  '&': '&amp;',
  '"': '&quot;',
  "'": '&apos;',
};

/**
 * Escape text for XML content and attributes (prototype esc). Also drops the characters XML 1.0
 * forbids outright (C0 controls other than tab/newline/CR, U+FFFE/U+FFFF), which would otherwise
 * make the whole file unparseable.
 */
export function xmlEscape(text: string): string {
  return text
    // eslint-disable-next-line no-control-regex -- matching XML-illegal controls is the point
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
    .replace(/[<>&"']/g, (c) => XML_ENTITIES[c]!);
}

/** "#RRGGBB" upper-case; "#rgb" is expanded; anything unparseable becomes `fallback`. */
export function normalizeColor(color: HexColor, fallback: HexColor): HexColor {
  return parseHex(color) ?? parseHex(fallback) ?? DEFAULT_COLORS.trail;
}

function parseHex(color: string): HexColor | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  if (!m) return null;
  const hex = m[1]!.length === 3 ? [...m[1]!].map((c) => c + c).join('') : m[1]!;
  return '#' + hex.toUpperCase();
}

/** The feature's color, normalized, with its kind's default as fallback. */
export function featureColor(f: GeoFeature): HexColor {
  return normalizeColor(f.color, DEFAULT_COLORS[f.kind]);
}

/** Coordinate to 7 decimals (~1 cm), prototype f7. */
export const f7 = (v: number): string => v.toFixed(7);

/** An area's ring closed by repeating its first vertex; trails unchanged. */
export function geometryPath(f: Exclude<GeoFeature, { readonly kind: 'poi' }>): readonly LatLon[] {
  return f.kind === 'area' && f.ll.length ? [...f.ll, f.ll[0]!] : f.ll;
}
