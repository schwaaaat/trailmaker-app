import type { JobHooks, Px, RasterImage, Rgb } from '../types';
import { simplify } from './simplify';

/** Options for tracing one color. */
export interface AutoTraceColorOptions {
  readonly tolerance: number;
  readonly gapPx: number;
  readonly minLengthPx: number;
}

/** Derive safer worker parameters for untouched project defaults from the picked ink. */
export function deriveDefaultAutoTraceOptions(
  img: Pick<RasterImage, 'width' | 'height'>,
  rgb: Rgb,
  options: AutoTraceColorOptions,
): AutoTraceColorOptions {
  const mapSize = Math.max(img.width, img.height);
  if (mapSize < 1000) return options;
  const defaultGap = Math.max(6, Math.min(120, Math.round(mapSize / 80)));
  const defaultMinLength = mapSize * 0.04;
  if (
    options.tolerance !== 60 ||
    options.gapPx !== defaultGap ||
    Math.abs(options.minLengthPx - defaultMinLength) > 1e-6
  ) {
    return options;
  }

  const chroma = Math.max(...rgb) - Math.min(...rgb);
  if (chroma > 110) return options;
  if (chroma <= 32 && Math.min(...rgb) < 220) return options;
  return {
    tolerance: chroma > 32 ? 40 : 60,
    gapPx: chroma > 32 ? 8 : 0,
    minLengthPx: Math.min(defaultMinLength, 50),
  };
}
/** A traced line before it becomes a candidate. */
export interface TracedLine {
  readonly pts: Px[];
  readonly lengthPx: number;
}
interface EngineOptions {
  tol: number;
  gap: number;
  minLen: number;
}
interface GraphNode {
  x: number;
  y: number;
  px: number[];
}
interface GraphEdge {
  id: number;
  a: number;
  b: number;
  pts: Float64Array;
  alive: boolean;
  len: number;
}
interface Endpoint {
  e: GraphEdge;
  end: 'a' | 'b';
}
interface EndRef {
  n: number;
  e: GraphEdge;
  x: number;
  y: number;
  ox: number;
  oy: number;
  k: number;
}
type ProtoLine = { pts: Px[]; len: number };
interface ScratchWorkspace {
  mask: Uint8Array;
  baseMask: Uint8Array;
  auxMask: Uint8Array;
  boxTmp: Uint8Array;
  labels: Int32Array;
  skeletonCounts: Float64Array;
  degrees: Uint8Array;
  nodes: Int32Array;
  visited: Uint8Array;
  prefix: Int32Array;
}

// Workspaces are checked out for the duration of a call. This permits hooks to
// re-enter autoTraceColor without allowing the nested job to overwrite its parent.
const scratchPool: ScratchWorkspace[] = [];
function acquireScratch(size: number, prefixSize: number): ScratchWorkspace {
  const scratch = scratchPool.pop() ?? {
    mask: new Uint8Array(0),
    baseMask: new Uint8Array(0),
    auxMask: new Uint8Array(0),
    boxTmp: new Uint8Array(0),
    labels: new Int32Array(0),
    skeletonCounts: new Float64Array(0),
    degrees: new Uint8Array(0),
    nodes: new Int32Array(0),
    visited: new Uint8Array(0),
    prefix: new Int32Array(0),
  };
  if (scratch.mask.length !== size) scratch.mask = new Uint8Array(size);
  if (scratch.baseMask.length !== size) scratch.baseMask = new Uint8Array(size);
  if (scratch.auxMask.length !== size) scratch.auxMask = new Uint8Array(size);
  if (scratch.boxTmp.length !== size) scratch.boxTmp = new Uint8Array(size);
  if (scratch.labels.length !== size) scratch.labels = new Int32Array(size);
  if (scratch.degrees.length !== size) scratch.degrees = new Uint8Array(size);
  if (scratch.nodes.length !== size) scratch.nodes = new Int32Array(size);
  if (scratch.visited.length !== size) scratch.visited = new Uint8Array(size);
  if (scratch.skeletonCounts.length < size) scratch.skeletonCounts = new Float64Array(size);
  if (scratch.prefix.length < prefixSize) scratch.prefix = new Int32Array(prefixSize);
  return scratch;
}
function releaseScratch(scratch: ScratchWorkspace): void {
  if (scratchPool.length < 2) scratchPool.push(scratch);
}

