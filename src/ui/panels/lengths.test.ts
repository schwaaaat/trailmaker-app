import { describe, expect, it } from 'vitest';
import { fitAnchors } from '../../core/geo/fit';
import { featureLengthSteps } from '../../core/geo/feature-length';
import type { Anchor, Area, GeoFit, Trail } from '../../core/types';
import {
  cachedCandidateLengthM,
  cachedFeatureLengthM,
  candidateLengthM,
  featureLengthM,
  fillCandidateLengths,
  fillFeatureLengths,
} from './lengths';

const W = 1200;
const H = 800;
const anchors: Anchor[] = [
  { id: '0', px: [100, 100], ll: [26.4, -80.1], source: 'paste' },
  { id: '1', px: [1000, 120], ll: [26.42, -80.0], source: 'paste' },
  { id: '2', px: [130, 680], ll: [26.3, -80.12], source: 'paste' },
];

function fitOrThrow(): GeoFit {
  const fit = fitAnchors(anchors, W, H, 'similarity');
  if (!fit.ok) throw new Error(`fit failed: ${fit.reason}`);
  return fit;
}

function trail(id: string): Trail {
  return {
    id,
    kind: 'trail',
    name: id,
    color: '#D9480F',
    notes: '',
    ink: null,
    pts: [
      [100, 100],
      [200, 150],
      [300, 200],
    ],
  };
}

function area(id: string): Area {
  return {
    id,
    kind: 'area',
    name: id,
    color: '#3A7D44',
    notes: '',
    pts: [
      [100, 100],
      [200, 100],
      [150, 200],
    ],
  };
}

describe('lengths cache', () => {
  it('featureLengthM computes and caches, cachedFeatureLengthM then hits', () => {
    const fit = fitOrThrow();
    const t = trail('a');
    expect(cachedFeatureLengthM(fit, t)).toBeUndefined();
    const m = featureLengthM(fit, t);
    expect(m).toBeGreaterThan(0);
    expect(cachedFeatureLengthM(fit, t)).toBe(m);
  });

  it('treats areas as closed (perimeter includes the closing edge)', () => {
    const fit = fitOrThrow();
    const a = area('b');
    const t = trail('c');
    // Same three points; an area's closed perimeter is longer than the open path.
    const areaLen = featureLengthM(fit, { ...a, pts: t.pts });
    const trailLen = featureLengthM(fit, t);
    expect(areaLen).toBeGreaterThan(trailLen);
  });

  it('fillFeatureLengths caches every item and calls onDone once complete', async () => {
    const fit = fitOrThrow();
    const items = [trail('f1'), trail('f2'), trail('f3')];
    let done = 0;
    fillFeatureLengths(fit, items, () => {
      done++;
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(done).toBe(1);
    for (const it of items) {
      expect(cachedFeatureLengthM(fit, it)).toBeCloseTo(featureLengthM(fit, it), 6);
    }
  });

  it('fillFeatureLengths skips items already cached synchronously', async () => {
    const fit = fitOrThrow();
    const already = trail('g1');
    const fresh = trail('g2');
    const precomputed = featureLengthM(fit, already);
    let done = 0;
    fillFeatureLengths(fit, [already, fresh], () => {
      done++;
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(done).toBe(1);
    expect(cachedFeatureLengthM(fit, already)).toBe(precomputed);
    expect(cachedFeatureLengthM(fit, fresh)).toBeGreaterThan(0);
  });

  it('abandoning a fill before it completes suppresses onDone', async () => {
    const fit = fitOrThrow();
    const items = [trail('h1'), trail('h2')];
    let done = 0;
    const abandon = fillFeatureLengths(fit, items, () => {
      done++;
    });
    abandon();
    await new Promise((r) => setTimeout(r, 50));
    expect(done).toBe(0);
  });

  it('a fit change means fresh caches: old fit lengths are unaffected', () => {
    const fit1 = fitOrThrow();
    const fit2 = fitOrThrow();
    const t = trail('i1');
    const m1 = featureLengthM(fit1, t);
    expect(cachedFeatureLengthM(fit2, t)).toBeUndefined();
    const m2 = featureLengthM(fit2, t);
    expect(m1).toBeCloseTo(m2, 6); // same anchors refit, same geometry
  });

  it('fillFeatureLengths agrees exactly with featureLengthSteps (T-114) for trails and areas', async () => {
    const fit = fitOrThrow();
    const items = [trail('k1'), area('k2')];
    const gen = featureLengthSteps(fit, items);
    let r = gen.next();
    while (!r.done) r = gen.next();
    const expected = r.value;
    let done = 0;
    fillFeatureLengths(fit, items, () => {
      done++;
    });
    await new Promise((r2) => setTimeout(r2, 50));
    expect(done).toBe(1);
    for (const item of items) {
      expect(cachedFeatureLengthM(fit, item)).toBe(expected.get(item.id));
    }
  });

  it('candidateLengthM and fillCandidateLengths cache by polyline identity', async () => {
    const fit = fitOrThrow();
    const c1 = { pts: trail('j1').pts };
    const c2 = { pts: trail('j2').pts };
    expect(cachedCandidateLengthM(fit, c1)).toBeUndefined();
    let done = 0;
    fillCandidateLengths(fit, [c1, c2], () => {
      done++;
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(done).toBe(1);
    expect(cachedCandidateLengthM(fit, c1)).toBeCloseTo(candidateLengthM(fit, c1), 6);
    expect(cachedCandidateLengthM(fit, c2)).toBeGreaterThan(0);
  });
});
