import type { LatLon } from '../core/types';
import type { MercatorExtent } from './imagery-sources';

export const MARTIN_TILE_MAPSERVER_URL =
  'https://geoweb.martin.fl.us/arcgis/rest/services/Imagery/MC_Imagery/MapServer';

export interface ArcGisTileServiceJson {
  readonly name?: string;
  readonly description?: string;
  readonly copyrightText?: string;
  readonly documentInfo?: { readonly Title?: string; readonly Comments?: string };
  readonly singleFusedMapCache?: boolean;
  readonly fullExtent?: {
    readonly xmin: number;
    readonly ymin: number;
    readonly xmax: number;
    readonly ymax: number;
    readonly spatialReference?: { readonly wkid?: number; readonly latestWkid?: number };
  };
  readonly tileInfo?: {
    readonly rows: number;
    readonly cols: number;
    readonly origin: { readonly x: number; readonly y: number };
    readonly spatialReference?: { readonly wkid?: number; readonly latestWkid?: number };
    readonly lods: readonly { readonly level: number; readonly resolution: number }[];
  };
  readonly error?: { readonly code?: number; readonly message?: string };
  readonly layers?: readonly { readonly id: number }[];
}

export interface TiledServiceLevel {
  readonly z: number;
  readonly resolutionM: number;
}

export interface TiledImagerySource {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  readonly host: string;
  readonly tileSize: number;
  readonly levels: readonly TiledServiceLevel[];
  readonly coverage: MercatorExtent;
  readonly attribution: string;
  readonly year?: number;
}

export function tiledBoundaryWithinCoverage(
  source: TiledImagerySource,
  boundary: readonly LatLon[],
): boolean {
  return boundary.every(([lat, lon]) => {
    const clampedLat = Math.max(-85.05112878, Math.min(85.05112878, lat));
    const x = (lon * 20037508.342789244) / 180;
    const y =
      (Math.log(Math.tan(((90 + clampedLat) * Math.PI) / 360)) * 20037508.342789244) / Math.PI;
    return (
      x >= source.coverage.west &&
      x <= source.coverage.east &&
      y >= source.coverage.south &&
      y <= source.coverage.north
    );
  });
}

function mercatorExtent(
  extent: NonNullable<ArcGisTileServiceJson['fullExtent']>,
  wkid: number,
): MercatorExtent {
  if (![3857, 102100, 102113].includes(wkid)) {
    throw new Error('Only Web Mercator ArcGIS tile services are supported.');
  }
  return { west: extent.xmin, south: extent.ymin, east: extent.xmax, north: extent.ymax };
}

function reportedYear(text: string | undefined): number | undefined {
  const year = text?.match(/\b(?:19|20)\d{2}\b/)?.[0];
  return year ? Number(year) : undefined;
}

