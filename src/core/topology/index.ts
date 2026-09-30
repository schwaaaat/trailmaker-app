// Lane A, M2. Trail topology: snapping, split, join.
import type { Feature, FeatureId, Px, SnapOptions, TopologyEdit, Trail } from '../types';

type End = { trail: Trail; side: 0 | 1; point: Px };
type Insertion = { index: number; t: number; point: Px };
type DetectorEnd = { trailIndex: number; trail: Trail; point: Px };

/** A chosen location on a trail segment. `segmentIndex` identifies pts[i]..pts[i + 1]. */
export interface TrailPoint {
  readonly trailId: FeatureId;
  readonly segmentIndex: number;
  readonly point: Px;
}

/** Project a map-pixel location onto the nearest segment of a trail. */
export function projectTrailPoint(trail: Trail, point: Px): TrailPoint {
  let best: TrailPoint | null = null;
  let bestDistance = Infinity;
  for (let i = 0; i < trail.pts.length - 1; i++) {
    const start = trail.pts[i]!;
    const end = trail.pts[i + 1]!;
    const dx = end[0] - start[0];
    const dy = end[1] - start[1];
    const length2 = dx * dx + dy * dy;
    const fraction = length2 === 0 ? 0 : Math.max(0, Math.min(1, ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / length2));
    const projected: Px = [start[0] + fraction * dx, start[1] + fraction * dy];
    const d2 = distanceSquared(point, projected);
    if (d2 < bestDistance) {
      bestDistance = d2;
      best = { trailId: trail.id, segmentIndex: i, point: projected };
    }
  }
  if (!best) throw new RangeError('Trail must contain a segment');
  return best;
}

const distanceSquared = (a: Px, b: Px): number => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;
const samePoint = (a: Px, b: Px): boolean => a[0] === b[0] && a[1] === b[1];
const reverse = <T>(items: readonly T[]): T[] => [...items].reverse();

