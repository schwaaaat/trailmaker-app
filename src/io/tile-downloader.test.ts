import { describe, expect, it } from 'vitest';
import {
  countPlannedTileKeys,
  createPoliteTileDownloader,
  retryDelayMs,
  tileDownloadProgress,
  type TileFetchResponse,
} from './tile-downloader';

const tiles = Array.from({ length: 6 }, (_, index) => ({
  z: 20,
  x: index,
  y: 9,
  col: index,
  row: 0,
}));
const ok = (): TileFetchResponse<number> => ({ ok: true, status: 200, value: 1 });

describe('tile download progress', () => {
  it('reports cumulative resumed progress for planned keys and ignores extras', async () => {
    const progress: { complete: number; total: number; missing: number }[] = [];
    const plannedTiles = tiles.slice(0, 3);
    const savedKeys = ['20/0/9', '20/2/9', '20/99/9'];
    const downloader = createPoliteTileDownloader(plannedTiles, async () => ok(), {
      maxConcurrent: 1,
      completedKeys: savedKeys,
      onProgress: (complete, total, missing) => progress.push({ complete, total, missing }),
    });

    const result = await downloader.promise;

    expect(countPlannedTileKeys(plannedTiles, savedKeys)).toBe(2);
    expect(countPlannedTileKeys(plannedTiles, ['20/1/9', '20/99/9'])).toBe(1);
    expect(progress).toEqual([{ complete: 3, total: 3, missing: 0 }]);
    expect(result.completedCount).toBe(3);
    expect(result.completed).toHaveLength(1);
  });

  it('reports only completed tiles after cancellation', () => {
    expect(
      tileDownloadProgress(
        {
          completed: tiles.slice(0, 2),
          completedCount: 3,
          missing: [tiles[2]!],
          cancelled: true,
        },
        tiles.length,
      ),
    ).toEqual({ complete: 3, total: 6, missing: 1 });
  });
});

describe('polite tile downloading', () => {
  it('completes a 3,000-tile stub set without exceeding concurrency', async () => {
    const manyTiles = Array.from({ length: 3000 }, (_, index) => ({
      z: 20,
      x: index,
      y: 0,
      col: index,
      row: 0,
    }));
    let now = 0;
    let active = 0;
    let maximumActive = 0;
    const downloader = createPoliteTileDownloader(
      manyTiles,
      async () => {
        active++;
        maximumActive = Math.max(maximumActive, active);
        await Promise.resolve();
        active--;
        return ok();
      },
      {
        now: () => now,
        sleep: async (ms) => {
          now += ms;
        },
      },
    );
    const result = await downloader.promise;
    expect(result.completed).toHaveLength(3000);
    expect(maximumActive).toBeLessThanOrEqual(4);
  });

  it('never exceeds four in flight or five request starts per second', async () => {
    let now = 0;
    const starts: number[] = [];
    let active = 0;
    let maxActive = 0;
    const downloader = createPoliteTileDownloader(
      tiles,
      async () => {
        starts.push(now);
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 0));
        active--;
        return ok();
      },
      {
        now: () => now,
        sleep: async (ms) => {
          now += ms;
        },
        random: () => 1,
      },
    );

    const result = await downloader.promise;
    expect(maxActive).toBeLessThanOrEqual(4);
    const orderedStarts = [...starts].sort((a, b) => a - b);
    for (let i = 0; i <= orderedStarts.length - 6; i++) {
      expect(orderedStarts[i + 5]! - orderedStarts[i]!).toBeGreaterThanOrEqual(1000);
    }
    expect(result.completed).toHaveLength(6);
  });

  it('honors Retry-After when a server returns 429', async () => {
    let now = 0;
    let calls = 0;
    const sleeps: number[] = [];
    const downloader = createPoliteTileDownloader(
      tiles.slice(0, 1),
      async () => {
        calls++;
        return calls === 1 ? { ok: false, status: 429, retryAfter: '2' } : ok();
      },
      {
        now: () => now,
        sleep: async (ms) => {
          sleeps.push(ms);
          now += ms;
        },
        random: () => 1,
      },
    );

    const result = await downloader.promise;
    expect(calls).toBe(2);
    expect(sleeps[0]).toBe(2000);
    expect(result.completed).toHaveLength(1);
  });

  it('caps exponential backoff and gives a repeatedly failing tile up after six attempts', async () => {
    let now = 0;
    let calls = 0;
    const sleeps: number[] = [];
    const downloader = createPoliteTileDownloader(
      tiles.slice(0, 1),
      async () => {
        calls++;
        return { ok: false, status: 503 };
      },
      {
        now: () => now,
        sleep: async (ms) => {
          sleeps.push(ms);
          now += ms;
        },
        random: () => 1,
      },
    );

    const result = await downloader.promise;
    expect(calls).toBe(6);
    expect(sleeps).toEqual([1000, 2000, 4000, 8000, 16000]);
    expect(result.missing).toHaveLength(1);
  });

  it('pauses new requests, resumes, and skips tiles already stored before a reload', async () => {
    const started: number[] = [];
    let markPaused: (() => void) | undefined;
    const pausedAtFirst = new Promise<void>((resolve) => {
      markPaused = resolve;
    });
    const downloader = createPoliteTileDownloader(
      tiles.slice(0, 3),
      async (tile) => {
        started.push(tile.x);
        return ok();
      },
      {
        maxConcurrent: 1,
        completedKeys: ['20/0/9'],
        onTileComplete: (tile) => {
          if (tile.x === 1) {
            downloader.pause();
            markPaused?.();
          }
        },
      },
    );

    await pausedAtFirst;
    expect(started).toEqual([1]);
    downloader.resume();
    const result = await downloader.promise;
    expect(started).toEqual([1, 2]);
    expect(result.completed).toHaveLength(2);
  });
});

describe('tile retry delay', () => {
  it('parses Retry-After dates and caps exponential backoff with jitter', () => {
    expect(retryDelayMs(1, undefined, 0, () => 1)).toBe(1000);
    expect(retryDelayMs(7, undefined, 0, () => 1)).toBe(60_000);
    expect(retryDelayMs(1, '3', 0, () => 0)).toBe(3000);
    expect(retryDelayMs(1, '120', 0, () => 0)).toBe(120_000);
    expect(retryDelayMs(1, new Date(4000).toUTCString(), 0, () => 0)).toBe(4000);
  });
});
