import type { LatLon, Px } from '../../src/core/types';

export type Polyline = readonly Px[];
type Segment = readonly [Px, Px];
const sub = (a: Px, b: Px): Px => [a[0] - b[0], a[1] - b[1]];
const dot = (a: Px, b: Px) => a[0] * b[0] + a[1] * b[1];
const norm = (p: Px) => Math.hypot(...p);
function segments(lines: readonly Polyline[]): Segment[] {
  return lines.flatMap((line) =>
    line.length === 1
      ? [[line[0]!, line[0]!] as Segment]
      : line.slice(1).map((p, i) => [line[i]!, p] as Segment),
  );
}
function distance(p: Px, [a, b]: Segment) {
  const d = sub(b, a),
    q = sub(p, a);
  const t = dot(d, d) ? Math.max(0, Math.min(1, dot(q, d) / dot(d, d))) : 0;
  return Math.hypot(q[0] - t * d[0], q[1] - t * d[1]);
}

/** Symmetric point-to-segment Hausdorff, sampled along edges at <= step units.
 * Underestimates the continuous distance by at most step/2 (1-Lipschitz bound).
 * Unlike vertex-only distance, catches deviations inside long edges.
 */
export function hausdorff(a: Polyline, b: Polyline, step = 0.25): number {
  if (!(step > 0 && Number.isFinite(step))) throw new Error('step must be finite and positive');
  if (!a.length || !b.length) return a.length === b.length ? 0 : Infinity;
  const directed = (source: Polyline, target: Polyline) => {
    const targetSegments = segments([target]);
    let max = 0;
    for (const [p, q] of segments([source])) {
      const count = Math.max(1, Math.ceil(norm(sub(q, p)) / step));
      for (let i = 0; i <= count; i++) {
        const at: Px = [p[0] + ((q[0] - p[0]) * i) / count, p[1] + ((q[1] - p[1]) * i) / count];
        let min = Infinity;
        for (const segment of targetSegments) min = Math.min(min, distance(at, segment));
        max = Math.max(max, min);
      }
    }
    return max;
  };
  return Math.max(directed(a, b), directed(b, a));
}

/** Local equirectangular meters for park-sized (<20 km) comparisons. Dateline aware. */
export function hausdorffMeters(a: readonly LatLon[], b: readonly LatLon[], stepM = 0.25): number {
  const origin = a[0] ?? b[0];
  if (!origin) return 0;
  const radians = Math.PI / 180,
    radius = 6371008.8;
  const project = ([lat, lon]: LatLon): Px => [
    (((lon - origin[1] + 540) % 360) - 180) * radians * radius * Math.cos(origin[0] * radians),
    (lat - origin[0]) * radians * radius,
  ];
  return hausdorff(a.map(project), b.map(project), stepM);
}

type Interval = [number, number];
function intersect(a: Interval, b: Interval): Interval {
  return [Math.max(a[0], b[0]), Math.min(a[1], b[1])];
}
function linearBand(value: number, slope: number, low: number, high: number): Interval {
  if (Math.abs(slope) < 1e-12) return value >= low && value <= high ? [0, 1] : [1, 0];
  const a = (low - value) / slope,
    b = (high - value) / slope;
  return intersect([0, 1], [Math.min(a, b), Math.max(a, b)]);
}
// Parameter intervals of source A+tD within a target capsule (segment + radius).
function capsule([a, b]: Segment, [p, q]: Segment, radius: number): Interval[] {
  const d = sub(b, a),
    v = sub(q, p),
    w = sub(a, p);
  const dd = dot(d, d),
    vv = dot(v, v);
  if (dd === 0) return [];
  const intervals: Interval[] = [];
  for (const end of [p, q]) {
    const delta = sub(a, end),
      projection = dot(delta, d);
    const disc = projection * projection - dd * (dot(delta, delta) - radius * radius);
    if (disc >= 0)
      intervals.push(
        intersect(
          [0, 1],
          [(-projection - Math.sqrt(disc)) / dd, (-projection + Math.sqrt(disc)) / dd],
        ),
      );
  }
  if (vv > 0) {
    const cross = (x: Px, y: Px) => x[0] * y[1] - x[1] * y[0];
    intervals.push(
      intersect(
        linearBand(dot(w, v), dot(d, v), 0, vv),
        linearBand(cross(w, v), cross(d, v), -radius * Math.sqrt(vv), radius * Math.sqrt(vv)),
      ),
    );
  }
  return intervals.filter(([lo, hi]) => hi > lo);
}
function coveredLength(source: Segment[], target: Segment[], tolerance: number) {
  let total = 0,
    matched = 0;
  for (const segment of source) {
    const length = norm(sub(segment[1], segment[0]));
    total += length;
    const intervals = target
      .flatMap((other) => capsule(segment, other, tolerance))
      .sort((a, b) => a[0] - b[0]);
    let end = 0;
    for (const [lo, hi] of intervals) {
      matched += Math.max(0, hi - Math.max(lo, end)) * length;
      end = Math.max(end, hi);
    }
  }
  return { total, matched };
}
/** Exact length fraction inside the union of tolerance capsules; independent of vertex density.
 * Empty truth has recall 1; empty found has precision 1 (and recall 0 for nonempty truth).
 */
export function lengthRecallPrecision(
  found: readonly Polyline[],
  truth: readonly Polyline[],
  tolPx: number,
) {
  if (!(tolPx >= 0 && Number.isFinite(tolPx)))
    throw new Error('tolerance must be finite and nonnegative');
  const f = segments(found),
    t = segments(truth);
  const recall = coveredLength(t, f, tolPx),
    precision = coveredLength(f, t, tolPx);
  return {
    recall: recall.total ? Math.min(1, recall.matched / recall.total) : 1,
    precision: precision.total ? Math.min(1, precision.matched / precision.total) : 1,
  };
}
