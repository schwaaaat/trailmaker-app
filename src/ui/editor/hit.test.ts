import { describe, expect, it } from 'vitest';
import type { Anchor, Feature } from '../../core/types';
import { hitAnchor, hitFeature, hitHandle, hitVertex, inPoly, segDist } from './hit';
import type { View } from './view';

// 2x zoom, offset: image (x, y) -> screen (2x + 10, 2y + 20).
const V: View = { s: 2, x: 10, y: 20 };

const trail: Feature = {
  kind: 'trail',
  id: 't',
  name: 'T',
  color: '#D9480F',
  notes: '',
  pts: [
    [0, 0],
    [100, 0],
    [100, 100],
  ],
  ink: null,
};
const area: Feature = {
  kind: 'area',
  id: 'a',
  name: 'A',
  color: '#3A7D44',
  notes: '',
  pts: [
    [200, 200],
    [300, 200],
    [300, 300],
    [200, 300],
  ],
};
const poi: Feature = {
  kind: 'poi',
  id: 'p',
  name: 'P',
  color: '#1F6FB2',
  notes: '',
  at: [50, 50],
  poiType: 'Water',
};

describe('geometry helpers', () => {
  it('segDist measures to the segment, clamping at the ends', () => {
    expect(segDist([5, 3], [0, 0], [10, 0])).toBe(3);
    expect(segDist([-4, 3], [0, 0], [10, 0])).toBe(5);
    expect(segDist([13, 4], [0, 0], [10, 0])).toBe(5);
    expect(segDist([3, 4], [0, 0], [0, 0])).toBe(5);
  });

  it('inPoly handles convex, concave and outside points', () => {
    const l = [
      [0, 0],
      [10, 0],
      [10, 4],
      [4, 4],
      [4, 10],
      [0, 10],
    ] as const;
    expect(inPoly([2, 2], l)).toBe(true);
    expect(inPoly([8, 8], l)).toBe(false);
    expect(inPoly([2, 8], l)).toBe(true);
    expect(inPoly([-1, 2], l)).toBe(false);
  });
});

describe('hitVertex / hitHandle', () => {
  it('finds the nearest vertex within 9 screen px, at any zoom', () => {
    // Vertex [100, 0] is at screen (210, 20).
    expect(hitVertex(trail, V, [216, 25])).toBe(1); // ~7.8 px
    expect(hitVertex(trail, V, [219, 20])).toBe(-1); // 9 px: not strictly within
    const far: View = { s: 0.1, x: 0, y: 0 };
    // At 0.1x, vertices 0 and 1 are 10 px apart on screen: pick the nearer.
    expect(hitVertex(trail, far, [7, 0])).toBe(1);
    expect(hitVertex(poi, V, [110, 120])).toBe(-1);
    expect(hitVertex(undefined, V, [0, 0])).toBe(-1);
  });

  it('treats a POI as one handle within 12 px', () => {
    // POI [50, 50] -> screen (110, 120).
    expect(hitHandle(poi, V, [118, 126])).toBe(0); // 10 px
    expect(hitHandle(poi, V, [122, 120])).toBe(-1); // 12 px
    expect(hitHandle(trail, V, [10, 20])).toBe(0);
  });
});

describe('hitFeature', () => {
  const all = [trail, area, poi];

  it('picks lines within 9 px of any segment', () => {
    // Segment [0,0]-[100,0] runs along screen y = 20.
    expect(hitFeature(all, V, [100, 28])?.id).toBe('t');
    expect(hitFeature(all, V, [100, 30])).toBeNull();
    // Area edges count, including the implied closing edge (x = 200 -> screen 410).
    expect(hitFeature(all, V, [404, 500])?.id).toBe('a');
  });

  it('picks a POI within 12 px, preferring it over a nearby line (3 px bonus)', () => {
    expect(hitFeature(all, V, [110, 131])?.id).toBe('p'); // 11 px from the POI
    const onLine: Feature = { ...poi, id: 'p2', at: [50, 4] }; // screen (110, 28), 8 px below the line
    // Cursor 4 px from the line and 4 px from the POI: POI wins with its bonus.
    expect(hitFeature([trail, onLine], V, [110, 24])?.id).toBe('p2');
  });

  it('falls back to point-in-polygon for areas', () => {
    // Area interior: image (250, 250) -> screen (510, 520).
    expect(hitFeature(all, V, [510, 520])?.id).toBe('a');
    expect(hitFeature(all, V, [900, 900])).toBeNull();
  });
});

describe('hitAnchor', () => {
  const anchors: Anchor[] = [
    { id: 'g1', px: [10, 10], ll: null, source: 'paste' },
    { id: 'g2', px: [12, 10], ll: [1, 2], source: 'paste' },
  ];

  it('hits the pin head above the tip and the tip itself, topmost (last) first', () => {
    // g2 tip -> screen (34, 40); head centre used for hits at (34, 22).
    expect(hitAnchor(anchors, V, [34, 22])).toBe('g2');
    expect(hitAnchor(anchors, V, [34, 40])).toBe('g2');
    // g1 alone: tip at (30, 40); 5 px left of it is 9 px from g2's tip.
    expect(hitAnchor(anchors, V, [25, 40])).toBe('g1');
    expect(hitAnchor(anchors, V, [34, 70])).toBeNull();
  });
});
