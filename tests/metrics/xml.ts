import { readFileSync } from 'node:fs';
import { ParseOption, XmlDocument, XsdValidator } from 'libxml2-wasm';
import type { LatLon } from '../../src/core/types';

const schema = readFileSync(new URL('../fixtures/schema/gpx.xsd', import.meta.url), 'utf8');
function parse(xml: string) {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('External declarations are not accepted');
  return XmlDocument.fromString(xml, {
    option: ParseOption.XML_PARSE_NONET | ParseOption.XML_PARSE_NO_XXE,
  });
}
/** Throws with schema diagnostics on invalid GPX; never fetches a schema at test time. */
export function validateGpx(xml: string): true {
  const xsd = parse(schema);
  try {
    const validator = XsdValidator.fromDoc(xsd);
    try {
      const doc = parse(xml);
      try {
        validator.validate(doc);
        return true;
      } finally {
        doc.dispose();
      }
    } finally {
      validator.dispose();
    }
  } finally {
    xsd.dispose();
  }
}
/** Well-formed KML and finite lon,lat[,alt] tuples; returns paths in contract [lat,lon] order. */
export function parseKml(xml: string): LatLon[][] {
  const doc = parse(xml);
  try {
    const ns = { k: 'http://www.opengis.net/kml/2.2', gx: 'http://www.google.com/kml/ext/2.2' };
    if (!doc.get('/k:kml', ns)) throw new Error('Expected a KML 2.2 root');
    return doc.find('//k:coordinates', ns).map((node) =>
      node.content
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .map((tuple) => {
          const parts = tuple.split(',');
          const values = parts.map(Number);
          if (
            parts.length < 2 ||
            parts.length > 3 ||
            parts.some((p) => !p.trim()) ||
            values.some((v) => !Number.isFinite(v)) ||
            Math.abs(values[0]!) > 180 ||
            Math.abs(values[1]!) > 90
          )
            throw new Error(`Invalid KML coordinate: ${tuple}`);
          return [values[1]!, values[0]!] as LatLon;
        }),
    );
  } finally {
    doc.dispose();
  }
}
