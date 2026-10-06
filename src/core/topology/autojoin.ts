import type { Feature, FeatureId, Px, SnapOptions, TopologyEdit, Trail } from '../types';
import { validateRouteInvariants } from '../geo/route';

export interface TrailRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Closed segment/rectangle intersection, including crossings with no inside vertex. */
export function trailIntersectsRect(trail: Trail, rect: TrailRect): boolean {
  const left = Math.min(rect.x, rect.x + rect.width);
  const right = Math.max(rect.x, rect.x + rect.width);
  const top = Math.min(rect.y, rect.y + rect.height);
  const bottom = Math.max(rect.y, rect.y + rect.height);
  for (let i = 1; i < trail.pts.length; i++) {
    const a = trail.pts[i - 1]!;
    const b = trail.pts[i]!;
    let lo = 0;
    let hi = 1;
    let intersects = true;
    for (const [start, delta, min, max] of [
      [a[0], b[0] - a[0], left, right],
      [a[1], b[1] - a[1], top, bottom],
    ]) {
      if (delta === 0) {
        if (start! < min! || start! > max!) intersects = false;
      } else {
        const first = (min! - start!) / delta!;
        const last = (max! - start!) / delta!;
        lo = Math.max(lo, Math.min(first, last));
        hi = Math.min(hi, Math.max(first, last));
      }
    }
    if (intersects && lo <= hi) return true;
  }
  return false;
}

export interface AutoJoinProposal {
  readonly edit: TopologyEdit;
  /** Components containing two or more trails that will become one trail. */
  readonly chainCount: number;
  readonly ambiguousJunctionCount: number;
  readonly ambiguousTrailIds: readonly FeatureId[];
}

type End = { trail: Trail; side: 0 | 1; point: Px };
const d2 = (a: Px, b: Px) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;
const key = (end: End) => `${end.trail.id}:${end.side}`;
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

type TrailBound = {
  trail: Trail;
  left: number;
  top: number;
  right: number;
  bottom: number;
  length: number;
};
type BranchIndex = {
  left: number;
  top: number;
  right: number;
  bottom: number;
  leaves: readonly TrailBound[];
  children: readonly BranchIndex[];
};

function indexBranches(bounds: readonly TrailBound[]): BranchIndex {
  const left = Math.min(...bounds.map((b) => b.left));
  const top = Math.min(...bounds.map((b) => b.top));
  const right = Math.max(...bounds.map((b) => b.right));
  const bottom = Math.max(...bounds.map((b) => b.bottom));
  if (bounds.length <= 8) return { left, top, right, bottom, leaves: bounds, children: [] };
  const horizontal = right - left >= bottom - top;
  const ordered = [...bounds].sort((a, b) =>
    horizontal ? a.left + a.right - b.left - b.right : a.top + a.bottom - b.top - b.bottom,
  );
  const middle = Math.floor(ordered.length / 2);
  return {
    left,
    top,
    right,
    bottom,
    leaves: [],
    children: [indexBranches(ordered.slice(0, middle)), indexBranches(ordered.slice(middle))],
  };
}

function interiorBranchAt(index: BranchIndex, point: Px, tolerance: number): boolean {
  if (
    point[0] < index.left - tolerance ||
    point[0] > index.right + tolerance ||
    point[1] < index.top - tolerance ||
    point[1] > index.bottom + tolerance
  )
    return false;
  return (
    index.leaves.some(
      (bound) =>
        point[0] >= bound.left - tolerance &&
        point[0] <= bound.right + tolerance &&
        point[1] >= bound.top - tolerance &&
        point[1] <= bound.bottom + tolerance &&
        atInterior(bound.trail, point, tolerance ** 2, bound.length),
    ) || index.children.some((child) => interiorBranchAt(child, point, tolerance))
  );
}

function atInterior(trail: Trail, point: Px, tolerance2: number, totalLength: number): boolean {
  const tolerance = Math.sqrt(tolerance2);
  let distance = 0;
  for (let i = 1; i < trail.pts.length; i++) {
    const a = trail.pts[i - 1]!;
    const b = trail.pts[i]!;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const t = Math.max(
      0,
      Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)),
    );
    const length = Math.hypot(dx, dy);
    const along = distance + t * length;
    // Ignore only the short endpoint approach, not other visits to the same junction.
    if (
      along > tolerance &&
      totalLength - along > tolerance &&
      d2(point, [a[0] + t * dx, a[1] + t * dy]) <= tolerance2
    )
      return true;
    distance += length;
  }
  return false;
}

