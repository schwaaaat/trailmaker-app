import { retryDelayMs } from './tile-downloader';
import type { DetailExportCell } from './max-detail-planner';

export interface DetailExportFetchResponse<T> {
  readonly ok: boolean;
  readonly status: number;
  readonly value?: T;
  readonly retryAfter?: string | null;
  readonly error?: string;
}

export interface DetailExportProgress {
  readonly completed: number;
  readonly total: number;
  readonly missing: number;
  readonly hourlyStartsRemaining?: number;
}

export interface DetailExportDownloadResult {
  /** Export cells completed during this run. */
  readonly completed: readonly DetailExportCell[];
  /** All completed keys from this run and any restored manifest. */
  readonly completedKeys: readonly string[];
  readonly missing: readonly DetailExportCell[];
  readonly deferred: readonly DetailExportCell[];
  readonly budgetExhausted: boolean;
  readonly cancelled: boolean;
}

export interface DetailExportDownloaderOptions {
  readonly completedKeys?: readonly string[];
  readonly minStartIntervalMs?: number;
  /** Previous export request start, used to preserve throttling across resumed sessions. */
  readonly lastStartAt?: number;
  readonly onStart?: (startedAt: number) => void;
  readonly maxAttempts?: number;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
  /** Called immediately before every network start; false defers this and later cells. */
  readonly beforeStart?: (cell: DetailExportCell, now: number) => boolean | Promise<boolean>;
  readonly hourlyStartsRemaining?: () => number;
  readonly onProgress?: (progress: DetailExportProgress) => void;
}

export interface PoliteExportDownloader {
  readonly promise: Promise<DetailExportDownloadResult>;
  pause(): void;
  resume(): void;
  cancel(): void;
}

export function detailExportKey(cell: Pick<DetailExportCell, 'x' | 'y'>): string {
  return `${cell.x}/${cell.y}`;
}

function retryable(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/** Runs expensive MapServer exports one at a time with a minimum delay between request starts. */
export function createPoliteExportDownloader<T>(
  cells: readonly DetailExportCell[],
  fetchExport: (
    cell: DetailExportCell,
    signal: AbortSignal,
  ) => Promise<DetailExportFetchResponse<T>>,
  storeExport: (cell: DetailExportCell, value: T) => void | Promise<void>,
  options: DetailExportDownloaderOptions = {},
): PoliteExportDownloader {
  const minStartIntervalMs = Math.max(3000, options.minStartIntervalMs ?? 3000);
  const maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? 6));
  const baseDelayMs = options.baseDelayMs ?? 1000;
  const maxDelayMs = options.maxDelayMs ?? 60_000;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const random = options.random ?? Math.random;
  const uniqueCells = [...new Map(cells.map((cell) => [detailExportKey(cell), cell])).values()];
  const plannedKeys = new Set(uniqueCells.map(detailExportKey));
  const completedKeys = new Set(
    (options.completedKeys ?? []).filter((key) => plannedKeys.has(key)),
  );
  const queue = uniqueCells.filter((cell) => !completedKeys.has(detailExportKey(cell)));
  const completed: DetailExportCell[] = [];
  const missing: DetailExportCell[] = [];
  const deferred: DetailExportCell[] = [];
  let cancelled = false;
  let paused = false;
  let pauseWait: Promise<void> | null = null;
  let resumePause: (() => void) | null = null;
  let activeController: AbortController | null = null;
  let lastStart: number | null = Number.isFinite(options.lastStartAt) ? options.lastStartAt! : null;
  let budgetExhausted = false;
  let signalCancelWait!: () => void;
  const cancelWait = new Promise<void>((resolve) => {
    signalCancelWait = resolve;
  });
  const delay = (ms: number) => Promise.race([sleep(ms), cancelWait]);

  const report = () =>
    options.onProgress?.({
      completed: completedKeys.size,
      total: uniqueCells.length,
      missing: missing.length,
      ...(options.hourlyStartsRemaining
        ? { hourlyStartsRemaining: options.hourlyStartsRemaining() }
        : {}),
    });

  const waitWhilePaused = async () => {
    while (paused && !cancelled) {
      pauseWait ??= new Promise<void>((resolve) => {
        resumePause = resolve;
      });
      await pauseWait;
      pauseWait = null;
    }
  };

  const waitForStart = async () => {
    await waitWhilePaused();
    if (cancelled || lastStart === null) return;
    const remaining = lastStart + minStartIntervalMs - now();
    if (remaining > 0) await delay(remaining);
    await waitWhilePaused();
  };

  const promise = (async (): Promise<DetailExportDownloadResult> => {
    report();
    for (let queueIndex = 0; queueIndex < queue.length; queueIndex++) {
      const cell = queue[queueIndex]!;
      if (cancelled) break;
      await waitWhilePaused();
      let lastError = new Error('Maximum-detail export failed.');
      let completedCell = false;

      for (let attempt = 1; attempt <= maxAttempts && !cancelled; attempt++) {
        await waitForStart();
        if (cancelled) break;
        if (options.beforeStart && !(await options.beforeStart(cell, now()))) {
          budgetExhausted = true;
          deferred.push(...queue.slice(queueIndex));
          break;
        }
        activeController = new AbortController();
        lastStart = now();
        options.onStart?.(lastStart);

        let response: DetailExportFetchResponse<T>;
        try {
          response = await fetchExport(cell, activeController.signal);
        } catch (error) {
          if (cancelled && error instanceof DOMException && error.name === 'AbortError') break;
          lastError = error instanceof Error ? error : new Error(String(error));
          if (attempt < maxAttempts) {
            await delay(retryDelayMs(attempt, null, now(), random, baseDelayMs, maxDelayMs));
            continue;
          }
          break;
        } finally {
          activeController = null;
        }

        if (response.ok) {
          if (response.value === undefined) {
            lastError = new Error('Maximum-detail export returned no image.');
          } else {
            await storeExport(cell, response.value);
            completed.push(cell);
            completedKeys.add(detailExportKey(cell));
            completedCell = true;
            report();
            break;
          }
        } else {
          lastError = new Error(
            response.error ?? `Maximum-detail export returned HTTP ${response.status}.`,
          );
          if (retryable(response.status) && attempt < maxAttempts) {
            await delay(
              retryDelayMs(attempt, response.retryAfter, now(), random, baseDelayMs, maxDelayMs),
            );
            continue;
          }
        }
        break;
      }

      if (cancelled) break;
      if (budgetExhausted) break;
      if (!completedCell) {
        missing.push(cell);
        report();
        if (!lastError.message) lastError = new Error('Maximum-detail export failed.');
      }
    }

    return {
      completed,
      completedKeys: [...completedKeys],
      missing,
      deferred,
      budgetExhausted,
      cancelled,
    };
  })();

  return {
    promise,
    pause: () => {
      paused = true;
    },
    resume: () => {
      paused = false;
      resumePause?.();
      resumePause = null;
      pauseWait = null;
    },
    cancel: () => {
      cancelled = true;
      paused = false;
      resumePause?.();
      resumePause = null;
      signalCancelWait();
      activeController?.abort();
    },
  };
}
