// Copied verbatim from reference/trailmaker-prototype.html for characterization tests.
const R = 6378137, D2R = Math.PI / 180;
  function solve(A, b) {
    const n = b.length;
    A = A.map(r => r.slice()); b = b.slice();
    for (let c = 0; c < n; c++) {
      let p = c;
      for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
      if (Math.abs(A[p][c]) < 1e-12) return null;
      [A[c], A[p]] = [A[p], A[c]]; [b[c], b[p]] = [b[p], b[c]];
      for (let r = c + 1; r < n; r++) {
        const f = A[r][c] / A[c][c];
        if (!f) continue;
        for (let k = c; k < n; k++) A[r][k] -= f * A[c][k];
        b[r] -= f * b[c];
      }
    }
    const x = new Array(n);
    for (let r = n - 1; r >= 0; r--) {
      let s = b[r];
      for (let k = r + 1; k < n; k++) s -= A[r][k] * x[k];
      x[r] = s / A[r][r];
    }
    return x;
  }

  function lsq(rows, rhs) {
    const n = rows[0].length;
    const A = Array.from({ length: n }, () => new Array(n).fill(0));
    const b = new Array(n).fill(0);
    rows.forEach((r, k) => {
      for (let i = 0; i < n; i++) {
        b[i] += r[i] * rhs[k];
        for (let j = 0; j < n; j++) A[i][j] += r[i] * r[j];
      }
    });
    return solve(A, b);
  }

  const U = r2 => (r2 > 0 ? r2 * Math.log(r2) : 0);
  const avg = a => a.reduce((s, v) => s + v, 0) / a.length;

  // Fit image pixels -> lat/lon from anchor points
  function fit(gcps, W, H, method) {
    const g = gcps.filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lon));
    if (g.length < 2) return { ok: false, count: g.length, need: 2 - g.length };
    const lat0 = avg(g.map(p => p.lat)), lon0 = avg(g.map(p => p.lon));
    const kx = R * D2R * Math.cos(lat0 * D2R), ky = R * D2R;
    const sc = Math.max(W, H) || 1, cx = W / 2, cy = H / 2;
    const P = g.map(p => ({ id: p.id, u: (p.x - cx) / sc, v: (p.y - cy) / sc, E: (p.lon - lon0) * kx, N: (p.lat - lat0) * ky }));

    // similarity (scale + rotation, no mirroring)
    let sim = null, simScale = 0;
    {
      const rows = [], rhs = [];
      P.forEach(p => { rows.push([p.u, p.v, 1, 0]); rhs.push(p.E); rows.push([-p.v, p.u, 0, 1]); rhs.push(p.N); });
      const s = lsq(rows, rhs);
      if (s) { sim = (u, v) => [s[0] * u + s[1] * v + s[2], s[1] * u - s[0] * v + s[3]]; simScale = Math.hypot(s[0], s[1]); }
    }
    // affine
    let aff = null, affDet = 0;
    if (P.length >= 3) {
      const rows = P.map(p => [p.u, p.v, 1]);
      const a = lsq(rows, P.map(p => p.E)), b = lsq(rows, P.map(p => p.N));
      if (a && b) {
        affDet = a[0] * b[1] - a[1] * b[0];
        if (Math.abs(affDet) > 1e-9) aff = (u, v) => [a[0] * u + a[1] * v + a[2], b[0] * u + b[1] * v + b[2]];
      }
    }
    if (!sim && !aff) return { ok: false, count: g.length, need: 0, degenerate: true };

    let m = method;
    if (m === 'auto') m = P.length >= 4 && aff ? 'affine' : 'similarity';
    if (m === 'affine' && !aff) m = 'similarity';
    if (m === 'tps' && (P.length < 4 || !aff)) m = aff ? 'affine' : 'similarity';
    if (m === 'similarity' && !sim) m = 'affine';

    let fwdEN;
    if (m === 'similarity') fwdEN = sim;
    else if (m === 'affine') fwdEN = aff;
    else {
      const n = P.length, M = Array.from({ length: n + 3 }, () => new Array(n + 3).fill(0));
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) M[i][j] = U((P[i].u - P[j].u) ** 2 + (P[i].v - P[j].v) ** 2);
        M[i][n] = M[n][i] = 1; M[i][n + 1] = M[n + 1][i] = P[i].u; M[i][n + 2] = M[n + 2][i] = P[i].v;
      }
      const wE = solve(M, [...P.map(p => p.E), 0, 0, 0]);
      const wN = solve(M, [...P.map(p => p.N), 0, 0, 0]);
      if (wE && wN) {
        fwdEN = (u, v) => {
          let e = wE[n] + wE[n + 1] * u + wE[n + 2] * v, nn = wN[n] + wN[n + 1] * u + wN[n + 2] * v;
          for (let i = 0; i < n; i++) { const k = U((u - P[i].u) ** 2 + (v - P[i].v) ** 2); e += wE[i] * k; nn += wN[i] * k; }
          return [e, nn];
        };
      } else { m = 'affine'; fwdEN = aff; }
    }
    // residuals from a rigid-ish model so there is always an error check
    const resModel = m === 'tps' ? aff : fwdEN;
    const res = {};
    let ss = 0;
    P.forEach(p => { const [e, n] = resModel(p.u, p.v); const d = Math.hypot(e - p.E, n - p.N); res[p.id] = d; ss += d * d; });
    const rms = Math.sqrt(ss / P.length);
    const dof = m === 'similarity' ? P.length - 2 : m === 'affine' ? P.length - 3 : P.length - 3;
    const mpp = (m === 'similarity' ? simScale : Math.sqrt(Math.abs(affDet))) / sc;
    const mirrored = m !== 'similarity' && affDet > 0;
    const fwd = (x, y) => { const [E, N] = fwdEN((x - cx) / sc, (y - cy) / sc); return [lat0 + N / ky, lon0 + E / kx]; };
    return { ok: true, method: m, fwd, res, rms, checked: dof > 0, mpp, mirrored, count: g.length };
  }
export { fit as prototypeFit };
