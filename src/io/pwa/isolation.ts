// Lane C. PWA cross-origin isolation headers and routing policy (card T-310, D-013, D-018).

export const COOP_HEADER = 'Cross-Origin-Opener-Policy';
export const COEP_HEADER = 'Cross-Origin-Embedder-Policy';
export const CORP_HEADER = 'Cross-Origin-Resource-Policy';

export const DEFAULT_ISOLATION_HEADERS: Readonly<Record<string, string>> = {
  [COOP_HEADER]: 'same-origin',
  [COEP_HEADER]: 'require-corp',
  [CORP_HEADER]: 'cross-origin',
};

export interface IsolationOptions {
  readonly credentialless?: boolean;
}

/** Check if the current window or worker environment is cross-origin isolated. */
export function isCrossOriginIsolated(): boolean {
  if (typeof crossOriginIsolated !== 'undefined') {
    return crossOriginIsolated;
  }
  return false;
}

/**
 * Checks if a request should be intercepted and cached by the PWA service worker.
 * Crucially:
 * - Only same-origin requests are intercepted.
 * - External origin requests (basemap tiles, geocoder, remote assets) are NEVER intercepted or cached (D-018).
 * - Non-HTTP(S) schemes (blob:, data:) and non-GET/HEAD methods are bypassed.
 */
export function shouldInterceptRequest(
  requestUrl: string | URL,
  baseOrigin: string,
  method = 'GET'
): boolean {
  if (method !== 'GET' && method !== 'HEAD') {
    return false;
  }

  let parsed: URL;
  try {
    parsed = typeof requestUrl === 'string' ? new URL(requestUrl, baseOrigin) : requestUrl;
  } catch {
    return false;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return false;
  }

  // Cross-origin network requests (e.g. OpenFreeMap tiles, Nominatim geocoder) must bypass the cache
  if (parsed.origin !== baseOrigin) {
    return false;
  }

  // Test fixtures and Vite internal namespaces (e.g. /__fixtures/) must never be intercepted
  if (parsed.pathname.startsWith('/__')) {
    return false;
  }

  return true;
}

/**
 * Injects Cross-Origin Isolation headers into a Response.
 * Used by the service worker to ensure document and asset responses enable cross-origin
 * isolation even on static hosts that cannot set custom response headers (coi pattern).
 */
export function injectIsolationHeaders(
  response: Response,
  options: IsolationOptions = {}
): Response {
  // Opaque / synthetic empty responses cannot have headers rewritten
  if (response.status === 0 || response.type === 'opaque') {
    return response;
  }

  const newHeaders = new Headers(response.headers);
  newHeaders.set(COOP_HEADER, 'same-origin');
  newHeaders.set(COEP_HEADER, options.credentialless ? 'credentialless' : 'require-corp');

  if (!newHeaders.has(CORP_HEADER)) {
    newHeaders.set(CORP_HEADER, 'cross-origin');
  }

  // Strip content-encoding and transfer-related headers:
  // response.body is already decompressed and decoded. Keeping content-encoding or
  // stale content-length causes the browser decoding layer to fail with net::ERR_FAILED.
  newHeaders.delete('content-encoding');
  newHeaders.delete('content-length');
  newHeaders.delete('transfer-encoding');
  newHeaders.delete('connection');
  newHeaders.delete('keep-alive');

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: newHeaders,
  });
}
