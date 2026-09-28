// Copied verbatim from reference/trailmaker-prototype.html for characterization tests.
import { rgbToHsl, nameColor } from "../../geo/__prototype__/utilities.js";
  function scanColors(img) {
    const { data: P, W, H } = img;
    const f = Math.max(1, Math.ceil(Math.max(W, H) / 1600)), w = Math.floor(W / f), h = Math.floor(H / f), N = w * h;
    const q = new Uint16Array(N), hist = new Uint32Array(4096);
    for (let y = 0, k = 0; y < h; y++) for (let x = 0; x < w; x++, k++) {
      const i = (y * f * W + x * f) * 4, b = ((P[i] >> 4) << 8) | ((P[i + 1] >> 4) << 4) | (P[i + 2] >> 4);
      q[k] = b; hist[b]++;
    }
    const bins = []; for (let b = 0; b < 4096; b++) if (hist[b]) bins.push(b);
    bins.sort((a, b) => hist[b] - hist[a]);
    const cl = [], binCl = new Int16Array(4096).fill(-1);
    for (const b of bins) {
      const c = [((b >> 8) & 15) * 16 + 8, ((b >> 4) & 15) * 16 + 8, (b & 15) * 16 + 8], n = hist[b];
      let best = -1, bd = 1e9;
      cl.forEach((k, i) => { const d = (k.m[0] - c[0]) ** 2 + (k.m[1] - c[1]) ** 2 + (k.m[2] - c[2]) ** 2; if (d < bd) { bd = d; best = i; } });
      if (best < 0 || (bd > 34 * 34 && cl.length < 90)) { cl.push({ m: c.slice(), n }); binCl[b] = cl.length - 1; }
      else { const k = cl[best], t = k.n + n; for (let j = 0; j < 3; j++) k.m[j] = (k.m[j] * k.n + c[j] * n) / t; k.n = t; binCl[b] = best; }
    }
    const C = cl.length, cnt = new Float64Array(C), edge = new Float64Array(C), sum = new Float64Array(C * 3);
    for (let y = 0, k = 0; y < h; y++) for (let x = 0; x < w; x++, k++) {
      const c = binCl[q[k]]; cnt[c]++;
      const i = (y * f * W + x * f) * 4; sum[c * 3] += P[i]; sum[c * 3 + 1] += P[i + 1]; sum[c * 3 + 2] += P[i + 2];
      if ((x > 0 && binCl[q[k - 1]] !== c) || (x < w - 1 && binCl[q[k + 1]] !== c) || (y > 0 && binCl[q[k - w]] !== c) || (y < h - 1 && binCl[q[k + w]] !== c)) edge[c]++;
    }
    let out = [];
    for (let c = 0; c < C; c++) {
      if (!cnt[c]) continue;
      const rgb = [sum[c * 3] / cnt[c], sum[c * 3 + 1] / cnt[c], sum[c * 3 + 2] / cnt[c]].map(Math.round);
      const share = cnt[c] / N, thin = edge[c] / cnt[c], [, s, l] = rgbToHsl(rgb);
      if (share < 0.0003 || share > 0.25 || thin < 0.3) continue;
      if (l > 0.86 && s < 0.3) continue;
      out.push({ rgb, share, thin, sat: s, light: l, score: share * thin * (0.35 + s) });
    }
    out.sort((a, b) => b.score - a.score);
    const kept = [];
    for (const o of out) {
      if (kept.some(k => Math.hypot(k.rgb[0] - o.rgb[0], k.rgb[1] - o.rgb[1], k.rgb[2] - o.rgb[2]) < 48)) continue;
      kept.push(o); if (kept.length >= 10) break;
    }
    kept.forEach(k => { k.name = nameColor(k.rgb); k.likely = k.sat > 0.3 && k.thin > 0.45 && k.light < 0.8; });
    return kept;
  }
export { scanColors as prototypeScanColors };
