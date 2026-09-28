import { describe, expect, it } from 'vitest';
import { autoTraceColor, deriveDefaultAutoTraceOptions } from './autotrace';
import type { JobHooks, RasterImage } from '../types';
import { JOB_CANCELLED } from '../types';
// @ts-expect-error The copied reference implementation is untyped and test-only.
import { traceColor as prototypeTraceColor } from './__prototype__/autotrace.js';

const ink: [number, number, number] = [205, 48, 48];
const white: [number, number, number] = [255, 255, 255];

function raster(
  width: number,
  height: number,
  draw: (put: (x: number, y: number, rgb?: number[]) => void) => void,
) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) data.set([...white, 255], i * 4);
  draw((x, y, rgb = ink) => data.set([...rgb, 255], (y * width + x) * 4));
  return { width, height, data } satisfies RasterImage;
}

function horizontal(thickness = 1, gap = 0): RasterImage {
  return raster(64, 64, (put) => {
    for (let x = 8; x < 56; x++) {
      if (gap && x >= 28 && x < 28 + gap) continue;
      for (let y = 32; y < 32 + thickness; y++) put(x, y);
    }
  });
}

const opts = { tolerance: 60, gapPx: 0, minLengthPx: 0 };
const asPrototypeImage = (img: RasterImage) => ({ W: img.width, H: img.height, data: img.data });
const normalized = (lines: ReturnType<typeof autoTraceColor>) =>
  lines.map(({ pts, lengthPx }) => ({ pts, len: lengthPx }));

describe('deriveDefaultAutoTraceOptions', () => {
  it('adapts untouched defaults for achromatic and chromatic picked ink', () => {
    expect(
      deriveDefaultAutoTraceOptions(
        { width: 1188, height: 1836 },
        [255, 255, 255],
        { tolerance: 60, gapPx: 23, minLengthPx: 73.44 },
      ),
    ).toEqual({ tolerance: 60, gapPx: 0, minLengthPx: 50 });
    expect(
      deriveDefaultAutoTraceOptions(
        { width: 1458, height: 2376 },
        [174, 107, 85],
        { tolerance: 60, gapPx: 30, minLengthPx: 95.04 },
      ),
    ).toEqual({ tolerance: 40, gapPx: 8, minLengthPx: 50 });
  });

  it('leaves explicitly tuned settings alone', () => {
    const tuned = { tolerance: 40, gapPx: 8, minLengthPx: 50 };
    expect(
      deriveDefaultAutoTraceOptions({ width: 1458, height: 2376 }, [174, 107, 85], tuned),
    ).toBe(tuned);
  });

  it('leaves dark achromatic map ink on its dimension-based defaults', () => {
    const defaults = { tolerance: 60, gapPx: 15, minLengthPx: 47.52 };
    expect(
      deriveDefaultAutoTraceOptions({ width: 918, height: 1188 }, [0, 0, 0], defaults),
    ).toBe(defaults);
  });

  it('does not reinterpret defaults for compact maps', () => {
    const defaults = { tolerance: 60, gapPx: 10, minLengthPx: 32 };
    expect(deriveDefaultAutoTraceOptions({ width: 800, height: 600 }, [220, 40, 45], defaults)).toBe(
      defaults,
    );
  });

  it('does not reinterpret highly saturated map colors', () => {
    const defaults = { tolerance: 60, gapPx: 23, minLengthPx: 73.44 };
    expect(
      deriveDefaultAutoTraceOptions({ width: 1188, height: 1836 }, [220, 48, 48], defaults),
    ).toBe(defaults);
  });
});

