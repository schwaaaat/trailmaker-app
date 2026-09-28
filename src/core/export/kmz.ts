// Lane B. Port of prototype buildKmz, using fflate instead of JSZip. Streams (D-014, card T-207):
// the KML is generated piece by piece and deflated in bounded chunks, the image is passed through
// in bounded slices, and the job hooks run between every push, so a worker job can be cancelled
// within D-008's 100 ms however large the export.
import { Zip, ZipDeflate, ZipPassThrough, strToU8 } from 'fflate';
import type { JobHooks, KmzRequest } from '../types';
import { kmlParts } from './kml';
import { zipMtime } from './zip';

/** Largest single push into the zip stream, bytes (D-014). */
export const KMZ_CHUNK_BYTES = 256 * 1024;
/** KML text buffered before encoding: at most 4 UTF-8 bytes per UTF-16 unit, so <= KMZ_CHUNK_BYTES. */
const KML_CHUNK_CHARS = KMZ_CHUNK_BYTES / 4;

const STAGE_KML = 'Writing map file';
const STAGE_IMAGE = 'Adding map image';

const NO_HOOKS: JobHooks = { progress() {}, throwIfCancelled() {} };

/** Zip headers, data descriptors and the central directory for two entries fit in this. */
const ZIP_OVERHEAD_BYTES = 4096;

/**
 * Output buffer the zip stream writes into as it goes, so the archive is never copied in one
 * uninterruptible piece at the end. It grows ahead of the big stored image (whose size is known)
 * and doubles otherwise, so growth only ever copies the small deflated KML.
 */
class ByteSink {
  private buf: Uint8Array;
  private len = 0;

  constructor(capacity: number) {
    this.buf = new Uint8Array(capacity);
  }

  /** Make room for `more` bytes beyond what is written. */
  reserve(more: number): void {
    const need = this.len + more;
    if (need <= this.buf.byteLength) return;
    const next = new Uint8Array(Math.max(need, this.buf.byteLength * 2));
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }

  write(chunk: Uint8Array): void {
    this.reserve(chunk.byteLength);
    this.buf.set(chunk, this.len);
    this.len += chunk.byteLength;
  }

  /** The written bytes (a view; the buffer has at most ZIP_OVERHEAD_BYTES of slack). */
  bytes(): Uint8Array {
    return this.len === this.buf.byteLength ? this.buf : this.buf.subarray(0, this.len);
  }
}

/**
 * Zip doc.kml (+ files/map.<ext> referenced by a GroundOverlay when overlayImage is set). Pure; the worker calls it.
 * CONTRACT (D-014): with hooks, KML generation and zipping must call hooks.throwIfCancelled() and
 * report progress at least every ~50 ms of work. Card T-207 implements this: a check and a
 * progress report around every push of at most KMZ_CHUNK_BYTES.
 */
export function buildKmz(req: KmzRequest, hooks: JobHooks = NO_HOOKS): Uint8Array {
  const { doc, options, overlayImage, quad } = req;
  if (overlayImage && !quad) throw new Error('KMZ overlay image needs its corner quad');
  hooks.throwIfCancelled();
  const href = overlayImage ? `files/map.${overlayImage.ext}` : null;
  const mtime = zipMtime(options.time);

  const out = new ByteSink(64 * 1024);
  const zip = new Zip((err, chunk) => {
    if (err) throw err;
    out.write(chunk);
  });

  // doc.kml first: Google Earth reads the first .kml entry.
  const kml = new ZipDeflate('doc.kml', { level: 6 });
  kml.mtime = mtime;
  zip.add(kml);
  const kmlShare = overlayImage ? 0.5 : 1;
  // kmlParts yields a header, one style and one placemark per feature, folder tags and a footer.
  const expected = 2 * doc.features.length + 8;
  let pieces = 0;
  let text = '';
  const pushText = (final: boolean) => {
    const bytes = strToU8(text);
    text = '';
    // One huge feature can exceed a chunk; slice it so no push is unbounded.
    let at = 0;
    do {
      hooks.throwIfCancelled();
      const end = Math.min(bytes.byteLength, at + KMZ_CHUNK_BYTES);
      const last = final && end === bytes.byteLength;
      kml.push(bytes.subarray(at, end), last);
      hooks.progress(last ? kmlShare : kmlShare * Math.min(0.99, pieces / expected), STAGE_KML);
      at = end;
    } while (at < bytes.byteLength);
  };
  for (const part of kmlParts(doc, options, href && quad ? { href, quad } : null)) {
    text += part;
    pieces++;
    if (text.length >= KML_CHUNK_CHARS) pushText(false);
  }
  pushText(true);

  // The image is already compressed: store it, in bounded slices.
  if (href && overlayImage) {
    const bytes = overlayImage.bytes;
    // One growth now (copying only the deflated KML) instead of doubling past the image.
    out.reserve(bytes.byteLength + ZIP_OVERHEAD_BYTES);
    const image = new ZipPassThrough(href);
    image.mtime = mtime;
    zip.add(image);
    let at = 0;
    do {
      hooks.throwIfCancelled();
      const end = Math.min(bytes.byteLength, at + KMZ_CHUNK_BYTES);
      image.push(bytes.subarray(at, end), end === bytes.byteLength);
      hooks.progress(0.5 + 0.5 * (bytes.byteLength ? end / bytes.byteLength : 1), STAGE_IMAGE);
      at = end;
    } while (at < bytes.byteLength);
  }
  zip.end();
  return out.bytes();
}
