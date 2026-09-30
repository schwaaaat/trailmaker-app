import { describe, expect, it } from 'vitest';
import type { Feature } from '../core/types';
import { clampVertexFocus, moveVertexFocus, stepCount, stepVertexFocus } from './vertex-focus';

const trail: Feature = {
  kind: 'trail',
  id: 't1',
  name: 'Trail',
  color: '#D9480F',
  notes: '',
  pts: [
    [0, 0],
    [10, 0],
    [20, 0],
  ],
  ink: null,
};
const otherTrail: Feature = { ...trail, id: 't2' };
const poi: Feature = {
  kind: 'poi',
  id: 'p1',
  name: 'Point',
  color: '#1F6FB2',
  notes: '',
  at: [5, 5],
  poiType: 'Waypoint',
};

describe('stepCount', () => {
  it('is the vertex count for a trail/area', () => {
    expect(stepCount(trail)).toBe(3);
  });
  it('is zero for a point of interest (nothing to step into)', () => {
    expect(stepCount(poi)).toBe(0);
  });
  it('is zero with no feature', () => {
    expect(stepCount(undefined)).toBe(0);
  });
});

describe('stepVertexFocus', () => {
  it('Tab with no focus lands on the first vertex', () => {
    expect(stepVertexFocus(null, trail, 1)).toEqual({ featureId: 't1', index: 0 });
  });
  it('Shift+Tab with no focus lands on the last vertex', () => {
    expect(stepVertexFocus(null, trail, -1)).toEqual({ featureId: 't1', index: 2 });
  });
  it('steps forward within range', () => {
    const focus = { featureId: 't1', index: 0 };
    expect(stepVertexFocus(focus, trail, 1)).toEqual({ featureId: 't1', index: 1 });
  });
  it('steps backward within range', () => {
    const focus = { featureId: 't1', index: 2 };
    expect(stepVertexFocus(focus, trail, -1)).toEqual({ featureId: 't1', index: 1 });
  });
  it('releases focus past the last vertex (Tab moves on to the next focusable element)', () => {
    const focus = { featureId: 't1', index: 2 };
    expect(stepVertexFocus(focus, trail, 1)).toBeNull();
  });
  it('releases focus before the first vertex (Shift+Tab moves back off the canvas)', () => {
    const focus = { featureId: 't1', index: 0 };
    expect(stepVertexFocus(focus, trail, -1)).toBeNull();
  });
  it('starts fresh on the given feature when focus belongs to a different one', () => {
    const focus = { featureId: 't2', index: 1 };
    expect(stepVertexFocus(focus, trail, 1)).toEqual({ featureId: 't1', index: 0 });
  });
  it('is null for a point of interest (no vertices to step through)', () => {
    expect(stepVertexFocus(null, poi, 1)).toBeNull();
  });
  it('is null with no feature selected', () => {
    expect(stepVertexFocus(null, undefined, 1)).toBeNull();
  });
});

describe('moveVertexFocus (T-223)', () => {
  it('moves one or ten points in either direction and clamps at endpoints', () => {
    expect(moveVertexFocus(null, trail, 1)).toEqual({ featureId: 't1', index: 0 });
    expect(moveVertexFocus({ featureId: 't1', index: 0 }, trail, 1, 10)).toEqual({
      featureId: 't1',
      index: 2,
    });
    expect(moveVertexFocus({ featureId: 't1', index: 2 }, trail, -1, 10)).toEqual({
      featureId: 't1',
      index: 0,
    });
    expect(moveVertexFocus(null, poi, 1)).toBeNull();
  });
});

describe('clampVertexFocus', () => {
  it('passes through a focus that still points at a real vertex', () => {
    const focus = { featureId: 't1', index: 1 };
    expect(clampVertexFocus(focus, [trail, otherTrail])).toEqual(focus);
  });
  it('is null once the feature is gone (deleted, or undo removed it)', () => {
    expect(clampVertexFocus({ featureId: 't1', index: 1 }, [otherTrail])).toBeNull();
  });
  it('is null once the index no longer exists (a vertex before it was deleted)', () => {
    expect(clampVertexFocus({ featureId: 't1', index: 5 }, [trail])).toBeNull();
  });
  it('is null once the feature became (or always was) a point of interest', () => {
    expect(clampVertexFocus({ featureId: 'p1', index: 0 }, [poi])).toBeNull();
  });
  it('passes null through', () => {
    expect(clampVertexFocus(null, [trail])).toBeNull();
  });
});
