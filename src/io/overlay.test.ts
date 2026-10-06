import { describe, expect, it, vi } from 'vitest';
import type { LoadedMap } from '../ui/contract';
import type { MapImage } from '../core/types';
import { encodeOverlayJpeg } from './overlay';

describe('encodeOverlayJpeg (T-331, Lane C)', () => {
  it('scales standard map images so the long side is <= maxSide', async () => {
    let canvasW = 0;
    let canvasH = 0;
    const drawn: { img: CanvasImageSource; x: number; y: number; w: number; h: number }[] = [];

    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
      canvasW = this.width;
      canvasH = this.height;
      return {
        fillStyle: '',
        fillRect: vi.fn(),
        drawImage: vi.fn((img, x, y, w, h) => {
          drawn.push({ img, x, y, w, h });
        }),
      } as unknown as CanvasRenderingContext2D;
    });

    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (
      this: HTMLCanvasElement,
      callback: (blob: Blob | null) => void,
    ) {
      canvasW = this.width;
      canvasH = this.height;
      const data = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
      const blob = {
        arrayBuffer: async () => data.buffer,
        size: data.byteLength,
        type: 'image/jpeg',
      } as unknown as Blob;
      callback(blob);
    });

    const meta: MapImage = {
      fileName: 'large-park',
      width: 8000,
      height: 6000,
      originalWidth: 8000,
      originalHeight: 6000,
      sha256: 'mock-sha',
      source: { kind: 'image', mimeType: 'image/png' },
    };

    const display = {
      width: 8000,
      height: 6000,
      close: vi.fn(),
    } as unknown as ImageBitmap;

    const map: LoadedMap = {
      meta,
      display,
      raster: { width: 8000, height: 6000, data: new Uint8ClampedArray(4) },
      original: new Blob(),
      pdf: null,
    };

    const bytes = await encodeOverlayJpeg(map, 4096);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes[0]).toBe(0xff);
    expect(bytes[1]).toBe(0xd8);
    expect(canvasW).toBe(4096);
    expect(canvasH).toBe(3072);
    expect(drawn).toHaveLength(1);
    expect(drawn[0]!.w).toBe(4096);
    expect(drawn[0]!.h).toBe(3072);
  });

  it('uses native overview dimensions without upscaling for tiled maps', async () => {
    let canvasW = 0;
    let canvasH = 0;
    const drawn: { img: CanvasImageSource; x: number; y: number; w: number; h: number }[] = [];

    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
      canvasW = this.width;
      canvasH = this.height;
      return {
        fillStyle: '',
        fillRect: vi.fn(),
        drawImage: vi.fn((img, x, y, w, h) => {
          drawn.push({ img, x, y, w, h });
        }),
      } as unknown as CanvasRenderingContext2D;
    });

    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (
      this: HTMLCanvasElement,
      callback: (blob: Blob | null) => void,
    ) {
      canvasW = this.width;
      canvasH = this.height;
      const data = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
      const blob = {
        arrayBuffer: async () => data.buffer,
        size: data.byteLength,
        type: 'image/jpeg',
      } as unknown as Blob;
      callback(blob);
    });

    // Virtual tiled raster is 30,720 x 20,480, but overview level is 3,840 x 2,560
    const meta: MapImage = {
      fileName: 'seabranch-tiled',
      width: 30720,
      height: 20480,
      originalWidth: 30720,
      originalHeight: 20480,
      sha256: 'mock-sha',
      source: {
        kind: 'tiles',
        sourceId: 'martin-county',
        z: 20,
        tileSize: 256,
        origin: { x: 74400000, y: 112800000 },
        boundary: [
          [27.15, -80.16],
          [27.15, -80.14],
          [27.13, -80.14],
          [27.13, -80.16],
        ],
        tileCount: 96 * 64,
      },
    };

    const display = {
      width: 3840,
      height: 2560,
      close: vi.fn(),
    } as unknown as ImageBitmap;

    const map: LoadedMap = {
      meta,
      display,
      raster: { width: 3840, height: 2560, data: new Uint8ClampedArray(4) },
      original: new Blob(),
      pdf: null,
    };

    const bytes = await encodeOverlayJpeg(map, 4096);
    expect(bytes).toBeInstanceOf(Uint8Array);
    // Canvas dimensions must equal the overview image dimensions (3840 x 2560), NOT upscaled to 4096!
    expect(canvasW).toBe(3840);
    expect(canvasH).toBe(2560);
    expect(drawn).toHaveLength(1);
    expect(drawn[0]!.w).toBe(3840);
    expect(drawn[0]!.h).toBe(2560);
  });
});
