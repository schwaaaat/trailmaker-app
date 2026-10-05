/** Pure metadata and export planning for ArcGIS imagery capture. */
export type ImageryServiceKind = 'mapserver-export' | 'mapserver-tiles' | 'imageserver-export';
export interface MercatorExtent {
  readonly west: number;
  readonly south: number;
  readonly east: number;
  readonly north: number;
}
export interface ImagerySource {
  readonly id: string;
  readonly name: string;
  readonly kind: ImageryServiceKind;
  readonly url: string;
  readonly host: string;
  readonly attribution: string;
  readonly maxSize: readonly [number, number];
  readonly nominalResolutionM: number;
  readonly coverage: MercatorExtent;
  readonly year?: number;
}
export interface ArcGisServiceJson {
  readonly name?: string;
  readonly description?: string;
  readonly serviceDescription?: string;
  readonly copyrightText?: string;
  readonly copyright?: string;
  readonly documentInfo?: { readonly Title?: string; readonly Comments?: string };
  readonly fullExtent?: {
    readonly xmin: number;
    readonly ymin: number;
    readonly xmax: number;
    readonly ymax: number;
    readonly spatialReference?: { readonly wkid?: number; readonly latestWkid?: number };
  };
  readonly spatialReference?: { readonly wkid?: number; readonly latestWkid?: number };
  readonly maxImageWidth?: number;
  readonly maxImageHeight?: number;
  readonly pixelSizeX?: number;
  readonly pixelSizeY?: number;
  readonly layers?: readonly { readonly id: number; readonly name: string }[];
  readonly error?: {
    readonly code?: number;
    readonly message?: string;
    readonly details?: readonly string[];
  };
  readonly capabilities?: string;
}
export interface ServiceRequest {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly bbox: MercatorExtent;
  readonly pixelSize: number;
}

export interface AchievableResolutionOptions {
  readonly maxLongSide: number;
  readonly maxRequests: number;
}

/** Finest service pixel size that keeps a frame inside the output and request caps. */
export function achievableImageryResolution(
  frame: MercatorExtent,
  nativeResolutionM: number,
  maxSize: readonly [number, number],
  limits: AchievableResolutionOptions,
): number {
  const dimensionsAt = (resolution: number) => ({
    width: Math.ceil((frame.east - frame.west) / resolution),
    height: Math.ceil((frame.north - frame.south) / resolution),
  });
  const fits = (resolution: number) => {
    const { width, height } = dimensionsAt(resolution);
    const requests = Math.ceil(width / maxSize[0]) * Math.ceil(height / maxSize[1]);
    return Math.max(width, height) <= limits.maxLongSide && requests <= limits.maxRequests;
  };

  if (fits(nativeResolutionM)) return nativeResolutionM;
  let low = nativeResolutionM;
  let high = Math.max(
    low * 2,
    (frame.east - frame.west) / limits.maxLongSide,
    (frame.north - frame.south) / limits.maxLongSide,
  );
  while (!fits(high)) high *= 2;
  for (let i = 0; i < 52; i++) {
    const middle = (low + high) / 2;
    if (fits(middle)) high = middle;
    else low = middle;
  }
  // Leave a little room for WGS84/Web Mercator roundoff between UI planning and export planning.
  return high * 1.02;
}

const martinExtent = {
  west: -8983106.55923276,
  south: 3116499.117350954,
  east: -8912756.246533474,
  north: 3158127.2318873256,
};
export const IMAGERY_SOURCES: readonly ImagerySource[] = [
  {
    id: 'martin-county',
    name: 'Martin County (3-inch)',
    kind: 'mapserver-export',
    url: 'https://geoweb.martin.fl.us/arcgis/rest/services/Imagery/MC_Imagery/MapServer',
    host: 'geoweb.martin.fl.us',
    attribution:
      'Imagery: GPI Geospatial, Inc. via Martin County (2026, as reported by the service)',
    maxSize: [2048, 2048],
    nominalResolutionM: 0.0762,
    coverage: martinExtent,
    year: 2026,
  },
];

export function containsFrame(extent: MercatorExtent, frame: MercatorExtent): boolean {
  return (
    frame.west >= extent.west &&
    frame.east <= extent.east &&
    frame.south >= extent.south &&
    frame.north <= extent.north
  );
}

