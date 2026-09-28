// Lane C. Project creation, the .trailmaker file format, and migrations (DECISIONS D-003).
import { zip, unzip, zipSync, unzipSync, type AsyncZippable, type Zippable } from 'fflate';
import type {
  Anchor,
  AnchorSource,
  ColorChip,
  Feature,
  FitMethod,
  LatLon,
  MapImage,
  PoiType,
  Project,
  Px,
  Rgb,
  Units,
} from '../types';
import { DEFAULT_COLORS, POI_TYPES, PROJECT_VERSION } from '../types';

export { DEFAULT_COLORS, PROJECT_VERSION };
export type { MapImage, Project };

/** The map image bytes stored alongside a project. */
export interface StoredImage {
  /** Original file bytes (not the downscaled working raster). */
  readonly bytes: Uint8Array;
  /** MIME type of bytes. */
  readonly mimeType: string;
}

const VALID_POI_TYPES = new Set<string>(POI_TYPES);
const VALID_FIT_METHODS = new Set<FitMethod>(['auto', 'similarity', 'affine', 'tps']);
const VALID_UNITS = new Set<Units>(['mi', 'km']);
const VALID_ANCHOR_SOURCES = new Set<AnchorSource>(['paste', 'basemap']);

const MIME_TO_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/tiff': 'tiff',
  'image/tif': 'tiff',
  'image/bmp': 'bmp',
  'image/avif': 'avif',
  'application/pdf': 'pdf',
};

const EXT_TO_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  tiff: 'image/tiff',
  tif: 'image/tiff',
  bmp: 'image/bmp',
  avif: 'image/avif',
  pdf: 'application/pdf',
};

export function extFromMimeType(mimeType: string): string {
  const norm = mimeType.toLowerCase().trim();
  if (MIME_TO_EXT[norm]) {
    return MIME_TO_EXT[norm];
  }
  const match = norm.match(/^(?:image|application)\/([a-z0-9_-]+)$/);
  if (match && match[1]) {
    return match[1].replace(/^x-/, '');
  }
  return 'bin';
}

export function mimeTypeFromExt(ext: string): string {
  const norm = ext.toLowerCase().trim();
  return EXT_TO_MIME[norm] || 'application/octet-stream';
}

function isObject(val: unknown): val is Record<string, unknown> {
  return typeof val === 'object' && val !== null && !Array.isArray(val);
}

function isFiniteNumber(val: unknown): val is number {
  return typeof val === 'number' && Number.isFinite(val);
}

function isFinitePair(val: unknown): val is readonly [number, number] {
  return Array.isArray(val) && val.length === 2 && isFiniteNumber(val[0]) && isFiniteNumber(val[1]);
}

function isFiniteTriplet(val: unknown): val is readonly [number, number, number] {
  return (
    Array.isArray(val) &&
    val.length === 3 &&
    isFiniteNumber(val[0]) &&
    isFiniteNumber(val[1]) &&
    isFiniteNumber(val[2])
  );
}

function canonicalize(val: unknown): unknown {
  if (val === null || typeof val !== 'object') {
    return val;
  }
  if (Array.isArray(val)) {
    return val.map(canonicalize);
  }
  const obj = val as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const sortedObj: Record<string, unknown> = {};
  for (const k of keys) {
    sortedObj[k] = canonicalize(obj[k]);
  }
  return sortedObj;
}

export function stableStringify(val: unknown, space?: number): string {
  return JSON.stringify(canonicalize(val), null, space);
}

