import {
  JOB_CANCELLED,
  type AutoTraceCandidate,
  type AutoTraceRequest,
  type ImageId,
  type JobControl,
  type JobHooks,
  type JobId,
  type JobProgress,
  type KmzRequest,
  type Px,
  type RasterImage,
  type Rgb,
  type SmartTraceRequest,
  type SmartTraceResult,
  type WorkerApi,
} from '../core/types';
import { buildKmz as writeKmz } from '../core/export/kmz';
import { pickInk as pickImageInk, snapToInk } from '../core/trace/ink';
import { tracePath } from '../core/trace/astar';
import { scanColors } from '../core/trace/scan';
import { autoTraceColor, deriveDefaultAutoTraceOptions } from '../core/trace/autotrace';
import { mergeCrossColorCandidates } from '../core/trace/crosscolor';
import { candidateConfidence } from '../core/trace/confidence';

/** Private field added by the typed main-thread bridge. Shared across the worker boundary. */
export interface InternalJobControl extends JobControl {
  readonly cancelFlag?: SharedArrayBuffer;
}

interface JobContext {
  readonly hooks: JobHooks;
  readonly flag: Int32Array;
  readonly flushProgress: () => Promise<void>;
  readonly dispose: () => void;
}

const PROGRESS_INTERVAL_MS = 50;
function cancelledError(): Error {
  const error = new Error('Job cancelled');
  error.name = JOB_CANCELLED;
  return error;
}

function createJobContext(control: InternalJobControl): JobContext {
  if (!control.jobId) throw new Error('Worker job requires a non-empty jobId');
  if (typeof SharedArrayBuffer === 'undefined') {
    throw new Error('SharedArrayBuffer cancellation requires cross-origin isolation');
  }
  const buffer = control.cancelFlag ?? new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  if (buffer.byteLength < Int32Array.BYTES_PER_ELEMENT) {
    throw new Error('Worker cancellation flag must contain at least one Int32');
  }
  const flag = new Int32Array(buffer);
  let lastSentAt = -Infinity;
  let pending: JobProgress | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let waiters: (() => void)[] = [];

  const throwIfCancelled = (): void => {
    if (Atomics.load(flag, 0) !== 0) throw cancelledError();
  };
  const notify = (event: JobProgress): void => {
    if (!control.onProgress) return;
    try {
      const result = (control.onProgress as (event: JobProgress) => unknown)(event);
      if (result && typeof (result as unknown as PromiseLike<void>).then === 'function') {
        void Promise.resolve(result).catch(() => {});
      }
    } catch {
      // A UI progress listener must not turn a successful worker job into a failure.
    }
  };
  const settleWaiters = (): void => {
    const ready = waiters;
    waiters = [];
    for (const resolve of ready) resolve();
  };
  const deliverPending = (): void => {
    timer = undefined;
    if (!pending) {
      settleWaiters();
      return;
    }
    const delay = PROGRESS_INTERVAL_MS - (performance.now() - lastSentAt);
    if (delay > 0) {
      timer = setTimeout(deliverPending, delay);
      return;
    }
    const event = pending;
    pending = undefined;
    lastSentAt = performance.now();
    notify(event);
    settleWaiters();
  };
  const schedulePending = (): void => {
    if (timer !== undefined || !pending) return;
    const delay = Math.max(0, PROGRESS_INTERVAL_MS - (performance.now() - lastSentAt));
    if (delay === 0) deliverPending();
    else timer = setTimeout(deliverPending, delay);
  };

  const hooks: JobHooks = {
    progress: (fraction, stage) => {
      throwIfCancelled();
      if (!control.onProgress) return;
      pending = { jobId: control.jobId, fraction, stage };
      schedulePending();
    },
    throwIfCancelled,
  };
  return {
    hooks,
    flag,
    flushProgress: () => {
      if (!pending) return Promise.resolve();
      return new Promise((resolve) => {
        waiters.push(resolve);
        schedulePending();
      });
    },
    dispose: () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      pending = undefined;
      settleWaiters();
    },
  };
}

