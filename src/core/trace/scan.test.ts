import { beforeAll, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { readFile } from 'node:fs/promises';
import { colorDistance } from './color';
import { scanColors } from './scan';
import type { JobHooks, RasterImage } from '../types';
import { JOB_CANCELLED } from '../types';
import { fixtureNames, generate } from '../../../tests/fixtures/generate';
import type { FixtureTruth } from '../../../tests/fixtures/truth';
// @ts-expect-error Copied prototype scanner is untyped and test-only.
import * as prototype from './__prototype__/scan.js';

async function loadFixture(name: string): Promise<{ image: RasterImage; truth: FixtureTruth }> {
  const [decoded, truthText] = await Promise.all([
    sharp(`tests/fixtures/generated/${name}.png`)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true }),
    readFile(`tests/fixtures/generated/${name}.truth.json`, 'utf8'),
  ]);
  return {
    image: {
      width: decoded.info.width,
      height: decoded.info.height,
      data: new Uint8ClampedArray(decoded.data),
    },
    truth: JSON.parse(truthText) as FixtureTruth,
  };
}
function prototypeImage(img: RasterImage) {
  return { W: img.width, H: img.height, data: img.data };
}
function normalizedPrototype(img: RasterImage) {
  const colors = prototype.prototypeScanColors(prototypeImage(img)) as {
    rgb: number[];
    name: string;
    share: number;
    thin: number;
    sat: number;
    light: number;
    score: number;
    likely: boolean;
  }[];
  return colors.map((c) => ({
    rgb: c.rgb,
    name: c.name,
    share: c.share,
    thinness: c.thin,
    saturation: c.sat,
    lightness: c.light,
    score: c.score,
    likely: c.likely,
  }));
}

beforeAll(async () => {
  await generate();
}, 30000);

describe('scanColors prototype characterization', () => {
  it('matches the prototype output and returns deterministically ordered results', async () => {
    const { image } = await loadFixture('solid');
    const expected = normalizedPrototype(image);
    const first = scanColors(image);
    expect(first.colors).toEqual(expected);
    expect(scanColors(image)).toEqual(first);
    for (let i = 1; i < first.colors.length; i++)
      expect(first.colors[i - 1]!.score).toBeGreaterThanOrEqual(first.colors[i]!.score);
  });
});

describe('scanColors fixture recall', () => {
  it.each(fixtureNames)('%s finds every true trail color', async (name) => {
    const { image, truth } = await loadFixture(name);
    const result = scanColors(image).colors;
    const trailColors = [
      ...new Map(truth.polylines.map((line) => [line.color.join(','), line.color])).values(),
    ];
    for (const target of trailColors) {
      const candidate = result.find((color) => colorDistance(color.rgb, target) <= 40);
      expect(candidate, `missing ${target.join(',')} from ${name}`).toBeDefined();
      expect(candidate!.likely, `${target.join(',')} not likely in ${name}`).toBe(true);
    }
    const trueIndices = trailColors.map((target) =>
      result.findIndex((color) => colorDistance(color.rgb, target) <= 40),
    );
    expect(Math.min(...trueIndices)).toBeLessThan(10);
    if (name === 'clutter') {
      const firstOtherColor = result.findIndex((color) =>
        trailColors.every((target) => colorDistance(color.rgb, target) > 40),
      );
      expect(firstOtherColor).toBeGreaterThan(Math.max(...trueIndices));
    }
  });

  it('runs 20 scans on the 3000x2200 fixture without timing out', async () => {
    const { image } = await loadFixture('benchmark');
    const samples: number[] = [];
    for (let i = 0; i < 20; i++) {
      const start = performance.now();
      scanColors(image);
      samples.push(performance.now() - start);
    }
    samples.sort((a, b) => a - b);
    expect((samples[9]! + samples[10]!) / 2).toBeLessThan(1000);
  }, 30000);
});

describe('scanColors worker hooks', () => {
  it('reports progress across the two passes and final ranking', () => {
    const image: RasterImage = { width: 8, height: 8, data: new Uint8ClampedArray(8 * 8 * 4) };
    const progress: number[] = [];
    const hooks: JobHooks = {
      progress: (fraction) => progress.push(fraction),
      throwIfCancelled: () => {},
    };
    scanColors(image, hooks);
    expect(progress[0]).toBe(0);
    expect(progress.at(-1)).toBe(1);
    expect(progress).toContain(0.25);
    expect(progress).toContain(0.4);
  });
  it('checks cancellation between passes', () => {
    const image: RasterImage = { width: 4, height: 4, data: new Uint8ClampedArray(4 * 4 * 4) };
    let calls = 0;
    const hooks: JobHooks = {
      progress: () => {},
      throwIfCancelled: () => {
        if (++calls > 1) throw Object.assign(new Error('cancelled'), { name: JOB_CANCELLED });
      },
    };
    expect(() => scanColors(image, hooks)).toThrowError(
      expect.objectContaining({ name: JOB_CANCELLED }),
    );
    expect(calls).toBeGreaterThan(1);
  });
});