function validateMapImage(img: unknown): void {
  if (!isObject(img)) throw new Error('image must be an object');
  if (typeof img.fileName !== 'string' || !img.fileName) {
    throw new Error('image.fileName must be a non-empty string');
  }
  if (!isFiniteNumber(img.width) || img.width <= 0) {
    throw new Error('image.width must be a positive number');
  }
  if (!isFiniteNumber(img.height) || img.height <= 0) {
    throw new Error('image.height must be a positive number');
  }
  if (!isFiniteNumber(img.originalWidth) || img.originalWidth <= 0) {
    throw new Error('image.originalWidth must be a positive number');
  }
  if (!isFiniteNumber(img.originalHeight) || img.originalHeight <= 0) {
    throw new Error('image.originalHeight must be a positive number');
  }
  if (typeof img.sha256 !== 'string' || !img.sha256) {
    throw new Error('image.sha256 must be a non-empty string');
  }
  if (!isObject(img.source)) {
    throw new Error('image.source must be an object');
  }
  const src = img.source;
  if (src.kind === 'image') {
    if (typeof src.mimeType !== 'string' || !src.mimeType) {
      throw new Error('image.source.mimeType must be a non-empty string');
    }
  } else if (src.kind === 'pdf') {
    if (!isFiniteNumber(src.page) || src.page < 1) {
      throw new Error('image.source.page must be an integer >= 1');
    }
    if (!isFiniteNumber(src.pageCount) || src.pageCount < 1) {
      throw new Error('image.source.pageCount must be an integer >= 1');
    }
    if (!isFiniteNumber(src.renderScale) || src.renderScale <= 0) {
      throw new Error('image.source.renderScale must be a positive number');
    }
  } else {
    throw new Error(`unknown image.source.kind "${String((src as Record<string, unknown>).kind)}"`);
  }
}

function validateAnchor(a: unknown, idx: number): void {
  if (!isObject(a)) throw new Error(`anchor[${idx}] must be an object`);
  if (typeof a.id !== 'string' || !a.id) {
    throw new Error(`anchor[${idx}].id must be a non-empty string`);
  }
  if (!isFinitePair(a.px)) {
    throw new Error(`anchor[${idx}].px must be a finite [x, y] pair`);
  }
  if (a.ll !== null && !isFinitePair(a.ll)) {
    throw new Error(`anchor[${idx}].ll must be null or a finite [lat, lon] pair`);
  }
  if (typeof a.source !== 'string' || !VALID_ANCHOR_SOURCES.has(a.source as AnchorSource)) {
    throw new Error(`anchor[${idx}].source must be 'paste' or 'basemap'`);
  }
}

function validateFeature(f: unknown, idx: number): void {
  if (!isObject(f)) throw new Error(`feature[${idx}] must be an object`);
  if (typeof f.id !== 'string' || !f.id) {
    throw new Error(`feature[${idx}].id must be a non-empty string`);
  }
  if (typeof f.name !== 'string') {
    throw new Error(`feature[${idx}].name must be a string`);
  }
  if (typeof f.color !== 'string') {
    throw new Error(`feature[${idx}].color must be a string`);
  }
  if (typeof f.notes !== 'string') {
    throw new Error(`feature[${idx}].notes must be a string`);
  }

  if (f.kind === 'trail') {
    if (!Array.isArray(f.pts) || f.pts.length < 2) {
      throw new Error(`trail[${idx}].pts must contain at least 2 points`);
    }
    for (let pIdx = 0; pIdx < f.pts.length; pIdx++) {
      if (!isFinitePair(f.pts[pIdx])) {
        throw new Error(`trail[${idx}].pts[${pIdx}] must be a finite [x, y] pair`);
      }
    }
    if (f.ink !== null && !isFiniteTriplet(f.ink)) {
      throw new Error(`trail[${idx}].ink must be null or an RGB triplet`);
    }
  } else if (f.kind === 'poi') {
    if (!isFinitePair(f.at)) {
      throw new Error(`poi[${idx}].at must be a finite [x, y] pair`);
    }
    if (typeof f.poiType !== 'string' || !VALID_POI_TYPES.has(f.poiType)) {
      throw new Error(`poi[${idx}].poiType must be one of POI_TYPES`);
    }
  } else if (f.kind === 'area') {
    if (!Array.isArray(f.pts) || f.pts.length < 3) {
      throw new Error(`area[${idx}].pts must contain at least 3 points`);
    }
    for (let pIdx = 0; pIdx < f.pts.length; pIdx++) {
      if (!isFinitePair(f.pts[pIdx])) {
        throw new Error(`area[${idx}].pts[${pIdx}] must be a finite [x, y] pair`);
      }
    }
  } else {
    throw new Error(`unknown feature[${idx}].kind "${String((f as Record<string, unknown>).kind)}"`);
  }
}