/** Join selected endpoint chains only; all project trails participate in branch detection. */
export function autoJoinTrails(
  features: readonly Feature[],
  selectedIds: readonly FeatureId[],
  opts: SnapOptions,
): AutoJoinProposal {
  const empty = (): AutoJoinProposal => ({
    edit: { updated: [], removed: [] },
    chainCount: 0,
    ambiguousJunctionCount: 0,
    ambiguousTrailIds: [],
  });
  const tolerance = opts.tolerancePx;
  if (!Number.isFinite(tolerance) || tolerance < 0) return empty();
  const tolerance2 = tolerance ** 2;
  const selected = new Set(selectedIds);
  const trails = features
    .filter((f): f is Trail => f.kind === 'trail' && f.pts.length >= 2)
    .sort((a, b) => compare(a.id, b.id));
  const ends: End[] = trails.flatMap((trail) => [
    { trail, side: 0 as const, point: trail.pts[0]! },
    { trail, side: 1 as const, point: trail.pts.at(-1)! },
  ]);
  const bounds = trails.map((trail) => {
    let left = Infinity,
      top = Infinity,
      right = -Infinity,
      bottom = -Infinity,
      length = 0;
    trail.pts.forEach((point, i) => {
      left = Math.min(left, point[0]);
      right = Math.max(right, point[0]);
      top = Math.min(top, point[1]);
      bottom = Math.max(bottom, point[1]);
      if (i) length += Math.sqrt(d2(point, trail.pts[i - 1]!));
    });
    return { trail, left, top, right, bottom, length };
  });
  const parents = ends.map((_, i) => i);
  const root = (i: number): number => {
    while (parents[i] !== i) {
      parents[i] = parents[parents[i]!]!;
      i = parents[i]!;
    }
    return i;
  };
  const cellSize = tolerance || 1;
  const grid = new Map<string, number[]>();
  for (let i = 0; i < ends.length; i++) {
    const point = ends[i]!.point;
    const x = Math.floor(point[0] / cellSize);
    const y = Math.floor(point[1] / cellSize);
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++) {
        for (const j of grid.get(`${x + dx},${y + dy}`) ?? []) {
          if (d2(point, ends[j]!.point) <= tolerance2) parents[root(i)] = root(j);
        }
      }
    const bucket = `${x},${y}`;
    const entries = grid.get(bucket);
    if (entries) entries.push(i);
    else grid.set(bucket, [i]);
  }
  const groups = new Map<number, End[]>();
  ends.forEach((end, i) => {
    const group = root(i);
    const entries = groups.get(group);
    if (entries) entries.push(end);
    else groups.set(group, [end]);
  });
  const targets = new Map<string, Px>();
  const links = new Map<string, End>();
  let ambiguousJunctionCount = 0;
  const ambiguousTrailIds = new Set<FeatureId>();
  const branchIndex = indexBranches(bounds);
  for (const group of groups.values()) {
    if (group.length < 2 || !group.some((end) => selected.has(end.trail.id))) continue;
    const first = group[0]!.point;
    const midpoint: Px = [
      first[0] + group.reduce((sum, end) => sum + end.point[0] - first[0], 0) / group.length,
      first[1] + group.reduce((sum, end) => sum + end.point[1] - first[1], 0) / group.length,
    ];
    // An existing deterministic branch point cannot introduce new endpoint neighbors after
    // normalization. A centroid can, and would move that junction again on the next pass.
    const center = group.length > 2 ? first : midpoint;
    const compact = group.every((a) => group.every((b) => d2(a.point, b.point) <= tolerance2));
    const interiorBranch = interiorBranchAt(branchIndex, center, tolerance);
    const allSelected = group.every((end) => selected.has(end.trail.id));
    const distinctPair = group.length === 2 && group[0]!.trail.id !== group[1]!.trail.id;
    if (group.length > 2 || interiorBranch || !compact) {
      ambiguousJunctionCount++;
      for (const end of group) if (selected.has(end.trail.id)) ambiguousTrailIds.add(end.trail.id);
    }
    // Do not move unselected geometry or a transitive cluster wider than the snap tolerance.
    if (!compact || !allSelected || interiorBranch) continue;
    if (distinctPair || group.length > 2) for (const end of group) targets.set(key(end), center);
    if (distinctPair) {
      links.set(key(group[0]!), group[1]!);
      links.set(key(group[1]!), group[0]!);
    }
  }
  const visited = new Set<string>();
  const updated: Trail[] = [];
  const removed: string[] = [];
  let chainCount = 0;
  for (const seed of trails.filter((trail) => selected.has(trail.id))) {
    if (visited.has(seed.id)) continue;
    const component = new Map<string, Trail>();
    const queue = [seed];
    while (queue.length) {
      const trail = queue.pop()!;
      if (component.has(trail.id)) continue;
      component.set(trail.id, trail);
      for (const side of [0, 1] as const) {
        const next = links.get(`${trail.id}:${side}`);
        if (next) queue.push(next.trail);
      }
    }
    const members = [...component.values()].sort((a, b) => compare(a.id, b.id));
    const survivor = members[0]!;
    const terminal = members
      .flatMap((trail) => ([0, 1] as const).map((side) => ({ trail, side })))
      .find((end) => !links.has(`${end.trail.id}:${end.side}`));
    let current = terminal?.trail ?? survivor;
    let entry = terminal?.side ?? 0;
    const pts: Px[] = [];
    while (!visited.has(current.id)) {
      visited.add(current.id);
      const local = [...current.pts];
      local[0] = targets.get(`${current.id}:0`) ?? local[0]!;
      local[local.length - 1] = targets.get(`${current.id}:1`) ?? local.at(-1)!;
      if (entry === 1) local.reverse();
      pts.push(...(pts.length ? local.slice(1) : local));
      const next = links.get(`${current.id}:${1 - entry}`);
      if (!next) break;
      current = next.trail;
      entry = next.side;
    }
    if (members.length > 1) {
      chainCount++;
      removed.push(...members.slice(1).map((trail) => trail.id));
    }
    if (members.length > 1 || pts.some((point, i) => d2(point, survivor.pts[i]!) !== 0)) {
      const { route: _, ...survivorBase } = survivor;
      const route =
        members.length === 1 && survivor.route && validateRouteInvariants(pts, survivor.route).valid
          ? survivor.route
          : undefined;
      updated.push({ ...survivorBase, pts, ...(route ? { route } : {}) });
    }
  }
  return {
    edit: { updated, removed: removed.sort(compare) },
    chainCount,
    ambiguousJunctionCount,
    ambiguousTrailIds: [...ambiguousTrailIds].sort(compare),
  };
}
