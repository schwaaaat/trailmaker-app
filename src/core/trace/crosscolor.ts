import type { AutoTraceCandidate, JobHooks, Px } from '../types';

interface Endpoint {
  candidate: number;
  end: 0 | 1;
  x: number;
  y: number;
  dx: number;
  dy: number;
}

interface Link {
  a: Endpoint;
  b: Endpoint;
  distance: number;
}

const portKey = (candidate: number, end: 0 | 1): string => `${candidate}:${end}`;

function makeEndpoint(candidate: AutoTraceCandidate, candidateIndex: number, end: 0 | 1): Endpoint {
  const endpointIndex = end === 0 ? 0 : candidate.pts.length - 1;
  const point = candidate.pts[endpointIndex] ?? [0, 0];
  let interior = point;
  if (end === 0) {
    for (let i = 1; i < candidate.pts.length; i++) {
      const next = candidate.pts[i]!;
      if (next[0] !== point[0] || next[1] !== point[1]) {
        interior = next;
        break;
      }
    }
  } else {
    for (let i = candidate.pts.length - 2; i >= 0; i--) {
      const next = candidate.pts[i]!;
      if (next[0] !== point[0] || next[1] !== point[1]) {
        interior = next;
        break;
      }
    }
  }
  const dx = interior[0] - point[0];
  const dy = interior[1] - point[1];
  const length = Math.hypot(dx, dy);
  return {
    candidate: candidateIndex,
    end,
    x: point[0],
    y: point[1],
    dx: length ? dx / length : 0,
    dy: length ? dy / length : 0,
  };
}

function continues(a: Endpoint, b: Endpoint): boolean {
  return a.dx * b.dx + a.dy * b.dy < -0.7;
}

function compareLinks(a: Link, b: Link, candidates: readonly AutoTraceCandidate[]): number {
  return (
    a.distance - b.distance ||
    candidates[a.a.candidate]!.id.localeCompare(candidates[b.a.candidate]!.id) ||
    a.a.end - b.a.end ||
    candidates[a.b.candidate]!.id.localeCompare(candidates[b.b.candidate]!.id) ||
    a.b.end - b.b.end
  );
}

function compareEndpoints(a: Endpoint, b: Endpoint, candidates: readonly AutoTraceCandidate[]): number {
  return (
    a.x - b.x || a.y - b.y || candidates[a.candidate]!.id.localeCompare(candidates[b.candidate]!.id)
  );
}

function orientedPoints(candidate: AutoTraceCandidate, startEnd: 0 | 1): readonly Px[] {
  return startEnd === 0 ? candidate.pts : [...candidate.pts].reverse();
}

