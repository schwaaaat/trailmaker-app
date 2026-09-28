// Copied verbatim from reference/trailmaker-prototype.html for characterization tests.
const R = 6378137, D2R = Math.PI / 180;
  function hav(a, b) {
    const dLat = (b[0] - a[0]) * D2R, dLon = (b[1] - a[1]) * D2R;
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * D2R) * Math.cos(b[0] * D2R) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
  }
  const pathLen = ll => { let d = 0; for (let i = 1; i < ll.length; i++) d += hav(ll[i - 1], ll[i]); return d; };

  function parseLL(s) {
    s = String(s || '').trim();
    if (!s) return null;
    let lat, lon;
    let m = s.match(/@(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/) || s.match(/[?&](?:q|query|ll)=(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/);
    if (m) { lat = +m[1]; lon = +m[2]; }
    else {
      const dmsRe = /(\d+(?:\.\d+)?)\s*(?:°|º|deg)\s*(?:(\d+(?:\.\d+)?)\s*(?:'|′|’)\s*)?(?:(\d+(?:\.\d+)?)\s*(?:"|″|”|''|’’)\s*)?([NSEW])/gi;
      const parts = [...s.matchAll(dmsRe)];
      if (parts.length === 2) {
        const conv = p => { let v = +p[1] + (+(p[2] || 0)) / 60 + (+(p[3] || 0)) / 3600; if (/[SW]/i.test(p[4])) v = -v; return { v, isLat: /[NS]/i.test(p[4]) }; };
        const a = conv(parts[0]), b = conv(parts[1]);
        if (a.isLat) { lat = a.v; lon = b.v; } else { lat = b.v; lon = a.v; }
      } else {
        const nums = s.match(/-?\d+(?:\.\d+)?\s*[NSEW]?/gi);
        if (!nums || nums.length < 2) return null;
        let a = parseFloat(nums[0]), b = parseFloat(nums[1]);
        const ha = (nums[0].match(/[NSEW]/i) || [''])[0].toUpperCase(), hb = (nums[1].match(/[NSEW]/i) || [''])[0].toUpperCase();
        if (ha === 'S' || ha === 'W') a = -Math.abs(a);
        if (hb === 'S' || hb === 'W') b = -Math.abs(b);
        if ((ha === 'E' || ha === 'W') && (hb === 'N' || hb === 'S')) { lat = b; lon = a; } else { lat = a; lon = b; }
      }
    }
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
    return [lat, lon];
  }
  const cdist = (P, i, t) => { const r = P[i] - t[0], g = P[i + 1] - t[1], b = P[i + 2] - t[2]; return Math.sqrt(r * r + g * g + b * b); };
  function simplify(pts, eps) {
    if (pts.length < 3) return pts.slice();
    const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
    const stack = [[0, pts.length - 1]];
    while (stack.length) {
      const [a, b] = stack.pop(); const [ax, ay] = pts[a], [bx, by] = pts[b];
      const dx = bx - ax, dy = by - ay, L = Math.hypot(dx, dy);
      let md = -1, mi = -1;
      for (let i = a + 1; i < b; i++) { const d = L > 1e-6 ? Math.abs(dy * pts[i][0] - dx * pts[i][1] + bx * ay - by * ax) / L : Math.hypot(pts[i][0] - ax, pts[i][1] - ay); if (d > md) { md = d; mi = i; } }
      if (md > eps) { keep[mi] = 1; stack.push([a, mi], [mi, b]); }
    }
    return pts.filter((_, i) => keep[i]);
  }
  function rgbToHsl([r, g, b]) {
    r /= 255; g /= 255; b /= 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
    let h = 0, s = 0;
    if (d > 1e-6) {
      s = d / (1 - Math.abs(2 * l - 1));
      h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
      h = (h * 60 + 360) % 360;
    }
    return [h, s, l];
  }
  function nameColor(rgb) {
    const [h, s, l] = rgbToHsl(rgb);
    if (l < 0.16) return 'Black';
    if (s < 0.16) return l > 0.82 ? 'White' : 'Gray';
    if ((h < 45 || h >= 340) && l < 0.42 && s < 0.65 && h >= 10) return 'Brown';
    if (h < 12 || h >= 345) return 'Red';
    if (h < 42) return l < 0.35 ? 'Brown' : 'Orange';
    if (h < 68) return 'Yellow';
    if (h < 160) return 'Green';
    if (h < 195) return 'Teal';
    if (h < 250) return 'Blue';
    if (h < 290) return 'Purple';
    return 'Pink';
  }
export { hav, pathLen, parseLL, cdist, simplify, rgbToHsl, nameColor };
