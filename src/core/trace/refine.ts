import type { JobHooks, Px, RasterImage, RefineSegment, Rgb } from '../types';
import { simplify } from './simplify';

type Node = { x: number; y: number; score: number; parent: number };

function medianColor(img: RasterImage, pts: readonly Px[]): Rgb {
  const channels = [[], [], []] as number[][];
  for (const [x0, y0] of pts) {
    const x = Math.max(0, Math.min(img.width - 1, Math.round(x0)));
    const y = Math.max(0, Math.min(img.height - 1, Math.round(y0)));
    const i = (y * img.width + x) * 4;
    for (let c = 0; c < 3; c++) channels[c]!.push(img.data[i + c]!);
  }
  return channels.map((values) => {
    values.sort((a, b) => a - b);
    return values[Math.floor(values.length / 2)] ?? 0;
  }) as unknown as Rgb;
}

function medianRgb(values: readonly Rgb[]): Rgb {
  return [0, 1, 2].map((channel) => {
    const sorted = values.map((rgb) => rgb[channel]!).sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)] ?? 0;
  }) as unknown as Rgb;
}

function sample(img: RasterImage, x: number, y: number): Rgb {
  const i =
    (Math.max(0, Math.min(img.height - 1, Math.round(y))) * img.width +
      Math.max(0, Math.min(img.width - 1, Math.round(x)))) *
    4;
  return [img.data[i]!, img.data[i + 1]!, img.data[i + 2]!];
}

function colorDistance(a: Rgb, b: Rgb): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function inferDistinctInk(
  img: RasterImage,
  pts: readonly Px[],
  corridor: number,
  tolerance: number,
): Rgb | null {
  const total = lengthOf(pts);
  if (total < 1 || corridor < 2) return null;
  const votes = new Map<string, { count: number; r: number; g: number; b: number }>();
  const centerSamples: Rgb[] = [];
  const backgrounds: Rgb[] = [];
  let stations = 0;
  for (let distance = 0; distance <= total; distance += 4) {
    const center = pointAt(pts, distance);
    const before = pointAt(pts, Math.max(0, distance - 2));
    const after = pointAt(pts, Math.min(total, distance + 2));
    const dx = after[0] - before[0];
    const dy = after[1] - before[1];
    const length = Math.hypot(dx, dy) || 1;
    const nx = -dy / length;
    const ny = dx / length;
    const left = sample(img, center[0] - nx * corridor, center[1] - ny * corridor);
    const right = sample(img, center[0] + nx * corridor, center[1] + ny * corridor);
    centerSamples.push(sample(img, center[0], center[1]));
    const background = medianRgb([left, right]);
    backgrounds.push(background);
    let best: Rgb | null = null;
    let bestContrast = tolerance;
    for (let offset = -corridor; offset <= corridor; offset++) {
      const candidate = sample(img, center[0] + nx * offset, center[1] + ny * offset);
      const contrast = Math.min(colorDistance(candidate, left), colorDistance(candidate, right));
      if (contrast > bestContrast) {
        best = candidate;
        bestContrast = contrast;
      }
    }
    if (best) {
      const key = `${best[0] >> 4},${best[1] >> 4},${best[2] >> 4}`;
      const vote = votes.get(key) ?? { count: 0, r: 0, g: 0, b: 0 };
      vote.count++;
      vote.r += best[0];
      vote.g += best[1];
      vote.b += best[2];
      votes.set(key, vote);
    }
    stations++;
  }
  const centerlineMedian = medianRgb(centerSamples);
  const flankMedian = medianRgb(backgrounds);
  if (colorDistance(centerlineMedian, flankMedian) > tolerance) return centerlineMedian;
  const strongest = [...votes.values()].sort((a, b) => b.count - a.count)[0];
  if (!strongest || strongest.count / Math.max(1, stations) < 0.5) return null;
  const ink: Rgb = [
    Math.round(strongest.r / strongest.count),
    Math.round(strongest.g / strongest.count),
    Math.round(strongest.b / strongest.count),
  ];
  if (colorDistance(ink, flankMedian) <= tolerance) return null;
  return ink;
}

function pointAt(pts: readonly Px[], distance: number): Px {
  let left = distance;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (left <= length || i === pts.length - 1) {
      const t = length === 0 ? 0 : Math.min(1, left / length);
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    }
    left -= length;
  }
  return pts.at(-1)!;
}

function lengthOf(pts: readonly Px[]): number {
  let n = 0;
  for (let i = 1; i < pts.length; i++)
    n += Math.hypot(pts[i]![0] - pts[i - 1]![0], pts[i]![1] - pts[i - 1]![1]);
  return n;
}

