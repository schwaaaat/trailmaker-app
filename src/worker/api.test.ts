// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  JOB_CANCELLED,
  type AutoTraceRequest,
  type JobHooks,
  type KmzRequest,
  type RasterImage,
} from '../core/types';
import { createWorkerApi, type InternalJobControl } from './api';

const red: [number, number, number] = [205, 48, 48];
const blue: [number, number, number] = [35, 96, 195];
function image(width = 64, height = 64): RasterImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const offset = i * 4;
    data[offset] = 255;
    data[offset + 1] = 255;
    data[offset + 2] = 255;
    data[offset + 3] = 255;
  }
  for (let x = 8; x < width - 8; x++) {
    const offset = (Math.floor(height / 2) * width + x) * 4;
    data[offset] = red[0];
    data[offset + 1] = red[1];
    data[offset + 2] = red[2];
  }
  return { width, height, data };
}

function twoToneImage(): RasterImage {
  const data = new Uint8ClampedArray(64 * 64 * 4);
  for (let i = 0; i < 64 * 64; i++) {
    const offset = i * 4;
    data[offset] = data[offset + 1] = data[offset + 2] = 255;
    data[offset + 3] = 255;
  }
  for (let x = 8; x < 56; x++) {
    const color = x < 32 ? red : blue;
    const offset = (32 * 64 + x) * 4;
    data[offset] = color[0];
    data[offset + 1] = color[1];
    data[offset + 2] = color[2];
  }
  return { width: 64, height: 64, data };
}

function control(jobId: string, overrides: Partial<InternalJobControl> = {}): InternalJobControl {
  return { jobId, ...overrides };
}

const autoRequest = (imageId: string): AutoTraceRequest => ({
  imageId,
  colors: [
    { chipId: 'red-chip', rgb: red },
    { chipId: 'red-chip-2', rgb: red },
  ],
  tolerance: 60,
  gapPx: 0,
  minLengthPx: 8,
});

