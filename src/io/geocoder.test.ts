import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGeocoderClient, search, type GeocodeResult } from './geocoder';
import { DEFAULT_GEOCODER_SERVICE_URL, resetSettings, updateGeocoderSettings } from './settings';

function response(
  rows: readonly unknown[] = [
    {
      display_name: 'Dickey Ridge Visitor Center, Virginia',
      lat: '38.5482',
      lon: '-78.3897',
      boundingbox: ['38.54', '38.56', '-78.40', '-78.38'],
    },
  ],
  status = 200,
): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(rows),
  } as unknown as Response;
}

describe('Nominatim geocoder', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    resetSettings();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('does not call the network before the separate search opt-in is enabled', async () => {
    const fetcher = vi.fn().mockResolvedValue(response());
    vi.stubGlobal('fetch', fetcher);
    await expect(search('Dickey Ridge')).rejects.toMatchObject({ code: 'disabled' });
    expect(fetcher).not.toHaveBeenCalled();
    updateGeocoderSettings({ enabled: true });
    await expect(search('Dickey Ridge')).resolves.toHaveLength(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('sends only format and the typed query, then maps Nominatim coordinates and bounds', async () => {
    const fetcher = vi.fn().mockResolvedValue(response());
    const client = createGeocoderClient({
      fetcher,
      getServiceUrl: () => `${DEFAULT_GEOCODER_SERVICE_URL}&zoom=12`,
    });

    const results = await client.search('Dickey Ridge Visitor Center');
    const [input] = fetcher.mock.calls[0]!;
    const requestUrl = new URL(String(input));
    expect([...requestUrl.searchParams.entries()].sort()).toEqual([
      ['format', 'jsonv2'],
      ['q', 'Dickey Ridge Visitor Center'],
    ]);
    expect(requestUrl.search).not.toMatch(/lat|lon|image|project|zoom/i);
    expect(results).toEqual([
      {
        name: 'Dickey Ridge Visitor Center, Virginia',
        ll: [38.5482, -78.3897],
        bbox: [
          [-78.4, 38.54],
          [-78.38, 38.56],
        ],
      },
    ] satisfies GeocodeResult[]);
  });

  it('allows at most one request per second across concurrent queries', async () => {
    const fetcher = vi.fn().mockResolvedValue(response());
    const client = createGeocoderClient({ fetcher });
    const first = client.search('first');
    const second = client.search('second');
    await vi.advanceTimersByTimeAsync(0);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await first;
    await vi.advanceTimersByTimeAsync(999);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await second;
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('serves an identical query from memory for ten minutes, then expires it', async () => {
    const fetcher = vi.fn().mockResolvedValue(response());
    const client = createGeocoderClient({ fetcher });
    const first = await client.search('Dickey Ridge');
    await vi.advanceTimersByTimeAsync(9 * 60_000);
    expect(await client.search('Dickey Ridge')).toEqual(first);
    expect(fetcher).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60 * 60_000 + 1);
    await client.search('Dickey Ridge');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('aborts while waiting for a rate-limit token', async () => {
    const fetcher = vi.fn().mockResolvedValue(response());
    const client = createGeocoderClient({ fetcher });
    await client.search('first');
    const controller = new AbortController();
    const queued = client.search('second', controller.signal);
    controller.abort();
    await expect(queued).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('backs off globally for 60 seconds after HTTP 429', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(response([], 429)).mockResolvedValue(response());
    const client = createGeocoderClient({ fetcher });
    await expect(client.search('first')).rejects.toMatchObject({ code: 'rate-limited' });
    await expect(client.search('second')).rejects.toMatchObject({ code: 'rate-limited' });
    expect(fetcher).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_000);
    await client.search('second');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects a queued request if a concurrent query receives 429 while it waits for a token', async () => {
    let resolveFirstResponse!: (value: Response) => void;
    const delayed429 = new Promise<Response>((resolve) => {
      resolveFirstResponse = resolve;
    });
    const fetcher = vi.fn().mockReturnValueOnce(delayed429).mockResolvedValue(response());
    const client = createGeocoderClient({ fetcher });

    const first = client.search('first');
    await vi.advanceTimersByTimeAsync(0);
    expect(fetcher).toHaveBeenCalledTimes(1);

    const queued = client.search('queued');
    const queuedResult = expect(queued).rejects.toMatchObject({ code: 'rate-limited' });
    resolveFirstResponse(response([], 429));
    await expect(first).rejects.toMatchObject({ code: 'rate-limited' });

    await vi.advanceTimersByTimeAsync(1_000);
    await queuedResult;
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('reports service and offline failures as readable geocoder errors', async () => {
    const unavailable = createGeocoderClient({
      fetcher: vi.fn().mockResolvedValue(response([], 503)),
    });
    await expect(unavailable.search('place')).rejects.toMatchObject({
      name: 'GeocoderError',
      code: 'service-unavailable',
    });

    const offline = createGeocoderClient({
      fetcher: vi.fn().mockRejectedValue(new TypeError('Failed to fetch')),
    });
    await expect(offline.search('place')).rejects.toMatchObject({
      name: 'GeocoderError',
      code: 'offline',
    });
  });
});