export function selectImagerySources(frame: MercatorExtent): ImagerySource[] {
  return IMAGERY_SOURCES.filter((source) => containsFrame(source.coverage, frame)).sort(
    (a, b) => a.nominalResolutionM - b.nominalResolutionM,
  );
}

export function deriveImageryCredit(
  agency: string,
  copyrightText?: string,
  dateText?: string,
): { attribution: string; year?: number } {
  const copyright = copyrightText?.trim() || agency;
  const date = dateText?.trim();
  const yearMatch = date?.match(/\b(?:19|20)\d{2}\b/);
  const year = yearMatch ? Number(yearMatch[0]) : undefined;
  return {
    attribution: `Imagery: ${copyright} via ${agency}${date ? ` (${date})` : ''}`,
    ...(year ? { year } : {}),
  };
}

function extentToMercator(
  extent: NonNullable<ArcGisServiceJson['fullExtent']>,
  wkid: number,
): MercatorExtent {
  const project = (x: number, y: number): [number, number] => {
    if (wkid === 3857 || wkid === 102100 || wkid === 102113) return [x, y];
    if (wkid === 4326 || wkid === 4269) {
      return [
        (x * 20037508.342789244) / 180,
        (Math.log(Math.tan(((90 + Math.max(-85.051129, Math.min(85.051129, y))) * Math.PI) / 360)) *
          20037508.342789244) /
          Math.PI,
      ];
    }
    if (wkid === 3087) {
      // EPSG:3087 NAD83 / Florida GDL Albers. Used by FDEP's statewide aerial services.
      const a = 6378137,
        f = 1 / 298.257222101,
        e = Math.sqrt(2 * f - f * f);
      const phi1 = (24 * Math.PI) / 180,
        phi2 = (31.5 * Math.PI) / 180,
        phi0 = (24 * Math.PI) / 180,
        lambda0 = (-84 * Math.PI) / 180;
      const m = (phi: number) => Math.cos(phi) / Math.sqrt(1 - e * e * Math.sin(phi) ** 2);
      const q = (phi: number) =>
        (1 - e * e) *
        (Math.sin(phi) / (1 - e * e * Math.sin(phi) ** 2) -
          Math.log((1 - e * Math.sin(phi)) / (1 + e * Math.sin(phi))) / (2 * e));
      const n = (m(phi1) ** 2 - m(phi2) ** 2) / (q(phi2) - q(phi1));
      const c = m(phi1) ** 2 + n * q(phi1);
      const rho0 = (a * Math.sqrt(c - n * q(phi0))) / n;
      const dx = x - 400000,
        dy = rho0 - y;
      const rho = Math.sign(n) * Math.hypot(dx, dy),
        theta = Math.atan2(dx, dy);
      const targetQ = (c - ((rho * n) / a) ** 2) / n;
      let phi = Math.asin(targetQ / 2);
      for (let i = 0; i < 8; i++) {
        const sin = Math.sin(phi);
        const derivative = (2 * (1 - e * e) * Math.cos(phi)) / (1 - e * e * sin * sin) ** 2;
        const current = q(phi);
        if (!Number.isFinite(derivative) || Math.abs(derivative) < 1e-12) break;
        phi -= (current - targetQ) / derivative;
      }
      const lon = lambda0 + theta / n;
      const latDeg = (phi * 180) / Math.PI,
        lonDeg = (lon * 180) / Math.PI;
      return [
        (lonDeg * 20037508.342789244) / 180,
        (Math.log(
          Math.tan(((90 + Math.max(-85.051129, Math.min(85.051129, latDeg))) * Math.PI) / 360),
        ) *
          20037508.342789244) /
          Math.PI,
      ];
    }
    throw new Error(
      `Unsupported service spatial reference EPSG:${wkid}; use a Web Mercator, WGS84, or Florida GDL Albers service.`,
    );
  };
  const corners = [
    project(extent.xmin, extent.ymin),
    project(extent.xmin, extent.ymax),
    project(extent.xmax, extent.ymin),
    project(extent.xmax, extent.ymax),
  ];
  return {
    west: Math.min(...corners.map((p) => p[0])),
    south: Math.min(...corners.map((p) => p[1])),
    east: Math.max(...corners.map((p) => p[0])),
    north: Math.max(...corners.map((p) => p[1])),
  };
}

