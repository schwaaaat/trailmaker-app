// Lane B. The app's one gateway to the worker (card T-206). Every worker call goes through
// `call()`, which counts pending jobs (for TestHook.idle), and reports the cross-origin-isolation
// error once (D-013 item 3). The worker itself only ever comes from getWorker() (D-013).
//
// It also owns the map image lifecycle: each LoadedMap's raster is transferred to the worker once,
// its ImageId kept in the store, and released (with its running jobs cancelled) when the session
// moves to another map. Results of jobs started on an old map are dropped by `stillOn(map)`.
import { JOB_CANCELLED, type ImageId, type JobId, type WorkerApi } from '../core/types';
import type { LoadedMap } from '../ui/contract';
import { getWorker, newJobId } from '../worker/client';
import { appStore, showToast } from './store';

let override: { api: WorkerApi; ids: () => JobId } | null = null;

/** Tests: use a fake worker (and job ids) instead of getWorker(); null restores the real one. */
export function setWorkerForTests(api: WorkerApi | null, ids?: () => JobId): void {
  let n = 0;
  override = api ? { api, ids: ids ?? (() => `job-${++n}` as JobId) } : null;
}

function worker(): WorkerApi {
  return override?.api ?? (getWorker() as unknown as WorkerApi);
}

/** A fresh job id for a cancellable call. */
export function jobId(): JobId {
  return override ? override.ids() : newJobId();
}

/* ------------------------------------------------------------------ errors */

const reported = new WeakSet<object>();
let isolationToastShown = false;

/** True for the Error the worker throws when a job is cancelled. */
export function isCancelled(err: unknown): boolean {
  return err instanceof Error && err.name === JOB_CANCELLED;
}

/** True once an error has been shown to the user (so nobody toasts it again). */
export function isReported(err: unknown): boolean {
  return typeof err === 'object' && err !== null && reported.has(err);
}

const isIsolationError = (err: unknown): boolean =>
  err instanceof Error && /cross-origin isolation|SharedArrayBuffer/i.test(err.message);

function report(err: unknown): void {
  if (!isIsolationError(err)) return;
  reported.add(err as object);
  if (isolationToastShown) return;
  isolationToastShown = true;
  showToast(
    `Tracing needs this page to be cross-origin isolated (COOP/COEP headers). ${(err as Error).message}`,
    10000,
  );
}

/** Tests: allow the isolation toast to show again. */
export function resetIsolationToastForTests(): void {
  isolationToastShown = false;
}

/* ------------------------------------------------------------------ calls + idle */

let pending = 0;
let waiters: (() => void)[] = [];

/**
 * Run one worker call. Catches a synchronous throw from the client (it checks isolation before
 * any promise exists) as well as a rejection; reports the isolation error once and rethrows.
 */
export async function call<T>(fn: (api: WorkerApi) => Promise<T>): Promise<T> {
  pending++;
  try {
    return await Promise.resolve().then(() => fn(worker()));
  } catch (err) {
    report(err);
    throw err;
  } finally {
    pending--;
    if (pending === 0) {
      const done = waiters;
      waiters = [];
      for (const w of done) w();
    }
  }
}

/**
 * Count a multi-step task (several awaits around worker calls) as pending for its whole
 * duration, so idle() cannot resolve in a gap between its steps.
 */
export async function track<T>(task: Promise<T>): Promise<T> {
  pending++;
  try {
    return await task;
  } finally {
    pending--;
    if (pending === 0) {
      const done = waiters;
      waiters = [];
      for (const w of done) w();
    }
  }
}

/** Number of worker calls in flight. */
export function pendingJobs(): number {
  return pending;
}

/** Resolves when no worker call is in flight. */
export function jobsIdle(): Promise<void> {
  return pending === 0 ? Promise.resolve() : new Promise((r) => waiters.push(r));
}

/* ------------------------------------------------------------------ image lifecycle */

const images = new WeakMap<LoadedMap, Promise<ImageId>>();
const running = new Map<JobId, LoadedMap>();

/** The worker ImageId for `map`, transferring its raster the first time only. */
export function imageFor(map: LoadedMap): Promise<ImageId> {
  let id = images.get(map);
  if (!id) {
    id = call((api) => api.loadImage(map.raster));
    images.set(map, id);
    id.then(
      (value) => {
        if (appStore.getState().session?.map === map) appStore.setState({ imageId: value });
      },
      () => images.delete(map),
    );
  }
  return id;
}

/** True while the session is still on `map` (results for another map must be dropped). */
export function stillOn(map: LoadedMap): boolean {
  return appStore.getState().session?.map === map;
}

/** Register a cancellable job started for `map`; returns its id. Call `jobDone(id)` when it settles. */
export function startJob(map: LoadedMap): JobId {
  const id = jobId();
  running.set(id, map);
  return id;
}

export function jobDone(id: JobId): void {
  running.delete(id);
}

/** Ask the worker to cancel a job (no-op if it already finished). */
export function cancelJob(id: JobId): Promise<void> {
  return call((api) => api.cancel(id)).catch(() => undefined);
}

let linked: LoadedMap | null = null;

function onMap(map: LoadedMap | null): void {
  if (map === linked) return;
  const old = linked;
  linked = map;
  appStore.setState({ imageId: null });
  if (old) {
    for (const [id, m] of running) if (m === old) void cancelJob(id);
    const oldId = images.get(old);
    images.delete(old);
    if (oldId) {
      void oldId
        .then(
          (id) => call((api) => api.releaseImage(id)),
          () => undefined,
        )
        .catch(() => undefined);
    }
  }
  if (map) imageFor(map).catch(() => undefined);
}

let unlink: (() => void) | null = null;

/** Start following the session's map (idempotent). Returns a function that stops. */
export function linkWorkerToSession(): () => void {
  if (!unlink) {
    onMap(appStore.getState().session?.map ?? null);
    const off = appStore.subscribe((s, prev) => {
      if (s.session?.map !== prev.session?.map) onMap(s.session?.map ?? null);
    });
    unlink = () => {
      off();
      unlink = null;
      linked = null;
    };
  }
  return unlink;
}