// Binary box filters on a padded grid. any=true: dilation, any=false: erosion.
function box(
  m: Uint8Array,
  out: Uint8Array,
  tmp: Uint8Array,
  prefix: Int32Array,
  PW: number,
  PH: number,
  r: number,
  any: boolean,
  cancelCheck: (force?: boolean) => void,
): void {
  cancelCheck(true);
  const pass = (
    src: Uint8Array,
    dst: Uint8Array,
    len: number,
    count: number,
    stride: number,
    lineStride: number,
  ) => {
    const pre = prefix;
    for (let L = 0; L < count; L++) {
      cancelCheck();
      const base = L * lineStride;
      pre[0] = 0;
      for (let i = 0; i < len; i++) {
        if ((i & 4095) === 0) cancelCheck();
        pre[i + 1] = pre[i]! + src[base + i * stride]!;
      }
      for (let i = 0; i < len; i++) {
        if ((i & 4095) === 0) cancelCheck();
        const lo = Math.max(0, i - r),
          hi = Math.min(len - 1, i + r),
          s = pre[hi + 1]! - pre[lo]!;
        dst[base + i * stride] = any ? (s > 0 ? 1 : 0) : s === hi - lo + 1 ? 1 : 0;
      }
    }
  };
  pass(m, tmp, PW, PH, 1, PW);
  pass(tmp, out, PH, PW, PW, 1);
}

function thin(
  m: Uint8Array,
  PW: number,
  list: number[],
  cancelCheck: (force?: boolean) => void,
): number[] {
  cancelCheck(true);
  const del = [];
  let changed = true;
  while (changed) {
    cancelCheck();
    changed = false;
    for (let step = 0; step < 2; step++) {
      del.length = 0;
      for (const i of list) {
        if ((i & 4095) === 0) cancelCheck();
        if (!m[i]) continue;
        const p2 = m[i - PW]!,
          p3 = m[i - PW + 1]!,
          p4 = m[i + 1]!,
          p5 = m[i + PW + 1]!,
          p6 = m[i + PW]!,
          p7 = m[i + PW - 1]!,
          p8 = m[i - 1]!,
          p9 = m[i - PW - 1]!;
        const B = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
        if (B < 2 || B > 6) continue;
        const A =
          Number(!p2 && !!p3) +
          Number(!p3 && !!p4) +
          Number(!p4 && !!p5) +
          Number(!p5 && !!p6) +
          Number(!p6 && !!p7) +
          Number(!p7 && !!p8) +
          Number(!p8 && !!p9) +
          Number(!p9 && !!p2);
        if (A !== 1) continue;
        if (
          step === 0 ? (p2 && p4 && p6) || (p4 && p6 && p8) : (p2 && p4 && p8) || (p2 && p6 && p8)
        )
          continue;
        del.push(i);
      }
      for (let d = 0; d < del.length; d++) {
        if ((d & 4095) === 0) cancelCheck();
        m[del[d]!] = 0;
      }
      if (del.length) changed = true;
    }
    const kept: number[] = [];
    for (let i = 0; i < list.length; i++) {
      if ((i & 4095) === 0) cancelCheck();
      if (m[list[i]!]!) kept.push(list[i]!);
    }
    list = kept;
  }
  // remove staircase corners so every line pixel has exactly two neighbours
  for (const i of list) {
    cancelCheck();
    if (!m[i]) continue;
    const n = m[i - PW]!,
      e = m[i + 1]!,
      s = m[i + PW]!,
      w = m[i - 1]!;
    if (
      (n && e && !s && !w && !m[i + PW - 1]) ||
      (e && s && !n && !w && !m[i - PW - 1]) ||
      (s && w && !n && !e && !m[i - PW + 1]) ||
      (w && n && !e && !s && !m[i + PW + 1])
    )
      m[i] = 0;
  }
  const kept: number[] = [];
  for (const i of list) {
    cancelCheck();
    if (m[i]!) kept.push(i);
  }
  return kept;
}

