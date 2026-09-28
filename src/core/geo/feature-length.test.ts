import { describe, expect, it } from 'vitest';
import type { Anchor, Area, GeoFit, Trail } from '../types';
import { featureLengthSteps } from './feature-length';
import { pathLength } from './distance';
import { fitAnchors, projectPath } from './fit';

const anchors: Anchor[] = [
  { id: 'a', px: [0, 0], ll: [38, -78], source: 'paste' },
  { id: 'b', px: [1000, 0], ll: [38, -77.98], source: 'paste' },
  { id: 'c', px: [0, 1000], ll: [37.99, -78], source: 'paste' },
  { id: 'd', px: [1000, 1000], ll: [37.99, -77.98], source: 'paste' },
];

function fitOrThrow(): GeoFit {
  const fit = fitAnchors(anchors, 1000, 1000, 'tps');
  if (!fit.ok) throw new Error(`Fit failed: ${fit.reason}`);
  return fit;
}

function drain<T>(steps: Generator<void, T, undefined>): { result: T; yields: number } {
  let yields = 0;
  let next = steps.next();
  while (!next.done) {
    yields++;
    next = steps.next();
  }
  return { result: next.value, yields };
}

describe('featureLengthSteps', () => {
  it('matches projected pathLength for trails and closed areas', () => {
    const trail: Trail = {
      id: 'trail', name: 'Trail', color: '#D9480F', notes: '', kind: 'trail', ink: null,
      pts: [[0, 0], [100, 40], [500, 700], [1000, 1000]],
    };
    const area: Area = {
      id: 'area', name: 'Area', color: '#3A7D44', notes: '', kind: 'area',
      pts: [[200, 200], [700, 200], [650, 700], [300, 800]],
    };
    const currentFit = fitOrThrow();
    const lengths = drain(featureLengthSteps(currentFit, [trail, area])).result;
    expect(lengths.get(trail.id)).toBe(pathLength(projectPath(currentFit, trail.pts)));
    expect(lengths.get(area.id)).toBe(pathLength(projectPath(currentFit, area.pts), true));
  });

  it('yields inside a long feature at roughly 5,000 projected vertices', () => {
    const trail: Trail = {
      id: 'long', name: 'Long', color: '#D9480F', notes: '', kind: 'trail', ink: null,
      pts: Array.from({ length: 12_001 }, (_, i) => [i % 1000, Math.floor(i / 1000)] as const),
    };
    const { result, yields } = drain(featureLengthSteps(fitOrThrow(), [trail]));
    expect(yields).toBe(3);
    expect(result.has(trail.id)).toBe(true);
  });
});
