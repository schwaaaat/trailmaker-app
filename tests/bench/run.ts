import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { autoTraceColor, deriveDefaultAutoTraceOptions } from '../../src/core/trace/autotrace';
import { tracePath } from '../../src/core/trace/astar';
import { scanColors } from '../../src/core/trace/scan';
import { refineLine } from '../../src/core/trace/refine';
import { newProject } from '../../src/core/project';
import type { Anchor, Px, RasterImage, Rgb } from '../../src/core/types';
import { fixtureNames, generate } from '../fixtures/generate';
import type { FixtureTruth } from '../fixtures/truth';
import { hausdorff, lengthRecallPrecision } from '../metrics/geometry';

export interface BenchRow {
  target: string;
  status: 'pass' | 'fail' | 'pending' | 'report';
  recall?: number;
  precision?: number;
  ms?: number;
  reason?: string;
}
export function measure<T>(fn: () => T, stub: string): { value: T; ms: number } | null {
  const start = performance.now();
  try {
    return { value: fn(), ms: performance.now() - start };
  } catch (error) {
    if (error instanceof Error && error.message === `not implemented: ${stub}`) return null;
    throw error;
  }
}
export function passesQuality(recall: number, precision: number) {
  return (
    Number.isFinite(recall) && Number.isFinite(precision) && recall >= 0.95 && precision >= 0.9
  );
}

function noisySparseLine(pts: readonly Px[], metersPerPixel: number): Px[] {
  const sampled: Px[] = [pts[0]!];
  let accumulated = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    accumulated += length;
    if (accumulated >= 10 || i === pts.length - 1) {
      sampled.push(b);
      accumulated = 0;
    }
  }
  return sampled.map((p, i) => {
    if (i === 0 || i === sampled.length - 1) return p;
    const a = sampled[i - 1]!;
    const b = sampled[i + 1]!;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const length = Math.hypot(dx, dy) || 1;
    const noiseMeters = (((i * 17) % 7) - 3) * 0.5;
    const offset = noiseMeters / Math.max(0.001, metersPerPixel);
    return [p[0] - (dy / length) * offset, p[1] + (dx / length) * offset] as Px;
  });
}

const realFixtureNames = ['dickey-ridge', 'acadia-carriage-roads', 'zion-wilderness'] as const;

interface RealTruth {
  readonly image: string;
  readonly anchors: readonly Anchor[];
  readonly baseline: { readonly recall: number; readonly precision: number };
  readonly trace: {
    readonly color: Rgb;
    readonly tolerance: number;
    readonly gapPx?: number;
    readonly minLengthPx?: number;
    readonly pts: readonly Px[];
  };
}

