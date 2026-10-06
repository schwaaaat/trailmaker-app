import {
  createPoliteExportDownloader,
  detailExportKey,
  type DetailExportProgress,
  type DetailExportDownloadResult,
  type DetailExportDownloaderOptions,
  type PoliteExportDownloader,
} from './max-detail-downloader';
import type { DetailExportCell } from './max-detail-planner';
import { planDetailExportAt, planDetailExportNeighborhood } from './max-detail-planner';
import type { LatLon } from '../core/types';
import { createRollingExportBudget, type RollingExportBudget } from './max-detail-budget';
import {
  fetchDetailExportBlob,
  detailExportLocalTiles,
  storeDetailExportBlob,
  type DetailMapExtent,
} from './max-detail-export';
import {
  getDetailDownload,
  getDetailExportBudget,
  putDetailDownload,
  putDetailExportBudget,
  type DetailDownloadManifest,
} from './tile-store';

export interface MaximumDetailDownloadOptions extends DetailExportDownloaderOptions {
  readonly serviceUrl?: string;
  /** Enables the persisted 60-start rolling-hour budget used by Path B. */
  readonly fillIn?: boolean;
}

export interface MaximumDetailFillInController {
  setEnabled(enabled: boolean): Promise<void>;
  updateFocus(focus: LatLon): Promise<void>;
  pause(): void;
  resume(): void;
  cancel(): Promise<void>;
}

export interface MaximumDetailFillInControllerOptions {
  readonly startDownload?: typeof startMaximumDetailDownload;
  /** Reports asynchronous session setup errors while leaving later focus updates usable. */
  readonly onError?: (error: unknown) => void;
  readonly onProgress?: (progress: DetailExportProgress) => void;
}

/** Keeps a small detail neighborhood centered on the latest local focus position. */
export function createMaximumDetailFillInController(
  mapId: string,
  sourceId: string,
  extent: DetailMapExtent,
  options: MaximumDetailFillInControllerOptions = {},
): MaximumDetailFillInController {
  const startDownload = options.startDownload ?? startMaximumDetailDownload;
  let enabled = false;
  let focus: LatLon | null = null;
  let centerKey: string | null = null;
  let session: PoliteExportDownloader | null = null;
  let generation = 0;
  let transition = Promise.resolve();

  const replaceNeighborhood = async (nextFocus: LatLon) => {
    const nextCenter = planDetailExportAt(nextFocus);
    const nextKey = detailExportKey(nextCenter);
    if (!enabled || nextKey === centerKey) return;

    const ticket = ++generation;
    const previous = session;
    session = null;
    centerKey = nextKey;
    if (previous) {
      previous.cancel();
      await previous.promise.catch(() => undefined);
    }
    if (!enabled || ticket !== generation || !focus) return;

    // Keep the planner's center-first ordering while excluding exports that
    // cannot contribute any tiles to this saved map extent.
    const cells = planDetailExportNeighborhood(focus).filter(
      (cell) => detailExportLocalTiles(cell, extent).length > 0,
    );
    let nextSession: PoliteExportDownloader;
    try {
      nextSession = await startDownload(mapId, sourceId, extent, cells, {
        fillIn: true,
        ...(options.onProgress ? { onProgress: options.onProgress } : {}),
      });
    } catch (error) {
      if (ticket === generation && centerKey === nextKey) centerKey = null;
      throw error;
    }
    if (!enabled || ticket !== generation) {
      nextSession.cancel();
      await nextSession.promise.catch(() => undefined);
      return;
    }
    session = nextSession;
    void nextSession.promise
      .finally(() => {
        if (session === nextSession) session = null;
      })
      .catch(() => undefined);
  };

  const enqueue = (operation: () => Promise<void>) => {
    const task = transition.then(operation);
    transition = task.catch((error: unknown) => {
      try {
        options.onError?.(error);
      } catch {
        // Error reporting must not poison the serial queue.
      }
    });
    return task;
  };

  const enqueueFocus = (nextFocus: LatLon) => {
    focus = nextFocus;
    return enqueue(() => replaceNeighborhood(nextFocus));
  };

  const setEnabled = (nextEnabled: boolean) => {
    enabled = nextEnabled;
    if (!enabled) {
      generation++;
      centerKey = null;
      const active = session;
      session = null;
      active?.cancel();
      return enqueue(async () => {
        await active?.promise.catch(() => undefined);
      });
    }
    return focus ? enqueueFocus(focus) : transition;
  };

  return {
    setEnabled,
    updateFocus: enqueueFocus,
    pause: () => session?.pause(),
    resume: () => session?.resume(),
    cancel: async () => {
      enabled = false;
      generation++;
      centerKey = null;
      const active = session;
      session = null;
      active?.cancel();
      await transition;
      await active?.promise.catch(() => undefined);
    },
  };
}

