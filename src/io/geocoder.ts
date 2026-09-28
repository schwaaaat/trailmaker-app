import type { LatLon } from '../core/types';
import { loadSettings, DEFAULT_GEOCODER_SERVICE_URL } from './settings';

export type GeocodeBounds = readonly [
  readonly [west: number, south: number],
  readonly [east: number, north: number],
];

export interface GeocodeResult {
  readonly name: string;
  readonly ll: LatLon;
  readonly bbox?: GeocodeBounds;
}

export type GeocoderErrorCode =
  | 'disabled'
  | 'rate-limited'
  | 'service-unavailable'
  | 'offline'
  | 'invalid-url'
  | 'invalid-response';

export class GeocoderError extends Error {
  constructor(
    readonly code: GeocoderErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'GeocoderError';
  }
}

export interface GeocoderClient {
  search(query: string, signal?: AbortSignal): Promise<GeocodeResult[]>;
}

type GeocoderFetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

interface GeocoderClientOptions {
  readonly fetcher?: GeocoderFetcher;
  readonly getServiceUrl?: () => string;
  readonly now?: () => number;
}

interface CacheEntry {
  readonly expiresAt: number;
  readonly results: GeocodeResult[];
}

const REQUEST_INTERVAL_MS = 1_000;
const CACHE_TTL_MS = 10 * 60_000;
const RATE_LIMIT_BACKOFF_MS = 60_000;

function abortError(): DOMException {
  return new DOMException('Place search was superseded.', 'AbortError');
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function copyResults(results: readonly GeocodeResult[]): GeocodeResult[] {
  return results.map((result) => ({
    name: result.name,
    ll: [result.ll[0], result.ll[1]],
    ...(result.bbox
      ? {
          bbox: [
            [result.bbox[0][0], result.bbox[0][1]],
            [result.bbox[1][0], result.bbox[1][1]],
          ] as const,
        }
      : {}),
  }));
}

function numberFrom(value: unknown): number | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseResults(payload: unknown): GeocodeResult[] {
  if (!Array.isArray(payload)) {
    throw new GeocoderError('invalid-response', 'Place search returned an invalid response.');
  }
  const results: GeocodeResult[] = [];
  for (const row of payload) {
    if (!row || typeof row !== 'object') continue;
    const item = row as Record<string, unknown>;
    const lat = numberFrom(item.lat);
    const lon = numberFrom(item.lon);
    if (
      typeof item.display_name !== 'string' ||
      !item.display_name.trim() ||
      lat === null ||
      lon === null ||
      lat < -90 ||
      lat > 90 ||
      lon < -180 ||
      lon > 180
    ) {
      continue;
    }

    let bbox: GeocodeBounds | undefined;
    if (Array.isArray(item.boundingbox) && item.boundingbox.length === 4) {
      const south = numberFrom(item.boundingbox[0]);
      const north = numberFrom(item.boundingbox[1]);
      const west = numberFrom(item.boundingbox[2]);
      const east = numberFrom(item.boundingbox[3]);
      if (
        south !== null &&
        north !== null &&
        west !== null &&
        east !== null &&
        south >= -90 &&
        north <= 90 &&
        west >= -180 &&
        east <= 180
      ) {
        bbox = [
          [west, south],
          [east, north],
        ];
      }
    }
    results.push({
      name: item.display_name.trim(),
      ll: [lat, lon],
      ...(bbox ? { bbox } : {}),
    });
  }
  return results;
}

/** Create an isolated client for deterministic service tests; production uses one shared client. */
export function createGeocoderClient(options: GeocoderClientOptions = {}): GeocoderClient {
  const fetcher: GeocoderFetcher = options.fetcher ?? ((input, init) => fetch(input, init));
  const getServiceUrl = options.getServiceUrl ?? (() => loadSettings().geocoder.serviceUrl);
  const now = options.now ?? Date.now;
  const cache = new Map<string, CacheEntry>();
  let tokens = 1;
  let refilledAt = now();
  let backoffUntil = 0;

  function ensureOutsideBackoff(currentTime: number): void {
    if (currentTime < backoffUntil) {
      throw new GeocoderError(
        'rate-limited',
        'Place search is paused after a rate limit. Try again shortly.',
      );
    }
  }

  async function acquireToken(signal?: AbortSignal): Promise<void> {
    while (true) {
      throwIfAborted(signal);
      const currentTime = now();
      tokens = Math.min(1, tokens + Math.max(0, currentTime - refilledAt) / REQUEST_INTERVAL_MS);
      refilledAt = currentTime;
      if (tokens >= 1) {
        tokens -= 1;
        return;
      }
      await delay((1 - tokens) * REQUEST_INTERVAL_MS, signal);
    }
  }

  return {
    async search(query: string, signal?: AbortSignal): Promise<GeocodeResult[]> {
      const typedQuery = query.trim();
      if (!typedQuery) return [];
      throwIfAborted(signal);

      let endpoint: URL;
      try {
        endpoint = new URL(getServiceUrl());
      } catch {
        throw new GeocoderError('invalid-url', 'Place search has an invalid service URL.');
      }
      const cacheKey = `${endpoint.origin}${endpoint.pathname}\u0000${typedQuery}`;
      const cached = cache.get(cacheKey);
      const currentTime = now();
      if (cached && cached.expiresAt > currentTime) return copyResults(cached.results);
      if (cached) cache.delete(cacheKey);

      ensureOutsideBackoff(currentTime);

      // Deliberately discard configurable URL parameters: the only query data sent is typed text.
      endpoint.search = '';
      endpoint.searchParams.set('format', 'jsonv2');
      endpoint.searchParams.set('q', typedQuery);

      await acquireToken(signal);
      throwIfAborted(signal);
      // A concurrent request may have received 429 while this search waited for a token.
      ensureOutsideBackoff(now());

      let response: Response;
      try {
        response = await fetcher(endpoint, signal ? { signal } : {});
      } catch (error) {
        if (signal?.aborted || (error instanceof Error && error.name === 'AbortError'))
          throw abortError();
        throw new GeocoderError('offline', 'Place search is unavailable while offline.');
      }

      if (response.status === 429) {
        backoffUntil = now() + RATE_LIMIT_BACKOFF_MS;
        throw new GeocoderError(
          'rate-limited',
          'Place search is rate limited. Try again in a minute.',
        );
      }
      if (!response.ok) {
        throw new GeocoderError('service-unavailable', 'Place search is temporarily unavailable.');
      }

      let parsed: GeocodeResult[];
      try {
        parsed = parseResults(await response.json());
      } catch (error) {
        if (signal?.aborted) throw abortError();
        if (error instanceof GeocoderError) throw error;
        throw new GeocoderError('invalid-response', 'Place search returned an invalid response.');
      }
      throwIfAborted(signal);

      cache.set(cacheKey, { expiresAt: now() + CACHE_TTL_MS, results: copyResults(parsed) });
      return copyResults(parsed);
    },
  };
}

const sharedGeocoder = createGeocoderClient({
  getServiceUrl: () => loadSettings().geocoder.serviceUrl || DEFAULT_GEOCODER_SERVICE_URL,
});

/** Search Nominatim with the configured endpoint and globally shared rate limit/cache. */
export function search(query: string, signal?: AbortSignal): Promise<GeocodeResult[]> {
  if (!loadSettings().geocoder.enabled) {
    return Promise.reject(
      new GeocoderError('disabled', 'Place search is disabled until you enable it in settings.'),
    );
  }
  return sharedGeocoder.search(query, signal);
}
