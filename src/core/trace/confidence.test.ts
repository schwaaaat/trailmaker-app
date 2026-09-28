import { beforeAll, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { readFile } from 'node:fs/promises';
import { autoTraceColor } from './autotrace';
import { candidateConfidence } from './confidence';
import { colorDistance } from './color';
import { scanColors } from './scan';
import type { RasterImage, Rgb } from '../types';
import { fixtureNames, generate } from '../../../tests/fixtures/generate';
import type { FixtureTruth } from '../../../tests/fixtures/truth';
import { lengthRecallPrecision } from '../../../tests/metrics/geometry';

const red: Rgb = [205, 48, 48];
function raster(width: number, height: number, draw: (put: (x: number, y: number) => void) => void) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let pixel = 0; pixel < width * height; pixel++) {
    const offset = pixel * 4;
    data[offset] = data[offset + 1] = data[offset + 2] = 255;
    data[offset + 3] = 255;
  }
  draw((x, y) => {
    const offset = (y * width + x) * 4;
    data[offset] = red[0];
    data[offset + 1] = red[1];
    data[offset + 2] = red[2];
    data[offset + 3] = 255;
  });
  return { width, height, data } satisfies RasterImage;
}

async function loadFixture(name: string): Promise<{ image: RasterImage; truth: FixtureTruth }> {
  const [decoded, truthText] = await Promise.all([
    sharp(`tests/fixtures/generated/${name}.png`).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
    readFile(`tests/fixtures/generated/${name}.truth.json`, 'utf8'),
  ]);
  return {
    image: { width: decoded.info.width, height: decoded.info.height, data: new Uint8ClampedArray(decoded.data) },
    truth: JSON.parse(truthText) as FixtureTruth,
  };
}

function auc(samples: readonly { confidence: number; isTrail: boolean }[]): number {
  const positive = samples.filter((sample) => sample.isTrail);
  const negative = samples.filter((sample) => !sample.isTrail);
  let wins = 0;
  for (const yes of positive) for (const no of negative) {
    wins += yes.confidence > no.confidence ? 1 : yes.confidence === no.confidence ? 0.5 : 0;
  }
  return wins / (positive.length * negative.length);
}

beforeAll(async () => {
  await generate();
}, 30000);