/** Snap trail ends onto nearby trails and insert shared junction vertices. */
export function snapTrailEnds(features: readonly Feature[], opts: SnapOptions): TopologyEdit {
  const tolerance = opts.tolerancePx;
  if (!(tolerance > 0) || !Number.isFinite(tolerance)) return { updated: [], removed: [] };
  const tolerance2 = tolerance * tolerance;
  const trails = features.filter((feature): feature is Trail => feature.kind === 'trail' && feature.pts.length >= 2)
    .sort((a, b) => a.id.localeCompare(b.id));
  const cellSize = tolerance * 4;
  const ends: End[] = [];
  let stride = 0;
  for (let trailIndex = 0; trailIndex < trails.length; trailIndex++) {
    const trail = trails[trailIndex]!;
    stride = Math.max(stride, trail.pts.length);
    ends.push(
      { trail, side: 0, point: trail.pts[0]! },
      { trail, side: 1, point: trail.pts[trail.pts.length - 1]! },
    );
  }
  const parents = Int32Array.from({ length: ends.length }, (_, index) => index);
  const paired = new Uint8Array(ends.length);
  const rootOf = (index: number): number => {
    let root = index;
    while (parents[root] !== root) root = parents[root]!;
    while (parents[index] !== index) {
      const next = parents[index]!;
      parents[index] = root;
      index = next;
    }
    return root;
  };
  const endpointGrid = new Map<number, Map<number, number[]>>();
  for (let i = 0; i < ends.length; i++) {
    const point = ends[i]!.point;
    const cx = Math.floor(point[0] / cellSize);
    const cy = Math.floor(point[1] / cellSize);
    for (let x = cx - 1; x <= cx + 1; x++) for (let y = cy - 1; y <= cy + 1; y++) {
      for (const j of endpointGrid.get(x)?.get(y) ?? []) {
        const a = ends[i]!;
        const b = ends[j]!;
        if (a.trail.id === b.trail.id) continue;
        const distance2 = distanceSquared(a.point, b.point);
        if (distance2 <= tolerance2) {
          const leftRoot = rootOf(j);
          const rightRoot = rootOf(i);
          if (leftRoot !== rightRoot) parents[rightRoot] = leftRoot;
        }
      }
    }
    let column = endpointGrid.get(cx);
    if (!column) {
      column = new Map<number, number[]>();
      endpointGrid.set(cx, column);
    }
    const bucket = column.get(cy);
    if (bucket) bucket.push(i);
    else column.set(cy, [i]);
  }
  const groupSizes = new Int32Array(ends.length);
  const groupDx = new Float64Array(ends.length);
  const groupDy = new Float64Array(ends.length);
  const groupOrigins: (Px | undefined)[] = new Array(ends.length);
  for (let index = 0; index < ends.length; index++) {
    const root = rootOf(index);
    const point = ends[index]!.point;
    const origin = groupOrigins[root];
    if (!origin) groupOrigins[root] = point;
    else {
      groupDx[root] = groupDx[root]! + point[0] - origin[0];
      groupDy[root] = groupDy[root]! + point[1] - origin[1];
    }
    groupSizes[root] = groupSizes[root]! + 1;
  }
  const endpointTargets = new Map<string, Px>();
  const endKey = (end: End): string => `${end.trail.id}:${end.side}`;
  const sharedTargets: (Px | undefined)[] = new Array(ends.length);
  for (let index = 0; index < ends.length; index++) {
    const root = rootOf(index);
    const size = groupSizes[root]!;
    if (size < 2) continue;
    paired[index] = 1;
    let shared = sharedTargets[root];
    if (!shared) {
      const origin = groupOrigins[root]!;
      shared = [origin[0] + groupDx[root]! / size, origin[1] + groupDy[root]! / size];
      sharedTargets[root] = shared;
    }
    endpointTargets.set(endKey(ends[index]!), shared);
  }

  // Already-coincident endpoint groups cannot produce insertions or endpoint moves. Avoid
  // building the segment index and replacement point arrays for a clean, fully paired map.
  let hasUnpairedEnd = false;
  let hasMovedEndpoint = false;
  let hasPairedEndpoint = false;
  for (let index = 0; index < ends.length; index++) {
    if (!paired[index]) {
      hasUnpairedEnd = true;
      continue;
    }
    hasPairedEndpoint = true;
    const shared = sharedTargets[rootOf(index)]!;
    if (!samePoint(shared, ends[index]!.point)) hasMovedEndpoint = true;
  }
  if (!hasUnpairedEnd && !hasMovedEndpoint) return { updated: [], removed: [] };
  if (hasPairedEndpoint && !hasMovedEndpoint && !hasUnsnappedEnds(features, opts)) {
    return { updated: [], removed: [] };
  }

  // Index only the cells queried by unpaired ends. The previous full segment
  // object grid indexed every edge even when most of the map was nowhere near
  // an endpoint. Packed references keep the spatial index compact at 2,000×50.
  const requiredCells = new Map<number, Map<number, number>>();
  let bucketCount = 0;
  for (let index = 0; index < ends.length; index++) {
    if (paired[index]) continue;
    const point = ends[index]!.point;
    const cx = Math.floor(point[0] / cellSize);
    const cy = Math.floor(point[1] / cellSize);
    for (let x = cx - 1; x <= cx + 1; x++) {
      let rows = requiredCells.get(x);
      if (!rows) {
        rows = new Map<number, number>();
        requiredCells.set(x, rows);
      }
      for (let y = cy - 1; y <= cy + 1; y++) {
        if (!rows.has(y)) rows.set(y, bucketCount++);
      }
    }
  }

  const segmentHeads = new Int32Array(bucketCount);
  segmentHeads.fill(-1);
  const segmentRefs: number[] = [];
  const segmentNext: number[] = [];
  if (bucketCount > 0) {
    for (let trailIndex = 0; trailIndex < trails.length; trailIndex++) {
      const trail = trails[trailIndex]!;
      for (let segmentIndex = 0; segmentIndex < trail.pts.length - 1; segmentIndex++) {
        const a = trail.pts[segmentIndex]!;
        const b = trail.pts[segmentIndex + 1]!;
        const minX = Math.floor(Math.min(a[0], b[0]) / cellSize);
        const maxX = Math.floor(Math.max(a[0], b[0]) / cellSize);
        const minY = Math.floor(Math.min(a[1], b[1]) / cellSize);
        const maxY = Math.floor(Math.max(a[1], b[1]) / cellSize);
        const packedRef = trailIndex * stride + segmentIndex;
        for (let x = minX; x <= maxX; x++) {
          const neededRows = requiredCells.get(x);
          if (!neededRows) continue;
          for (let y = minY; y <= maxY; y++) {
            const bucketId = neededRows.get(y);
            if (bucketId === undefined) continue;
            const entryIndex = segmentRefs.length;
            segmentRefs.push(packedRef);
            segmentNext.push(segmentHeads[bucketId]!);
            segmentHeads[bucketId] = entryIndex;
          }
        }
      }
    }
  }

  const insertions = new Map<string, Insertion[]>();
  const seenSegments = new Uint32Array(trails.length * stride);
  for (let endIndex = 0; endIndex < ends.length; endIndex++) {
    if (paired[endIndex]) continue;
    const end = ends[endIndex]!;
    const cx = Math.floor(end.point[0] / cellSize);
    const cy = Math.floor(end.point[1] / cellSize);
    let bestTrailIndex = -1;
    let bestSegmentIndex = -1;
    let bestPoint: Px | undefined;
    let bestT = 0;
    let bestDistance2 = Infinity;
    for (let gx = cx - 1; gx <= cx + 1; gx++) for (let gy = cy - 1; gy <= cy + 1; gy++) {
      const bucketId = requiredCells.get(gx)?.get(gy);
      if (bucketId === undefined) continue;
      for (let entryIndex = segmentHeads[bucketId]!; entryIndex !== -1; entryIndex = segmentNext[entryIndex]!) {
      const packedRef = segmentRefs[entryIndex]!;
      if (seenSegments[packedRef] === endIndex + 1) continue;
      seenSegments[packedRef] = endIndex + 1;
      const trailIndex = Math.floor(packedRef / stride);
      const segmentIndex = packedRef - trailIndex * stride;
      const segmentTrail = trails[trailIndex]!;
      if (segmentTrail.id === end.trail.id) continue;
      const a = segmentTrail.pts[segmentIndex]!;
      const b = segmentTrail.pts[segmentIndex + 1]!;
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const length2 = dx * dx + dy * dy;
      if (length2 === 0) continue;
      const t = Math.max(0, Math.min(1, ((end.point[0] - a[0]) * dx + (end.point[1] - a[1]) * dy) / length2));
      const point: Px = [a[0] + t * dx, a[1] + t * dy];
      const distance2 = distanceSquared(end.point, point);
      const isBetterTie = bestTrailIndex >= 0 && distance2 === bestDistance2 &&
        (segmentTrail.id.localeCompare(trails[bestTrailIndex]!.id) < 0 ||
          (segmentTrail.id === trails[bestTrailIndex]!.id && segmentIndex < bestSegmentIndex));
      if (distance2 <= tolerance2 && (distance2 < bestDistance2 || isBetterTie)) {
        bestTrailIndex = trailIndex;
        bestSegmentIndex = segmentIndex;
        bestPoint = point;
        bestT = t;
        bestDistance2 = distance2;
      }
      }
    }
    if (bestTrailIndex < 0 || !bestPoint) continue;
    endpointTargets.set(endKey(end), bestPoint);
    if (bestT > 1e-9 && bestT < 1 - 1e-9) {
      const trailId = trails[bestTrailIndex]!.id;
      const list = insertions.get(trailId) ?? [];
      list.push({ index: bestSegmentIndex, t: bestT, point: bestPoint });
      insertions.set(trailId, list);
    }
  }

  const updated: Trail[] = [];
  for (const trail of trails) {
    const startTarget = endpointTargets.get(`${trail.id}:0`);
    const endTarget = endpointTargets.get(`${trail.id}:1`);
    const trailInsertions = insertions.get(trail.id);
    if (!trailInsertions?.length) {
      const startChanged = startTarget !== undefined && !samePoint(startTarget, trail.pts[0]!);
      const endChanged = endTarget !== undefined && !samePoint(endTarget, trail.pts[trail.pts.length - 1]!);
      if (!startChanged && !endChanged) continue;
      const points = trail.pts.slice();
      if (startChanged) points[0] = startTarget!;
      if (endChanged) points[points.length - 1] = endTarget!;
      updated.push({ ...trail, pts: points });
      continue;
    }
    const points: Px[] = [];
    const start = startTarget ?? trail.pts[0]!;
    points.push(start);
    const bySegment = new Map<number, Insertion[]>();
    for (const insertion of trailInsertions) {
      const group = bySegment.get(insertion.index);
      if (group) group.push(insertion);
      else bySegment.set(insertion.index, [insertion]);
    }
    for (let index = 0; index < trail.pts.length - 1; index++) {
      for (const insertion of (bySegment.get(index) ?? []).sort((a, b) => a.t - b.t)) {
        if (!samePoint(points[points.length - 1]!, insertion.point)) points.push(insertion.point);
      }
      points.push(trail.pts[index + 1]!);
    }
    const end = endTarget;
    if (end) points[points.length - 1] = end;
    if (points.length === trail.pts.length && points.every((point, index) => samePoint(point, trail.pts[index]!))) continue;
    updated.push({ ...trail, pts: points });
  }
  return { updated, removed: [] };
}