describe('autoTraceColor prototype characterization', () => {
  it('matches the copied prototype on a thin horizontal trail', () => {
    const img = horizontal();
    const expected = prototypeTraceColor(asPrototypeImage(img), ink, {
      tol: opts.tolerance,
      gap: opts.gapPx,
      minLen: opts.minLengthPx,
    });
    expect(expected).toEqual([
      {
        pts: [
          [8.5, 32.5],
          [55.5, 32.5],
        ],
        len: 47,
      },
    ]);
    expect(normalized(autoTraceColor(img, ink, opts))).toEqual(expected);
  });

  it('preserves connected 1px lines and bridges a fixture-sized dash gap', () => {
    const solid = autoTraceColor(horizontal(), ink, opts);
    expect(solid).toHaveLength(1);
    expect(solid[0]!.lengthPx).toBeGreaterThan(40);

    const gapImg = horizontal(1, 5);
    const joined = autoTraceColor(gapImg, ink, { ...opts, gapPx: 8 });
    expect(joined).toHaveLength(1);
    expect(joined[0]!.lengthPx).toBeGreaterThan(40);
  });

  it('supports a precision-oriented warm-color profile without losing the long route', () => {
    const route: [number, number, number] = [174, 107, 85];
    const nearbyInk: [number, number, number] = [205, 132, 110];
    const img = raster(128, 128, (put) => {
      for (let x = 10; x <= 90; x++) {
        if (x >= 47 && x < 52) continue;
        const y = 20 + Math.round((x - 10) * 0.35);
        put(x, y, route);
      }
      for (let x = 20; x <= 44; x++) put(x, 100, nearbyInk);
    });

    const broad = autoTraceColor(img, route, { tolerance: 60, gapPx: 8, minLengthPx: 10 });
    expect(broad.length).toBeGreaterThan(1);
    const tuned = autoTraceColor(img, route, { tolerance: 40, gapPx: 8, minLengthPx: 50 });
    expect(tuned).toHaveLength(1);
    expect(tuned[0]!.lengthPx).toBeGreaterThan(75);
  });

  it('chains a run of isolated dot symbols onto the nearby trail endpoint', () => {
    const dotted = raster(128, 64, (put) => {
      for (let x = 8; x <= 50; x++) put(x, 18);
      for (let x = 60; x <= 114; x += 9) {
        const y = Math.round(18 + (x - 60) * 0.35);
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) put(x + dx, y + dy);
      }
    });
    const lines = autoTraceColor(dotted, ink, { tolerance: 60, gapPx: 10, minLengthPx: 30 });
    expect(lines).toHaveLength(1);
    expect(lines[0]!.lengthPx).toBeGreaterThan(90);
  });

  it('pairs straight continuations through a plus and leaves the T branch distinct', () => {
    const plus = raster(64, 64, (put) => {
      for (let i = 8; i < 56; i++) {
        put(i, 31);
        put(i, 32);
        put(31, i);
        put(32, i);
      }
    });
    const plusLines = autoTraceColor(plus, ink, opts);
    expect(plusLines).toHaveLength(2);
    expect(plusLines.every((line) => line.lengthPx > 35)).toBe(true);

    const tee = raster(64, 64, (put) => {
      for (let i = 8; i < 56; i++) {
        put(i, 31);
        put(i, 32);
      }
      for (let i = 32; i < 56; i++) {
        put(31, i);
        put(32, i);
      }
    });
    expect(autoTraceColor(tee, ink, opts)).toHaveLength(2);
  });

  it('drops a filled color swatch instead of returning its perimeter', () => {
    const swatch = raster(64, 64, (put) => {
      for (let y = 12; y < 52; y++) for (let x = 12; x < 52; x++) put(x, y);
    });
    expect(autoTraceColor(swatch, ink, opts)).toEqual([]);
  });

  it('reports pipeline progress and honors cancellation checks', () => {
    const progress: number[] = [];
    const image = horizontal();
    const hooks: JobHooks = {
      progress: (fraction) => progress.push(fraction),
      throwIfCancelled: () => {},
    };
    autoTraceColor(image, ink, opts, hooks);
    expect(progress[0]).toBe(0);
    expect(progress.at(-1)).toBe(1);
    expect(progress).toContain(0.4);
    expect(progress).toContain(0.7);
    expect(
      progress.every((fraction, index) => index === 0 || fraction >= progress[index - 1]!),
    ).toBe(true);

    let checks = 0;
    const cancelling: JobHooks = {
      progress: () => {},
      throwIfCancelled: () => {
        if (++checks === 4) throw Object.assign(new Error('cancelled'), { name: JOB_CANCELLED });
      },
    };
    expect(() => autoTraceColor(image, ink, opts, cancelling)).toThrowError(
      expect.objectContaining({ name: JOB_CANCELLED }),
    );
  });

  it.each(['Close small gaps', 'Find connected components', 'Thin color mask', 'Build skeleton graph'])(
    'checks cancellation inside %s work',
    (targetStage) => {
      const image = raster(320, 320, (put) => {
        for (let x = 12; x < 308; x++) put(x, 160);
      });
      let stageEntered = false;
      const hooks: JobHooks = {
        progress: (_fraction, stage) => {
          if (stage === targetStage) stageEntered = true;
        },
        throwIfCancelled: () => {
          if (stageEntered) throw Object.assign(new Error('cancelled'), { name: JOB_CANCELLED });
        },
      };
      const options = targetStage === 'Close small gaps' ? { ...opts, gapPx: 8 } : opts;
      expect(() => autoTraceColor(image, ink, options, hooks)).toThrowError(
        expect.objectContaining({ name: JOB_CANCELLED }),
      );
    },
  );

  it('reuses scratch safely across same-sized and reentrant calls without stale graph state', () => {
    const image = horizontal();
    const blank = raster(64, 64, () => {});
    expect(autoTraceColor(image, ink, opts)).toHaveLength(1);
    expect(autoTraceColor(blank, ink, opts)).toEqual([]);

    let nested = false;
    let buildMaskProgressCount = 0;
    let nestedResult: ReturnType<typeof autoTraceColor> | undefined;
    const hooks: JobHooks = {
      progress: (_fraction, stage) => {
        if (stage === 'Build color mask' && ++buildMaskProgressCount === 2 && !nested) {
          nested = true;
          nestedResult = autoTraceColor(blank, ink, opts);
        }
      },
      throwIfCancelled: () => {},
    };
    expect(autoTraceColor(image, ink, opts, hooks)).toHaveLength(1);
    expect(nestedResult).toEqual([]);
    expect(autoTraceColor(image, ink, opts)).toHaveLength(1);
  });
});