describe('auto-trace candidate confidence', () => {
  it('is deterministic, finite, bounded, and rewards thin connected ink over a filled band', () => {
    const thin = raster(128, 64, (put) => {
      for (let x = 8; x < 120; x++) put(x, 32);
    });
    const filledBand = raster(128, 64, (put) => {
      for (let y = 24; y < 41; y++) for (let x = 8; x < 120; x++) put(x, y);
    });
    const line = [[8, 32], [119, 32]] as const;
    const options = { tolerance: 60, minLengthPx: 24 };
    const trailScore = candidateConfidence(thin, red, line, 111, options);
    const fillScore = candidateConfidence(filledBand, red, line, 111, options);
    expect(trailScore).toBe(candidateConfidence(thin, red, line, 111, options));
    expect(trailScore).toBeGreaterThanOrEqual(0.5);
    expect(fillScore).toBeLessThan(trailScore);
    for (const score of [trailScore, fillScore]) {
      expect(Number.isFinite(score)).toBe(true);
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    }
  });

  it('checks cancellation between bounded chunks of path evidence', () => {
    const image = raster(128, 64, (put) => {
      for (let x = 8; x < 120; x++) put(x, 32);
    });
    let checks = 0;
    expect(() => candidateConfidence(image, red, [[8, 32], [119, 32]], 111, {
      tolerance: 60,
      minLengthPx: 24,
    }, {
      progress: () => {},
      throwIfCancelled: () => {
        checks++;
        throw Object.assign(new Error('cancelled'), { name: 'JobCancelled' });
      },
    })).toThrowError(expect.objectContaining({ name: 'JobCancelled' }));
    expect(checks).toBe(1);
  });

  it('calibrates against every generated fixture using the 3 px ground-truth overlap metric', async () => {
    const rows: { fixture: string; candidates: number; trueTrails: number; falseCandidates: number; auc: number; falseBelowHalf: number }[] = [];
    const all: { confidence: number; isTrail: boolean }[] = [];
    for (const name of fixtureNames) {
      const { image, truth } = await loadFixture(name);
      const colors = [...new Map(
        truth.polylines.map((line) => [line.color.join(','), line.color] as const),
      ).values()];
      // A scan chip within the same 40-unit color tolerance as a truth chip follows
      // the same color mask and yields duplicate candidates. Keep likely non-truth
      // chips for false-positive calibration, but avoid retracing near-identical ink.
      const extraChip = scanColors(image).colors
        .filter(
          (color) =>
            color.likely && !colors.some((truthColor) => colorDistance(color.rgb, truthColor) <= 40),
        )
        .sort((a, b) => b.share - a.share)[0];
      if (extraChip) colors.push(extraChip.rgb);
      const local: typeof all = [];
      for (const color of colors) {
        const truthColor = [...new Map(truth.polylines.map((line) => [line.color.join(','), line.color] as const)).values()]
          .find((target) => colorDistance(color, target) <= 40);
        const expected = truthColor
          ? truth.polylines.filter((line) => line.color.join(',') === truthColor.join(',')).map((line) => line.pts)
          : [];
        const lines = autoTraceColor(image, color, {
          tolerance: 60,
          gapPx: Math.max(10, Math.round(truth.width / 80)),
          minLengthPx: truth.width * 0.04,
        });
        for (const line of lines) {
          const overlap = expected.length ? lengthRecallPrecision([line.pts], expected, 3).precision : 0;
          const confidence = candidateConfidence(image, color, line.pts, line.lengthPx, {
            tolerance: 60,
            minLengthPx: truth.width * 0.04,
          });
          local.push({
            confidence,
            isTrail: overlap >= 0.5,
          });
        }
      }
      all.push(...local);
      const positive = local.filter((row) => row.isTrail).length;
      const negative = local.length - positive;
      rows.push({
        fixture: name,
        candidates: local.length,
        trueTrails: positive,
        falseCandidates: negative,
        auc: negative && positive ? auc(local) : Number.NaN,
        falseBelowHalf: negative ? local.filter((row) => !row.isTrail && row.confidence < 0.5).length / negative : Number.NaN,
      });
    }
    const trueScores = all.filter((row) => row.isTrail).map((row) => row.confidence);
    const falseRows = all.filter((row) => !row.isTrail);
    console.table(rows);
    console.info(`all-fixture AUC ${auc(all).toFixed(3)}; min true ${Math.min(...trueScores).toFixed(3)}; false below 0.5 ${(falseRows.filter((row) => row.confidence < 0.5).length / falseRows.length * 100).toFixed(1)}%`);
    expect(rows.every((row) => row.auc >= 0.9)).toBe(true);
    expect(auc(all)).toBeGreaterThanOrEqual(0.9);
    expect(Math.min(...trueScores)).toBeGreaterThanOrEqual(0.5);
    expect(falseRows.filter((row) => row.confidence < 0.5).length / falseRows.length).toBeGreaterThanOrEqual(0.8);
  }, 90000);

  it('keeps confidence work below five percent of benchmark auto-trace time', async () => {
    const { image, truth } = await loadFixture('benchmark');
    const colors = [...new Map(truth.polylines.map((line) => [line.color.join(','), line.color])).values()];
    const options = {
      tolerance: 60,
      gapPx: Math.max(10, Math.round(truth.width / 80)),
      minLengthPx: truth.width * 0.04,
    };
    let traceMs = 0;
    let confidenceMs = 0;
    for (const color of colors) {
      const traceStart = performance.now();
      const lines = autoTraceColor(image, color, options);
      traceMs += performance.now() - traceStart;
      const confidenceStart = performance.now();
      for (const line of lines) candidateConfidence(image, color, line.pts, line.lengthPx, options);
      confidenceMs += performance.now() - confidenceStart;
    }
    console.info(`benchmark confidence overhead: ${confidenceMs.toFixed(2)} ms / ${traceMs.toFixed(2)} ms`);
    expect(confidenceMs).toBeLessThan(traceMs * 0.05);
  });
});