/**
 * Check whether snapping would change any feature, without building replacement trails.
 * The grid stores packed numeric segment references only in cells needed by an unpaired end.
 */
export function hasUnsnappedEnds(features: readonly Feature[], opts: SnapOptions): boolean {
  const tolerance = opts.tolerancePx;
  if (!(tolerance > 0) || !Number.isFinite(tolerance)) return false;
  const tolerance2 = tolerance * tolerance;
  const trails = features
    .filter((feature): feature is Trail => feature.kind === 'trail' && feature.pts.length >= 2)
    .sort((a, b) => a.id.localeCompare(b.id));
  if (trails.length === 0) return false;

  const cellSize = tolerance * 4;
  const ends: DetectorEnd[] = [];
  let stride = 0;
  for (let trailIndex = 0; trailIndex < trails.length; trailIndex++) {
    const trail = trails[trailIndex]!;
    stride = Math.max(stride, trail.pts.length);
    ends.push(
      { trailIndex, trail, point: trail.pts[0]! },
      { trailIndex, trail, point: trail.pts[trail.pts.length - 1]! },
    );
  }

  const endpointGrid = new Map<number, Map<number, number[]>>();
  const paired = new Uint8Array(ends.length);
  let pairedCount = 0;
  for (let index = 0; index < ends.length; index++) {
    const point = ends[index]!.point;
    const cx = Math.floor(point[0] / cellSize);
    const cy = Math.floor(point[1] / cellSize);
    for (let x = cx - 1; x <= cx + 1; x++) {
      for (let y = cy - 1; y <= cy + 1; y++) {
        const nearbyEnds = endpointGrid.get(x)?.get(y);
        if (!nearbyEnds) continue;
        for (const previousIndex of nearbyEnds) {
          const current = ends[index]!;
          const previous = ends[previousIndex]!;
          if (current.trail.id === previous.trail.id) continue;
          const dx = current.point[0] - previous.point[0];
          const dy = current.point[1] - previous.point[1];
          const distance2 = dx * dx + dy * dy;
          if (distance2 > tolerance2) continue;

          if (!paired[index]) {
            paired[index] = 1;
            pairedCount++;
          }
          if (!paired[previousIndex]) {
            paired[previousIndex] = 1;
            pairedCount++;
          }
          // A connected endpoint group with distinct coordinates must move at least one end
          // to its shared mean, so the snap operation will update a trail.
          if (distance2 > 0) return true;
        }
      }
    }

    let column = endpointGrid.get(cx);
    if (!column) {
      column = new Map<number, number[]>();
      endpointGrid.set(cx, column);
    }
    const bucket = column.get(cy);
    if (bucket) bucket.push(index);
    else column.set(cy, [index]);
  }

  if (pairedCount === ends.length) return false;

  // Only segment cells queried by unpaired ends are populated. This keeps distant trail
  // geometry out of the index and avoids allocating one Segment object for every edge.
  const requiredCells = new Map<number, Map<number, number>>();
  let bucketCount = 0;
  for (let index = 0; index < ends.length; index++) {
    if (paired[index]) continue;
    const point = ends[index]!.point;
    const cx = Math.floor(point[0] / cellSize);
    const cy = Math.floor(point[1] / cellSize);
    for (let x = cx - 1; x <= cx + 1; x++) {
      let rows = requiredCells.get(x);
      if (!rows) {
        rows = new Map<number, number>();
        requiredCells.set(x, rows);
      }
      for (let y = cy - 1; y <= cy + 1; y++) {
        if (!rows.has(y)) rows.set(y, bucketCount++);
      }
    }
  }

  const segmentHeads = new Int32Array(bucketCount);
  segmentHeads.fill(-1);
  const segmentRefs: number[] = [];
  const segmentNext: number[] = [];
  for (let trailIndex = 0; trailIndex < trails.length; trailIndex++) {
    const trail = trails[trailIndex]!;
    for (let segmentIndex = 0; segmentIndex < trail.pts.length - 1; segmentIndex++) {
      const a = trail.pts[segmentIndex]!;
      const b = trail.pts[segmentIndex + 1]!;
      const minX = Math.floor(Math.min(a[0], b[0]) / cellSize);
      const maxX = Math.floor(Math.max(a[0], b[0]) / cellSize);
      const minY = Math.floor(Math.min(a[1], b[1]) / cellSize);
      const maxY = Math.floor(Math.max(a[1], b[1]) / cellSize);
      const packedRef = trailIndex * stride + segmentIndex;
      for (let x = minX; x <= maxX; x++) {
        const neededRows = requiredCells.get(x);
        if (!neededRows) continue;
        for (let y = minY; y <= maxY; y++) {
          const bucketId = neededRows.get(y);
          if (bucketId === undefined) continue;
          const entryIndex = segmentRefs.length;
          segmentRefs.push(packedRef);
          segmentNext.push(segmentHeads[bucketId]!);
          segmentHeads[bucketId] = entryIndex;
        }
      }
    }
  }

  for (let endIndex = 0; endIndex < ends.length; endIndex++) {
    if (paired[endIndex]) continue;
    const end = ends[endIndex]!;
    const cx = Math.floor(end.point[0] / cellSize);
    const cy = Math.floor(end.point[1] / cellSize);
    let bestTrailIndex = -1;
    let bestSegmentIndex = -1;
    let bestDistance2 = Infinity;
    let bestT = 0;

    for (let x = cx - 1; x <= cx + 1; x++) {
      for (let y = cy - 1; y <= cy + 1; y++) {
        const bucketId = requiredCells.get(x)?.get(y);
        if (bucketId === undefined) continue;
        for (
          let entryIndex = segmentHeads[bucketId]!;
          entryIndex !== -1;
          entryIndex = segmentNext[entryIndex]!
        ) {
          const packedRef = segmentRefs[entryIndex]!;
          const trailIndex = Math.floor(packedRef / stride);
          const segmentIndex = packedRef - trailIndex * stride;
          const candidateTrail = trails[trailIndex]!;
          if (candidateTrail.id === end.trail.id) continue;
          const a = candidateTrail.pts[segmentIndex]!;
          const b = candidateTrail.pts[segmentIndex + 1]!;
          const dx = b[0] - a[0];
          const dy = b[1] - a[1];
          const length2 = dx * dx + dy * dy;
          if (length2 === 0) continue;
          const t = Math.max(
            0,
            Math.min(1, ((end.point[0] - a[0]) * dx + (end.point[1] - a[1]) * dy) / length2),
          );
          const closestX = a[0] + t * dx;
          const closestY = a[1] + t * dy;
          const distanceX = end.point[0] - closestX;
          const distanceY = end.point[1] - closestY;
          const distance2 = distanceX * distanceX + distanceY * distanceY;
          const isBetterTie =
            bestTrailIndex >= 0 &&
            distance2 === bestDistance2 &&
            (candidateTrail.id.localeCompare(trails[bestTrailIndex]!.id) < 0 ||
              (candidateTrail.id === trails[bestTrailIndex]!.id &&
                segmentIndex < bestSegmentIndex));
          if (
            distance2 <= tolerance2 &&
            (distance2 < bestDistance2 || isBetterTie)
          ) {
            bestTrailIndex = trailIndex;
            bestSegmentIndex = segmentIndex;
            bestDistance2 = distance2;
            bestT = t;
          }
        }
      }
    }

    if (bestTrailIndex < 0) continue;
    if (bestDistance2 > 0 || (bestT > 1e-9 && bestT < 1 - 1e-9)) return true;
  }
  return false;
}

