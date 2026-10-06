import { describe, expect, it } from 'vitest';
import {
  createPoliteExportDownloader,
  type DetailExportFetchResponse,
} from './max-detail-downloader';
import { planDetailExportAt } from './max-detail-planner';

describe('polite maximum-detail export downloader', () => {
  it('serializes exports and waits at least three seconds between request starts', async () => {
    let now = 0;
    let active = 0;
    let maxActive = 0;
    const starts: number[] = [];
    const cells = [
      planDetailExportAt([27.135, -80.172]),
      planDetailExportAt([27.135, -80.169]),
      planDetailExportAt([27.135, -80.166]),
    ];
    const downloader = createPoliteExportDownloader(
      cells,
      async () => {
        starts.push(now);
        active++;
        maxActive = Math.max(maxActive, active);
        await Promise.resolve();
        active--;
        return { ok: true, status: 200, value: 'image' };
      },
      async () => undefined,
      {
        now: () => now,
        sleep: async (delay) => {
          now += delay;
        },
      },
    );

    const result = await downloader.promise;
    expect(maxActive).toBe(1);
    expect(starts).toHaveLength(cells.length);
    expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(3000);
    expect(starts[2]! - starts[1]!).toBeGreaterThanOrEqual(3000);
    expect(result.completed).toHaveLength(cells.length);
    expect(result.cancelled).toBe(false);
  });

  it('preserves the minimum interval when a resumed session has a prior start time', async () => {
    let now = 10_000;
    const cells = [planDetailExportAt([27.135, -80.172])];
    let startedAt = 0;
    const delays: number[] = [];
    const downloader = createPoliteExportDownloader(
      cells,
      async () => ({ ok: true, status: 200, value: 'image' }),
      async () => undefined,
      {
        now: () => now,
        lastStartAt: 8_000,
        sleep: async (delay) => {
          delays.push(delay);
          now += delay;
        },
        onStart: (time) => {
          startedAt = time;
        },
      },
    );

    await downloader.promise;
    expect(delays[0]).toBeGreaterThanOrEqual(1000);
    expect(startedAt - 8_000).toBeGreaterThanOrEqual(3000);
  });

  it('resumes completed export keys and retries retryable service responses', async () => {
    let now = 0;
    let firstCellCalls = 0;
    const cells = [planDetailExportAt([27.135, -80.172]), planDetailExportAt([27.14, -80.172])];
    const saved = [`${cells[0]!.x}/${cells[0]!.y}`];
    const downloader = createPoliteExportDownloader(
      cells,
      async (cell): Promise<DetailExportFetchResponse<string>> => {
        if (cell === cells[1] && firstCellCalls++ === 0) {
          return { ok: false, status: 429, retryAfter: '4' };
        }
        return { ok: true, status: 200, value: 'image' };
      },
      async () => undefined,
      {
        completedKeys: saved,
        now: () => now,
        sleep: async (delay) => {
          now += delay;
        },
        random: () => 1,
      },
    );

    const result = await downloader.promise;
    expect(result.completed).toHaveLength(1);
    expect(result.completedKeys).toHaveLength(2);
    expect(result.missing).toHaveLength(0);
    expect(firstCellCalls).toBe(2);
  });

  it('can pause between exports and cancel the queued cells', async () => {
    const cells = [planDetailExportAt([27.135, -80.172]), planDetailExportAt([27.135, -80.169])];
    let starts = 0;
    let signalPaused!: () => void;
    const paused = new Promise<void>((resolve) => {
      signalPaused = resolve;
    });
    const downloader: ReturnType<typeof createPoliteExportDownloader<string>> =
      createPoliteExportDownloader(
        cells,
        async () => {
          starts++;
          return { ok: true, status: 200, value: 'image' };
        },
        async () => undefined,
        {
          onProgress: ({ completed }) => {
            if (completed === 1) {
              downloader.pause();
              signalPaused();
            }
          },
        },
      );

    await paused;
    downloader.cancel();
    const result = await downloader.promise;
    expect(starts).toBe(1);
    expect(result.cancelled).toBe(true);
    expect(result.completed).toHaveLength(1);
  });

  it('defers queued cells when the shared hourly budget is exhausted', async () => {
    const cells = [planDetailExportAt([27.135, -80.172]), planDetailExportAt([27.135, -80.169])];
    let starts = 0;
    const downloader = createPoliteExportDownloader(
      cells,
      async () => {
        starts++;
        return { ok: true, status: 200, value: 'image' };
      },
      async () => undefined,
      {
        now: () => 0,
        sleep: async () => undefined,
        beforeStart: () => starts === 0,
      },
    );

    const result = await downloader.promise;
    expect(starts).toBe(1);
    expect(result.completed).toHaveLength(1);
    expect(result.deferred).toEqual([cells[1]]);
    expect(result.budgetExhausted).toBe(true);
    expect(result.missing).toEqual([]);
  });
});