export function parseArcGisService(url: string, json: ArcGisServiceJson): ImagerySource {
  if (json.error) {
    const reason = `${json.error.message ?? 'ArcGIS service error'} ${json.error.details?.join(' ') ?? ''}`;
    if (
      /token|credential|sign.?in|unauthor/i.test(reason) ||
      json.error.code === 498 ||
      json.error.code === 499
    )
      throw new Error('This ArcGIS service requires a token or login.');
    throw new Error(`ArcGIS service error: ${reason.trim()}`);
  }
  const parsed = new URL(url);
  const endpoint = parsed.pathname.match(/\/(MapServer|ImageServer)\/?$/i)?.[1]?.toLowerCase();
  if (!endpoint) throw new Error('Paste an ArcGIS REST MapServer or ImageServer URL.');
  const extent = json.fullExtent;
  const wkid =
    extent?.spatialReference?.latestWkid ??
    extent?.spatialReference?.wkid ??
    json.spatialReference?.latestWkid ??
    json.spatialReference?.wkid;
  if (!extent || wkid === undefined)
    throw new Error('This service must publish a supported map extent.');
  const coverage = extentToMercator(extent, wkid);
  const kind: ImageryServiceKind =
    endpoint === 'imageserver' ? 'imageserver-export' : 'mapserver-export';
  const title = json.documentInfo?.Title;
  const flightSeason = json.description?.match(
    /flight season was from\s+(.+?)\s+for all areas\./i,
  )?.[1];
  const dateText =
    flightSeason ??
    title?.match(/\b(?:19|20)\d{2}(?:\s*[-–]\s*(?:19|20)?\d{2})?\b/)?.[0] ??
    json.name?.match(/(?:^|[_\s-])((?:19|20)\d{2})(?:$|[_\s-])/)?.[1];
  const credit = deriveImageryCredit('ArcGIS', json.copyrightText || json.copyright, dateText);
  const width = Math.floor(json.maxImageWidth ?? 2048);
  const height = Math.floor(json.maxImageHeight ?? 2048);
  if (!(width > 0 && height > 0))
    throw new Error('This service does not report a usable maximum export size.');
  const urlBase = new URL(url);
  urlBase.search = '';
  urlBase.hash = '';
  return {
    id: `custom:${urlBase.href}`,
    name: json.name || parsed.hostname,
    kind,
    url: urlBase.href,
    host: parsed.hostname,
    attribution: credit.attribution,
    maxSize: [width, height],
    nominalResolutionM: Math.max(json.pixelSizeX ?? 0.3, json.pixelSizeY ?? 0.3),
    coverage,
    ...(credit.year ? { year: credit.year } : {}),
  };
}

/** Output at requested scale, never finer than service pixels, in capped export chunks. */
export function planServiceRequests(
  frame: MercatorExtent,
  requestedPixelSize: number,
  maxSize: readonly [number, number],
  nativePixelSize: number,
): ServiceRequest[] {
  const pixelSize = Math.max(requestedPixelSize, nativePixelSize);
  const width = Math.max(1, Math.ceil((frame.east - frame.west) / pixelSize));
  const height = Math.max(1, Math.ceil((frame.north - frame.south) / pixelSize));
  const requests: ServiceRequest[] = [];
  for (let y = 0; y < height; y += maxSize[1])
    for (let x = 0; x < width; x += maxSize[0]) {
      const w = Math.min(maxSize[0], width - x),
        h = Math.min(maxSize[1], height - y);
      const west = frame.west + x * pixelSize,
        north = frame.north - y * pixelSize;
      requests.push({
        x,
        y,
        width: w,
        height: h,
        pixelSize,
        bbox: { west, south: north - h * pixelSize, east: west + w * pixelSize, north },
      });
    }
  return requests;
}

/** Uniform or fully transparent samples indicate a likely blank/nodata response. */
export function isMostlyBlank(
  data: ArrayLike<number>,
  channels = 4,
  sampleCount = Math.floor(data.length / channels),
): boolean {
  if (sampleCount === 0) return true;
  let transparent = 0;
  let first = -1;
  let same = 0;
  for (let i = 0; i < sampleCount; i++) {
    const offset = i * channels;
    if (channels >= 4 && data[offset + 3] === 0) {
      transparent++;
      continue;
    }
    const value =
      ((data[offset] ?? 0) << 16) | ((data[offset + 1] ?? 0) << 8) | (data[offset + 2] ?? 0);
    if (first < 0) first = value;
    if (value === first) same++;
  }
  return transparent / sampleCount > 0.8 || same / sampleCount > 0.98;
}
