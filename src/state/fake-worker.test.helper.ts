// Lane B test support: a scriptable fake WorkerApi (T-206). Excluded from the app build.
import {
  JOB_CANCELLED,
  type AutoTraceCandidate,
  type ColorScanResult,
  type ImageId,
  type JobControl,
  type JobId,
  type Px,
  type Rgb,
  type SmartTraceResult,
  type WorkerApi,
} from '../core/types';

export interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(v: T): void;
  reject(e: unknown): void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}

export function cancelledError(): Error {
  const err = new Error('Job cancelled');
  err.name = JOB_CANCELLED;
  return err;
}

export interface Call {
  readonly method: keyof WorkerApi;
  readonly args: readonly unknown[];
}

/**
 * A WorkerApi whose methods record their calls and return scripted results. Cancellable methods
 * reject with JobCancelled when `cancel(jobId)` is called while they are pending (like the real
 * worker), so tests can drive cancellation.
 */
export function fakeWorker(over: Partial<WorkerApi> = {}) {
  const calls: Call[] = [];
  const pendingJobs = new Map<JobId, (err: Error) => void>();
  let images = 0;
  const track = <T>(ctl: JobControl, work: Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      pendingJobs.set(ctl.jobId, reject);
      work.then(resolve, reject).finally(() => pendingJobs.delete(ctl.jobId));
    });
  const base: WorkerApi = {
    loadImage: async () => `image-${++images}` as ImageId,
    releaseImage: async () => {},
    pickInk: async (): Promise<Rgb> => [200, 40, 40],
    snapToInk: async (_id, at): Promise<Px | null> => [at[0] + 1, at[1]],
    smartTrace: async (req): Promise<SmartTraceResult> => ({
      path: [req.from, [(req.from[0] + req.to[0]) / 2, req.from[1]], req.to],
      snappedTo: req.to,
      ms: 5,
    }),
    refineTrail: async (req) => ({
      pts: req.pts,
      segments: [{ from: 0, to: req.pts.length - 1, refined: false, confidence: 0 }],
      ink: req.ink ?? [0, 0, 0],
      ms: 5,
    }),
    scanColors: async (): Promise<ColorScanResult> => ({ colors: [] }),
    autoTrace: async (): Promise<readonly AutoTraceCandidate[]> => [],
    buildKmz: async () => new Uint8Array(),
    cancel: async (jobId) => {
      pendingJobs.get(jobId)?.(cancelledError());
    },
  };
  const impl = { ...base, ...over };
  const api = {} as Record<keyof WorkerApi, unknown>;
  for (const method of Object.keys(impl) as (keyof WorkerApi)[]) {
    api[method] = (...args: unknown[]) => {
      calls.push({ method, args });
      const fn = impl[method] as (...a: unknown[]) => Promise<unknown>;
      const result = fn(...args);
      const ctl = args[args.length - 1] as JobControl | undefined;
      const cancellable = ['smartTrace', 'refineTrail', 'scanColors', 'autoTrace', 'buildKmz'].includes(method);
      return cancellable && ctl?.jobId ? track(ctl, result) : result;
    };
  }
  return {
    api: api as unknown as WorkerApi,
    calls,
    of: (method: keyof WorkerApi) => calls.filter((c) => c.method === method),
  };
}