/** Split a trail at a vertex into two trails; the second gets newId. */
export function splitTrail(trail: Trail, vertexIndex: number, newId: FeatureId): TopologyEdit {
  if (!Number.isInteger(vertexIndex) || vertexIndex <= 0 || vertexIndex >= trail.pts.length - 1) {
    throw new RangeError(`vertexIndex must be between 1 and ${trail.pts.length - 2}`);
  }
  const shared = trail.pts[vertexIndex]!;
  return {
    updated: [
      { ...trail, pts: trail.pts.slice(0, vertexIndex + 1) },
      { ...trail, id: newId, name: `${trail.name} (2)`, pts: [shared, ...trail.pts.slice(vertexIndex + 1)] },
    ],
    removed: [],
  };
}

/** Join two trails that share (or nearly share) an end into one, keeping a's id and attributes. */
export function joinTrails(a: Trail, b: Trail): TopologyEdit {
  if (a.id === b.id) throw new RangeError('Cannot join a trail with itself');
  const aForward = [...a.pts];
  const aReverse = reverse(a.pts);
  const bForward = [...b.pts];
  const bReverse = reverse(b.pts);
  const options = [
    { distance2: distanceSquared(aForward[aForward.length - 1]!, bForward[0]!), left: aForward, right: bForward },
    { distance2: distanceSquared(aForward[aForward.length - 1]!, bReverse[0]!), left: aForward, right: bReverse },
    { distance2: distanceSquared(aReverse[aReverse.length - 1]!, bForward[0]!), left: aReverse, right: bForward },
    { distance2: distanceSquared(aReverse[aReverse.length - 1]!, bReverse[0]!), left: aReverse, right: bReverse },
  ];
  options.sort((x, y) => x.distance2 - y.distance2);
  const best = options[0]!;
  const tail = best.distance2 <= 0.25 ? best.right.slice(1) : best.right;
  return { updated: [{ ...a, pts: [...best.left, ...tail] }], removed: [b.id] };
}

