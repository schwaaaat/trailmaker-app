import { beforeAll, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import type { Anchor, FitMethod, GeoFit, LatLon, Px } from '../types';
import { fitAnchors, forward, inverse, isOutlier, overlayMesh, overlayQuad, projectPath } from './fit';
import { generate } from '../../../tests/fixtures/generate';
import { pixelToLatLon } from '../../../tests/fixtures/truth';
import type { FixtureTruth } from '../../../tests/fixtures/truth';
// @ts-expect-error The verbatim prototype is deliberately untyped and test-only.
import { prototypeFit } from './__prototype__/fit.js';

const W = 1200;
const H = 800;
const lon0 = -80.12;
const lat0 = 26.36;
const kx = ((6378137 * Math.PI) / 180) * Math.cos((lat0 * Math.PI) / 180);
const ky = (6378137 * Math.PI) / 180;
const positions: Px[] = [
  [100, 100],
  [1000, 120],
  [130, 680],
  [1020, 700],
  [550, 300],
  [800, 550],
  [230, 470],
  [900, 340],
];
function ll([x, y]: Px, warp = 0): LatLon {
  return [
    lat0 + (-0.7 * y + 0.09 * x + warp * Math.sin(x / 250) * Math.cos(y / 170)) / ky,
    lon0 + (0.7 * x + 0.1 * y + warp * Math.sin(y / 200)) / kx,
  ];
}
function anchors(count: number, warp = 0): Anchor[] {
  return positions
    .slice(0, count)
    .map((px, i) => ({ id: String(i), px, ll: ll(px, warp), source: 'paste' }));
}
function fitOrThrow(points: Anchor[], method: FitMethod): GeoFit {
  const fit = fitAnchors(points, W, H, method);
  if (!fit.ok) throw new Error(`fit failed: ${fit.reason}`);
  return fit;
}

let warpedTruth: FixtureTruth;
beforeAll(async () => {
  await generate();
  warpedTruth = JSON.parse(
    await readFile('tests/fixtures/generated/warped.truth.json', 'utf8'),
  ) as FixtureTruth;
}, 30000);

describe('fit prototype characterization', () => {
  for (const count of [2, 3, 4, 8])
    for (const method of ['auto', 'similarity', 'affine', 'tps'] as const) {
      it(`${count} controls, ${method}`, () => {
        const points = anchors(count, count > 3 ? 5 : 0);
        const reference = prototypeFit(
          points.map((p) => ({ id: p.id, x: p.px[0], y: p.px[1], lat: p.ll![0], lon: p.ll![1] })),
          W,
          H,
          method,
        );
        const fit = fitOrThrow(points, method);
        expect(fit.method).toBe(reference.method);
        expect(fit.rms).toBeCloseTo(reference.rms, 7);
        expect(fit.metersPerPixel).toBeCloseTo(reference.mpp, 9);
        let seed = 7633;
        for (let i = 0; i < 40; i++) {
          seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
          const x = seed % W;
          seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
          const y = seed % H;
          const actual = forward(fit, [x, y]);
          const expected: LatLon = reference.fwd(x, y);
          expect(Math.abs(actual[0] - expected[0])).toBeLessThan(1e-9);
          expect(Math.abs(actual[1] - expected[1])).toBeLessThan(1e-9);
          const back = inverse(fit, actual);
          expect(back).not.toBeNull();
          expect(Math.hypot(back![0] - x, back![1] - y)).toBeLessThan(
            fit.method === 'tps' ? 0.01 : 1e-6,
          );
        }
      });
    }
});

describe('fit edge cases and helpers', () => {
  it('builds an exact affine grid whose corners match overlayQuad', () => {
    const fit = fitOrThrow(anchors(5), 'affine');
    const mesh = overlayMesh(fit, W, H, 8);
    expect(mesh.cols).toBe(8);
    expect(mesh.rows).toBe(5);
    expect(mesh.px).toHaveLength((mesh.cols + 1) * (mesh.rows + 1));
    expect(mesh.ll).toEqual(mesh.px.map((p) => forward(fit, p)));
    const at = (col: number, row: number): LatLon =>
      mesh.ll[row * (mesh.cols + 1) + col]!;
    expect(at(0, 0)).toEqual(forward(fit, [0, 0]));
    expect(at(mesh.cols, 0)).toEqual(overlayQuad(fit, W, H)[2]);
    expect(at(mesh.cols, mesh.rows)).toEqual(overlayQuad(fit, W, H)[1]);
    expect(at(0, mesh.rows)).toEqual(overlayQuad(fit, W, H)[0]);
    for (let row = 0; row <= mesh.rows; row++) {
      for (let col = 0; col <= mesh.cols; col++) {
        const t = col / mesh.cols;
        const u = row / mesh.rows;
        const top = at(0, 0), right = at(mesh.cols, 0);
        const bottom = at(0, mesh.rows), bottomRight = at(mesh.cols, mesh.rows);
        const expected: LatLon = [
          (1 - u) * ((1 - t) * top[0] + t * right[0]) + u * ((1 - t) * bottom[0] + t * bottomRight[0]),
          (1 - u) * ((1 - t) * top[1] + t * right[1]) + u * ((1 - t) * bottom[1] + t * bottomRight[1]),
        ];
        expect(Math.abs(at(col, row)[0] - expected[0])).toBeLessThan(1e-9);
        expect(Math.abs(at(col, row)[1] - expected[1])).toBeLessThan(1e-9);
      }
    }
  });

  it('samples TPS exactly and reports interpolation error for the warped fixture', () => {
    const meshAnchors: Anchor[] = [];
    for (let row = 0; row < 4; row++) {
      for (let col = 0; col < 4; col++) {
        const px: Px = [
          (warpedTruth.width * col) / 3,
          (warpedTruth.height * row) / 3,
        ];
        meshAnchors.push({
          id: `mesh-${row}-${col}`,
          px,
          ll: pixelToLatLon(px, warpedTruth.transform),
          source: 'paste',
        });
      }
    }
    const fit = fitOrThrow(meshAnchors, 'tps');
    expect(fit.model.kind).toBe('tps');
    const errors: Record<number, number> = {};
    for (const cells of [8, 16, 32]) {
      const mesh = overlayMesh(fit, warpedTruth.width, warpedTruth.height, cells);
      expect(mesh.ll).toEqual(mesh.px.map((p) => forward(fit, p)));
      let maxMeters = 0;
      for (let row = 0; row < mesh.rows; row++) {
        for (let col = 0; col < mesh.cols; col++) {
          const corners = [
            mesh.ll[row * (mesh.cols + 1) + col]!,
            mesh.ll[row * (mesh.cols + 1) + col + 1]!,
            mesh.ll[(row + 1) * (mesh.cols + 1) + col]!,
            mesh.ll[(row + 1) * (mesh.cols + 1) + col + 1]!,
          ];
          for (const fx of [0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875]) {
            for (const fy of [0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875]) {
              const px: Px = [
                mesh.px[row * (mesh.cols + 1) + col]![0] +
                  fx *
                    (mesh.px[row * (mesh.cols + 1) + col + 1]![0] -
                      mesh.px[row * (mesh.cols + 1) + col]![0]),
                mesh.px[row * (mesh.cols + 1) + col]![1] +
                  fy *
                    (mesh.px[(row + 1) * (mesh.cols + 1) + col]![1] -
                      mesh.px[row * (mesh.cols + 1) + col]![1]),
              ];
              const actual = forward(fit, px);
              const estimated: LatLon = [
                (1 - fy) * ((1 - fx) * corners[0]![0] + fx * corners[1]![0]) +
                  fy * ((1 - fx) * corners[2]![0] + fx * corners[3]![0]),
                (1 - fy) * ((1 - fx) * corners[0]![1] + fx * corners[1]![1]) +
                  fy * ((1 - fx) * corners[2]![1] + fx * corners[3]![1]),
              ];
              maxMeters = Math.max(
                maxMeters,
                Math.hypot(
                  (actual[0] - estimated[0]) * fit.frame.ky,
                  (actual[1] - estimated[1]) * fit.frame.kx,
                ),
              );
            }
          }
        }
      }
      errors[cells] = maxMeters;
    }
    console.info('warped overlay mesh interpolation max error (m):', errors);
    expect(errors[8]).toBeGreaterThanOrEqual(1);
    expect(errors[16]).toBeLessThan(1);
    expect(errors[32]).toBeLessThan(errors[16]!);
    expect(errors[16]).toBeLessThan(errors[8]!);
  });

  it('clamps cell count to 1..64, is deterministic, and builds 32 cells under 5 ms', () => {
    const fit = fitOrThrow(warpedTruth.anchors, 'tps');
    expect(overlayMesh(fit, W, H, -50).cols).toBe(1);
    expect(overlayMesh(fit, W, H, 500).cols).toBe(64);
    const first = overlayMesh(fit, W, H, 32);
    expect(overlayMesh(fit, W, H, 32)).toEqual(first);
    overlayMesh(fit, W, H, 32); // Warm up before measuring.
    const timings: number[] = [];
    for (let i = 0; i < 5; i++) {
      const started = performance.now();
      overlayMesh(fit, W, H, 32);
      timings.push(performance.now() - started);
    }
    timings.sort((a, b) => a - b);
    expect(timings[2]).toBeLessThan(5);
  });

  it('filters null and nonfinite positions; requires two controls', () => {
    const bad: Anchor[] = [
      { ...anchors(1)[0]!, ll: null },
      { ...anchors(1)[0]!, id: 'bad', ll: [Infinity, 0] },
    ];
    expect(fitAnchors(bad, W, H, 'auto')).toEqual({
      ok: false,
      reason: 'too-few',
      anchorCount: 0,
      need: 2,
    });
    expect(fitAnchors([...bad, anchors(1)[0]!], W, H, 'auto')).toEqual({
      ok: false,
      reason: 'too-few',
      anchorCount: 1,
      need: 1,
    });
  });
  it('rejects coincident controls and falls back on collinear affine controls', () => {
    const one = anchors(1)[0]!;
    expect(fitAnchors([one, { ...one, id: 'duplicate' }], W, H, 'similarity')).toMatchObject({
      ok: false,
      reason: 'degenerate',
      need: 0,
    });
    const line: Anchor[] = [0, 1, 2, 3].map((i) => ({
      id: `${i}`,
      px: [i * 100, i * 150],
      ll: ll([i * 100, i * 150]),
      source: 'paste',
    }));
    expect(fitOrThrow(line, 'affine').method).toBe('similarity');
    expect(fitOrThrow(line, 'tps').method).toBe('similarity');
  });
  it('falls back from singular TPS when an affine fit is still possible', () => {
    const controls = anchors(4);
    const duplicate = { ...controls[0]!, id: 'duplicate' };
    expect(fitOrThrow([...controls, duplicate], 'tps').method).toBe('affine');
  });
  it('recovers exact similarity and affine transforms', () => {
    for (const method of ['similarity', 'affine'] as const) {
      const controlPixels = positions.slice(0, 5);
      const meanX = controlPixels.reduce((s, p) => s + p[0], 0) / controlPixels.length;
      const meanY = controlPixels.reduce((s, p) => s + p[1], 0) / controlPixels.length;
      const points = controlPixels.map((px, i) => {
        const x = px[0] - meanX,
          y = px[1] - meanY;
        const E = method === 'similarity' ? 0.5 * x + 0.3 * y : 0.5 * x + 0.2 * y;
        const N = method === 'similarity' ? 0.3 * x - 0.5 * y : 0.1 * x - 0.7 * y;
        return {
          id: String(i),
          px,
          ll: [lat0 + N / ky, lon0 + E / kx] as LatLon,
          source: 'paste' as const,
        };
      });
      const fit = fitOrThrow(points, method);
      expect(fit.rms).toBeLessThan(1e-6);
      expect(Math.max(...Object.values(fit.residuals))).toBeLessThan(1e-6);
      expect(fit.checked).toBe(true);
    }
  });
  it('reports mirror, scale, paths, corners, and red pins', () => {
    const points = anchors(4);
    const fit = fitOrThrow(points, 'affine');
    expect(fit.mirrored).toBe(false);
    expect(fit.implausibleScale).toBe(false);
    expect(structuredClone(fit)).toEqual(fit);
    expect(projectPath(fit, positions.slice(0, 2))).toEqual(
      positions.slice(0, 2).map((p) => forward(fit, p)),
    );
    const corners: Px[] = [
      [0, H],
      [W, H],
      [W, 0],
      [0, 0],
    ];
    expect(overlayQuad(fit, W, H)).toEqual(corners.map((p) => forward(fit, p)));
    expect(isOutlier(fit, '0')).toBe(false);
    const flipped = points.map((p) => ({ ...p, ll: [p.ll![1], p.ll![0]] as LatLon }));
    expect(fitOrThrow(flipped, 'affine').mirrored).toBe(true);
    const huge = points.map((p) => ({
      ...p,
      ll: [lat0 + (p.ll![0] - lat0) * 1000, lon0 + (p.ll![1] - lon0) * 1000] as LatLon,
    }));
    expect(fitOrThrow(huge, 'affine').implausibleScale).toBe(true);
    const noisy = [...anchors(7), { ...anchors(8)[7]!, ll: [lat0 + 0.02, lon0 + 0.02] as LatLon }];
    const badFit = fitOrThrow(noisy, 'affine');
    expect(isOutlier(badFit, '7')).toBe(true);
  });
});
