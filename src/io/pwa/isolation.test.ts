import { describe, expect, it } from 'vitest';
import {
  COEP_HEADER,
  COOP_HEADER,
  CORP_HEADER,
  injectIsolationHeaders,
  isCrossOriginIsolated,
  shouldInterceptRequest,
} from './isolation';

describe('isCrossOriginIsolated', () => {
  it('returns boolean reflecting global environment', () => {
    const result = isCrossOriginIsolated();
    expect(typeof result).toBe('boolean');
  });
});

describe('shouldInterceptRequest', () => {
  const baseOrigin = 'https://trailmaker.local';

  it('allows same-origin GET and HEAD requests', () => {
    expect(shouldInterceptRequest('https://trailmaker.local/', baseOrigin)).toBe(true);
    expect(shouldInterceptRequest('/assets/index.js', baseOrigin)).toBe(true);
    expect(shouldInterceptRequest('https://trailmaker.local/assets/worker.js', baseOrigin, 'HEAD')).toBe(
      true
    );
  });

  it('rejects non-GET/HEAD methods', () => {
    expect(shouldInterceptRequest('/api/data', baseOrigin, 'POST')).toBe(false);
    expect(shouldInterceptRequest('/api/data', baseOrigin, 'DELETE')).toBe(false);
  });

  it('strictly rejects external origin requests (basemap tiles, geocoder)', () => {
    expect(
      shouldInterceptRequest('https://tiles.openfreemap.org/styles/liberty', baseOrigin)
    ).toBe(false);
    expect(
      shouldInterceptRequest('https://nominatim.openstreetmap.org/search?q=park', baseOrigin)
    ).toBe(false);
    expect(shouldInterceptRequest('https://other-origin.org/icon.png', baseOrigin)).toBe(false);
  });

  it('rejects non-http(s) schemes like blob and data', () => {
    expect(shouldInterceptRequest('blob:https://trailmaker.local/123-456', baseOrigin)).toBe(false);
    expect(shouldInterceptRequest('data:image/png;base64,...', baseOrigin)).toBe(false);
  });

  it('bypasses test fixtures and Vite internal namespaces', () => {
    expect(shouldInterceptRequest('/__fixtures/solid.png', baseOrigin)).toBe(false);
    expect(shouldInterceptRequest('https://trailmaker.local/__fixtures/solid.png', baseOrigin)).toBe(
      false
    );
  });

  it('handles malformed URLs safely', () => {
    expect(shouldInterceptRequest('http://[invalid', baseOrigin)).toBe(false);
  });
});

describe('injectIsolationHeaders', () => {
  it('injects same-origin COOP and require-corp COEP headers by default', () => {
    const original = new Response('Hello world', {
      status: 200,
      statusText: 'OK',
      headers: {
        'Content-Type': 'text/plain',
      },
    });

    const isolated = injectIsolationHeaders(original);
    expect(isolated.status).toBe(200);
    expect(isolated.statusText).toBe('OK');
    expect(isolated.headers.get('Content-Type')).toBe('text/plain');
    expect(isolated.headers.get(COOP_HEADER)).toBe('same-origin');
    expect(isolated.headers.get(COEP_HEADER)).toBe('require-corp');
    expect(isolated.headers.get(CORP_HEADER)).toBe('cross-origin');
  });

  it('supports credentialless mode when specified', () => {
    const original = new Response('test', { status: 200 });
    const isolated = injectIsolationHeaders(original, { credentialless: true });
    expect(isolated.headers.get(COEP_HEADER)).toBe('credentialless');
  });

  it('preserves existing CORP header if already set', () => {
    const original = new Response('test', {
      status: 200,
      headers: {
        [CORP_HEADER]: 'same-origin',
      },
    });
    const isolated = injectIsolationHeaders(original);
    expect(isolated.headers.get(CORP_HEADER)).toBe('same-origin');
  });

  it('preserves opaque / status 0 responses unchanged', () => {
    const opaque = new Response(null, { status: 200 });
    Object.defineProperty(opaque, 'status', { value: 0 });
    Object.defineProperty(opaque, 'type', { value: 'opaque' });
    const result = injectIsolationHeaders(opaque);
    expect(result).toBe(opaque);
  });

  it('strips content-encoding and transfer headers because response body is already decoded', () => {
    const original = new Response('{"ok":true}', {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Content-Encoding': 'gzip',
        'Content-Length': '42',
        'Transfer-Encoding': 'chunked',
        Connection: 'keep-alive',
        'Keep-Alive': 'timeout=5',
      },
    });

    const isolated = injectIsolationHeaders(original);
    expect(isolated.headers.get('Content-Type')).toBe('application/json');
    expect(isolated.headers.get(COOP_HEADER)).toBe('same-origin');
    expect(isolated.headers.get(COEP_HEADER)).toBe('require-corp');
    expect(isolated.headers.get('Content-Encoding')).toBeNull();
    expect(isolated.headers.get('Content-Length')).toBeNull();
    expect(isolated.headers.get('Transfer-Encoding')).toBeNull();
    expect(isolated.headers.get('Connection')).toBeNull();
    expect(isolated.headers.get('Keep-Alive')).toBeNull();
  });
});