/** Add a separate connector trail between two exact locations, inserting interior vertices. */
export function connectTrailPoints(
  features: readonly Feature[],
  a: TrailPoint,
  b: TrailPoint,
  connector: Trail,
): TopologyEdit {
  if (connector.id === a.trailId || connector.id === b.trailId) {
    throw new RangeError('Connector must have a new id');
  }
  const byId = new Map(features.filter((f): f is Trail => f.kind === 'trail').map((f) => [f.id, f]));
  const ends = [a, b] as const;
  for (const end of ends) {
    const trail = byId.get(end.trailId);
    if (!trail || !Number.isInteger(end.segmentIndex) || end.segmentIndex < 0 || end.segmentIndex >= trail.pts.length - 1) {
      throw new RangeError('Connect point must lie on a trail segment');
    }
    if (!end.point.every(Number.isFinite)) throw new RangeError('Connect point must be finite');
  }
  const updated: Trail[] = [];
  for (const trailId of new Set(ends.map((end) => end.trailId))) {
    const trail = byId.get(trailId)!;
    const points = ends.filter((end) => end.trailId === trailId).sort((left, right) => {
      const at = (end: TrailPoint) => {
        const start = trail.pts[end.segmentIndex]!;
        const next = trail.pts[end.segmentIndex + 1]!;
        const dx = next[0] - start[0];
        const dy = next[1] - start[1];
        return end.segmentIndex + ((end.point[0] - start[0]) * dx + (end.point[1] - start[1]) * dy) / (dx * dx + dy * dy || 1);
      };
      return at(left) - at(right);
    });
    const pts: Px[] = [];
    for (let i = 0; i < trail.pts.length; i++) {
      const vertex = trail.pts[i]!;
      pts.push(vertex);
      for (const end of points) {
        if (end.segmentIndex !== i || samePoint(end.point, vertex)) continue;
        if (i + 1 < trail.pts.length && samePoint(end.point, trail.pts[i + 1]!)) continue;
        if (!pts.some((point) => samePoint(point, end.point))) pts.push(end.point);
      }
    }
    if (pts.length !== trail.pts.length) updated.push({ ...trail, pts });
  }
  return { updated: [...updated, { ...connector, pts: [a.point, ...connector.pts.slice(1, -1), b.point] }], removed: [] };
}
