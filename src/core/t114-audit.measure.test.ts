import { readFile } from 'node:fs/promises';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Anchor, Feature, Px, Trail } from './types';
import { fitAnchors, projectPath } from './geo/fit';
import { featureLengthSteps } from './geo/feature-length';
import { withLooResiduals } from './geo/loo';
import { hasUnsnappedEnds, joinTrails, snapTrailEnds, splitTrail } from './topology';
import { simplify } from './trace/simplify';
import { generate } from '../../tests/fixtures/generate';
import type { FixtureTruth } from '../../tests/fixtures/truth';

let benchmarkTruth: FixtureTruth;
// This CPU-heavy audit runs separately from the concurrently scheduled full unit suite.
const ISOLATED_BUDGET_MS = 50;
beforeAll(async () => {
  await generate();
  benchmarkTruth = JSON.parse(await readFile('tests/fixtures/generated/benchmark.truth.json', 'utf8')) as FixtureTruth;
});

const medianOfFive = (label: string, run: () => unknown): number => {
  run();
  const times = Array.from({ length: 5 }, () => {
    const started = performance.now();
    run();
    return performance.now() - started;
  }).sort((a, b) => a - b);
  const median = times[2]!;
  console.info(`${label}: ${median.toFixed(3)} ms`);
  return median;
};

const medianMaximumSliceOfFive = (label: string, run: () => number): number => {
  run();
  const times = Array.from({ length: 5 }, run).sort((a, b) => a - b);
  const median = times[2]!;
  console.info(`${label}: ${median.toFixed(3)} ms max slice`);
  return median;
};

const makeTrail = (id: string, pts: readonly Px[]): Trail => ({
  id,
  name: id,
  color: '#D9480F',
  notes: '',
  kind: 'trail',
  pts,
  ink: null,
});

const pairedStress = (offset: number): Feature[] =>
  Array.from({ length: 1_000 }, (_, pair) => {
    const y = pair * 100;
    const left = makeTrail(`left-${pair}`, Array.from({ length: 50 }, (_, i) => [i, y] as const));
    const right = makeTrail(`right-${pair}`, Array.from({ length: 50 }, (_, i) => [49 + offset + i, y] as const));
    return [left, right];
  }).flat();

const farStress: Feature[] = Array.from({ length: 2_000 }, (_, trailIndex) =>
  makeTrail(
    `far-${trailIndex}`,
    Array.from({ length: 50 }, (_, pointIndex) => [trailIndex * 1_000 + pointIndex * 2, trailIndex * 1_000] as const),
  ),
);

const anchors: Anchor[] = Array.from({ length: 100 }, (_, index) => {
  const x = (index % 10) * 100 + 10;
  const y = Math.floor(index / 10) * 100 + 10;
  return { id: `a${index}`, px: [x, y], ll: [35 + y * 1e-5, -110 + x * 1e-5], source: 'paste' };
});

