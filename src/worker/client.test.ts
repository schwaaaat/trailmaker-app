// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import type { Remote } from 'comlink';
import type { ColorScanResult, JobControl, RasterImage, WorkerApi } from '../core/types';
import { createWorkerClient, newJobId } from './client';
import type { InternalJobControl } from './api';

function stubWorkerApi(): WorkerApi {
  return {
    loadImage: vi.fn(async () => 'image-1'),
    releaseImage: vi.fn(async () => {}),
    pickInk: vi.fn(async () => [1, 2, 3] as const),
    snapToInk: vi.fn(async () => null),
    smartTrace: vi.fn(async () => ({ path: null, snappedTo: [0, 0] as const, ms: 0 })),
    scanColors: vi.fn(async () => ({ colors: [] })),
    autoTrace: vi.fn(async () => []),
    buildKmz: vi.fn(async () => new Uint8Array()),
    cancel: vi.fn(async () => {}),
  };
}

const raster: RasterImage = { width: 1, height: 1, data: new Uint8ClampedArray([1, 2, 3, 255]) };

describe('worker client', () => {
  it('creates unique caller-owned job IDs', () => {
    const a = newJobId();
    const b = newJobId();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThan(8);
  });

  it('transfers images once and injects an atomic flag into each cancellable job', async () => {
    const remote = stubWorkerApi();
    let received: InternalJobControl | undefined;
    let receivedProgress: JobControl['onProgress'];
    let finish!: () => void;
    remote.scanColors = vi.fn(
      (
        _id: string,
        control: JobControl,
        onProgress?: JobControl['onProgress'],
      ): Promise<ColorScanResult> => {
      received = control as InternalJobControl;
      receivedProgress = onProgress;
      return new Promise<ColorScanResult>((resolve) => {
        finish = () => resolve({ colors: [] });
      });
      },
    );
    const client = createWorkerClient(remote as unknown as Remote<WorkerApi>);

    await expect(client.loadImage(raster)).resolves.toBe('image-1');
    expect(remote.loadImage).toHaveBeenCalledWith(raster);

    const onProgress = vi.fn();
    const running = client.scanColors('image-1', { jobId: 'job-1', onProgress });
    const flag = received?.cancelFlag;
    expect(flag).toBeInstanceOf(SharedArrayBuffer);
    expect(received?.onProgress).toBeUndefined();
    expect(receivedProgress).toBeTypeOf('function');
    receivedProgress?.({ jobId: 'job-1', fraction: 0.5, stage: 'halfway' });
    expect(onProgress).toHaveBeenCalledWith({ jobId: 'job-1', fraction: 0.5, stage: 'halfway' });

    await client.cancel('job-1');
    expect(Atomics.load(new Int32Array(flag!), 0)).toBe(1);
    expect(remote.cancel).toHaveBeenCalledWith('job-1');
    finish();
    await expect(running).resolves.toEqual({ colors: [] });
  });

  it('clears job flags after completion so later cancellation is harmless', async () => {
    const remote = stubWorkerApi();
    let finishedControl: InternalJobControl | undefined;
    remote.scanColors = vi.fn(async (_id, control: JobControl): Promise<ColorScanResult> => {
      finishedControl = control as InternalJobControl;
      return { colors: [] };
    });
    const client = createWorkerClient(remote as unknown as Remote<WorkerApi>);
    await client.scanColors('image-1', { jobId: 'done-job' });
    await expect(client.cancel('done-job')).resolves.toBeUndefined();
    expect(remote.cancel).toHaveBeenCalledWith('done-job');
    expect(Atomics.load(new Int32Array(finishedControl!.cancelFlag!), 0)).toBe(0);
  });
});
