// Lane B. The "Download all" zip (prototype #dlZip): GPX, KML, KMZ and GeoJSON of one document.
// Written as steps (card T-211): the text is generated piece by piece and deflated in bounded
// chunks through fflate's streaming Zip, so the app can build it in time slices; at 2,000 x 50
// the whole zip is ~1 s of work.
import { Zip, ZipDeflate, ZipPassThrough, strToU8 } from 'fflate';
import type { ExportDocument, ExportOptions } from '../types';
import { slugify } from './format';
import { geoJsonParts } from './geojson';
import { gpxParts } from './gpx';
import { kmlParts } from './kml';
import { drain } from './steps';
import { zipMtime } from './zip';

/** Largest piece pushed into the zip per step, bytes; deflating it takes a few ms. */
export const BUNDLE_CHUNK_BYTES = 64 * 1024;
/** Text buffered before encoding: at most 4 UTF-8 bytes per UTF-16 unit. */
const CHUNK_CHARS = BUNDLE_CHUNK_BYTES / 4;

/**
 * buildExportZip one bounded piece of work per step: yields after each text part is generated
 * and after each chunk is deflated or stored, and returns the zip bytes.
 */
export function* exportZipSteps(
  doc: ExportDocument,
  opts: ExportOptions,
  kmz: Uint8Array,
): Generator<void, Uint8Array, undefined> {
  const base = slugify(doc.name);
  const mtime = zipMtime(opts.time);
  const out: Uint8Array[] = [];
  const zip = new Zip((err, chunk) => {
    if (err) throw err;
    out.push(chunk);
  });

  function* text(name: string, parts: Iterable<string>): Generator<void, void, undefined> {
    const entry = new ZipDeflate(name, { level: 6 });
    entry.mtime = mtime;
    zip.add(entry);
    let buf = '';
    for (const part of parts) {
      buf += part;
      if (buf.length >= CHUNK_CHARS) {
        yield* push(entry, strToU8(buf), false);
        buf = '';
      } else {
        yield;
      }
    }
    yield* push(entry, strToU8(buf), true);
  }

  function* push(
    entry: ZipDeflate | ZipPassThrough,
    bytes: Uint8Array,
    final: boolean,
  ): Generator<void, void, undefined> {
    let at = 0;
    do {
      const end = Math.min(bytes.byteLength, at + BUNDLE_CHUNK_BYTES);
      entry.push(bytes.subarray(at, end), final && end === bytes.byteLength);
      at = end;
      yield;
    } while (at < bytes.byteLength);
  }

  yield* text(`${base}.gpx`, gpxParts(doc, opts));
  yield* text(`${base}.kml`, kmlParts(doc, opts, null));
  // The KMZ is already compressed: store it.
  const stored = new ZipPassThrough(`${base}.kmz`);
  stored.mtime = mtime;
  zip.add(stored);
  yield* push(stored, kmz, true);
  yield* text(`${base}.geojson`, geoJsonParts(doc, opts));
  zip.end();

  let size = 0;
  for (const c of out) size += c.byteLength;
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const c of out) {
    bytes.set(c, at);
    at += c.byteLength;
  }
  return bytes;
}

/** Zip `<slug>.gpx/.kml/.kmz/.geojson`. The KML has no overlay; `kmz` is a built KMZ (worker). */
export function buildExportZip(doc: ExportDocument, opts: ExportOptions, kmz: Uint8Array): Uint8Array {
  return drain(exportZipSteps(doc, opts, kmz));
}