describe('T-114 temporary path measurements', () => {
  const auditIt = process.env.TRAILMAKER_T114_AUDIT === '1' ? it : it.skip;
  auditIt('measures card loads with warm medians', () => {
    const snapped = pairedStress(0);
    const unsnapped = pairedStress(1);
    for (const tolerancePx of [8, 30]) {
      medianOfFive(`hasUnsnappedEnds far 2k x 50 tol ${tolerancePx}`, () => hasUnsnappedEnds(farStress, { tolerancePx }));
      medianOfFive(`hasUnsnappedEnds snapped 2k x 50 tol ${tolerancePx}`, () => hasUnsnappedEnds(snapped, { tolerancePx }));
      medianOfFive(`hasUnsnappedEnds unsnapped 2k x 50 tol ${tolerancePx}`, () => hasUnsnappedEnds(unsnapped, { tolerancePx }));
      medianOfFive(`snapTrailEnds far 2k x 50 tol ${tolerancePx}`, () => snapTrailEnds(farStress, { tolerancePx }));
      medianOfFive(`snapTrailEnds snapped 2k x 50 tol ${tolerancePx}`, () => snapTrailEnds(snapped, { tolerancePx }));
      medianOfFive(`snapTrailEnds unsnapped 2k x 50 tol ${tolerancePx}`, () => snapTrailEnds(unsnapped, { tolerancePx }));
    }

    for (const [label, features] of [['snapped', snapped], ['unsnapped', unsnapped]] as const) {
      const trails = features.filter((feature): feature is Trail => feature.kind === 'trail');
      const splitMs = medianOfFive(`splitTrail 2k x 50 ${label}`, () => {
        for (let i = 0; i < trails.length; i++) splitTrail(trails[i]!, 25, `split-${i}`);
      });
      const joinMs = medianOfFive(`joinTrails 2k x 50 ${label}`, () => {
        for (let i = 0; i < trails.length; i += 2) joinTrails(trails[i]!, trails[i + 1]!);
      });
      expect(splitMs).toBeLessThan(ISOLATED_BUDGET_MS);
      expect(joinMs).toBeLessThan(ISOLATED_BUDGET_MS);
    }

    for (const method of ['similarity', 'affine', 'tps'] as const) {
      expect(medianOfFive(`fitAnchors 100 ${method}`, () => fitAnchors(anchors, 1_000, 1_000, method))).toBeLessThan(ISOLATED_BUDGET_MS);
    }
    const tps = fitAnchors(anchors, 1_000, 1_000, 'tps');
    if (!tps.ok) throw new Error(`TPS fixture failed: ${tps.reason}`);
    expect(medianOfFive('withLooResiduals 100 TPS anchors', () => withLooResiduals(tps, anchors, 1_000, 1_000))).toBeLessThan(ISOLATED_BUDGET_MS);
    const hundredK: Px[] = Array.from({ length: 100_000 }, (_, i) => [i % 1_000, Math.floor(i / 1_000)] as const);
    medianOfFive('projectPath 100k vertices / 100 TPS anchors', () => projectPath(tps, hundredK));
    const maxLengthSliceMs = medianMaximumSliceOfFive('featureLengthSteps 100k vertices / 100 TPS anchors', () => {
      const steps = featureLengthSteps(tps, [makeTrail('length-stress', hundredK)]);
      let maxSliceMs = 0;
      while (true) {
        const started = performance.now();
        const next = steps.next();
        maxSliceMs = Math.max(maxSliceMs, performance.now() - started);
        if (next.done) break;
      }
      return maxSliceMs;
    });
    expect(maxLengthSliceMs).toBeLessThan(ISOLATED_BUDGET_MS);
    const wavy: Px[] = Array.from({ length: 100_000 }, (_, i) => [i, Math.sin(i * 0.1)] as const);
    medianOfFive('simplify 100k oscillating stress path at epsilon 0.6', () => simplify(wavy, 0.6));
    const fullMapLine = benchmarkTruth.polylines.find((line) => line.id === 'red-ridge');
    if (!fullMapLine) throw new Error('Benchmark fixture is missing red-ridge truth');
    medianOfFive('simplify full benchmark red-ridge truth path', () => simplify(fullMapLine.pts, 0.6));
    const denseTruth: Px[] = Array.from({ length: 100_000 }, (_, index) => {
      const position = (index / 99_999) * (fullMapLine.pts.length - 1);
      const segment = Math.min(fullMapLine.pts.length - 2, Math.floor(position));
      const t = position - segment;
      const a = fullMapLine.pts[segment]!;
      const b = fullMapLine.pts[segment + 1]!;
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    });
    expect(medianOfFive('simplify 100k-point dense resample of benchmark red-ridge at epsilon 0.6', () => simplify(denseTruth, 0.6))).toBeLessThan(ISOLATED_BUDGET_MS);
  });
});
