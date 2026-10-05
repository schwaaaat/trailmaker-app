import * as Comlink from 'comlink';
import type { Remote } from 'comlink';
import type { ImageId, JobControl, JobId, RasterImage, WorkerApi } from '../core/types';
import type { InternalJobControl } from './api';

const CANCELLABLE = new Set<keyof WorkerApi>([
  'smartTrace',
  'refineTrail',
  'scanColors',
  'autoTrace',
  'buildKmz',
]);
type WorkerMethod = keyof WorkerApi;

function cancellationFlag(): SharedArrayBuffer {
  if (typeof SharedArrayBuffer === 'undefined') {
    throw new Error('Worker cancellation requires SharedArrayBuffer support');
  }
  if (typeof crossOriginIsolated !== 'undefined' && !crossOriginIsolated) {
    throw new Error('Worker cancellation requires COOP/COEP cross-origin isolation headers');
  }
  return new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
}

/** Add client-side atomic cancellation and transfer handling around a Comlink remote. */
export function createWorkerClient(remote: Remote<WorkerApi>): Remote<WorkerApi> {
  const activeFlags = new Map<JobId, Int32Array>();
  return new Proxy(remote, {
    get(target, property, receiver) {
      const method = property as WorkerMethod;
      if (method === 'loadImage') {
        return (image: RasterImage) =>
          target.loadImage(Comlink.transfer(image, [image.data.buffer]));
      }
      if (method === 'cancel') {
        return async (jobId: JobId) => {
          const flag = activeFlags.get(jobId);
          if (flag) Atomics.store(flag, 0, 1);
          await target.cancel(jobId);
        };
      }
      if (CANCELLABLE.has(method)) {
        return (...args: unknown[]) => {
          const controlIndex = args.length - 1;
          const control = args[controlIndex] as JobControl | undefined;
          if (!control?.jobId) return Reflect.get(target, property, receiver)(...args);
          if (activeFlags.has(control.jobId)) {
            return Promise.reject(new Error(`Job already active: ${control.jobId}`));
          }

          const shared = cancellationFlag();
          const flag = new Int32Array(shared);
          activeFlags.set(control.jobId, flag);
          const { onProgress, ...cloneableControl } = control;
          const forwardedControl: InternalJobControl = {
            ...cloneableControl,
            cancelFlag: shared,
          };
          args[controlIndex] = forwardedControl;
          if (onProgress) args.push(Comlink.proxy(onProgress));
          const operation = Reflect.get(target, property, receiver) as (
            ...params: unknown[]
          ) => Promise<unknown>;
          let result: Promise<unknown>;
          try {
            result = Promise.resolve(operation(...args));
          } catch (error) {
            if (activeFlags.get(control.jobId) === flag) activeFlags.delete(control.jobId);
            return Promise.reject(error);
          }
          return result.finally(() => {
            if (activeFlags.get(control.jobId) === flag) activeFlags.delete(control.jobId);
          });
        };
      }
      return Reflect.get(target, property, receiver);
    },
  });
}

let singleton: Remote<WorkerApi> | undefined;
let workerInstance: Worker | undefined;

/** Get the one module worker used for tracing, color scans and KMZ construction. */
export function getWorker(): Remote<WorkerApi> {
  if (!singleton) {
    workerInstance = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    singleton = createWorkerClient(Comlink.wrap<WorkerApi>(workerInstance));
  }
  return singleton;
}

/** Caller-owned job identifier suitable for passing to WorkerApi.cancel. */
export function newJobId(): JobId {
  return globalThis.crypto.randomUUID() as JobId;
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    workerInstance?.terminate();
    workerInstance = undefined;
    singleton = undefined;
  });
}

export type { ImageId };
