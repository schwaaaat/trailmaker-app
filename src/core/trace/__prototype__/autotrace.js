function simplify(pts, eps) {
  if (pts.length < 3) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = pts[a],
      [bx, by] = pts[b];
    const dx = bx - ax,
      dy = by - ay,
      L = Math.hypot(dx, dy);
    let md = -1,
      mi = -1;
    for (let i = a + 1; i < b; i++) {
      const d =
        L > 1e-6
          ? Math.abs(dy * pts[i][0] - dx * pts[i][1] + bx * ay - by * ax) / L
          : Math.hypot(pts[i][0] - ax, pts[i][1] - ay);
      if (d > md) {
        md = d;
        mi = i;
      }
    }
    if (md > eps) {
      keep[mi] = 1;
      stack.push([a, mi], [mi, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

// Binary box filters on a padded grid. any=true: dilation, any=false: erosion.
function box(m, PW, PH, r, any) {
  const tmp = new Uint8Array(m.length),
    out = new Uint8Array(m.length);
  const pass = (src, dst, len, count, stride, lineStride) => {
    const pre = new Int32Array(len + 1);
    for (let L = 0; L < count; L++) {
      const base = L * lineStride;
      for (let i = 0; i < len; i++) pre[i + 1] = pre[i] + src[base + i * stride];
      for (let i = 0; i < len; i++) {
        const lo = Math.max(0, i - r),
          hi = Math.min(len - 1, i + r),
          s = pre[hi + 1] - pre[lo];
        dst[base + i * stride] = any ? (s > 0 ? 1 : 0) : s === hi - lo + 1 ? 1 : 0;
      }
    }
  };
  pass(m, tmp, PW, PH, 1, PW);
  pass(tmp, out, PH, PW, PW, 1);
  return out;
}

function thin(m, PW, list) {
  const del = [];
  let changed = true;
  while (changed) {
    changed = false;
    for (let step = 0; step < 2; step++) {
      del.length = 0;
      for (const i of list) {
        if (!m[i]) continue;
        const p2 = m[i - PW],
          p3 = m[i - PW + 1],
          p4 = m[i + 1],
          p5 = m[i + PW + 1],
          p6 = m[i + PW],
          p7 = m[i + PW - 1],
          p8 = m[i - 1],
          p9 = m[i - PW - 1];
        const B = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
        if (B < 2 || B > 6) continue;
        const A =
          (!p2 && p3) +
          (!p3 && p4) +
          (!p4 && p5) +
          (!p5 && p6) +
          (!p6 && p7) +
          (!p7 && p8) +
          (!p8 && p9) +
          (!p9 && p2);
        if (A !== 1) continue;
        if (
          step === 0 ? (p2 && p4 && p6) || (p4 && p6 && p8) : (p2 && p4 && p8) || (p2 && p6 && p8)
        )
          continue;
        del.push(i);
      }
      for (const i of del) m[i] = 0;
      if (del.length) changed = true;
    }
    list = list.filter((i) => m[i]);
  }
  // remove staircase corners so every line pixel has exactly two neighbours
  for (const i of list) {
    if (!m[i]) continue;
    const n = m[i - PW],
      e = m[i + 1],
      s = m[i + PW],
      w = m[i - 1];
    if (
      (n && e && !s && !w && !m[i + PW - 1]) ||
      (e && s && !n && !w && !m[i - PW - 1]) ||
      (s && w && !n && !e && !m[i - PW + 1]) ||
      (w && n && !e && !s && !m[i + PW + 1])
    )
      m[i] = 0;
  }
  return list.filter((i) => m[i]);
}

function traceColor(img, rgb, opt) {
  const { data: P, W, H } = img;
  const f = Math.max(1, Math.ceil(Math.max(W, H) / 2400));
  const w = Math.ceil(W / f),
    h = Math.ceil(H / f),
    PW = w + 2,
    PH = h + 2;
  const tol2 = opt.tol * opt.tol,
    G = Math.max(0, opt.gap || 0),
    r = G > 0 ? Math.min(3, Math.max(1, Math.round(G / f / 6))) : 0;
  let m = new Uint8Array(PW * PH);
  for (let y = 0; y < H; y++) {
    const row = (((y / f) | 0) + 1) * PW + 1;
    for (let x = 0, i = y * W * 4; x < W; x++, i += 4) {
      const dr = P[i] - rgb[0],
        dg = P[i + 1] - rgb[1],
        db = P[i + 2] - rgb[2];
      if (dr * dr + dg * dg + db * db <= tol2) m[row + ((x / f) | 0)] = 1;
    }
  }
  if (r > 0) m = box(box(m, PW, PH, r, true), PW, PH, r, false);
  for (let x = 0; x < PW; x++) {
    m[x] = 0;
    m[(PH - 1) * PW + x] = 0;
  }
  for (let y = 0; y < PH; y++) {
    m[y * PW] = 0;
    m[y * PW + PW - 1] = 0;
  }
  const OFF = [-PW, -PW + 1, 1, PW + 1, PW, PW - 1, -1, -PW - 1];

  // connected components: drop specks, remember area per component
  const lab = new Int32Array(m.length).fill(-1),
    areas = [],
    stack = [];
  const minArea = Math.max(6, (r + 2) * 3);
  for (let i = PW; i < m.length - PW; i++) {
    if (!m[i] || lab[i] >= 0) continue;
    const id = areas.length,
      px = [i];
    lab[i] = id;
    stack.push(i);
    while (stack.length) {
      const c = stack.pop();
      for (const o of OFF) {
        const n = c + o;
        if (m[n] && lab[n] < 0) {
          lab[n] = id;
          stack.push(n);
          px.push(n);
        }
      }
    }
    areas.push(px.length);
    if (px.length < minArea) for (const p of px) m[p] = 0;
  }
  let list = [];
  for (let i = 0; i < m.length; i++) if (m[i]) list.push(i);
  if (opt.debug) {
    opt.debug.comps = areas.length;
    opt.debug.big = areas.filter((a) => a >= minArea).length;
    opt.debug.fg = list.length;
  }
  list = thin(m, PW, list);
  if (opt.debug) opt.debug.skel = list.length;

  // drop filled shapes (legend swatches, colored zones): their average width is large
  const sk = new Float64Array(areas.length);
  for (const i of list) sk[lab[i]]++;
  const maxW = 9 + 2 * r;
  list = list.filter((i) => {
    if (areas[lab[i]] / sk[lab[i]] > maxW) {
      m[i] = 0;
      return false;
    }
    return true;
  });

  // ---- skeleton graph ----
  const deg = new Uint8Array(m.length);
  for (const i of list) {
    let d = 0;
    for (const o of OFF) d += m[i + o];
    deg[i] = d;
  }
  const node = new Int32Array(m.length).fill(-1),
    nodes = [];
  const toXY = (i) => [((i % PW) - 1 + 0.5) * f, (((i / PW) | 0) - 1 + 0.5) * f];
  for (const i of list) {
    if (deg[i] === 2 || node[i] >= 0) continue;
    const id = nodes.length,
      px = [i];
    node[i] = id;
    stack.push(i);
    while (stack.length) {
      const c = stack.pop();
      for (const o of OFF) {
        const n = c + o;
        if (m[n] && deg[n] !== 2 && node[n] < 0) {
          node[n] = id;
          stack.push(n);
          px.push(n);
        }
      }
    }
    let sx = 0,
      sy = 0;
    px.forEach((p) => {
      const [x, y] = toXY(p);
      sx += x;
      sy += y;
    });
    nodes.push({ x: sx / px.length, y: sy / px.length, px });
  }
  const visited = new Uint8Array(m.length),
    edges = [],
    seen = new Set();
  const addEdge = (a, b, idx) => {
    const pts = idx.map(toXY);
    if (a >= 0) pts[0] = [nodes[a].x, nodes[a].y];
    if (b >= 0) pts[pts.length - 1] = [nodes[b].x, nodes[b].y];
    edges.push({ id: edges.length, a, b, pts, alive: true });
  };
  const newNode = (i) => {
    const [x, y] = toXY(i);
    nodes.push({ x, y, px: [i] });
    node[i] = nodes.length - 1;
    return nodes.length - 1;
  };
  nodes.forEach((nd, a) => {
    for (const p of nd.px)
      for (const o of OFF) {
        const q = p + o;
        if (!m[q] || node[q] === a) continue;
        if (node[q] >= 0) {
          const key = Math.min(p, q) + ':' + Math.max(p, q);
          if (seen.has(key)) continue;
          seen.add(key);
          addEdge(a, node[q], [p, q]);
          continue;
        }
        if (visited[q]) continue;
        const idx = [p];
        let prev = p,
          cur = q,
          b = -1;
        for (;;) {
          idx.push(cur);
          if (node[cur] >= 0) {
            b = node[cur];
            break;
          }
          visited[cur] = 1;
          let nx = -1;
          for (const oo of OFF) {
            const n = cur + oo;
            if (!m[n] || n === prev) continue;
            if (node[n] < 0 && visited[n]) continue;
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
  });
  for (const i of list) {
    // closed loops with no junctions
    if (visited[i] || node[i] >= 0) continue;
    const a = newNode(i),
      idx = [i];
    visited[i] = 1;
    let prev = -1,
      cur = i;
    for (;;) {
      let nx = -1;
      for (const o of OFF) {
        const n = cur + o;
        if (m[n] && n !== prev && (n === i ? idx.length > 2 : !visited[n])) {
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
  const elen = (e) => {
    let d = 0;
    for (let k = 1; k < e.pts.length; k++)
      d += Math.hypot(e.pts[k][0] - e.pts[k - 1][0], e.pts[k][1] - e.pts[k - 1][1]);
    return d;
  };
  edges.forEach((e) => {
    e.len = elen(e);
  });

  const dirLen = Math.max(8 * f, 4 * r * f);
  const dirOf = ({ e, end }) => {
    const pts = end === 'a' ? e.pts : [...e.pts].reverse(),
      o = pts[0];
    let t = pts[pts.length - 1];
    for (const p of pts)
      if (Math.hypot(p[0] - o[0], p[1] - o[1]) >= dirLen) {
        t = p;
        break;
      }
    const dx = t[0] - o[0],
      dy = t[1] - o[1],
      L = Math.hypot(dx, dy) || 1;
    return [dx / L, dy / L];
  };
  const degs = () => {
    const d = new Int32Array(nodes.length);
    edges.forEach((e) => {
      if (e.alive) {
        d[e.a]++;
        d[e.b]++;
      }
    });
    return d;
  };

  // bridge gaps: join line ends that point at each other (dashed lines, breaks at crossings)
  if (G > 0) {
    const d = degs(),
      ends = [],
      grid = new Map(),
      key = (x, y) => Math.floor(x / G) + ',' + Math.floor(y / G);
    edges.forEach((e) => {
      if (!e.alive) return;
      for (const end of ['a', 'b']) {
        const n = end === 'a' ? e.a : e.b;
        if (d[n] !== 1) continue;
        const dir = dirOf({ e, end }),
          o = { n, e, x: nodes[n].x, y: nodes[n].y, ox: -dir[0], oy: -dir[1], k: ends.length };
        ends.push(o);
        const kk = key(o.x, o.y);
        if (!grid.has(kk)) grid.set(kk, []);
        grid.get(kk).push(o);
      }
    });
    const cands = [];
    for (const p of ends) {
      const gx = Math.floor(p.x / G),
        gy = Math.floor(p.y / G);
      for (let yy = gy - 1; yy <= gy + 1; yy++)
        for (let xx = gx - 1; xx <= gx + 1; xx++)
          for (const q of grid.get(xx + ',' + yy) || []) {
            if (q.k <= p.k || q.n === p.n) continue;
            if (q.e === p.e && p.e.len < 4 * G) continue;
            const dx = q.x - p.x,
              dy = q.y - p.y,
              dist = Math.hypot(dx, dy);
            if (dist > G || dist < 1e-6) continue;
            const vx = dx / dist,
              vy = dy / dist,
              c1 = p.ox * vx + p.oy * vy,
              c2 = -(q.ox * vx + q.oy * vy);
            const need1 = p.e.len < dirLen ? 0.2 : 0.55,
              need2 = q.e.len < dirLen ? 0.2 : 0.55;
            if (c1 < need1 || c2 < need2) continue;
            cands.push([dist * (3 - c1 - c2), p, q, dist]);
          }
    }
    cands.sort((a, b) => a[0] - b[0]);
    const usedN = new Set();
    for (const [, p, q, dist] of cands) {
      if (usedN.has(p.n) || usedN.has(q.n)) continue;
      usedN.add(p.n);
      usedN.add(q.n);
      edges.push({
        id: edges.length,
        a: p.n,
        b: q.n,
        pts: [
          [p.x, p.y],
          [q.x, q.y],
        ],
        alive: true,
        len: dist,
      });
    }
  }

  // prune short spurs hanging off junctions
  const spur = Math.max(6 * f, (2 * r + 5) * f, opt.minLen * 0.15);
  for (let round = 0; round < 4; round++) {
    const d = degs();
    let n = 0;
    edges.forEach((e) => {
      if (
        e.alive &&
        e.a !== e.b &&
        e.len < spur &&
        ((d[e.a] === 1 && d[e.b] >= 3) || (d[e.b] === 1 && d[e.a] >= 3))
      ) {
        e.alive = false;
        n++;
      }
    });
    if (!n) break;
  }

  // pair edges through junctions by straightest continuation
  const inc = nodes.map(() => []);
  edges.forEach((e) => {
    if (e.alive) {
      inc[e.a].push({ e, end: 'a' });
      inc[e.b].push({ e, end: 'b' });
    }
  });
  const pair = new Map(),
    K = (x) => x.e.id + x.end;
  inc.forEach((list) => {
    if (list.length === 2) {
      if (list[0].e !== list[1].e) {
        pair.set(K(list[0]), list[1]);
        pair.set(K(list[1]), list[0]);
      }
      return;
    }
    if (list.length < 3) return;
    const dirs = list.map(dirOf),
      cand = [];
    for (let i = 0; i < list.length; i++)
      for (let j = i + 1; j < list.length; j++)
        if (list[i].e !== list[j].e)
          cand.push([dirs[i][0] * dirs[j][0] + dirs[i][1] * dirs[j][1], i, j]);
    cand.sort((a, b) => a[0] - b[0]);
    const used = new Set();
    for (const [c, i, j] of cand) {
      if (c > -0.7) break;
      if (used.has(i) || used.has(j)) continue;
      used.add(i);
      used.add(j);
      pair.set(K(list[i]), list[j]);
      pair.set(K(list[j]), list[i]);
    }
  });

  // chain edges into lines
  const used = new Set(),
    lines = [];
  for (const e of edges) {
    if (!e.alive || used.has(e)) continue;
    used.add(e);
    let pts = e.pts.slice();
    let cur = { e, end: 'b' };
    for (;;) {
      const nx = pair.get(K(cur));
      if (!nx || used.has(nx.e)) break;
      used.add(nx.e);
      const seg = nx.end === 'a' ? nx.e.pts : [...nx.e.pts].reverse();
      pts = pts.concat(seg.slice(1));
      cur = { e: nx.e, end: nx.end === 'a' ? 'b' : 'a' };
    }
    cur = { e, end: 'a' };
    for (;;) {
      const nx = pair.get(K(cur));
      if (!nx || used.has(nx.e)) break;
      used.add(nx.e);
      const seg = nx.end === 'a' ? [...nx.e.pts].reverse() : nx.e.pts;
      pts = seg.slice(0, -1).concat(pts);
      cur = { e: nx.e, end: nx.end === 'a' ? 'b' : 'a' };
    }
    const s = simplify(pts, Math.max(1, f * 0.9));
    let L = 0;
    for (let k = 1; k < s.length; k++)
      L += Math.hypot(s[k][0] - s[k - 1][0], s[k][1] - s[k - 1][1]);
    if (L >= opt.minLen && s.length >= 2) lines.push({ pts: s, len: L });
  }
  lines.sort((a, b) => b.len - a.len);
  return lines;
}

export { simplify, box, thin, traceColor };