/** Validates an ArcGIS cached MapServer and returns its Web Mercator tile scheme. */
export function parseTiledMapServer(
  url: string,
  root: ArcGisTileServiceJson,
  firstLayer?: ArcGisTileServiceJson,
): TiledImagerySource {
  if (root.error) {
    throw new Error(
      `ArcGIS service error: ${root.error.message ?? `code ${root.error.code ?? 'unknown'}`}`,
    );
  }
  const parsedUrl = new URL(url);
  if (!/\/MapServer\/?$/i.test(parsedUrl.pathname)) {
    throw new Error('Paste an ArcGIS REST MapServer URL with a cached tile service.');
  }
  if (root.singleFusedMapCache !== true || !root.tileInfo) {
    throw new Error('This ArcGIS MapServer does not expose a cached tile service.');
  }
  const tileInfo = root.tileInfo;
  if (tileInfo.rows !== 256 || tileInfo.cols !== 256) {
    throw new Error('Only 256 × 256 cached ArcGIS tiles are supported.');
  }
  if (!Number.isFinite(tileInfo.origin.x) || !Number.isFinite(tileInfo.origin.y)) {
    throw new Error('The ArcGIS tile service has an invalid cache origin.');
  }
  const halfWorld = 20037508.342789244;
  if (Math.abs(tileInfo.origin.x + halfWorld) > 1 || Math.abs(tileInfo.origin.y - halfWorld) > 1) {
    throw new Error('Only the standard Web Mercator cache origin is supported.');
  }
  const tileWkid = tileInfo.spatialReference?.latestWkid ?? tileInfo.spatialReference?.wkid;
  if (!tileWkid) throw new Error('The ArcGIS tile service must publish its spatial reference.');
  const coverageWkid =
    root.fullExtent?.spatialReference?.latestWkid ??
    root.fullExtent?.spatialReference?.wkid ??
    tileWkid;
  if (!root.fullExtent) throw new Error('The ArcGIS tile service must publish its full extent.');
  const coverage = mercatorExtent(root.fullExtent, coverageWkid);
  if (![3857, 102100, 102113].includes(tileWkid)) {
    throw new Error('Only Web Mercator ArcGIS tile services are supported.');
  }
  const levels = tileInfo.lods
    .filter(
      (lod) =>
        Number.isInteger(lod.level) &&
        lod.level >= 0 &&
        Number.isFinite(lod.resolution) &&
        lod.resolution > 0,
    )
    .map((lod) => ({ z: lod.level, resolutionM: lod.resolution }))
    .sort((a, b) => a.z - b.z);
  if (
    levels.some((level) => {
      const expected = (2 * Math.PI * 6378137) / (tileInfo.cols * 2 ** level.z);
      return Math.abs(level.resolutionM - expected) > expected * 0.01;
    })
  ) {
    throw new Error('The ArcGIS cache levels do not use the standard Web Mercator zoom matrix.');
  }
  if (!levels.length || new Set(levels.map((level) => level.z)).size !== levels.length) {
    throw new Error('The ArcGIS tile service has no valid, unique cache levels.');
  }

  const metadata = firstLayer ?? root;
  const year = reportedYear(metadata.description) ?? reportedYear(root.documentInfo?.Title);
  const copyright =
    metadata.copyrightText?.trim() || root.copyrightText?.trim() || root.name || parsedUrl.hostname;
  const agency = parsedUrl.hostname === 'geoweb.martin.fl.us' ? 'Martin County' : 'ArcGIS';
  const date = year
    ? ` (${year}${agency === 'Martin County' && metadata.description ? ', as reported by the service' : ''})`
    : '';
  const serviceUrl = new URL(url);
  serviceUrl.search = '';
  serviceUrl.hash = '';
  return {
    id:
      serviceUrl.hostname === 'geoweb.martin.fl.us' ? 'martin-county' : `custom:${serviceUrl.href}`,
    name: root.name?.trim() || parsedUrl.hostname,
    url: serviceUrl.href.replace(/\/$/, ''),
    host: parsedUrl.hostname,
    tileSize: 256,
    levels,
    coverage,
    attribution: `Imagery: ${copyright} via ${agency}${date}`,
    ...(year ? { year } : {}),
  };
}

/** Reads a cached ArcGIS MapServer from the live or stubbed service endpoint. */
export async function inspectTiledMapServer(
  url: string,
  fetcher: typeof fetch = fetch,
): Promise<TiledImagerySource> {
  const cleanUrl = url.trim().replace(/\/$/, '');
  const metadataUrl = new URL(cleanUrl);
  metadataUrl.search = 'f=json';
  const response = await fetcher(metadataUrl, { mode: 'cors', cache: 'no-store' });
  if (!response.ok) throw new Error(`ArcGIS service returned HTTP ${response.status}.`);
  const root = (await response.json()) as ArcGisTileServiceJson;
  let firstLayer: ArcGisTileServiceJson | undefined;
  const layerId = root.layers?.[0]?.id;
  if (layerId !== undefined) {
    const layerUrl = new URL(`${cleanUrl.replace(/\/$/, '')}/${layerId}`);
    layerUrl.search = 'f=json';
    const layerResponse = await fetcher(layerUrl, { mode: 'cors', cache: 'no-store' });
    if (!layerResponse.ok) throw new Error(`ArcGIS layer returned HTTP ${layerResponse.status}.`);
    firstLayer = (await layerResponse.json()) as ArcGisTileServiceJson;
  }
  return parseTiledMapServer(cleanUrl, root, firstLayer);
}
