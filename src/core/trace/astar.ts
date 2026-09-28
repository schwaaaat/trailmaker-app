import type { JobHooks, Px, RasterImage, Rgb } from '../types';
import { simplify } from './simplify';

class MinHeap {
  private keys = new Int32Array(4096);
  private priorities = new Float64Array(4096);
  size = 0;

  clear(): void {
    this.size = 0;
  }

  push(key: number, priority: number): void {
    if (this.size === this.keys.length) {
      const capacity = this.size * 2;
      const keys = new Int32Array(capacity),
        priorities = new Float64Array(capacity);
      keys.set(this.keys);
      priorities.set(this.priorities);
      this.keys = keys;
      this.priorities = priorities;
    }
    const keys = this.keys,
      priorities = this.priorities;
    let i = this.size++;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (priorities[parent]! <= priority) break;
      keys[i] = keys[parent]!;
      priorities[i] = priorities[parent]!;
      i = parent;
    }
    keys[i] = key;
    priorities[i] = priority;
  }

  pop(): number {
    const keys = this.keys,
      priorities = this.priorities;
    const first = keys[0]!;
    const size = --this.size;
    if (size > 0) {
      const key = keys[size]!,
        priority = priorities[size]!;
      let i = 0;
      for (;;) {
        let child = 2 * i + 1;
        if (child >= size) break;
        if (child + 1 < size && priorities[child + 1]! < priorities[child]!) child++;
        if (priorities[child]! >= priority) break;
        keys[i] = keys[child]!;
        priorities[i] = priorities[child]!;
        i = child;
      }
      keys[i] = key;
      priorities[i] = priority;
    }
    return first;
  }
}

const heap = new MinHeap();
let costs = new Float32Array(0);
let pathCosts = new Float32Array(0);
let previous = new Int32Array(0);
let completed = new Uint8Array(0);
function reserve(size: number): void {
  if (costs.length >= size) return;
  costs = new Float32Array(size);
  pathCosts = new Float32Array(size);
  previous = new Int32Array(size);
  completed = new Uint8Array(size);
}
const DX = [1, -1, 0, 0, 1, 1, -1, -1] as const;
const DY = [0, 0, 1, -1, 1, -1, 1, -1] as const;

/** A* over an expanded image window, reusing typed-array scratch between synchronous calls. */
export function tracePath(
  img: RasterImage,
  a: Px,
  b: Px,
  ink: Rgb,
  tolerance: number,
  hooks?: JobHooks,
): Px[] | null {
  const { data, width, height } = img;
  hooks?.throwIfCancelled();
  hooks?.progress(0, 'Preparing trace');
  if (
    !width ||
    !height ||
    !Number.isFinite(a[0]) ||
    !Number.isFinite(a[1]) ||
    !Number.isFinite(b[0]) ||
    !Number.isFinite(b[1])
  )
    return null;
  const ax = Math.round(a[0]),
    ay = Math.round(a[1]),
    bx = Math.round(b[0]),
    by = Math.round(b[1]);
  if (
    ax < 0 ||
    ay < 0 ||
    bx < 0 ||
    by < 0 ||
    ax >= width ||
    bx >= width ||
    ay >= height ||
    by >= height
  )
    return null;
  const distance = Math.hypot(bx - ax, by - ay);
  const margin = Math.max(24, distance * 0.4);
  const x0 = Math.max(0, Math.floor(Math.min(ax, bx) - margin));
  const x1 = Math.min(width - 1, Math.ceil(Math.max(ax, bx) + margin));
  const y0 = Math.max(0, Math.floor(Math.min(ay, by) - margin));
  const y1 = Math.min(height - 1, Math.ceil(Math.max(ay, by) + margin));
  const w = x1 - x0 + 1,
    h = y1 - y0 + 1,
    size = w * h;
  if (size > 3.2e6 || w < 1 || h < 1) return null;
  reserve(size);
  costs.fill(0, 0, size);
  pathCosts.fill(Infinity, 0, size);
  previous.fill(-1, 0, size);
  completed.fill(0, 0, size);
  const started = performance.now();
  let lastCheck = started;
  const check = (fraction: number, stage: string, force = false): void => {
    const now = performance.now();
    if (force || now - lastCheck >= 45) {
      hooks?.throwIfCancelled();
      hooks?.progress(fraction, stage);
      lastCheck = now;
    }
  };
  const colorTolerance = Math.max(1e-6, tolerance);
  for (let yy = 0, k = 0; yy < h; yy++) {
    let pixel = ((yy + y0) * width + x0) * 4;
    for (let xx = 0; xx < w; xx++, k++, pixel += 4) {
      const dr = data[pixel]! - ink[0],
        dg = data[pixel + 1]! - ink[1],
        db = data[pixel + 2]! - ink[2];
      const t = Math.hypot(dr, dg, db) / colorTolerance;
      costs[k] = t <= 1 ? 1 + 0.6 * t : 8 + t * 5;
    }
    check(0.15 * ((yy + 1) / h), 'Scoring pixels');
  }
  const start = (ay - y0) * w + (ax - x0);
  const end = (by - y0) * w + (bx - x0);
  const endX = bx - x0,
    endY = by - y0;
  const heuristic = (index: number): number => {
    const dx = Math.abs((index % w) - endX);
    const dy = Math.abs(Math.floor(index / w) - endY);
    return dx + dy + (Math.SQRT2 - 2) * Math.min(dx, dy);
  };
  heap.clear();
  pathCosts[start] = 0;
  heap.push(start, heuristic(start));
  let expansions = 0;
  while (heap.size) {
    const index = heap.pop();
    if (completed[index]!) continue;
    if (index === end) break;
    completed[index] = 1;
    expansions++;
    const x = index % w,
      y = Math.floor(index / w),
      baseCost = pathCosts[index]!,
      sourceCost = costs[index]!;
    for (let direction = 0; direction < 8; direction++) {
      const nx = x + DX[direction]!,
        ny = y + DY[direction]!;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const neighbor = ny * w + nx;
      if (completed[neighbor]!) continue;
      const step = direction < 4 ? 1 : Math.SQRT2;
      const nextCost = baseCost + step * (sourceCost + costs[neighbor]!) * 0.5;
      if (nextCost < pathCosts[neighbor]!) {
        pathCosts[neighbor] = nextCost;
        previous[neighbor] = index;
        heap.push(neighbor, nextCost + heuristic(neighbor));
      }
    }
    if ((expansions & 255) === 0) check(0.15 + 0.8 * (expansions / size), 'Finding path');
  }
  if (start !== end && previous[end]! < 0) return null;
  const reversed: Px[] = [];
  let index = end;
  while (index !== -1) {
    reversed.push([(index % w) + x0, Math.floor(index / w) + y0]);
    if (index === start) break;
    index = previous[index]!;
  }
  if (reversed.at(-1)?.[0] !== ax || reversed.at(-1)?.[1] !== ay) return null;
  reversed.reverse();
  const path = simplify(reversed, 0.9);
  check(1, 'Trace complete', true);
  return path;
}
