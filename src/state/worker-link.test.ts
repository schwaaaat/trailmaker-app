import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LoadedMap } from '../ui/contract';
import { fakeWorker } from './fake-worker.test.helper';
import { loadPixelRegion, setWorkerForTests } from './worker-link';

afterEach(() => setWorkerForTests(null));

describe('loadPixelRegion', () => {
  it('reads a full-resolution rect, maps level pixels, and releases the temporary worker image', async () => {
    const raster = { width: 10, height: 5, data: new Uint8ClampedArray(10 * 5 * 4) };
    const readRegion = vi.fn(async () => raster);
    const fake = fakeWorker();
    setWorkerForTests(fake.api);
    const map = {
      meta: { width: 400, height: 300 },
      raster,
      tiles: {
        levels: [{ level: 0, width: 400, height: 300, cols: 2, rows: 2 }],
        tileSize: 256,
        overviewScale: 0.1,
        getTileBitmap: vi.fn(async () => null),
        readRegion,
      },
    } as unknown as LoadedMap;

    const patch = await loadPixelRegion(map, { x: 102.2, y: 50.1, width: 40, height: 20 }, 2);
    expect(readRegion).toHaveBeenCalledWith({ x: 102, y: 50, width: 41, height: 21 }, 2);
    expect(patch.pixelScale).toBe(0.25);
    expect(patch.toLocal([108, 56])).toEqual([2, 2]);
    expect(patch.toMap([2, 2])).toEqual([108, 56]);
    expect(patch.readMs).toBeGreaterThanOrEqual(0);
    expect(fake.of('loadImage')).toHaveLength(1);
    await patch.release();
    expect(fake.of('releaseImage')).toHaveLength(1);
  });
});