/** Plain API factory so worker behavior can be tested directly in Node. */
export function createWorkerApi(kmzWriter: typeof writeKmz = writeKmz): WorkerApi {
  const images = new Map<ImageId, RasterImage>();
  const jobs = new Map<JobId, Int32Array>();
  let imageSequence = 0;
  let candidateSequence = 0;

  const imageFor = (id: ImageId): RasterImage => {
    const image = images.get(id);
    if (!image) throw new Error(`Unknown image id: ${id}`);
    return image;
  };
  const runJob = <T>(control: InternalJobControl, work: (hooks: JobHooks) => T): Promise<T> => {
    if (jobs.has(control.jobId))
      return Promise.reject(new Error(`Job already active: ${control.jobId}`));
    let context: JobContext;
    try {
      context = createJobContext(control);
    } catch (error) {
      return Promise.reject(error);
    }
    jobs.set(control.jobId, context.flag);
    return (async () => {
      try {
        context.hooks.throwIfCancelled();
        const result = work(context.hooks);
        await context.flushProgress();
        context.hooks.throwIfCancelled();
        return result;
      } finally {
        context.dispose();
        jobs.delete(control.jobId);
      }
    })();
  };

  return {
    loadImage: async (image) => {
      if (
        !Number.isInteger(image.width) ||
        !Number.isInteger(image.height) ||
        image.width < 1 ||
        image.height < 1
      ) {
        throw new Error('Raster image dimensions must be positive integers');
      }
      if (image.data.length !== image.width * image.height * 4) {
        throw new Error('Raster image data length does not match its dimensions');
      }
      const id = `image-${++imageSequence}` as ImageId;
      images.set(id, image);
      return id;
    },
    releaseImage: async (id) => {
      images.delete(id);
    },
    pickInk: async (id, at: Px, radiusPx) => pickImageInk(imageFor(id), at, radiusPx),
    snapToInk: async (id, at: Px, ink: Rgb, tolerance, radiusPx) =>
      snapToInk(imageFor(id), at, ink, tolerance, radiusPx),
    smartTrace: async (request: SmartTraceRequest, control) => {
      const image = imageFor(request.imageId);
      return await runJob(control, (hooks) => {
        const started = performance.now();
        const snappedTo =
          snapToInk(
            image,
            request.to,
            request.ink,
            request.tolerance,
            Math.max(2, Math.min(30, request.snapRadiusPx)),
          ) ?? request.to;
        const path = tracePath(
          image,
          request.from,
          snappedTo,
          request.ink,
          request.tolerance,
          hooks,
        );
        return { path, snappedTo, ms: performance.now() - started } satisfies SmartTraceResult;
      });
    },
    scanColors: async (id, control) => {
      const image = imageFor(id);
      return await runJob(control, (hooks) => scanColors(image, hooks));
    },
    autoTrace: async (request: AutoTraceRequest, control) => {
      const image = imageFor(request.imageId);
      return await runJob(control, (hooks) => {
        const candidates: AutoTraceCandidate[] = [];
        const colorCount = request.colors.length;
        if (!colorCount) {
          hooks.progress(1, 'Auto-trace complete');
          return candidates;
        }
        // Per-color work (trace, then confidence) fills [0, 0.9) when a cross-color merge follows.
        const perColorSpan = request.mergeAcrossColors ? 0.9 : 1;
        for (let colorIndex = 0; colorIndex < colorCount; colorIndex++) {
          hooks.throwIfCancelled();
          const color = request.colors[colorIndex]!;
          const options = deriveDefaultAutoTraceOptions(image, color.rgb, {
            tolerance: request.tolerance,
            gapPx: request.gapPx,
            minLengthPx: request.minLengthPx,
          });
          const lines = autoTraceColor(
            image,
            color.rgb,
            options,
            {
              throwIfCancelled: hooks.throwIfCancelled,
              progress: (fraction, stage) =>
                hooks.progress(
                  ((colorIndex + fraction * 0.9) / colorCount) * perColorSpan,
                  `${color.chipId}: ${stage}`,
                ),
            },
          );
          for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
            const line = lines[lineIndex]!;
            const confidence = candidateConfidence(image, color.rgb, line.pts, line.lengthPx, {
              tolerance: options.tolerance,
              minLengthPx: options.minLengthPx,
            }, hooks);
            candidates.push({
              id: `candidate-${++candidateSequence}`,
              chipId: color.chipId,
              pts: line.pts,
              lengthPx: line.lengthPx,
              ink: [...color.rgb],
              confidence,
            });
            hooks.progress(
              ((colorIndex + 0.9 + 0.1 * ((lineIndex + 1) / lines.length)) / colorCount) * perColorSpan,
              `${color.chipId}: Score candidate confidence`,
            );
          }
          if (!lines.length)
            hooks.progress(((colorIndex + 1) / colorCount) * perColorSpan, `${color.chipId}: Score candidate confidence`);
        }
        if (request.mergeAcrossColors) {
          hooks.progress(0.9, 'Merge cross-color candidates');
          const merged = mergeCrossColorCandidates(candidates, request.gapPx, {
            throwIfCancelled: hooks.throwIfCancelled,
            progress: (fraction, stage) => hooks.progress(0.9 + fraction * 0.09, stage),
          });
          hooks.throwIfCancelled();
          hooks.progress(1, 'Auto-trace complete');
          return merged;
        }
        hooks.progress(1, 'Auto-trace complete');
        return candidates;
      });
    },
    buildKmz: (request: KmzRequest, control) =>
      runJob(control, (hooks) => {
        hooks.progress(0, 'Building KMZ');
        hooks.throwIfCancelled();
        const bytes = kmzWriter(request, hooks);
        hooks.throwIfCancelled();
        hooks.progress(1, 'KMZ complete');
        return bytes;
      }),
    cancel: async (jobId) => {
      const flag = jobs.get(jobId);
      if (flag) Atomics.store(flag, 0, 1);
    },
  };
}
