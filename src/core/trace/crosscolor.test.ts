import { describe, expect, it } from 'vitest';
import { autoTraceColor } from './autotrace';
import { lengthRecallPrecision } from '../../../tests/metrics/geometry';
import type { AutoTraceCandidate, ChipId, Px, Rgb } from '../types';
import { mergeCrossColorCandidates } from './crosscolor';

const ink: Rgb = [180, 40, 40];

function candidate(
  id: string,
  chipId: string,
  pts: Px[],
  options: Partial<AutoTraceCandidate> = {},
): AutoTraceCandidate {
  const lengthPx = pts.slice(1).reduce((sum, point, index) => {
    const previous = pts[index]!;
    return sum + Math.hypot(point[0] - previous[0], point[1] - previous[1]);
  }, 0);
  return {
    id,
    chipId: chipId as ChipId,
    pts,
    lengthPx,
    ink,
    confidence: null,
    ...options,
  };
}

describe('mergeCrossColorCandidates', () => {
  it('joins straight endpoint continuations into deterministic multi-color chains', () => {
    const first = candidate('a', 'red', [[0, 10], [10, 10]]);
    const middle = candidate('b', 'blue', [[12, 10], [20, 10]]);
    const last = candidate('c', 'green', [[22, 10], [30, 10]]);

    const result = mergeCrossColorCandidates([first, middle, last], 3);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      chipId: 'red',
      alsoChips: ['blue', 'green'],
      pts: [[0, 10], [10, 10], [12, 10], [20, 10], [22, 10], [30, 10]],
      lengthPx: 26,
    });
    expect(mergeCrossColorCandidates([last, first, middle], 3)).toEqual(result);
  });

  it('recovers at least 95% of a twice-color-switch trail in an in-test fixture', () => {
    const colors: Rgb[] = [
      [205, 48, 48],
      [35, 96, 195],
      [38, 132, 65],
    ];
    const data = new Uint8ClampedArray(64 * 64 * 4);
    for (let i = 0; i < 64 * 64; i++) {
      const offset = i * 4;
      data[offset] = data[offset + 1] = data[offset + 2] = 255;
      data[offset + 3] = 255;
    }
    for (let x = 8; x < 56; x++) {
      const color = colors[x < 24 ? 0 : x < 40 ? 1 : 2]!;
      const offset = (32 * 64 + x) * 4;
      data[offset] = color[0];
      data[offset + 1] = color[1];
      data[offset + 2] = color[2];
    }
    const image = { width: 64, height: 64, data };
    const candidates = colors.flatMap((rgb, index) =>
      autoTraceColor(image, rgb, { tolerance: 20, gapPx: 3, minLengthPx: 8 }).map(
        (line, part) =>
          candidate(`fixture-${index}-${part}`, `chip-${index}`, line.pts, {
            lengthPx: line.lengthPx,
            ink: rgb,
          }),
      ),
    );

    const mergedCandidates = mergeCrossColorCandidates(candidates, 3);
    expect(mergedCandidates).toHaveLength(1);
    const merged = mergedCandidates[0]!;
    const metrics = lengthRecallPrecision([merged!.pts], [[[8.5, 32.5], [55.5, 32.5]]], 3);

    expect(merged!.alsoChips).toEqual(['chip-1', 'chip-2']);
    expect(metrics.recall).toBeGreaterThanOrEqual(0.95);
  });

  it('uses the longest part for chip and ink, and length-weights available confidence', () => {
    const short = candidate('short', 'red', [[0, 0], [2, 0]], {
      confidence: 0.2,
      ink: [200, 10, 10],
    });
    const long = candidate('long', 'blue', [[4, 0], [14, 0]], {
      confidence: 0.8,
      ink: [10, 20, 200],
    });

    const [merged] = mergeCrossColorCandidates([short, long], 2);

    expect(merged).toMatchObject({
      id: 'long',
      chipId: 'blue',
      ink: [10, 20, 200],
      alsoChips: ['red'],
      confidence: (2 * 0.2 + 10 * 0.8) / 12,
    });
  });

  it('does not join parallel, sharp-angle, or interior-crossing lines', () => {
    const parallel = [
      candidate('a', 'red', [[0, 0], [10, 0]]),
      candidate('b', 'blue', [[12, 2], [22, 2]]),
    ];
    const sharp = [
      candidate('a', 'red', [[0, 0], [10, 0]]),
      candidate('b', 'blue', [[11, 1], [11, 11]]),
    ];
    const crossing = [
      candidate('a', 'red', [[0, 10], [20, 10]]),
      candidate('b', 'blue', [[10, 0], [10, 20]]),
    ];

    expect(mergeCrossColorCandidates(parallel, 2)).toEqual(parallel);
    expect(mergeCrossColorCandidates(sharp, 3)).toEqual(sharp);
    expect(mergeCrossColorCandidates(crossing, 3)).toEqual(crossing);
  });

  it('does not merge candidates of the same chip or pass a same-color continuation', () => {
    const red = candidate('red-1', 'red', [[0, 10], [10, 10]]);
    const redContinuation = candidate('red-2', 'red', [[12, 10], [22, 10]]);
    const blue = candidate('blue', 'blue', [[12, 10], [20, 10]]);

    expect(mergeCrossColorCandidates([red, redContinuation], 3)).toEqual([
      red,
      redContinuation,
    ]);
    expect(mergeCrossColorCandidates([red, redContinuation, blue], 3)).toHaveLength(3);
  });

  it('leaves candidates unchanged when the gap is too small', () => {
    const parts = [
      candidate('a', 'red', [[0, 0], [10, 0]]),
      candidate('b', 'blue', [[12, 0], [20, 0]]),
    ];
    expect(mergeCrossColorCandidates(parts, 1)).toEqual(parts);
  });

  it('checks cancellation during endpoint matching', () => {
    const parts = [
      candidate('a', 'red', [[0, 0], [10, 0]]),
      candidate('b', 'blue', [[12, 0], [20, 0]]),
    ];
    let checks = 0;
    expect(() =>
      mergeCrossColorCandidates(parts, 3, {
        progress: () => {},
        throwIfCancelled: () => {
          checks++;
          if (checks === 3) throw new Error('cancelled');
        },
      }),
    ).toThrow('cancelled');
    expect(checks).toBe(3);
  });

  it('reports progress during a merge stage that runs over the hook interval', () => {
    const parts = [
      candidate('a', 'red', [[0, 0], [10, 0]]),
      candidate('b', 'blue', [[12, 0], [20, 0]]),
    ];
    const stages: string[] = [];
    let checks = 0;
    mergeCrossColorCandidates(parts, 3, {
      progress: (_fraction, stage) => stages.push(stage),
      throwIfCancelled: () => {
        if (++checks !== 3) return;
        const start = performance.now();
        while (performance.now() - start < 55) {
          // Simulate elapsed work between cancellation checkpoints.
        }
      },
    });
    expect(stages).toContain('Find color continuations');
    expect(stages.at(-1)).toBe('Cross-color merge complete');
  });
});
