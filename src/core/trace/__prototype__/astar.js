// Copied verbatim from reference/trailmaker-prototype.html; imports helper algorithms for characterization.
import { cdist, simplify } from "../../geo/__prototype__/utilities.js";
  function pickInk(img, x, y, r) {
    const { data: P, W, H } = img;
    x = Math.round(x); y = Math.round(y); r = Math.max(1, Math.min(14, Math.round(r)));
    const R2 = r * 2; let s = [0, 0, 0], n = 0;
    for (let yy = Math.max(0, y - R2); yy <= Math.min(H - 1, y + R2); yy++)
      for (let xx = Math.max(0, x - R2); xx <= Math.min(W - 1, x + R2); xx++) { const i = (yy * W + xx) * 4; s[0] += P[i]; s[1] += P[i + 1]; s[2] += P[i + 2]; n++; }
    if (!n) return [0, 0, 0];
    const mean = s.map(v => v / n);
    let best = null, bd = -1;
    for (let yy = Math.max(0, y - r); yy <= Math.min(H - 1, y + r); yy++)
      for (let xx = Math.max(0, x - r); xx <= Math.min(W - 1, x + r); xx++) {
        if ((xx - x) ** 2 + (yy - y) ** 2 > r * r) continue;
        const i = (yy * W + xx) * 4, d = cdist(P, i, mean) - Math.hypot(xx - x, yy - y) * 2;
        if (d > bd) { bd = d; best = [P[i], P[i + 1], P[i + 2]]; }
      }
    if (!best || bd < 10) { const cx = Math.min(W - 1, Math.max(0, x)), cy = Math.min(H - 1, Math.max(0, y)); const i = (cy * W + cx) * 4; return [P[i], P[i + 1], P[i + 2]]; }
    return best;
  }

  function snap(img, x, y, target, tol, r) {
    const { data: P, W, H } = img;
    const x0 = Math.round(x), y0 = Math.round(y); r = Math.max(2, Math.min(30, Math.round(r)));
    let best = null, bs = Infinity;
    for (let yy = Math.max(0, y0 - r); yy <= Math.min(H - 1, y0 + r); yy++)
      for (let xx = Math.max(0, x0 - r); xx <= Math.min(W - 1, x0 + r); xx++) {
        const dd = Math.hypot(xx - x, yy - y); if (dd > r) continue;
        const cd = cdist(P, (yy * W + xx) * 4, target); if (cd > tol) continue;
        const sc = dd + (cd / tol) * r * 0.5;
        if (sc < bs) { bs = sc; best = [xx, yy]; }
      }
    return best;
  }
  class Heap {
    constructor(c = 4096) { this.k = new Int32Array(c); this.f = new Float64Array(c); this.n = 0; }
    push(k, f) {
      if (this.n === this.k.length) { const nk = new Int32Array(this.n * 2); nk.set(this.k); this.k = nk; const nf = new Float64Array(this.n * 2); nf.set(this.f); this.f = nf; }
      const K = this.k, F = this.f; let i = this.n++;
      while (i > 0) { const p = (i - 1) >> 1; if (F[p] <= f) break; K[i] = K[p]; F[i] = F[p]; i = p; }
      K[i] = k; F[i] = f;
    }
    pop() {
      const K = this.k, F = this.f, top = K[0], n = --this.n;
      if (n > 0) {
        const lk = K[n], lf = F[n]; let i = 0;
        for (;;) { let c = 2 * i + 1; if (c >= n) break; if (c + 1 < n && F[c + 1] < F[c]) c++; if (F[c] >= lf) break; K[i] = K[c]; F[i] = F[c]; i = c; }
        K[i] = lk; F[i] = lf;
      }
      return top;
    }
  }
  function trace(img, a, b, target, tol) {
    const { data: P, W, H } = img;
    const ax = Math.round(a[0]), ay = Math.round(a[1]), bx = Math.round(b[0]), by = Math.round(b[1]);
    const d = Math.hypot(bx - ax, by - ay), m = Math.max(24, d * 0.4);
    const x0 = Math.max(0, Math.floor(Math.min(ax, bx) - m)), x1 = Math.min(W - 1, Math.ceil(Math.max(ax, bx) + m));
    const y0 = Math.max(0, Math.floor(Math.min(ay, by) - m)), y1 = Math.min(H - 1, Math.ceil(Math.max(ay, by) + m));
    const w = x1 - x0 + 1, h = y1 - y0 + 1, N = w * h;
    if (N > 3.2e6 || w < 1 || h < 1) return null;
    const cost = new Float32Array(N);
    for (let yy = 0, k = 0; yy < h; yy++) {
      let pi = ((yy + y0) * W + x0) * 4;
      for (let xx = 0; xx < w; xx++, k++, pi += 4) { const t = cdist(P, pi, target) / tol; cost[k] = t <= 1 ? 1 + 0.6 * t : 8 + t * 5; }
    }
    const g = new Float32Array(N).fill(Infinity), from = new Int32Array(N).fill(-1), done = new Uint8Array(N);
    const s = (ay - y0) * w + (ax - x0), e = (by - y0) * w + (bx - x0), ex = bx - x0, ey = by - y0;
    const hf = k => { const dx = Math.abs((k % w) - ex), dy = Math.abs(((k / w) | 0) - ey); return dx + dy + (Math.SQRT2 - 2) * Math.min(dx, dy); };
    const heap = new Heap(); g[s] = 0; heap.push(s, hf(s));
    const DX = [1, -1, 0, 0, 1, 1, -1, -1], DY = [0, 0, 1, -1, 1, -1, 1, -1];
    while (heap.n) {
      const k = heap.pop(); if (done[k]) continue; if (k === e) break; done[k] = 1;
      const kx = k % w, ky = (k / w) | 0, gk = g[k], ck = cost[k];
      for (let q = 0; q < 8; q++) {
        const nx = kx + DX[q], ny = ky + DY[q]; if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const nk = ny * w + nx; if (done[nk]) continue;
        const ng = gk + (q < 4 ? 1 : Math.SQRT2) * (ck + cost[nk]) * 0.5;
        if (ng < g[nk]) { g[nk] = ng; from[nk] = k; heap.push(nk, ng + hf(nk)); }
      }
    }
    if (s !== e && from[e] < 0) return null;
    const out = []; let k = e;
    while (k !== -1) { out.push([(k % w) + x0, ((k / w) | 0) + y0]); if (k === s) break; k = from[k]; }
    out.reverse();
    return simplify(out, 0.9);
  }
export { pickInk as prototypePickInk, snap as prototypeSnap, trace as prototypeTrace };