function corridorPath(
  img: RasterImage,
  hand: readonly Px[],
  ink: Rgb,
  corridor: number,
  tolerance: number,
  hooks?: JobHooks,
): { path: Px[]; confidence: number } | null {
  const minX = Math.max(0, Math.floor(Math.min(...hand.map((p) => p[0])) - corridor));
  const maxX = Math.min(img.width - 1, Math.ceil(Math.max(...hand.map((p) => p[0])) + corridor));
  const minY = Math.max(0, Math.floor(Math.min(...hand.map((p) => p[1])) - corridor));
  const maxY = Math.min(img.height - 1, Math.ceil(Math.max(...hand.map((p) => p[1])) + corridor));
  const width = maxX - minX + 1;
  const height = maxY - minY + 1;
  if (width <= 0 || height <= 0 || width * height > 1_000_000) return null;
  const count = width * height;
  const dist = new Float64Array(count);
  dist.fill(Infinity);
  const parent = new Int32Array(count);
  parent.fill(-1);
  const closed = new Uint8Array(count);
  const heap: Node[] = [];
  const nearestIndex = (p: Px) =>
    Math.max(0, Math.min(height - 1, Math.round(p[1]) - minY)) * width +
    Math.max(0, Math.min(width - 1, Math.round(p[0]) - minX));
  const start = nearestIndex(hand[0]!);
  const goal = nearestIndex(hand.at(-1)!);
  dist[start] = 0;
  heap.push({ x: start % width, y: Math.floor(start / width), score: 0, parent: -1 });
  const dirs = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
    [1, 1],
    [1, -1],
    [-1, 1],
    [-1, -1],
  ] as const;
  let found = false;
  let iterations = 0;
  const pop = (): Node => {
    const n = heap[0]!;
    const last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      let i = 0;
      while (true) {
        let child = i * 2 + 1;
        if (child >= heap.length) break;
        if (child + 1 < heap.length && heap[child + 1]!.score < heap[child]!.score) child++;
        if (heap[i]!.score <= heap[child]!.score) break;
        [heap[i], heap[child]] = [heap[child]!, heap[i]!];
        i = child;
      }
    }
    return n;
  };
  const push = (n: Node) => {
    heap.push(n);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p]!.score <= n.score) break;
      heap[i] = heap[p]!;
      i = p;
    }
    heap[i] = n;
  };
  while (heap.length) {
    if ((iterations++ & 2047) === 0) {
      if (hooks?.throwIfCancelled) hooks.throwIfCancelled();
    }
    const n = pop();
    const idx = n.y * width + n.x;
    if (closed[idx]) continue;
    closed[idx] = 1;
    if (idx === goal) {
      found = true;
      break;
    }
    for (const [dx, dy] of dirs) {
      const nx = n.x + dx;
      const ny = n.y + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const px = nx + minX;
      const py = ny + minY;
      let handDistance = Infinity;
      for (let i = 1; i < hand.length; i++) {
        const a = hand[i - 1]!;
        const b = hand[i]!;
        const vx = b[0] - a[0];
        const vy = b[1] - a[1];
        const t = Math.max(
          0,
          Math.min(1, ((px - a[0]) * vx + (py - a[1]) * vy) / (vx * vx + vy * vy || 1)),
        );
        handDistance = Math.min(handDistance, Math.hypot(px - a[0] - t * vx, py - a[1] - t * vy));
      }
      if (handDistance > corridor) continue;
      const delta = colorDistance(sample(img, px, py), ink);
      const step = dx && dy ? Math.SQRT2 : 1;
      const next =
        idx === start || idx === goal
          ? 0
          : delta / Math.max(1, tolerance) + (handDistance / Math.max(1, corridor)) ** 2 * 2;
      const alt = dist[idx]! + step * (0.2 + next);
      const ni = ny * width + nx;
      if (alt < dist[ni]!) {
        dist[ni] = alt;
        parent[ni] = idx;
        push({ x: nx, y: ny, score: alt, parent: idx });
      }
    }
  }
  if (!found) return null;
  const indexes: number[] = [];
  for (let i = goal; i >= 0; i = parent[i]!) {
    indexes.push(i);
    if (i === start) break;
  }
  if (indexes.at(-1) !== start) return null;
  indexes.reverse();
  const path = indexes.map((i) => [(i % width) + minX, Math.floor(i / width) + minY] as Px);
  let good = 0;
  for (const [x, y] of path) if (colorDistance(sample(img, x, y), ink) <= tolerance) good++;
  return { path, confidence: path.length ? good / path.length : 0 };
}

