import type { PlannedMapTile } from './tiled-capture';

export interface TileFetchResponse<T> {
  readonly ok: boolean;
  readonly status: number;
  readonly value?: T;
  readonly retryAfter?: string | null;
}

export interface TileDownloaderOptions<T> {
  readonly maxConcurrent?: number;
  readonly maxStartsPerSecond?: number;
  readonly maxAttempts?: number;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly completedKeys?: readonly string[];
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
  readonly onTileComplete?: (tile: PlannedMapTile, value: T) => void | Promise<void>;
  readonly onTileMissing?: (tile: PlannedMapTile, error: Error) => void | Promise<void>;
  readonly onProgress?: (completed: number, total: number, missing: number) => void;
}

export interface TileDownloadResult {
  readonly completed: readonly PlannedMapTile[];
  /** Count of all plan tiles already complete, including tiles skipped from prior sessions. */
  readonly completedCount: number;
  readonly missing: readonly PlannedMapTile[];
  readonly cancelled: boolean;
}

export function tileDownloadProgress(
  result: TileDownloadResult,
  total: number,
): { readonly complete: number; readonly total: number; readonly missing: number } {
  return { complete: result.completedCount, total, missing: result.missing.length };
}

/** Counts keys that belong to this plan, ignoring stale or unrelated manifest keys. */
export function countPlannedTileKeys(
  tiles: readonly PlannedMapTile[],
  keys: Iterable<string>,
): number {
  const includedKeys = new Set(keys);
  return tiles.reduce((count, tile) => count + Number(includedKeys.has(tileDownloadKey(tile))), 0);
}

export interface PoliteTileDownloader {
  readonly promise: Promise<TileDownloadResult>;
  pause(): void;
  resume(): void;
  cancel(): void;
}

export function tileDownloadKey(tile: Pick<PlannedMapTile, 'z' | 'x' | 'y'>): string {
  return `${tile.z}/${tile.x}/${tile.y}`;
}

function retryAfterMs(value: string | null | undefined, now: number): number | null {
  if (!value) return null;
  const seconds = Number(value.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

export function retryDelayMs(
  attempt: number,
  retryAfter: string | null | undefined,
  now = Date.now(),
  random = Math.random,
  baseDelayMs = 1000,
  maxDelayMs = 60_000,
): number {
  const exponential = Math.min(maxDelayMs, baseDelayMs * 2 ** Math.max(0, attempt - 1));
  const jittered = Math.round(exponential * (0.5 + Math.max(0, Math.min(1, random())) * 0.5));
  return Math.max(jittered, retryAfterMs(retryAfter, now) ?? 0);
}

function responseRetryable(response: TileFetchResponse<unknown>): boolean {
  return response.status === 408 || response.status === 429 || response.status >= 500;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/** Starts no more than four cache requests concurrently and five per rolling second by default. */
export function createPoliteTileDownloader<T>(
  tiles: readonly PlannedMapTile[],
  fetchTile: (tile: PlannedMapTile) => Promise<TileFetchResponse<T>>,
  options: TileDownloaderOptions<T> = {},
): PoliteTileDownloader {
  const maxConcurrent = Math.max(1, Math.floor(options.maxConcurrent ?? 4));
  const maxStartsPerSecond = Math.max(1, Math.floor(options.maxStartsPerSecond ?? 5));
  const maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? 6));
  const baseDelayMs = options.baseDelayMs ?? 1000;
  const maxDelayMs = options.maxDelayMs ?? 60_000;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const random = options.random ?? Math.random;
  const completedSet = new Set(options.completedKeys ?? []);
  const plannedKeys = new Set(tiles.map(tileDownloadKey));
  const completedPlannedKeys = new Set([...completedSet].filter((key) => plannedKeys.has(key)));
  const queue = tiles.filter((tile) => !completedSet.has(tileDownloadKey(tile)));
  const completed: PlannedMapTile[] = [];
  const missing: PlannedMapTile[] = [];
  const starts: number[] = [];
  let cursor = 0;
  let paused = false;
  let cancelled = false;
  let pauseWait: Promise<void> | null = null;
  let resumePause: (() => void) | null = null;

  const waitWhilePaused = async () => {
    while (paused && !cancelled) {
      pauseWait ??= new Promise<void>((resolve) => {
        resumePause = resolve;
      });
      await pauseWait;
      pauseWait = null;
    }
  };

  const waitForStartSlot = async () => {
    while (!cancelled) {
      await waitWhilePaused();
      const current = now();
      while (starts.length && current - starts[0]! >= 1000) starts.shift();
      if (starts.length < maxStartsPerSecond) {
        starts.push(current);
        return;
      }
      await sleep(Math.max(1, starts[0]! + 1000 - current));
    }
  };

  const total = tiles.length;
  const report = () => options.onProgress?.(completedPlannedKeys.size, total, missing.length);

  const worker = async () => {
    while (cursor < queue.length && !cancelled) {
      await waitWhilePaused();
      if (cancelled) return;
      const tile = queue[cursor++];
      if (!tile) return;
      let lastError = new Error('Tile request failed.');

      for (let attempt = 1; attempt <= maxAttempts && !cancelled; attempt++) {
        await waitForStartSlot();
        if (cancelled) return;
        let response: TileFetchResponse<T>;
        try {
          response = await fetchTile(tile);
        } catch (error) {
          lastError = asError(error);
          if (attempt < maxAttempts) {
            await sleep(retryDelayMs(attempt, null, now(), random, baseDelayMs, maxDelayMs));
            continue;
          }
          break;
        }

        if (response.ok) {
          try {
            await options.onTileComplete?.(tile, response.value as T);
          } catch (error) {
            cancelled = true;
            throw asError(error);
          }
          completed.push(tile);
          const key = tileDownloadKey(tile);
          completedSet.add(key);
          completedPlannedKeys.add(key);
          report();
          lastError = new Error('');
          break;
        }

        lastError = new Error(`Tile request returned HTTP ${response.status}.`);
        if (responseRetryable(response) && attempt < maxAttempts) {
          await sleep(
            retryDelayMs(attempt, response.retryAfter, now(), random, baseDelayMs, maxDelayMs),
          );
          continue;
        }
        break;
      }

      if (lastError.message) {
        missing.push(tile);
        await options.onTileMissing?.(tile, lastError);
        report();
      }
    }
  };

  const promise = (async (): Promise<TileDownloadResult> => {
    await Promise.all(
      Array.from({ length: Math.min(maxConcurrent, queue.length) }, () => worker()),
    );
    return {
      completed,
      completedCount: completedPlannedKeys.size,
      missing,
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
      pauseWait = null;
    },
  };
}
