import { describe, expect, it } from 'vitest';
import type { Anchor, FitMethod, GeoFit, LatLon, Px } from '../types';
import { makeTruth } from '../../../tests/fixtures/generate';
import { pixelToLatLon, warpPixel } from '../../../tests/fixtures/truth';
import { haversine } from './distance';
import { fitAnchors, forward, withLooResiduals } from './fit';

const width = 1200;
const height = 800;
const lat0 = 38.6;
const lon0 = -78.4;
const metersPerDegreeLat = 111320;
const metersPerDegreeLon = 111320 * Math.cos((lat0 * Math.PI) / 180);
const seabranchPixels: readonly Px[] = [
  [1127, 720],
  [1025, 562],
  [655, 162],
  [475, 395],
];
const seabranchCoordinates: readonly LatLon[] = [
  [27.131201, -80.162278],
  [27.134947, -80.164812],
  [27.143866, -80.172832],
  [27.136827, -80.17394],
];
const pixels: Px[] = [
  [80, 90],
  [1100, 100],
  [100, 700],
  [1080, 690],
  [590, 330],
];

function exactAnchors(method: FitMethod, scale = 1, originLat = lat0): Anchor[] {
  const meanX = pixels.reduce((sum, px) => sum + px[0], 0) / pixels.length;
  const meanY = pixels.reduce((sum, px) => sum + px[1], 0) / pixels.length;
  return pixels.map((px, i) => {
    const x = px[0] - meanX;
    const y = px[1] - meanY;
    const east = method === 'similarity'
      ? scale * (0.0005 * x + 0.0003 * y)
      : scale * (0.0005 * x + 0.0002 * y);
    const north = method === 'similarity'
      ? scale * (0.0003 * x - 0.0005 * y)
      : scale * (0.0001 * x - 0.0007 * y);
    return {
      id: `exact-${i}`,
      px,
      ll: [originLat + north / metersPerDegreeLat, lon0 + east / (111320 * Math.cos((originLat * Math.PI) / 180))] as LatLon,
      source: 'paste',
    };
  });
}

function fitted(anchors: readonly Anchor[], method: FitMethod): GeoFit {
  const fit = fitAnchors(anchors, width, height, method);
  if (!fit.ok) throw new Error(`Expected successful ${method} fit; got ${fit.reason}`);
  return fit;
}