export async function maximumDetailExportsRemaining(now = Date.now()): Promise<number> {
  const record = await getDetailExportBudget();
  return createRollingExportBudget(record ? { starts: record.starts } : {}).remaining(now);
}

/** Starts or resumes a Martin County detail plan without overwriting the z20 download manifest. */
export async function startMaximumDetailDownload(
  mapId: string,
  sourceId: string,
  extent: DetailMapExtent,
  cells: readonly DetailExportCell[],
  options: MaximumDetailDownloadOptions = {},
): Promise<PoliteExportDownloader> {
  if (sourceId !== 'martin-county') {
    throw new Error('Maximum-detail exports are available only for Martin County cached maps.');
  }
  if (!mapId) throw new Error('A tiled map id is required to download maximum-detail imagery.');
  if (extent.sourceZoom !== 20) {
    throw new Error('Maximum-detail exports require Martin County z20 base imagery.');
  }
  if (cells.length > 40) {
    throw new Error('This download exceeds the 40-export limit. Draw a smaller area to continue.');
  }

  const previous = await getDetailDownload(mapId);
  const budgetRecord = options.fillIn ? await getDetailExportBudget() : undefined;
  const budget: RollingExportBudget | undefined = options.fillIn
    ? createRollingExportBudget(budgetRecord ? { starts: budgetRecord.starts } : {})
    : undefined;
  const now = options.now ?? Date.now;
  const planKeys = new Set(cells.map(detailExportKey));
  const completedKeys: string[] = (
    previous?.sourceId === sourceId ? previous.completedKeys : []
  ).filter((key) => planKeys.has(key));
  let status: DetailDownloadManifest['status'] = 'downloading';
  let savedMissingKeys: readonly string[] = [];
  const saveManifest = (overrides: Partial<DetailDownloadManifest> = {}) =>
    putDetailDownload({
      mapId,
      sourceId,
      cells: cells.map(({ x, y }) => ({ x, y })),
      completedKeys,
      missingKeys: savedMissingKeys,
      status,
      updatedAt: new Date().toISOString(),
      ...overrides,
    });

  await saveManifest();
  const lastStartAt = (budgetRecord?.starts ?? []).reduce<number | null>(
    (latest, startedAt) => (latest === null || startedAt > latest ? startedAt : latest),
    options.lastStartAt ?? null,
  );
  const downloader = createPoliteExportDownloader<Blob>(
    cells,
    (cell, signal) => fetchDetailExportBlob(cell, signal, options.serviceUrl),
    async (cell, blob) => {
      await storeDetailExportBlob(mapId, cell, extent, blob);
      completedKeys.push(detailExportKey(cell));
      await saveManifest();
    },
    {
      ...options,
      completedKeys,
      ...(lastStartAt === null ? {} : { lastStartAt }),
      beforeStart: async (cell, now) => {
        if (options.beforeStart && !(await options.beforeStart(cell, now))) return false;
        if (!budget) return true;
        if (!budget.tryStart(now)) return false;
        await putDetailExportBudget(budget.timestamps(now));
        return true;
      },
      ...(budget ? { hourlyStartsRemaining: () => budget.remaining(now()) } : {}),
    },
  );

  const promise: Promise<DetailExportDownloadResult> = downloader.promise.then(
    async (result) => {
      status = result.cancelled
        ? 'cancelled'
        : result.missing.length || result.budgetExhausted
          ? 'paused'
          : 'complete';
      savedMissingKeys = result.missing.map(detailExportKey);
      await saveManifest({ completedKeys: result.completedKeys });
      return result;
    },
    async (error: unknown) => {
      status = 'paused';
      await saveManifest();
      throw error;
    },
  );

  return {
    promise,
    pause: () => {
      status = 'paused';
      downloader.pause();
      void saveManifest();
    },
    resume: () => {
      status = 'downloading';
      downloader.resume();
      void saveManifest();
    },
    cancel: () => {
      status = 'cancelled';
      downloader.cancel();
      void saveManifest();
    },
  };
}