/** Merge candidates that meet end-to-end across colors with near-straight continuation. */
export function mergeCrossColorCandidates(
  candidates: readonly AutoTraceCandidate[],
  gapPx: number,
  hooks?: JobHooks,
): AutoTraceCandidate[] {
  if (candidates.length < 2 || !Number.isFinite(gapPx) || gapPx < 0) return [...candidates];

  const endpoints: Endpoint[] = [];
  for (let index = 0; index < candidates.length; index++) {
    hooks?.throwIfCancelled();
    endpoints.push(
      makeEndpoint(candidates[index]!, index, 0),
      makeEndpoint(candidates[index]!, index, 1),
    );
  }

  const links: Link[] = [];
  const pairCount = (endpoints.length * (endpoints.length - 1)) / 2;
  const sameColorContinuedPorts = new Set<string>();
  let pairIndex = 0;
  let lastProgress = performance.now();
  const checkpoint = (fraction: number, stage: string): void => {
    if (!hooks) return;
    hooks.throwIfCancelled();
    const now = performance.now();
    if (now - lastProgress >= 45) {
      hooks.progress(fraction, stage);
      lastProgress = now;
    }
  };
  for (let i = 0; i < endpoints.length; i++) {
    const a = endpoints[i]!;
    for (let j = i + 1; j < endpoints.length; j++) {
      if ((pairIndex++ & 255) === 0)
        checkpoint(pairCount ? (pairIndex / pairCount) * 0.5 : 0.5, 'Find color continuations');
      const b = endpoints[j]!;
      if (a.candidate === b.candidate) continue;
      if (!continues(a, b)) continue;
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      if (distance > gapPx) continue;
      if (candidates[a.candidate]!.chipId === candidates[b.candidate]!.chipId) {
        sameColorContinuedPorts.add(portKey(a.candidate, a.end));
        sameColorContinuedPorts.add(portKey(b.candidate, b.end));
      } else {
        links.push({ a, b, distance });
      }
    }
  }
  links.sort((a, b) => compareLinks(a, b, candidates));
  hooks?.progress(0.55, 'Pair color continuations');

  const connected = new Map<string, Endpoint>();
  const parents = candidates.map((_, index) => index);
  const root = (index: number): number => {
    let current = index;
    while (parents[current] !== current) current = parents[current]!;
    while (parents[index] !== index) {
      const next = parents[index]!;
      parents[index] = current;
      index = next;
    }
    return current;
  };

  for (let linkIndex = 0; linkIndex < links.length; linkIndex++) {
    if ((linkIndex & 255) === 0)
      checkpoint(0.55 + (0.2 * linkIndex) / Math.max(links.length, 1), 'Pair color continuations');
    const link = links[linkIndex]!;
    const aKey = portKey(link.a.candidate, link.a.end);
    const bKey = portKey(link.b.candidate, link.b.end);
    if (connected.has(aKey) || connected.has(bKey)) continue;
    if (sameColorContinuedPorts.has(aKey) || sameColorContinuedPorts.has(bKey)) continue;
    const aRoot = root(link.a.candidate);
    const bRoot = root(link.b.candidate);
    // Each candidate has two ports. Prevent cycles so every merged group is one chain.
    if (aRoot === bRoot) continue;
    connected.set(aKey, link.b);
    connected.set(bKey, link.a);
    parents[bRoot] = aRoot;
  }

  const output: AutoTraceCandidate[] = [];
  const visited = new Set<number>();
  const orderedCandidates = candidates
    .map((candidate, index) => ({ candidate, index }))
    .sort((a, b) => a.candidate.id.localeCompare(b.candidate.id));
  const groups = new Map<number, number[]>();
  for (let index = 0; index < candidates.length; index++) {
    const groupRoot = root(index);
    const group = groups.get(groupRoot);
    if (group) group.push(index);
    else groups.set(groupRoot, [index]);
  }

  for (const { candidate, index } of orderedCandidates) {
    checkpoint(0.78, 'Assemble merged candidates');
    if (visited.has(index)) continue;
    const groupRoot = root(index);
    const group = groups.get(groupRoot)!;
    if (group.length === 1) {
      visited.add(index);
      output.push(candidate);
      continue;
    }

    const freePorts = group.flatMap((candidateIndex) =>
      ([0, 1] as const)
        .filter((end) => !connected.has(portKey(candidateIndex, end)))
        .map((end) => makeEndpoint(candidates[candidateIndex]!, candidateIndex, end)),
    );
    freePorts.sort((a, b) => compareEndpoints(a, b, candidates));
    const firstPort = freePorts[0]!;
    const chain: { index: number; startEnd: 0 | 1 }[] = [];
    let current = firstPort.candidate;
    let startEnd = firstPort.end;
    while (!visited.has(current)) {
      checkpoint(0.9, 'Assemble merged candidates');
      visited.add(current);
      chain.push({ index: current, startEnd });
      const exitEnd = (1 - startEnd) as 0 | 1;
      const next = connected.get(portKey(current, exitEnd));
      if (!next) break;
      current = next.candidate;
      startEnd = next.end;
    }
    const parts = chain.map(({ index: partIndex }) => candidates[partIndex]!);
    const primary = [...parts].sort(
      (a, b) => b.lengthPx - a.lengthPx || a.id.localeCompare(b.id),
    )[0]!;
    const alsoChips: string[] = [];
    const points: Px[] = [];
    for (const { index: partIndex, startEnd: partStart } of chain) {
      const part = candidates[partIndex]!;
      if (part.chipId !== primary.chipId && !alsoChips.includes(part.chipId))
        alsoChips.push(part.chipId);
      for (const point of orientedPoints(part, partStart)) {
        const previous = points.at(-1);
        if (!previous || previous[0] !== point[0] || previous[1] !== point[1]) points.push(point);
      }
    }
    const lengthPx = parts.reduce((sum, part) => sum + part.lengthPx, 0);
    const confidence = parts.every(
      (part) => typeof part.confidence === 'number' && Number.isFinite(part.confidence),
    )
      ? parts.reduce((sum, part) => sum + part.confidence! * part.lengthPx, 0) /
        Math.max(lengthPx, Number.EPSILON)
      : null;
    output.push({ ...primary, pts: points, lengthPx, confidence, alsoChips });
  }
  hooks?.progress(1, 'Cross-color merge complete');
  return output.sort((a, b) => a.id.localeCompare(b.id));
}