export function refineLine(
  img: RasterImage,
  pts: readonly Px[],
  corridorPx: number,
  ink: Rgb | null,
  tolerance: number,
  pinned: readonly number[],
  hooks?: JobHooks,
): Omit<import('../types').RefineResult, 'ms'> {
  if (pts.length < 2)
    return {
      pts: pts.slice(),
      segments: [],
      ink: ink ?? sample(img, pts[0]?.[0] ?? 0, pts[0]?.[1] ?? 0),
    };
  const total = lengthOf(pts);
  const sampled = Array.from({ length: Math.max(2, Math.ceil(total / 10) + 1) }, (_, i) =>
    pointAt(pts, (total * i) / (Math.max(2, Math.ceil(total / 10) + 1) - 1)),
  );
  const sampledColor = medianColor(img, sampled);
  const selectedInk = ink ?? inferDistinctInk(img, pts, corridorPx, tolerance);
  if (!selectedInk) {
    return {
      pts: pts.slice(),
      segments: [{ from: 0, to: pts.length - 1, refined: false, confidence: 0 }],
      ink: sampledColor,
    };
  }
  const stationDistances = new Set<number>([0, total]);
  for (let d = 60; d < total; d += 60) stationDistances.add(d);
  const pinnedStations = new Map<number, Px>();
  let acc = 0;
  pts.forEach((p, i) => {
    if (pinned.includes(i)) {
      stationDistances.add(acc);
      pinnedStations.set(acc, p);
    }
    if (i < pts.length - 1) acc += Math.hypot(pts[i + 1]![0] - p[0], pts[i + 1]![1] - p[1]);
  });
  const stationOffsets = [...stationDistances].sort((a, b) => a - b);
  const stations = stationOffsets.map((d, i) => {
    const pinnedPoint = pinnedStations.get(d);
    if (pinnedPoint) return pinnedPoint;
    const p = pointAt(pts, d);
    if (
      i === 0 ||
      i === stationOffsets.length - 1 ||
      pinned.some((index) => {
        let offset = 0;
        for (let j = 0; j < index; j++)
          offset += Math.hypot(pts[j + 1]![0] - pts[j]![0], pts[j + 1]![1] - pts[j]![1]);
        return Math.abs(offset - d) < 0.01;
      })
    )
      return p;
    let best = p;
    let cost = Infinity;
    for (
      let y = Math.max(0, Math.floor(p[1] - corridorPx));
      y <= Math.min(img.height - 1, Math.ceil(p[1] + corridorPx));
      y++
    ) {
      for (
        let x = Math.max(0, Math.floor(p[0] - corridorPx));
        x <= Math.min(img.width - 1, Math.ceil(p[0] + corridorPx));
        x++
      ) {
        const d =
          colorDistance(sample(img, x, y), selectedInk) +
          (Math.hypot(x - p[0], y - p[1]) * tolerance) / Math.max(1, corridorPx);
        if (d < cost) {
          cost = d;
          best = [x, y];
        }
      }
    }
    return cost <= tolerance ? best : p;
  });
  const out: Px[] = [stations[0]!];
  const segments: RefineSegment[] = [];
  hooks?.progress(0, 'Refining trail');
  for (let i = 1; i < stations.length; i++) {
    hooks?.throwIfCancelled();
    const a = stations[i - 1]!;
    const b = stations[i]!;
    const hand: Px[] = [a];
    for (let d = stationOffsets[i - 1]! + 10; d < stationOffsets[i]!; d += 10)
      hand.push(pointAt(pts, d));
    hand.push(b);
    const result = corridorPath(img, hand, selectedInk, corridorPx, tolerance, hooks);
    const refined = !!result && result.confidence >= 0.6;
    const path = refined ? simplify(result!.path, 0.9) : [b];
    const from = out.length - 1;
    out.push(...path.slice(1));
    segments.push({ from, to: out.length - 1, refined, confidence: result?.confidence ?? 0 });
    hooks?.progress(i / (stations.length - 1), 'Refining trail');
  }
  hooks?.progress(1, 'Refining trail');
  if (segments.every((s) => !s.refined)) {
    return {
      pts: pts.slice(),
      segments: [{ from: 0, to: pts.length - 1, refined: false, confidence: 0 }],
      ink: selectedInk,
    };
  }
  return { pts: out, segments, ink: selectedInk };
}