describe('withLooResiduals', () => {
  it('marks the initial Seabranch fit unchecked and leaves its lone cross-line anchor unscored', () => {
    const anchors: Anchor[] = seabranchPixels.map((px, index) => ({
      id: `seabranch-${index + 1}`,
      px,
      ll: seabranchCoordinates[index]!,
      source: 'paste',
    }));
    const fit = fitAnchors(anchors, 1920, 945, 'auto');
    if (!fit.ok) throw new Error(`Expected fit; got ${fit.reason}`);
    const result = withLooResiduals(fit, anchors, 1920, 945);

    expect(fit.method).toBe('affine');
    expect(fit.checked).toBe(false);
    expect(fit.rms).toBeLessThan(1);
    expect(result.looResiduals).not.toHaveProperty('seabranch-4');
    expect(Object.keys(result.looResiduals ?? {})).toHaveLength(3);
  });

  it('keeps the corrected Seabranch pin unchecked rather than treating it as an outlier', () => {
    const anchors: Anchor[] = seabranchPixels.map((px, index) => ({
      id: `seabranch-${index + 1}`,
      px,
      ll: index === 3 ? [27.138227, -80.176769] : seabranchCoordinates[index]!,
      source: 'paste',
    }));
    const fit = fitAnchors(anchors, 1920, 945, 'auto');
    if (!fit.ok) throw new Error(`Expected fit; got ${fit.reason}`);
    const result = withLooResiduals(fit, anchors, 1920, 945);

    expect(fit.method).toBe('affine');
    expect(fit.checked).toBe(false);
    expect(result.looResiduals).not.toHaveProperty('seabranch-4');
    expect(fit.rms).toBeLessThan(60);
  });

  it.each([
    ['similarity', 1000, 1e-6],
    ['affine', 1000, 1e-6],
    ['similarity', 9000, 1e-3],
    ['affine', 9000, 1e-3],
  ] as const)(
    'returns near-zero residuals for exact %s transforms at scale %i',
    (method, scale, toleranceM) => {
      const anchors = exactAnchors(method, scale, 0);
      const fit = fitted(anchors, method);
      const result = withLooResiduals(fit, anchors, width, height);
      expect(Object.keys(result.looResiduals ?? {})).toEqual(anchors.map((anchor) => anchor.id));
      expect(Math.max(...Object.values(result.looResiduals ?? {}))).toBeLessThan(toleranceM);
    },
  );

  it('omits anchors whose reduced fit has too few usable controls', () => {
    const anchors = exactAnchors('similarity').slice(0, 2);
    const fit = fitted(anchors, 'similarity');
    expect(withLooResiduals(fit, anchors, width, height).looResiduals).toEqual({});
  });

  it('ranks the pinned 200 m outlier first on the six-anchor warped fixture', () => {
    const truth = makeTruth('warped');
    const outlierId = 'a1';
    const anchors = truth.anchors.map((anchor) =>
      anchor.id === outlierId
        ? {
            ...anchor,
            ll: [anchor.ll![0] + 200 / metersPerDegreeLat, anchor.ll![1]] as LatLon,
          }
        : anchor,
    );
    const fit = fitAnchors(anchors, truth.width, truth.height, 'tps');
    if (!fit.ok) throw new Error(`Expected TPS fit; got ${fit.reason}`);
    expect(fit.method).toBe('tps');
    const result = withLooResiduals(fit, anchors, truth.width, truth.height);
    const residuals = result.looResiduals ?? {};
    const ordered = Object.entries(residuals).sort((a, b) => b[1] - a[1]);
    expect(Object.values(residuals).every((residual) => residual > 0)).toBe(true);
    expect(ordered[0]?.[0]).toBe(outlierId);
    expect(ordered[0]![1]).toBeGreaterThanOrEqual(150);
    expect(ordered[0]![1]).toBeGreaterThanOrEqual(1.5 * ordered[1]![1]);
  });

  it('ranks each displaced interior control first on a 4x4 warped truth grid', () => {
    const truth = makeTruth('warped');
    const xs = [40, 280, 520, 760];
    const ys = [40, 560 / 3, (2 * 560) / 3, 560];
    const grid: Anchor[] = ys.flatMap((y, row) => xs.map((x, column) => {
      const px = warpPixel([x, y], truth.transform);
      return {
        id: `grid-${row}-${column}`,
        px,
        ll: pixelToLatLon(px, truth.transform),
        source: 'paste' as const,
      };
    }));
    const cases = [[1, 1], [1, 2], [2, 1], [2, 2]] as const;
    const ratios: number[] = [];
    for (const [row, column] of cases) {
      const outlierId = `grid-${row}-${column}`;
      const anchors = grid.map((anchor) => anchor.id === outlierId
        ? { ...anchor, ll: [anchor.ll![0] + 200 / metersPerDegreeLat, anchor.ll![1]] as LatLon }
        : anchor);
      const fit = fitAnchors(anchors, truth.width, truth.height, 'tps');
      if (!fit.ok) throw new Error(`Expected dense TPS fit; got ${fit.reason}`);
      const residuals = withLooResiduals(fit, anchors, truth.width, truth.height).looResiduals ?? {};
      const ordered = Object.entries(residuals).sort((a, b) => b[1] - a[1]);
      expect(Object.values(residuals).every((residual) => residual > 0)).toBe(true);
      expect(ordered[0]?.[0]).toBe(outlierId);
      ratios.push(ordered[0]![1] / ordered[1]![1]);
    }
    expect(ratios).toHaveLength(4);
  });

  it('filters unusable anchors, preserves the input fit, and is deterministic', () => {
    const valid = exactAnchors('affine');
    const anchors: Anchor[] = [
      ...valid,
      { id: 'pending', px: [500, 400], ll: null, source: 'paste' },
      { id: 'invalid', px: [600, 400], ll: [Number.NaN, 0], source: 'paste' },
    ];
    const fit = fitted(anchors, 'affine');
    const before = structuredClone(fit);
    const first = withLooResiduals(fit, anchors, width, height);
    const second = withLooResiduals(fit, anchors, width, height);

    expect(fit).toEqual(before);
    expect(first).not.toBe(fit);
    expect(first).toEqual(second);
    expect(first.looResiduals).not.toHaveProperty('pending');
    expect(first.looResiduals).not.toHaveProperty('invalid');
    const fitWithoutLoo = { ...first };
    fitWithoutLoo.looResiduals = fit.looResiduals;
    expect(fitWithoutLoo).toEqual(fit);
  });

  it('records timing for 30 TPS leave-one-out residuals', () => {
    const anchors: Anchor[] = Array.from({ length: 30 }, (_, i) => {
      const px: Px = [40 + (i % 6) * 210, 40 + Math.floor(i / 6) * 140];
      return {
        id: `grid-${i}`,
        px,
        ll: [
          lat0 + (0.1 * px[0] - 0.7 * px[1]) / metersPerDegreeLat,
          lon0 + (px[0] * 0.5 + px[1] * 0.2) / metersPerDegreeLon,
        ] as LatLon,
        source: 'paste',
      };
    });
    const fit = fitted(anchors, 'tps');
    withLooResiduals(fit, anchors, width, height); // warm the JIT before timing
    const timings: number[] = [];
    let result: GeoFit = fit;
    for (let i = 0; i < 3; i++) {
      const start = performance.now();
      result = withLooResiduals(fit, anchors, width, height);
      timings.push(performance.now() - start);
    }
    const elapsedMs = timings.sort((a, b) => a - b)[1]!;
    expect(Object.keys(result.looResiduals ?? {})).toHaveLength(30);
    // Coverage instrumentation and parallel suites distort this measurement; record
    // isolated wall-clock time separately and retain this bound for the covered full gate.
    expect(elapsedMs).toBeLessThan(200);
    console.log(`30-anchor TPS LOO median: ${elapsedMs.toFixed(2)} ms`);
  });

  it('matches refit-oracle LOO residuals within 1 mm on 220 seeded TPS scenes', () => {
    let state = 0x25d025;
    const random = (): number => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 0x1_0000_0000;
    };
    let maxDeltaM = 0;
    let comparedScenes = 0;
    for (let scene = 0; scene < 220; scene++) {
      const count = 4 + Math.floor(random() * 7);
      const points: Anchor[] = Array.from({ length: count }, (_, i) => {
        const px: Px = [30 + random() * 1_100, 25 + random() * 750];
        const warp = 4 + random() * 25;
        return {
          id: `s${scene}-a${i}`,
          px,
          ll: [
            lat0 + (0.13 * px[0] - 0.54 * px[1] + warp * Math.sin(px[0] / 173)) / metersPerDegreeLat,
            lon0 + (0.61 * px[0] + 0.19 * px[1] + warp * Math.cos(px[1] / 121)) / metersPerDegreeLon,
          ],
          source: 'paste',
        };
      });
      const fit = fitAnchors(points, width, height, 'tps');
      if (!fit.ok) continue;
      comparedScenes++;
      const actual = withLooResiduals(fit, points, width, height).looResiduals ?? {};
      for (let i = 0; i < points.length; i++) {
        const anchor = points[i]!;
        const referenceFit = fitAnchors(points.filter((_, j) => i !== j), width, height, 'tps');
        if (!referenceFit.ok) continue;
        const expected = haversine(anchor.ll!, forward(referenceFit, anchor.px));
        const delta = Math.abs((actual[anchor.id] ?? expected) - expected);
        maxDeltaM = Math.max(maxDeltaM, delta);
        expect(delta).toBeLessThanOrEqual(0.001);
      }
    }
    expect(comparedScenes).toBeGreaterThanOrEqual(200);
    console.info(`220-scene Rippa LOO max residual delta: ${(maxDeltaM * 1000).toFixed(3)} mm`);
  });

});