export async function runBench(): Promise<BenchRow[]> {
  await generate();
  const rows: BenchRow[] = [];
  for (const name of fixtureNames) {
    const truth = JSON.parse(
      await readFile(`tests/fixtures/generated/${name}.truth.json`, 'utf8'),
    ) as FixtureTruth;
    const decoded = await sharp(`tests/fixtures/generated/${name}.png`)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const image: RasterImage = {
      width: decoded.info.width,
      height: decoded.info.height,
      data: new Uint8ClampedArray(decoded.data),
    };
    const colors = [
      ...new Map(truth.polylines.map((line) => [line.color.join(','), line.color])).values(),
    ];
    let totalMs = 0,
      pending = false;
    for (const color of colors) {
      const result = measure(
        () =>
          autoTraceColor(image, color, {
            tolerance: 60,
            gapPx: Math.max(10, Math.round(truth.width / 80)),
            minLengthPx: truth.width * 0.04,
          }),
        'trace/autotrace.autoTraceColor',
      );
      const target = `${name}: ${color.join(',')}`;
      if (!result) {
        pending = true;
        rows.push({ target, status: 'pending', reason: 'T-105 autoTraceColor' });
        continue;
      }
      totalMs += result.ms;
      const expected = truth.polylines
        .filter((line) => line.color.join(',') === color.join(','))
        .map((line) => line.pts);
      const quality = lengthRecallPrecision(
        result.value.map((line) => line.pts),
        expected,
        3,
      );
      rows.push({
        target,
        status: passesQuality(quality.recall, quality.precision) ? 'pass' : 'fail',
        ...quality,
        ms: result.ms,
      });
    }
    if (name === 'benchmark') {
      rows.push(
        pending
          ? {
              target: '3000x2200 / 3 colors / Node <1500ms',
              status: 'pending',
              reason: 'T-105; worker measurement waits T-106',
            }
          : (() => {
              // D-019 item 3: a single cold pass swung 0.76-1.59 s on a shared host with the
              // same code, so gate on the median of 5 warm passes (the scan row uses 20).
              const passes: number[] = [];
              for (let run = 0; run < 5; run++) {
                const started = performance.now();
                for (const color of colors) {
                  autoTraceColor(image, color, {
                    tolerance: 60,
                    gapPx: Math.max(10, Math.round(truth.width / 80)),
                    minLengthPx: truth.width * 0.04,
                  });
                }
                passes.push(performance.now() - started);
              }
              passes.sort((a, b) => a - b);
              const medianMs = passes[2]!;
              return {
                target: '3000x2200 / 3 colors / Node 5-run median <1500ms',
                status: medianMs < 1500 ? ('pass' as const) : ('fail' as const),
                ms: medianMs,
                reason: `cold first pass ${totalMs.toFixed(0)} ms; passes ${passes.map((v) => v.toFixed(0)).join('/')} ms`,
              };
            })(),
      );
      const target = '3000x2200 / color scan / Node 20-run median <300ms';
      const samples: number[] = [];
      let scanPending = false;
      for (let run = 0; run < 20; run++) {
        const result = measure(() => scanColors(image), 'trace/scan.scanColors');
        if (!result) {
          scanPending = true;
          break;
        }
        samples.push(result.ms);
      }
      if (scanPending) rows.push({ target, status: 'pending', reason: 'T-104 scanColors' });
      else {
        samples.sort((a, b) => a - b);
        const medianMs = (samples[9]! + samples[10]!) / 2;
        rows.push({ target, status: medianMs < 300 ? 'pass' : 'fail', ms: medianMs });
      }
    }
    if (name === 'solid' || name === 'dashed' || name === 'crossings') {
      const refineTarget = `refine ${name} / 10px samples, ±1.5m input noise / >=95% within 2px`;
      const refineTruth = truth.polylines.find((line) => line.id === 'red-ridge');
      if (!refineTruth) throw new Error(`Missing ${name} refinement truth`);
      const handLine = noisySparseLine(refineTruth.pts, truth.transform.metersPerPixel);
      const refined = measure(
        () =>
          refineLine(
            image,
            handLine,
            Math.max(6, Math.min(40, 4 / truth.transform.metersPerPixel)),
            refineTruth.color,
            60,
            [],
          ),
        'trace/refine.refineLine',
      );
      if (!refined)
        rows.push({ target: refineTarget, status: 'pending', reason: 'T-327 refineLine' });
      else {
        const quality = lengthRecallPrecision([refined.value.pts], [refineTruth.pts], 2);
        rows.push({
          target: refineTarget,
          status: quality.recall >= 0.95 && quality.precision >= 0.95 ? 'pass' : 'fail',
          ...quality,
          ms: refined.ms,
        });
      }
      const target = `smart-follow ${name} 400px / Node median <100ms, Hausdorff <=2px`;
      const truthHop = truth.polylines.find((line) => line.id === 'red-ridge')?.pts.slice(0, 51);
      if (!truthHop || truthHop.length !== 51)
        throw new Error(`Missing ${name} smart-follow truth`);
      const timings: number[] = [];
      let traced: ReturnType<typeof tracePath> = null;
      let isPending = false;
      for (let run = 0; run < 20; run++) {
        const result = measure(
          () => tracePath(image, truthHop[0]!, truthHop.at(-1)!, [205, 48, 48], 60),
          'trace/astar.tracePath',
        );
        if (!result) {
          isPending = true;
          break;
        }
        traced = result.value;
        timings.push(result.ms);
      }
      if (isPending) rows.push({ target, status: 'pending', reason: 'T-103 tracePath' });
      else {
        timings.sort((a, b) => a - b);
        const medianMs = (timings[9]! + timings[10]!) / 2;
        rows.push({
          target,
          status:
            traced && hausdorff(traced, truthHop, 0.5) <= 2 && medianMs < 100 ? 'pass' : 'fail',
          ms: medianMs,
        });
      }
    }
  }
  for (const name of realFixtureNames) {
    const truth = JSON.parse(
      await readFile(`tests/fixtures/real/${name}.truth.json`, 'utf8'),
    ) as RealTruth;
    if (truth.anchors.length < 3 || truth.trace.pts.length < 2) {
      throw new Error(`Incomplete hand-made truth for real fixture ${name}`);
    }
    const path = `tests/fixtures/real/${truth.image}`;
    const metadata = await sharp(path).metadata();
    if (!metadata.width || !metadata.height) throw new Error(`Missing image dimensions: ${path}`);
    const xs = truth.trace.pts.map((p) => p[0]);
    const ys = truth.trace.pts.map((p) => p[1]);
    // Score a reproducible local map region around the marked route. Whole-map precision would
    // count unrelated trail networks and duplicate insets as false positives for one route.
    const left = Math.max(0, Math.floor(Math.min(...xs) - 30));
    const top = Math.max(0, Math.floor(Math.min(...ys) - 30));
    const right = Math.min(metadata.width, Math.ceil(Math.max(...xs) + 31));
    const bottom = Math.min(metadata.height, Math.ceil(Math.max(...ys) + 31));
    const decoded = await sharp(path)
      .extract({ left, top, width: right - left, height: bottom - top })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const image: RasterImage = {
      width: decoded.info.width,
      height: decoded.info.height,
      data: new Uint8ClampedArray(decoded.data),
    };
    const expected = truth.trace.pts.map(([x, y]) => [x - left, y - top] as Px);
    const started = performance.now();
    const actual = autoTraceColor(image, truth.trace.color, {
      tolerance: truth.trace.tolerance,
      gapPx: truth.trace.gapPx ?? 10,
      minLengthPx: truth.trace.minLengthPx ?? 10,
    });
    const ms = performance.now() - started;
    const quality = lengthRecallPrecision(
      actual.map((line) => line.pts),
      [expected],
      5,
    );
    const recallFloor = truth.baseline.recall - 0.03;
    const precisionFloor = truth.baseline.precision - 0.03;
    rows.push({
      target: `real/${name} / auto-trace route region`,
      status:
        quality.recall >= recallFloor && quality.precision >= precisionFloor ? 'pass' : 'fail',
      ...quality,
      ms,
      reason: `baseline ${truth.baseline.recall.toFixed(3)}/${truth.baseline.precision.toFixed(3)}; floor ${recallFloor.toFixed(3)}/${precisionFloor.toFixed(3)}; 5 px`,
    });
    // Use the full working-map dimensions to derive app defaults, then score the same
    // marked local region as the tuned row. The picked chip uses the hand-marked ink color.
    const defaults = newProject(
      {
        fileName: truth.image,
        width: metadata.width,
        height: metadata.height,
        originalWidth: metadata.width,
        originalHeight: metadata.height,
        source: { kind: 'image', mimeType: 'image/png' },
        sha256: '0'.repeat(64),
      },
      name,
      '2026-09-27T00:00:00.000Z',
    );
    const defaultMinLengthPx =
      (defaults.autoTrace.minLengthPct / 100) * Math.max(metadata.width, metadata.height);
    // The worker derives effective options from the full map size and picked ink (T-116).
    const effective = deriveDefaultAutoTraceOptions(
      { width: metadata.width, height: metadata.height },
      truth.trace.color,
      {
        tolerance: defaults.trace.tolerance,
        gapPx: defaults.autoTrace.gapPx,
        minLengthPx: defaultMinLengthPx,
      },
    );
    const defaultStarted = performance.now();
    const defaultCandidates = autoTraceColor(image, truth.trace.color, effective);
    const defaultMs = performance.now() - defaultStarted;
    rows.push({
      target: `real/${name} / default auto-trace route region`,
      status: 'report',
      ...lengthRecallPrecision(
        defaultCandidates.map((line) => line.pts),
        [expected],
        5,
      ),
      ms: defaultMs,
      reason: `non-gating; effective tolerance ${effective.tolerance}, gap ${effective.gapPx} px, min length ${effective.minLengthPx.toFixed(2)} px (project defaults ${defaults.trace.tolerance}/${defaults.autoTrace.gapPx}/${defaultMinLengthPx.toFixed(2)}); 5 px`,
    });
  }
  // A 3 km trail at 0.15 m/px is 20,000 image pixels. This times the exact synchronous
  // routine called by WorkerApi.refineTrail on a narrow, bounded raster corridor.
  const longWidth = 20_000;
  const longHeight = 32;
  const longData = new Uint8ClampedArray(longWidth * longHeight * 4);
  for (let pixel = 0; pixel < longWidth * longHeight; pixel++) {
    const index = pixel * 4;
    longData[index] = 90;
    longData[index + 1] = 137;
    longData[index + 2] = 76;
    longData[index + 3] = 255;
  }
  for (let x = 0; x < longWidth; x++) {
    for (let y = 13; y <= 15; y++) {
      const index = (y * longWidth + x) * 4;
      longData[index] = 205;
      longData[index + 1] = 48;
      longData[index + 2] = 48;
    }
  }
  const longImage: RasterImage = { width: longWidth, height: longHeight, data: longData };
  const longPts: Px[] = [
    [2, 17],
    [longWidth - 3, 17],
  ];
  const longTimings: number[] = [];
  for (let run = 0; run < 3; run++) {
    const measured = measure(
      () => refineLine(longImage, longPts, 6, [205, 48, 48], 60, []),
      'trace/refine.refineLine',
    );
    if (!measured) break;
    longTimings.push(measured.ms);
  }
  longTimings.sort((a, b) => a - b);
  const longMedian = longTimings[Math.floor(longTimings.length / 2)] ?? Infinity;
  rows.push({
    target: '3000 m / 0.15 m per px / worker refine routine <1500 ms',
    status: longMedian < 1500 ? 'pass' : 'fail',
    ms: longMedian,
    reason: `20,000 px route; ${longTimings.map((value) => value.toFixed(1)).join(' / ')} ms`,
  });
  return rows;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const rows = await runBench();
  console.table(rows);
  console.info(
    `Bench: ${rows.filter((r) => r.status === 'pass').length} passed, ${rows.filter((r) => r.status === 'report').length} reported, ${rows.filter((r) => r.status === 'pending').length} pending, ${rows.filter((r) => r.status === 'fail').length} failed. Synthetic: 3 px, recall >=95%, precision >=90%; real: 5 px, per-fixture baseline minus 3 points; default-profile rows non-gating.`,
  );
  if (rows.some((r) => r.status === 'fail')) process.exitCode = 1;
}