function traceColor(
  img: { data: Uint8ClampedArray; W: number; H: number },
  rgb: Rgb,
  opt: EngineOptions,
  scratch: ScratchWorkspace,
  hooks?: JobHooks,
): ProtoLine[] {
  let lastCheck = performance.now();
  const cancelCheck = (force = false): void => {
    if (!hooks) return;
    const now = performance.now();
    if (force || now - lastCheck >= 20) {
      hooks.throwIfCancelled();
      lastCheck = now;
    }
  };
  const checkpoint = (fraction: number, stage: string, force = false): void => {
    const now = performance.now();
    if (force || now - lastCheck >= 20) {
      hooks?.throwIfCancelled();
      hooks?.progress(fraction, stage);
      lastCheck = now;
    }
  };
  checkpoint(0, 'Build color mask', true);
  const { data: P, W, H } = img;
  const f = Math.max(1, Math.ceil(Math.max(W, H) / 2400));
  const w = Math.ceil(W / f),
    h = Math.ceil(H / f),
    PW = w + 2,
    PH = h + 2;
  const tol2 = opt.tol * opt.tol,
    fuzzyTolerance2 = (opt.tol + 40) * (opt.tol + 40),
    G = Math.max(0, opt.gap || 0),
    r = G > 0 ? Math.min(3, Math.max(1, Math.round(G / f / 4))) : 0;
  const m = scratch.mask;
  m.fill(0);
  for (let y = 0; y < H; y++) {
    const row = (((y / f) | 0) + 1) * PW + 1;
    for (let x = 0, i = y * W * 4; x < W; x++, i += 4) {
      const dr = P[i]! - rgb[0]!,
        dg = P[i + 1]! - rgb[1]!,
        db = P[i + 2]! - rgb[2]!;
      if (dr * dr + dg * dg + db * db <= tol2) m[row + ((x / f) | 0)] = 1;
    }
    checkpoint(0.1 + (0.1 * (y + 1)) / H, 'Build color mask');
  }
  const baseMask = scratch.baseMask;
  baseMask.set(m);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const at = (y + 1) * PW + x + 1;
      if (baseMask[at]!) continue;
      const i = (y * f * W + x * f) * 4;
      const dr = P[i]! - rgb[0]!,
        dg = P[i + 1]! - rgb[1]!,
        db = P[i + 2]! - rgb[2]!;
      if (dr * dr + dg * dg + db * db > fuzzyTolerance2) continue;
      let adjacent = false;
      for (let oy = -1; oy <= 1 && !adjacent; oy++)
        for (let ox = -1; ox <= 1; ox++)
          if ((ox !== 0 || oy !== 0) && baseMask[at + oy * PW + ox]!) {
            adjacent = true;
            break;
          }
      if (adjacent) m[at] = 1;
    }
    checkpoint(0.2 + (0.1 * (y + 1)) / h, 'Capture antialiased edges');
  }
  checkpoint(0.3, 'Close small gaps', true);
  if (r > 0) {
    box(m, scratch.auxMask, scratch.boxTmp, scratch.prefix, PW, PH, r, true, cancelCheck);
    box(
      scratch.auxMask,
      m,
      scratch.boxTmp,
      scratch.prefix,
      PW,
      PH,
      r,
      false,
      cancelCheck,
    );
  }
  for (let x = 0; x < PW; x++) {
    if ((x & 4095) === 0) cancelCheck();
    m[x] = 0;
    m[(PH - 1) * PW + x] = 0;
  }
  for (let y = 0; y < PH; y++) {
    if ((y & 4095) === 0) cancelCheck();
    m[y * PW] = 0;
    m[y * PW + PW - 1] = 0;
  }
  const OFF = [-PW, -PW + 1, 1, PW + 1, PW, PW - 1, -1, -PW - 1];

  // connected components: drop specks, remember area per component
  const lab = scratch.labels;
  lab.fill(-1);
  const areas: number[] = [],
    stack: number[] = [];
  // Keep the small round components used by dotted trail symbology.
  const minArea = 4;
  checkpoint(0.4, 'Find connected components', true);
  for (let i = PW; i < m.length - PW; i++) {
    if ((i & 4095) === 0) cancelCheck();
    if (!m[i] || lab[i]! >= 0) continue;
    const id = areas.length,
      px = [i];
    lab[i] = id;
    stack.push(i);
    cancelCheck(true);
    while (stack.length) {
      cancelCheck();
      const c = stack.pop()!;
      for (const o of OFF) {
        const n: number = c + o;
        if (m[n]! && lab[n]! < 0) {
          lab[n] = id;
          stack.push(n);
          px.push(n);
        }
      }
    }
    areas.push(px.length);
    if (px.length < minArea) for (const p of px) m[p] = 0;
  }
  let list: number[] = [];
  for (let i = 0; i < m.length; i++) {
    if ((i & 4095) === 0) cancelCheck();
    if (m[i]!) list.push(i);
  }
  checkpoint(0.52, 'Thin color mask', true);
  list = thin(m, PW, list, cancelCheck);
  checkpoint(0.64, 'Remove filled regions', true);

  // drop filled shapes (legend swatches, colored zones): their average width is large
  const sk = scratch.skeletonCounts;
  sk.fill(0, 0, areas.length);
  for (let k = 0; k < list.length; k++) {
    cancelCheck();
    const i = list[k]!;
    sk[lab[i]!] = sk[lab[i]!]! + 1;
  }
  const maxW = 9 + 2 * r;
  const unfilled: number[] = [];
  for (let k = 0; k < list.length; k++) {
    if ((k & 4095) === 0) cancelCheck();
    const i = list[k]!;
    if (areas[lab[i]!]! > 4 * maxW * maxW && areas[lab[i]!]! / sk[lab[i]!]! > maxW) {
      m[i] = 0;
    } else {
      unfilled.push(i);
    }
  }
  list = unfilled;

  // ---- skeleton graph ----
  checkpoint(0.7, 'Build skeleton graph', true);
  const deg = scratch.degrees;
  deg.fill(0);
  cancelCheck(true);
  for (let k = 0; k < list.length; k++) {
    if ((k & 4095) === 0) cancelCheck();
    const i = list[k]!;
    cancelCheck();
    let d = 0;
    for (const o of OFF) d += m[i + o]!;
    deg[i] = d;
  }
  const node = scratch.nodes;
  node.fill(-1);
  const nodes: GraphNode[] = [];
  const toXY = (i: number): Px => [((i % PW) - 1 + 0.5) * f, (((i / PW) | 0) - 1 + 0.5) * f];
  for (let k = 0; k < list.length; k++) {
    if ((k & 4095) === 0) cancelCheck();
    const i = list[k]!;
    cancelCheck();
    if (deg[i] === 2 || node[i]! >= 0) continue;
    const id = nodes.length,
      px = [i];
    node[i] = id;
    stack.push(i);
    while (stack.length) {
      cancelCheck();
      const c = stack.pop()!;
      for (const o of OFF) {
        const n: number = c + o;
        if (m[n]! && deg[n]! !== 2 && node[n]! < 0) {
          node[n] = id;
          stack.push(n);
          px.push(n);
        }
      }
    }
    let sx = 0,
      sy = 0;
    for (let k = 0; k < px.length; k++) {
      if ((k & 4095) === 0) cancelCheck();
      const p = px[k]!;
      sx += ((p % PW) - 1 + 0.5) * f;
      sy += (((p / PW) | 0) - 1 + 0.5) * f;
    }
    nodes.push({ x: sx / px.length, y: sy / px.length, px });
  }
  const visited = scratch.visited;
  visited.fill(0);
  const
    edges: GraphEdge[] = [],
    seen = new Set<string>();
  const addEdge = (a: number, b: number, idx: number[]) => {
    const pts = new Float64Array(idx.length * 2);
    for (let i = 0; i < idx.length; i++) {
      if ((i & 4095) === 0) cancelCheck();
      pts[i * 2] = ((idx[i]! % PW) - 1 + 0.5) * f;
      pts[i * 2 + 1] = (((idx[i]! / PW) | 0) - 1 + 0.5) * f;
    }
    if (a >= 0) {
      pts[0] = nodes[a]!.x;
      pts[1] = nodes[a]!.y;
    }
    if (b >= 0) {
      pts[pts.length - 2] = nodes[b]!.x;
      pts[pts.length - 1] = nodes[b]!.y;
    }
    edges.push({ id: edges.length, a, b, pts, alive: true, len: 0 });
  };
  const newNode = (i: number): number => {
    const [x, y] = toXY(i);
    nodes.push({ x, y, px: [i] });
    node[i] = nodes.length - 1;
    return nodes.length - 1;
  };
  nodes.forEach((nd, a) => {
    cancelCheck();
    for (let j = 0; j < nd.px.length; j++) {
      if ((j & 4095) === 0) cancelCheck();
      const p = nd.px[j]!;
      for (const o of OFF) {
        const q = p + o;
        if (!m[q] || node[q] === a) continue;
        if (node[q]! >= 0) {
          const key = Math.min(p, q) + ':' + Math.max(p, q);
          if (seen.has(key)) continue;
          seen.add(key);
          addEdge(a, node[q]!, [p, q]);
          continue;
        }
        if (visited[q]!) continue;
        const idx = [p];
        let prev = p,
          cur = q,
          b = -1;
        for (;;) {
          cancelCheck();
          idx.push(cur);
          if (node[cur]! >= 0) {
            b = node[cur]!;
            break;
          }
          visited[cur] = 1;
          let nx = -1;
          for (const oo of OFF) {
            const n = cur + oo;
            if (!m[n] || n === prev) continue;
            if (node[n]! < 0 && visited[n]!) continue;
            if (node[n] === a && idx.length < 3 && n !== p) continue;
            nx = n;
            break;
          }
          if (nx < 0) {
            b = newNode(cur);
            break;
          }
          prev = cur;
          cur = nx;
        }
        addEdge(a, b, idx);
      }
    }
  });
  for (const i of list) {
    cancelCheck();
    // closed loops with no junctions
    if (visited[i]! || node[i]! >= 0) continue;
      const a = newNode(i),
      idx = [i];
    visited[i] = 1;
    let prev = -1,
      cur = i;
    for (;;) {
      cancelCheck();
      let nx = -1;
      for (const o of OFF) {
        const n = cur + o;
        if (m[n]! && n !== prev && (n === i ? idx.length > 2 : !visited[n])) {
          nx = n;
          break;
        }
      }
      if (nx < 0 || nx === i) {
        idx.push(i);
        break;
      }
      visited[nx] = 1;
      idx.push(nx);
      prev = cur;
      cur = nx;
    }
    addEdge(a, a, idx);
  }
  const elen = (e: GraphEdge) => {
    let d = 0;
    for (let k = 2; k < e.pts.length; k += 2) {
      if ((k & 8191) === 0) cancelCheck();
      d += Math.hypot(e.pts[k]! - e.pts[k - 2]!, e.pts[k + 1]! - e.pts[k - 1]!);
    }
    return d;
  };
  edges.forEach((e) => {
    cancelCheck();
    e.len = elen(e);
  });

  const bridgeG = G * 4;
  const dirLen = Math.max(8 * f, 4 * r * f);
  const dirOf = ({ e, end }: Endpoint) => {
    const start = end === 'a' ? 0 : e.pts.length - 2;
    const step = end === 'a' ? 2 : -2;
    const ox = e.pts[start]!,
      oy = e.pts[start + 1]!;
    let tx = ox,
      ty = oy;
    for (let k = start; k >= 0 && k < e.pts.length; k += step) {
      cancelCheck();
      if (Math.hypot(e.pts[k]! - ox, e.pts[k + 1]! - oy) >= dirLen) {
        tx = e.pts[k]!;
        ty = e.pts[k + 1]!;
        break;
      }
    }
    const dx = tx - ox,
      dy = ty - oy,
      L = Math.hypot(dx, dy) || 1;
    return [dx / L, dy / L];
  };
  const degs = () => {
    const d = new Int32Array(nodes.length);
    edges.forEach((e) => {
      cancelCheck();
      if (e.alive) {
        d[e.a] = d[e.a]! + 1;
        d[e.b] = d[e.b]! + 1;
      }
    });
    return d;
  };

  // bridge gaps: join line ends that point at each other (dashed lines, breaks at crossings)
  checkpoint(0.8, 'Bridge trail gaps', true);
  if (G > 0) {
    let d = degs();
    const isolated: number[] = [];
    for (let i = 0; i < nodes.length; i++) {
      if ((i & 4095) === 0) cancelCheck();
      if (d[i] === 0) isolated.push(i);
    }
    if (isolated.length >= 5) {
      let first = -1,
        trailEnd = -1,
        startDistance = G * 2.5;
      for (const candidate of isolated) {
        cancelCheck();
        for (let n = 0; n < nodes.length; n++) {
          if (d[n] !== 1) continue;
          const distance = Math.hypot(
            nodes[candidate]!.x - nodes[n]!.x,
            nodes[candidate]!.y - nodes[n]!.y,
          );
          if (distance < startDistance) {
            first = candidate;
            trailEnd = n;
            startDistance = distance;
          }
        }
      }
      if (first >= 0 && trailEnd >= 0) {
        const remaining = new Set(isolated);
        remaining.delete(first);
        edges.push({
          id: edges.length,
          a: trailEnd,
          b: first,
          pts: new Float64Array([
            nodes[trailEnd]!.x,
            nodes[trailEnd]!.y,
            nodes[first]!.x,
            nodes[first]!.y,
          ]),
          alive: true,
          len: startDistance,
        });
        let current = first;
        while (remaining.size) {
          let next = -1,
            nearest = G * 2.5;
          for (const candidate of remaining) {
            const distance = Math.hypot(
              nodes[current]!.x - nodes[candidate]!.x,
              nodes[current]!.y - nodes[candidate]!.y,
            );
            if (distance < nearest) {
              next = candidate;
              nearest = distance;
            }
          }
          if (next < 0) break;
          edges.push({
            id: edges.length,
            a: current,
            b: next,
            pts: new Float64Array([
              nodes[current]!.x,
              nodes[current]!.y,
              nodes[next]!.x,
              nodes[next]!.y,
            ]),
            alive: true,
            len: nearest,
          });
          remaining.delete(next);
          current = next;
        }
        d = degs();
      }
    }
    const ends: EndRef[] = [],
      grid = new Map<string, EndRef[]>(),
      key = (x: number, y: number) => Math.floor(x / bridgeG) + ',' + Math.floor(y / bridgeG);
    edges.forEach((e) => {
      if (!e.alive) return;
      for (const end of ['a', 'b'] as const) {
        const n = end === 'a' ? e.a : e.b;
        if (d[n]! !== 1) continue;
        const dir = dirOf({ e, end }),
          o = { n, e, x: nodes[n]!.x, y: nodes[n]!.y, ox: -dir[0]!, oy: -dir[1]!, k: ends.length };
        ends.push(o);
        const kk = key(o.x, o.y);
        if (!grid.has(kk)) grid.set(kk, []);
        grid.get(kk)!.push(o);
      }
    });
    const cands: [number, EndRef, EndRef, number][] = [];
    for (const p of ends) {
      cancelCheck();
      const gx = Math.floor(p.x / bridgeG),
        gy = Math.floor(p.y / bridgeG);
      for (let yy = gy - 1; yy <= gy + 1; yy++)
        for (let xx = gx - 1; xx <= gx + 1; xx++)
          for (const q of grid.get(xx + ',' + yy) || []) {
            if (q.k <= p.k || q.n === p.n) continue;
            if (q.e === p.e && p.e.len < 4 * G) continue;
            const dx = q.x - p.x,
              dy = q.y - p.y,
              dist = Math.hypot(dx, dy);
            if (dist > bridgeG || dist < 1e-6) continue;
            const vx = dx / dist,
              vy = dy / dist,
              c1 = p.ox * vx + p.oy * vy,
              c2 = -(q.ox * vx + q.oy * vy);
            const need1 = p.e.len < dirLen ? -0.25 : 0.55,
              need2 = q.e.len < dirLen ? -0.25 : 0.55;
            if (c1 < need1 || c2 < need2) continue;
            cands.push([dist * (3 - c1 - c2), p, q, dist]);
          }
    }
    cands.sort((a, b) => {
      cancelCheck();
      return a[0] - b[0];
    });
    const usedN = new Set();
    for (const [, p, q, dist] of cands) {
      cancelCheck();
      if (usedN.has(p.n) || usedN.has(q.n)) continue;
      usedN.add(p.n);
      usedN.add(q.n);
      edges.push({
        id: edges.length,
        a: p.n,
        b: q.n,
        pts: new Float64Array([p.x, p.y, q.x, q.y]),
        alive: true,
        len: dist,
      });
    }
  }

  // prune short spurs hanging off junctions
  checkpoint(0.88, 'Prune spurs and pair junctions', true);
  const spur = Math.max(6 * f, (2 * r + 5) * f, opt.minLen * 0.15);
  for (let round = 0; round < 4; round++) {
    const d = degs();
    let n = 0;
    edges.forEach((e) => {
      if (
        e.alive &&
        e.a !== e.b &&
        e.len < spur &&
        ((d[e.a] === 1 && d[e.b]! >= 3) || (d[e.b] === 1 && d[e.a]! >= 3))
      ) {
        e.alive = false;
        n++;
      }
    });
    if (!n) break;
  }

  // pair edges through junctions by straightest continuation
  const inc: Endpoint[][] = [];
  for (let i = 0; i < nodes.length; i++) {
    if ((i & 4095) === 0) cancelCheck();
    inc.push([]);
  }
  edges.forEach((e) => {
    cancelCheck();
    if (e.alive) {
      inc[e.a]!.push({ e, end: 'a' });
      inc[e.b]!.push({ e, end: 'b' });
    }
  });
  const pair = new Map<string, Endpoint>(),
    K = (x: Endpoint) => x.e.id + x.end;
  inc.forEach((list) => {
    cancelCheck();
    if (list.length === 2) {
      if (list[0]!.e !== list[1]!.e) {
        pair.set(K(list[0]!), list[1]!);
        pair.set(K(list[1]!), list[0]!);
      }
      return;
    }
    if (list.length < 3) return;
    const dirs = list.map(dirOf),
      cand: [number, number, number][] = [];
    for (let i = 0; i < list.length; i++) {
      cancelCheck();
      for (let j = i + 1; j < list.length; j++) {
        if ((j & 4095) === 0) cancelCheck();
        if (list[i]!.e !== list[j]!.e)
          cand.push([dirs[i]![0]! * dirs[j]![0]! + dirs[i]![1]! * dirs[j]![1]!, i, j]);
      }
    }
    cand.sort((a, b) => {
      cancelCheck();
      return a[0] - b[0];
    });
    const used = new Set();
    for (const [c, i, j] of cand) {
      if (c > -0.7) break;
      if (used.has(i) || used.has(j)) continue;
      used.add(i);
      used.add(j);
      pair.set(K(list[i]!), list[j]!);
      pair.set(K(list[j]!), list[i]!);
    }
  });

  // chain edges into lines
  checkpoint(0.94, 'Chain and simplify trails', true);
  const used = new Set<GraphEdge>(),
    lines: ProtoLine[] = [];
  const edgePoints = (edge: GraphEdge, reverse = false): Px[] => {
    const points: Px[] = [];
    if (reverse) {
      for (let i = edge.pts.length - 2; i >= 0; i -= 2) {
        if ((i & 8191) === 0) cancelCheck();
        points.push([edge.pts[i]!, edge.pts[i + 1]!]);
      }
    } else {
      for (let i = 0; i < edge.pts.length; i += 2) {
        if ((i & 8191) === 0) cancelCheck();
        points.push([edge.pts[i]!, edge.pts[i + 1]!]);
      }
    }
    return points;
  };
  for (const e of edges) {
    cancelCheck();
    if (!e.alive || used.has(e)) continue;
    used.add(e);
    let pts = edgePoints(e);
    let cur: Endpoint = { e, end: 'b' };
    for (;;) {
      cancelCheck();
      const nx = pair.get(K(cur));
      if (!nx || used.has(nx.e)) break;
      used.add(nx.e);
      const seg = edgePoints(nx.e, nx.end === 'b');
      pts = pts.concat(seg.slice(1));
      cur = { e: nx.e, end: nx.end === 'a' ? 'b' : 'a' };
    }
    cur = { e, end: 'a' };
    for (;;) {
      cancelCheck();
      const nx = pair.get(K(cur));
      if (!nx || used.has(nx.e)) break;
      used.add(nx.e);
      const seg = edgePoints(nx.e, nx.end === 'a');
      pts = seg.slice(0, -1).concat(pts);
      cur = { e: nx.e, end: nx.end === 'a' ? 'b' : 'a' };
    }
    cancelCheck(true);
    const s = simplify(pts, Math.max(1, f * 0.9));
    cancelCheck(true);
    let L = 0;
    for (let k = 1; k < s.length; k++)
      L += Math.hypot(s[k]![0] - s[k - 1]![0], s[k]![1] - s[k - 1]![1]);
    const chord = s.length > 1 ? Math.hypot(s.at(-1)![0] - s[0]![0], s.at(-1)![1] - s[0]![1]) : 0;
    const labelLike = L < 500 && L / Math.max(chord, 1) > 1.5;
    if (L >= opt.minLen && s.length >= 2 && !labelLike) lines.push({ pts: s, len: L });
  }
  lines.sort((a, b) => {
    cancelCheck();
    return b.len - a.len;
  });
  return lines;
}
/** Trace a selected color through a padded mask and its pixel skeleton graph. */
export function autoTraceColor(
  img: RasterImage,
  rgb: Rgb,
  opts: AutoTraceColorOptions,
  hooks?: JobHooks,
): TracedLine[] {
  hooks?.throwIfCancelled();
  hooks?.progress(0, 'Build color mask');
  const factor = Math.max(1, Math.ceil(Math.max(img.width, img.height) / 2400));
  const size = (Math.ceil(img.width / factor) + 2) * (Math.ceil(img.height / factor) + 2);
  const scratch = acquireScratch(size, Math.max(img.width, img.height) + 3);
  try {
    const result = traceColor(
      { data: img.data, W: img.width, H: img.height },
      rgb,
      {
        tol: opts.tolerance,
        gap: opts.gapPx,
        minLen: opts.minLengthPx,
      },
      scratch,
      hooks,
    );
    hooks?.throwIfCancelled();
    hooks?.progress(1, 'Auto-trace complete');
    return result.map(({ pts, len }) => ({ pts, lengthPx: len }));
  } finally {
    releaseScratch(scratch);
  }
}