function validateTraceSettings(t: unknown): void {
  if (!isObject(t)) throw new Error('trace must be an object');
  if (typeof t.smartFollow !== 'boolean') {
    throw new Error('trace.smartFollow must be a boolean');
  }
  if (!isFiniteNumber(t.tolerance)) {
    throw new Error('trace.tolerance must be a finite number');
  }
  if (t.ink !== null && !isFiniteTriplet(t.ink)) {
    throw new Error('trace.ink must be null or an RGB triplet');
  }
}

function validateAutoTraceSettings(at: unknown): void {
  if (!isObject(at)) throw new Error('autoTrace must be an object');
  if (!Array.isArray(at.chips)) {
    throw new Error('autoTrace.chips must be an array');
  }
  for (let i = 0; i < at.chips.length; i++) {
    const c = at.chips[i];
    if (!isObject(c)) throw new Error(`autoTrace.chips[${i}] must be an object`);
    if (typeof c.id !== 'string' || !c.id) {
      throw new Error(`autoTrace.chips[${i}].id must be a non-empty string`);
    }
    if (!isFiniteTriplet(c.rgb)) {
      throw new Error(`autoTrace.chips[${i}].rgb must be an RGB triplet`);
    }
    if (typeof c.name !== 'string') {
      throw new Error(`autoTrace.chips[${i}].name must be a string`);
    }
    if (typeof c.enabled !== 'boolean') {
      throw new Error(`autoTrace.chips[${i}].enabled must be a boolean`);
    }
    if (c.share !== null && !isFiniteNumber(c.share)) {
      throw new Error(`autoTrace.chips[${i}].share must be null or a finite number`);
    }
    if (typeof c.named !== 'boolean') {
      throw new Error(`autoTrace.chips[${i}].named must be a boolean`);
    }
  }
  if (!isFiniteNumber(at.gapPx) || at.gapPx < 0) {
    throw new Error('autoTrace.gapPx must be a non-negative number');
  }
  if (!isFiniteNumber(at.minLengthPct) || at.minLengthPct < 0) {
    throw new Error('autoTrace.minLengthPct must be a non-negative number');
  }
}

