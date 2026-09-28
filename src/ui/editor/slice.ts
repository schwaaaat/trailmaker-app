// Lane B. Cooperative time-slicing for main-thread work that would otherwise block longer than
// AGENTS.md section 6's 50 ms (card T-211). Work runs in slices of at most SLICE_MS, each in its
// own task, so input and frames are handled between slices.
import { JOB_CANCELLED } from '../../core/types';

/** Longest single slice of sliced work, ms (T-211 acceptance 1). */
export const SLICE_MS = 8;

/** Queue `fn` as a new task; returns a function that unqueues it. */
export type PostTask = (fn: () => void) => () => void;

interface TaskScheduler {
  postTask(
    fn: () => void,
    opts: { priority: 'user-visible'; signal: AbortSignal },
  ): Promise<unknown>;
}

/**
 * The default PostTask. It uses `scheduler.postTask` where available (Chromium); otherwise a
 * MessageChannel message, which, unlike setTimeout, is not clamped to 4 ms when nested.
 */
export const postTask: PostTask = (fn) => {
  const sched = (globalThis as { scheduler?: TaskScheduler }).scheduler;
  if (sched && typeof sched.postTask === 'function') {
    const ctl = new AbortController();
    sched.postTask(fn, { priority: 'user-visible', signal: ctl.signal }).catch(() => undefined);
    return () => ctl.abort();
  }
  const ch = new MessageChannel();
  let live = true;
  ch.port1.onmessage = () => {
    ch.port1.close();
    if (live) fn();
  };
  ch.port2.postMessage(null);
  return () => {
    live = false;
    ch.port1.close();
  };
};

/**
 * One step of sliced work. It does work until `timeUp()` returns true or the work is finished,
 * and returns true when finished. It should check `timeUp()` often enough that a slice overruns
 * the budget by well under a millisecond.
 */
export type Step = (timeUp: () => boolean) => boolean;

/**
 * Runs one sliced job at a time. `run` replaces (cancels) any job still in progress.
 * `onDone` runs in the task that finishes the job.
 */
export class Slicer {
  private unqueue: (() => void) | null = null;
  /** Slices run so far, and the longest one (ms), for tests and the perf log. */
  readonly stats = { slices: 0, maxSliceMs: 0 };

  constructor(
    private readonly post: PostTask = postTask,
    private readonly now: () => number = () => performance.now(),
    private readonly budgetMs = SLICE_MS,
  ) {}

  /** Whether a job is queued or in progress. */
  get busy(): boolean {
    return this.unqueue !== null;
  }

  run(step: Step, onDone: () => void): void {
    this.cancel();
    const slice = () => {
      const t0 = this.now();
      const deadline = t0 + this.budgetMs;
      const done = step(() => this.now() >= deadline);
      const ms = this.now() - t0;
      this.stats.slices++;
      this.stats.maxSliceMs = Math.max(this.stats.maxSliceMs, ms);
      if (done) {
        this.unqueue = null;
        onDone();
      } else {
        this.unqueue = this.post(slice);
      }
    };
    this.unqueue = this.post(slice);
  }

  cancel(): void {
    this.unqueue?.();
    this.unqueue = null;
  }
}

export interface RunSlicedOptions {
  /** Checked between slices; when it returns true the run rejects with a JobCancelled error. */
  readonly cancelled?: () => boolean;
  readonly post?: PostTask;
  readonly now?: () => number;
  readonly budgetMs?: number;
}

/** The error runSliced rejects with when cancelled (worker-link's isCancelled recognizes it). */
export function cancelledError(): Error {
  const err = new Error('Cancelled');
  err.name = JOB_CANCELLED;
  return err;
}

/**
 * Run a step generator (each `next()` a small piece of work) in time slices of at most the budget,
 * each slice in its own task, and resolve with its return value. The first slice runs in a later
 * task, so a busy indicator set just before can paint first.
 */
export async function runSliced<T>(
  steps: Generator<unknown, T, undefined>,
  {
    cancelled = () => false,
    post = postTask,
    now = () => performance.now(),
    budgetMs = SLICE_MS,
  }: RunSlicedOptions = {},
): Promise<T> {
  for (;;) {
    await new Promise<void>((resolve) => post(resolve));
    if (cancelled()) {
      steps.return(undefined as never);
      throw cancelledError();
    }
    const deadline = now() + budgetMs;
    do {
      const r = steps.next();
      if (r.done) return r.value;
    } while (now() < deadline);
  }
}
