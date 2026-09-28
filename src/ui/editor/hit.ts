// Lane B. Hit-testing in screen space (prototype hitGcp/hitVertex/hitFeature/segDist/inPoly).
// Tolerances are CSS pixels, so they feel the same at every zoom.
import type { Anchor, AnchorId, Feature, Px } from '../../core/types';
import { toImg, toScr, type Screen, type View } from './view';

/** Vertex grab radius and line pick distance. */
export const VERTEX_HIT_PX = 9;
/** POI pick radius. */
export const POI_HIT_PX = 12;

/** Distance from p to segment ab. */
export function segDist([px, py]: Screen, [ax, ay]: Screen, [bx, by]: Screen): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}

/** Even-odd point-in-polygon; `ring` is open (closing edge implied). */
export function inPoly([x, y]: Px, ring: readonly Px[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Topmost anchor pin under s: its round head (drawn 21 px above the tip) or its tip. */
export function hitAnchor(anchors: readonly Anchor[], v: View, [sx, sy]: Screen): AnchorId | null {
  for (let i = anchors.length - 1; i >= 0; i--) {
    const a = anchors[i]!;
    const [x, y] = toScr(v, a.px);
    if (Math.hypot(sx - x, sy - (y - 18)) < 13 || Math.hypot(sx - x, sy - y) < 7) return a.id;
  }
  return null;
}

/** Nearest trail/area vertex within VERTEX_HIT_PX, or -1 (POIs have none). */
export function hitVertex(f: Feature | undefined, v: View, s: Screen): number {
  if (!f || f.kind === 'poi') return -1;
  let best = -1;
  let bestD = VERTEX_HIT_PX;
  f.pts.forEach((p, i) => {
    const [x, y] = toScr(v, p);
    const d = Math.hypot(s[0] - x, s[1] - y);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  });
  return best;
}

/** Draggable handle of a selected feature: a vertex, or 0 for a POI within POI_HIT_PX. */
export function hitHandle(f: Feature | undefined, v: View, s: Screen): number {
  if (f?.kind !== 'poi') return hitVertex(f, v, s);
  const [x, y] = toScr(v, f.at);
  return Math.hypot(s[0] - x, s[1] - y) < POI_HIT_PX ? 0 : -1;
}

/**
 * Feature under s. Lines within VERTEX_HIT_PX and POIs within POI_HIT_PX compete by distance
 * (POIs get a 3 px bonus, as in the prototype); failing that, the first area containing s.
 */
export function hitFeature(features: readonly Feature[], v: View, s: Screen): Feature | null {
  let best: Feature | null = null;
  let bestD = VERTEX_HIT_PX;
  for (const f of features) {
    if (f.kind === 'poi') {
      const [x, y] = toScr(v, f.at);
      const d = Math.hypot(s[0] - x, s[1] - y);
      if (d < POI_HIT_PX && d < bestD + 3) {
        best = f;
        bestD = d - 3;
      }
      continue;
    }
    const pts = f.kind === 'area' ? [...f.pts, f.pts[0]!] : f.pts;
    let prev = toScr(v, pts[0]!);
    for (let i = 1; i < pts.length; i++) {
      const cur = toScr(v, pts[i]!);
      const d = segDist(s, prev, cur);
      if (d < bestD) {
        bestD = d;
        best = f;
      }
      prev = cur;
    }
  }
  if (best) return best;
  const img = toImg(v, s);
  for (const f of features) if (f.kind === 'area' && inPoly(img, f.pts)) return f;
  return null;
}

/** Nearest auto-trace candidate line within VERTEX_HIT_PX of s (prototype hitCand), or null. */
export function hitCandidate<C extends { readonly pts: readonly Px[] }>(
  candidates: readonly C[],
  v: View,
  s: Screen,
): C | null {
  let best: C | null = null;
  let bestD = VERTEX_HIT_PX;
  for (const c of candidates) {
    if (!c.pts.length) continue;
    let prev = toScr(v, c.pts[0]!);
    for (let i = 1; i < c.pts.length; i++) {
      const cur = toScr(v, c.pts[i]!);
      const d = segDist(s, prev, cur);
      if (d < bestD) {
        bestD = d;
        best = c;
      }
      prev = cur;
    }
  }
  return best;
}