export function validateProject(p: unknown, maxVersion = PROJECT_VERSION): asserts p is Project {
  if (!isObject(p)) throw new Error('Invalid Trailmaker project: root must be an object');
  if (typeof p.version !== 'number' || !Number.isFinite(p.version) || p.version < 1 || p.version > maxVersion) {
    throw new Error(`Invalid Trailmaker project: version must be between 1 and ${maxVersion}`);
  }
  if (typeof p.name !== 'string') {
    throw new Error('Invalid Trailmaker project: name must be a string');
  }
  try {
    validateMapImage(p.image);
    if (!Array.isArray(p.anchors)) {
      throw new Error('anchors must be an array');
    }
    p.anchors.forEach(validateAnchor);
    if (typeof p.fitMethod !== 'string' || !VALID_FIT_METHODS.has(p.fitMethod as FitMethod)) {
      throw new Error(`invalid fitMethod "${String(p.fitMethod)}"`);
    }
    if (!Array.isArray(p.features)) {
      throw new Error('features must be an array');
    }
    p.features.forEach(validateFeature);
    if (typeof p.units !== 'string' || !VALID_UNITS.has(p.units as Units)) {
      throw new Error(`units must be 'mi' or 'km'`);
    }
    validateTraceSettings(p.trace);
    validateAutoTraceSettings(p.autoTrace);
    if (!isFiniteNumber(p.seq) || p.seq < 1) {
      throw new Error('seq must be an integer >= 1');
    }
    if (typeof p.updatedAt !== 'string' || !p.updatedAt) {
      throw new Error('updatedAt must be a non-empty string');
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid Trailmaker project: malformed project data (${detail})`);
  }
}

export type MigrationStep = (raw: Record<string, unknown>) => Record<string, unknown>;

const migrationRegistry = new Map<number, MigrationStep>();

/** Registers built-in migrations for versions up to PROJECT_VERSION. (D-024) */
export function registerDefaultMigrations(): void {
  migrationRegistry.set(1, (raw) => ({
    ...raw,
    version: 2,
  }));
}

export function registerMigration(fromVersion: number, step: MigrationStep): void {
  migrationRegistry.set(fromVersion, step);
}

export function resetMigrations(clearBuiltins = false): void {
  migrationRegistry.clear();
  if (!clearBuiltins) {
    registerDefaultMigrations();
  }
}

// Initialize default migrations on module load
registerDefaultMigrations();

/** A fresh project for a newly opened map, with prototype defaults. now is an ISO timestamp. */
export function newProject(image: MapImage, name: string, now: string): Project {
  const maxDim = Math.max(image.width, image.height);
  const gapPx = Math.max(6, Math.min(120, Math.round(maxDim / 80)));

  return {
    version: PROJECT_VERSION,
    name,
    image,
    anchors: [],
    fitMethod: 'auto',
    features: [],
    units: 'mi',
    trace: {
      smartFollow: true,
      tolerance: 60,
      ink: null,
    },
    autoTrace: {
      chips: [],
      gapPx,
      minLengthPct: 4,
    },
    seq: 1,
    updatedAt: now,
  };
}

const PRECOMPRESSED_EXTS = new Set(['png', 'jpg', 'jpeg', 'webp', 'pdf', 'avif']);

/** Encode a .trailmaker file: zip of project.json + the original image (+ optional imported.gpx). */
export function serializeProject(
  project: Project,
  image: StoredImage,
  gpxBytes?: Uint8Array,
): Uint8Array {
  validateProject(project);
  if (!(image.bytes instanceof Uint8Array)) {
    throw new Error('Cannot serialize project: image bytes must be a Uint8Array');
  }
  const ext = extFromMimeType(image.mimeType);
  const imageFileName = `image.${ext}`;
  const jsonStr = stableStringify(project, 2);
  const jsonBytes = new TextEncoder().encode(jsonStr);

  const isPrecompressed = PRECOMPRESSED_EXTS.has(ext.toLowerCase());

  const archiveData: Zippable = {
    'project.json': jsonBytes,
    [imageFileName]: isPrecompressed ? [image.bytes, { level: 0 }] : image.bytes,
  };

  if (gpxBytes && gpxBytes.byteLength > 0) {
    archiveData['imported.gpx'] = gpxBytes;
  }

  return zipSync(archiveData);
}

export interface ProjectTestSeam {
  serializeAsync?: ((project: Project, image: StoredImage, gpxBytes?: Uint8Array) => Promise<Uint8Array>) | null;
  deserializeAsync?: ((bytes: Uint8Array, maxVersion?: number) => Promise<{ project: Project; image: StoredImage; gpxBytes?: Uint8Array | undefined }>) | null;
}

export const projectTestSeam: ProjectTestSeam = {
  serializeAsync: null,
  deserializeAsync: null,
};

export function setProjectTestSeam(seam: Partial<ProjectTestSeam> | null): void {
  if (seam === null) {
    projectTestSeam.serializeAsync = null;
    projectTestSeam.deserializeAsync = null;
  } else {
    Object.assign(projectTestSeam, seam);
  }
}

/**
 * Encode a .trailmaker file asynchronously: zip of project.json + the original image (+ optional imported.gpx).
 * Uses fflate's async zip to avoid blocking the main thread on large images (T-313 acceptance 2).
 */
export async function serializeProjectAsync(
  project: Project,
  image: StoredImage,
  gpxBytes?: Uint8Array,
): Promise<Uint8Array> {
  if (projectTestSeam.serializeAsync) {
    return projectTestSeam.serializeAsync(project, image, gpxBytes);
  }

  validateProject(project);
  if (!(image.bytes instanceof Uint8Array)) {
    throw new Error('Cannot serialize project: image bytes must be a Uint8Array');
  }
  const ext = extFromMimeType(image.mimeType);
  const imageFileName = `image.${ext}`;
  const jsonStr = stableStringify(project, 2);
  const jsonBytes = new TextEncoder().encode(jsonStr);

  const isPrecompressed = PRECOMPRESSED_EXTS.has(ext.toLowerCase());

  const archiveData: AsyncZippable = {
    'project.json': jsonBytes,
    [imageFileName]: isPrecompressed ? [image.bytes, { level: 0 }] : image.bytes,
  };

  if (gpxBytes && gpxBytes.byteLength > 0) {
    archiveData['imported.gpx'] = gpxBytes;
  }

  return new Promise<Uint8Array>((resolve, reject) => {
    try {
      zip(archiveData, (err, data) => {
        if (err) reject(err);
        else resolve(data);
      });
    } catch (err) {
      reject(err);
    }
  });
}

/** Migrate any known older project JSON to the current version. Throws on unknown or newer versions. */
export function migrateProject(raw: unknown, maxVersion = PROJECT_VERSION): Project {
  if (!isObject(raw)) {
    throw new Error('Invalid Trailmaker project: project data must be an object');
  }
  if (typeof raw.version !== 'number' || !Number.isFinite(raw.version)) {
    throw new Error('Invalid Trailmaker project: missing or invalid version number');
  }

  let maxSupportedVersion = maxVersion;
  let minSupportedVersion = 1;
  for (const v of migrationRegistry.keys()) {
    if (v + 1 > maxSupportedVersion) {
      maxSupportedVersion = v + 1;
    }
    if (v < minSupportedVersion) {
      minSupportedVersion = v;
    }
  }

  if (raw.version > maxSupportedVersion) {
    throw new Error(
      `This project was made by a newer Trailmaker (version ${raw.version}, latest supported: ${maxSupportedVersion}).`
    );
  }

  if (raw.version < minSupportedVersion) {
    throw new Error(`Invalid Trailmaker project: unsupported version ${raw.version}`);
  }

  let current = { ...raw };
  while (migrationRegistry.has(current.version as number)) {
    const step = migrationRegistry.get(current.version as number)!;
    current = step(current);
  }

  validateProject(current, maxSupportedVersion);
  return current;
}

function parseProjectArchive(
  files: Record<string, Uint8Array>,
  maxVersion = PROJECT_VERSION,
): { project: Project; image: StoredImage; gpxBytes?: Uint8Array | undefined } {
  const projectBytes = files['project.json'];
  if (!projectBytes) {
    throw new Error('Invalid Trailmaker project file: missing project.json');
  }

  const imageKey = Object.keys(files).find((name) => /^image\.[a-zA-Z0-9]+$/i.test(name));
  if (!imageKey) {
    throw new Error('Invalid Trailmaker project file: missing map image');
  }
  const imageBytes = files[imageKey];
  if (!imageBytes) {
    throw new Error('Invalid Trailmaker project file: missing map image');
  }

  let raw: unknown;
  try {
    const text = new TextDecoder().decode(projectBytes);
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `Invalid Trailmaker project file: project.json is not valid JSON (${err instanceof Error ? err.message : String(err)})`
    );
  }

  const project = migrateProject(raw, maxVersion);

  const ext = imageKey.slice(imageKey.lastIndexOf('.') + 1);
  let mimeType = mimeTypeFromExt(ext);
  if (project.image?.source?.kind === 'image' && project.image.source.mimeType) {
    if (extFromMimeType(project.image.source.mimeType) === ext.toLowerCase()) {
      mimeType = project.image.source.mimeType;
    }
  }

  const gpxBytes = files['imported.gpx'];

  return {
    project,
    image: {
      bytes: imageBytes,
      mimeType,
    },
    ...(gpxBytes ? { gpxBytes } : {}),
  };
}

/** Decode a .trailmaker file, migrating older versions. Throws a user-readable Error on bad input. */
export function deserializeProject(
  bytes: Uint8Array,
  maxVersion = PROJECT_VERSION,
): { project: Project; image: StoredImage; gpxBytes?: Uint8Array | undefined } {
  if (!(bytes instanceof Uint8Array)) {
    throw new Error('Invalid Trailmaker project file: input must be a Uint8Array');
  }

  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes);
  } catch (err) {
    throw new Error(
      `Invalid Trailmaker project file: not a valid zip archive (${err instanceof Error ? err.message : String(err)})`
    );
  }

  return parseProjectArchive(files, maxVersion);
}

/**
 * Decode a .trailmaker file asynchronously, migrating older versions.
 * Uses fflate's async unzip to avoid blocking the main thread on large images (T-313 acceptance 2).
 */
export async function deserializeProjectAsync(
  bytes: Uint8Array,
  maxVersion = PROJECT_VERSION,
): Promise<{ project: Project; image: StoredImage; gpxBytes?: Uint8Array | undefined }> {
  if (projectTestSeam.deserializeAsync) {
    return projectTestSeam.deserializeAsync(bytes, maxVersion);
  }

  if (!(bytes instanceof Uint8Array)) {
    throw new Error('Invalid Trailmaker project file: input must be a Uint8Array');
  }

  const files = await new Promise<Record<string, Uint8Array>>((resolve, reject) => {
    try {
      unzip(bytes, (err, unzipped) => {
        if (err) {
          reject(
            new Error(
              `Invalid Trailmaker project file: not a valid zip archive (${err instanceof Error ? err.message : String(err)})`
            )
          );
        } else if (!unzipped) {
          reject(new Error('Invalid Trailmaker project file: not a valid zip archive'));
        } else {
          resolve(unzipped);
        }
      });
    } catch (err) {
      reject(
        new Error(
          `Invalid Trailmaker project file: not a valid zip archive (${err instanceof Error ? err.message : String(err)})`
        )
      );
    }
  });

  return parseProjectArchive(files, maxVersion);
}

/** Import a prototype "*.trailmaker.json" (app: 'trailmaker', version 1, data-URL image). Async: hashes the image (WebCrypto). */
export async function importPrototypeJson(
  text: string
): Promise<{ project: Project; image: StoredImage }> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("That JSON file isn't a Trailmaker project.");
  }

  if (!isObject(raw) || raw.app !== 'trailmaker' || !raw.image) {
    throw new Error("That JSON file isn't a Trailmaker project.");
  }

  if (typeof raw.image !== 'string') {
    throw new Error("That JSON file isn't a Trailmaker project: missing image data.");
  }

  const match = /^data:([^;,]+)?(?:;[^,]*)?;base64,(.+)$/s.exec(raw.image);
  if (!match || !match[2]) {
    throw new Error("That JSON file isn't a Trailmaker project: invalid image data URL.");
  }
  const mimeType = match[1] || 'image/png';
  const base64Str = match[2].replace(/\s+/g, '');
  const binaryStr = atob(base64Str);
  const imageBytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) {
    imageBytes[i] = binaryStr.charCodeAt(i);
  }

  const hashBuf = await crypto.subtle.digest('SHA-256', imageBytes);
  const sha256 = Array.from(new Uint8Array(hashBuf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  const meta = isObject(raw.meta) ? raw.meta : {};
  const width = typeof meta.W === 'number' && meta.W > 0 ? meta.W : 1;
  const height = typeof meta.H === 'number' && meta.H > 0 ? meta.H : 1;
  const name = typeof meta.name === 'string' && meta.name.trim() ? meta.name.trim() : 'Park map';

  const mapImage: MapImage = {
    fileName: name,
    width,
    height,
    originalWidth: width,
    originalHeight: height,
    source: { kind: 'image', mimeType },
    sha256,
  };

  const rawGcps = Array.isArray(meta.gcps) ? meta.gcps : [];
  const anchors: Anchor[] = rawGcps.map((item, idx) => {
    const g = isObject(item) ? item : {};
    const id = typeof g.id === 'string' && g.id ? g.id : `g${idx + 1}`;
    const x = typeof g.x === 'number' && Number.isFinite(g.x) ? g.x : 0;
    const y = typeof g.y === 'number' && Number.isFinite(g.y) ? g.y : 0;
    const lat = typeof g.lat === 'number' && Number.isFinite(g.lat) ? g.lat : null;
    const lon = typeof g.lon === 'number' && Number.isFinite(g.lon) ? g.lon : null;
    const ll: LatLon | null = lat !== null && lon !== null ? [lat, lon] : null;
    return {
      id,
      px: [x, y] as const,
      ll,
      source: 'paste' as const,
    };
  });

  const rawFeatures = Array.isArray(meta.features) ? meta.features : [];
  const features: Feature[] = rawFeatures
    .map((item, idx): Feature | null => {
      const f = isObject(item) ? item : {};
      const id = typeof f.id === 'string' && f.id ? f.id : `f${idx + 1}`;
      const featName = typeof f.name === 'string' && f.name ? f.name : `Feature ${idx + 1}`;
      const notes = typeof f.notes === 'string' ? f.notes : '';

      if (f.type === 'point') {
        const sym = typeof f.sym === 'string' ? f.sym : '';
        const poiType: PoiType = VALID_POI_TYPES.has(sym) ? (sym as PoiType) : 'Waypoint';
        const at: Px =
          Array.isArray(f.pts) && f.pts.length > 0 && isFinitePair(f.pts[0])
            ? [f.pts[0][0], f.pts[0][1]]
            : [0, 0];
        return {
          id,
          name: featName,
          color: typeof f.color === 'string' && f.color ? f.color : DEFAULT_COLORS.poi,
          notes,
          kind: 'poi' as const,
          at,
          poiType,
        };
      } else if (f.type === 'area') {
        const rawPts = Array.isArray(f.pts) ? f.pts : [];
        const pts: Px[] = rawPts.filter(isFinitePair).map((p) => [p[0], p[1]] as const);
        if (pts.length < 3) return null;
        return {
          id,
          name: featName,
          color: typeof f.color === 'string' && f.color ? f.color : DEFAULT_COLORS.area,
          notes,
          kind: 'area' as const,
          pts,
        };
      } else {
        const rawPts = Array.isArray(f.pts) ? f.pts : [];
        const pts: Px[] = rawPts.filter(isFinitePair).map((p) => [p[0], p[1]] as const);
        if (pts.length < 2) return null;
        const ink: Rgb | null = isFiniteTriplet(f.ink)
          ? ([f.ink[0], f.ink[1], f.ink[2]] as const)
          : null;
        return {
          id,
          name: featName,
          color: typeof f.color === 'string' && f.color ? f.color : DEFAULT_COLORS.trail,
          notes,
          kind: 'trail' as const,
          pts,
          ink,
        };
      }
    })
    .filter((feat: Feature | null): feat is Feature => feat !== null);

  const rawChips = Array.isArray(meta.chips) ? meta.chips : [];
  const chips: ColorChip[] = rawChips.map((item, idx) => {
    const c = isObject(item) ? item : {};
    const id = typeof c.id === 'string' && c.id ? c.id : `c${idx + 1}`;
    const rgb: Rgb = isFiniteTriplet(c.rgb)
      ? [Math.round(c.rgb[0]), Math.round(c.rgb[1]), Math.round(c.rgb[2])]
      : [0, 0, 0];
    const chipName = typeof c.name === 'string' ? c.name : '';
    const enabled = Boolean(c.on);
    const share = typeof c.share === 'number' && Number.isFinite(c.share) ? c.share : null;
    const named = Boolean(c.fromLegend);
    return {
      id,
      rgb,
      name: chipName,
      enabled,
      share,
      named,
    };
  });

  const defaultGap = Math.max(6, Math.min(120, Math.round(Math.max(width, height) / 80)));
  const gapPx = typeof meta.gap === 'number' && Number.isFinite(meta.gap) ? meta.gap : defaultGap;
  const minLengthPct =
    typeof meta.minPct === 'number' && Number.isFinite(meta.minPct) ? meta.minPct : 4;
  const tolerance = typeof meta.tol === 'number' && Number.isFinite(meta.tol) ? meta.tol : 60;
  const smartFollow = meta.smart !== false;
  const units: Units = meta.units === 'km' ? 'km' : 'mi';
  const fitMethod: FitMethod =
    meta.method === 'similarity' || meta.method === 'affine' || meta.method === 'tps'
      ? meta.method
      : 'auto';
  const seq =
    typeof meta.seq === 'number' && Number.isFinite(meta.seq) && meta.seq >= 1 ? meta.seq : 1;
  const updatedAt =
    typeof meta.savedAt === 'number' || typeof meta.savedAt === 'string'
      ? new Date(meta.savedAt).toISOString()
      : new Date().toISOString();

  const project: Project = {
    version: PROJECT_VERSION,
    name,
    image: mapImage,
    anchors,
    fitMethod,
    features,
    units,
    trace: {
      smartFollow,
      tolerance,
      ink: null,
    },
    autoTrace: {
      chips,
      gapPx,
      minLengthPct,
    },
    seq,
    updatedAt,
  };

  validateProject(project);

  return {
    project,
    image: {
      bytes: imageBytes,
      mimeType,
    },
  };
}