describe('worker API', () => {
  it('keeps transferred rasters in an image registry until release', async () => {
    const api = createWorkerApi();
    const loaded = image();
    const id = await api.loadImage(loaded);
    expect(await api.pickInk(id, [32, 32], 14)).toEqual(red);
    await api.releaseImage(id);
    await expect(api.scanColors(id, control('unknown-image'))).rejects.toThrow(
      `Unknown image id: ${id}`,
    );
  });

  it('clamps smart-trace snapping, preserves the clicked target on fallback, and returns timing', async () => {
    const api = createWorkerApi();
    const id = await api.loadImage(image());
    const result = await api.smartTrace(
      {
        imageId: id,
        from: [8, 32],
        to: [55, 32],
        ink: red,
        tolerance: 60,
        snapRadiusPx: 100,
      },
      control('smart-1'),
    );
    expect(result.path).not.toBeNull();
    expect(result.snappedTo).toEqual([55, 32]);
    expect(result.ms).toBeGreaterThanOrEqual(0);

    const fallback = await api.smartTrace(
      {
        imageId: id,
        from: [8, 32],
        to: [55, 1],
        ink: red,
        tolerance: 60,
        snapRadiusPx: 100,
      },
      control('smart-2'),
    );
    expect(fallback.snappedTo).toEqual([55, 1]);
  });

  it('maps auto-trace lines to unique candidates in requested color order', async () => {
    const api = createWorkerApi();
    const id = await api.loadImage(image());
    const progress: number[] = [];
    const candidates = await api.autoTrace(autoRequest(id), {
      jobId: 'auto-1',
      onProgress: (event) => progress.push(event.fraction),
    });
    expect(candidates).toHaveLength(2);
    expect(candidates.map((candidate) => candidate.chipId)).toEqual(['red-chip', 'red-chip-2']);
    expect(new Set(candidates.map((candidate) => candidate.id)).size).toBe(candidates.length);
    expect(candidates.every((candidate) =>
      candidate.confidence !== null && candidate.confidence >= 0 && candidate.confidence <= 1,
    )).toBe(true);
    expect(candidates.map((candidate) => candidate.ink)).toEqual([red, red]);
    expect(progress[0]).toBe(0);
    expect(progress.at(-1)).toBe(1);
    expect(
      progress.every((fraction, index) => index === 0 || fraction >= progress[index - 1]!),
    ).toBe(true);
  });

  it('merges a color-changing trail only when mergeAcrossColors is enabled', async () => {
    const api = createWorkerApi();
    const id = await api.loadImage(twoToneImage());
    const request: AutoTraceRequest = {
      imageId: id,
      colors: [
        { chipId: 'red', rgb: red },
        { chipId: 'blue', rgb: blue },
      ],
      tolerance: 60,
      gapPx: 3,
      minLengthPx: 8,
    };
    const separate = await api.autoTrace(request, control('two-tone-separate'));
    const progress: number[] = [];
    const merged = await api.autoTrace(
      { ...request, mergeAcrossColors: true },
      {
        jobId: 'two-tone-merged',
        onProgress: (event) => {
          progress.push(event.fraction);
        },
      },
    );

    expect(separate).toHaveLength(2);
    expect(separate.every((candidate) => candidate.alsoChips === undefined)).toBe(true);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.alsoChips).toEqual(['blue']);
    expect(merged[0]!.chipId).toBe('red');
    expect(merged[0]!.pts[0]![0]).toBeLessThan(merged[0]!.pts.at(-1)![0]);
    expect(progress.at(-1)).toBe(1);
    expect(progress.every((value, index) => index === 0 || value >= progress[index - 1]!)).toBe(
      true,
    );
  });

  it('throttles per-job progress to a maximum of one callback every 50 ms', async () => {
    const api = createWorkerApi();
    const id = await api.loadImage(image());
    const timestamps: number[] = [];
    await api.autoTrace(autoRequest(id), {
      jobId: 'throttled-auto',
      onProgress: () => timestamps.push(performance.now()),
    });
    expect(timestamps.length).toBeGreaterThanOrEqual(2);
    expect(
      timestamps.every((time, index) => index === 0 || time - timestamps[index - 1]! >= 49),
    ).toBe(true);
  });

  it('supports color scan and deterministic KMZ bytes through worker jobs', async () => {
    const api = createWorkerApi();
    const id = await api.loadImage(image());
    const scan = await api.scanColors(id, control('scan-1'));
    expect(scan).toHaveProperty('colors');

    const bytes = await api.buildKmz(
      {
        doc: { name: 'worker test', features: [] },
        options: { units: 'km', time: '2026-01-02T03:04:05.000Z' },
        overlayImage: null,
        quad: null,
      },
      control('kmz-1'),
    );
    expect(bytes[0]).toBe(0x50);
    expect(bytes[1]).toBe(0x4b);
  });

  it('passes cancellation hooks to the KMZ writer', async () => {
    const flag = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
    let observedHooks = false;
    const writer = (_request: KmzRequest, hooks?: JobHooks): Uint8Array => {
      if (!hooks) throw new Error('Worker omitted KMZ job hooks');
      observedHooks = true;
      Atomics.store(flag, 0, 1);
      hooks.throwIfCancelled();
      return new Uint8Array([0x50, 0x4b]);
    };
    const api = createWorkerApi(writer);

    await expect(
      api.buildKmz(
        {
          doc: { name: 'hook test', features: [] },
          options: { units: 'km', time: '2026-01-02T03:04:05.000Z' },
          overlayImage: null,
          quad: null,
        },
        control('kmz-hook-cancel', { cancelFlag: flag.buffer }),
      ),
    ).rejects.toMatchObject({ name: JOB_CANCELLED });
    expect(observedHooks).toBe(true);
  });

  it('passes original job errors through and rejects jobs when their atomic flag is set', async () => {
    const api = createWorkerApi();
    const bad = api.smartTrace(
      {
        imageId: 'missing',
        from: [0, 0],
        to: [1, 1],
        ink: red,
        tolerance: 60,
        snapRadiusPx: 8,
      },
      control('bad-image'),
    );
    await expect(bad).rejects.toThrow('Unknown image id: missing');

    const id = await api.loadImage(image());
    const flag = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
    let armed = false;
    const cancelling: InternalJobControl = {
      jobId: 'cancel-auto',
      cancelFlag: flag.buffer,
      onProgress: (event) => {
        if (event.stage.endsWith('Build color mask')) {
          armed = true;
          Atomics.store(flag, 0, 1);
        }
      },
    };
    // Cancellation is observed immediately inside the core mask stage after progress arms it.
    await expect(api.autoTrace(autoRequest(id), cancelling)).rejects.toMatchObject({
      name: JOB_CANCELLED,
    });
    expect(armed).toBe(true);
  });

  it.each(['smartTrace', 'scanColors', 'autoTrace', 'buildKmz'] as const)(
    'rejects a pre-cancelled %s job with JobCancelled',
    async (method) => {
      const api = createWorkerApi();
      const id = await api.loadImage(image());
      const flag = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
      Atomics.store(flag, 0, 1);
      const ctl: InternalJobControl = { jobId: `cancel-before-${method}`, cancelFlag: flag.buffer };
      const operation = {
        smartTrace: () =>
          api.smartTrace(
            {
              imageId: id,
              from: [8, 32],
              to: [55, 32],
              ink: red,
              tolerance: 60,
              snapRadiusPx: 8,
            },
            ctl,
          ),
        scanColors: () => api.scanColors(id, ctl),
        autoTrace: () => api.autoTrace(autoRequest(id), ctl),
        buildKmz: () =>
          api.buildKmz(
            {
              doc: { name: 'worker test', features: [] },
              options: { units: 'km', time: '2026-01-02T03:04:05.000Z' },
              overlayImage: null,
              quad: null,
            },
            ctl,
          ),
      }[method]();
      await expect(operation).rejects.toMatchObject({ name: JOB_CANCELLED });
    },
  );

  it('rejects unknown image handles with the original clear error', async () => {
    const api = createWorkerApi();
    await expect(api.scanColors('no-image', control('scan-missing'))).rejects.toThrow(
      'Unknown image id: no-image',
    );
  });
});
