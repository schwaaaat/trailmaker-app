import { describe, expect, it } from 'vitest';
import type { Px } from '../types';
import {
  canCloseAsLoop,
  chooseOneWayStart,
  distinctVertexCount,
  isClosedLoop,
  loopWinding,
  polygonSignedArea,
  reverseLoop,
  reverseOneWay,
  rotateLoop,
  validateRouteInvariants,
} from './route';

describe('route geometry math (T-334)', () => {
  // Screen coords: x right, y downward.
  // Clockwise triangle: (0,0) -> (10,0) -> (10,10) -> (0,0)
  const cwTriangle: Px[] = [
    [0, 0],
    [10, 0],
    [10, 10],
    [0, 0],
  ];

  // Counterclockwise triangle: (0,0) -> (10,10) -> (10,0) -> (0,0)
  const ccwTriangle: Px[] = [
    [0, 0],
    [10, 10],
    [10, 0],
    [0, 0],
  ];

  // Collinear (zero area)
  const collinear: Px[] = [
    [0, 0],
    [5, 5],
    [10, 10],
    [0, 0],
  ];

  it('computes polygon signed area with y downward (positive clockwise, negative counterclockwise)', () => {
    expect(polygonSignedArea(cwTriangle)).toBe(50);
    expect(polygonSignedArea(ccwTriangle)).toBe(-50);
    expect(polygonSignedArea(collinear)).toBe(0);
  });

  it('detects loop winding correctly on map display coordinates', () => {
    expect(loopWinding(cwTriangle)).toBe('clockwise');
    expect(loopWinding(ccwTriangle)).toBe('counterclockwise');
    expect(loopWinding(collinear)).toBeNull();
  });

  it('counts distinct vertices', () => {
    expect(distinctVertexCount(cwTriangle)).toBe(3);
    expect(distinctVertexCount([[0, 0], [1, 1], [0, 0]])).toBe(2);
    expect(distinctVertexCount([[0, 0], [0, 0]])).toBe(1);
  });

  it('verifies closed loop requirement (>= 4 points, closed, >= 3 distinct)', () => {
    expect(isClosedLoop(cwTriangle)).toBe(true);
    expect(isClosedLoop([[0, 0], [10, 0], [10, 10]])).toBe(false); // open
    expect(isClosedLoop([[0, 0], [10, 0], [0, 0]])).toBe(false); // 2 distinct points
  });

  it('rotates a loop to a chosen vertex while preserving closure and direction', () => {
    // Square: (0,0) -> (10,0) -> (10,10) -> (0,10) -> (0,0)
    const square: Px[] = [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
      [0, 0],
    ];
    // Rotate to vertex 2: (10,10)
    const rotated = rotateLoop(square, 2);
    expect(rotated).toEqual([
      [10, 10],
      [0, 10],
      [0, 0],
      [10, 0],
      [10, 10],
    ]);
    expect(loopWinding(rotated)).toBe(loopWinding(square));
    expect(isClosedLoop(rotated)).toBe(true);

    // Rotating to index 0 or index 4 keeps same ring
    expect(rotateLoop(square, 0)).toEqual(square);
    expect(rotateLoop(square, 4)).toEqual(square);
  });

  it('reverses a loop while keeping its trailhead and flipping winding/direction', () => {
    // cwTriangle starts at [0, 0]
    const reversed = reverseLoop(cwTriangle);
    expect(reversed[0]).toEqual([0, 0]);
    expect(reversed[reversed.length - 1]).toEqual([0, 0]);
    expect(reversed).toEqual([
      [0, 0],
      [10, 10],
      [10, 0],
      [0, 0],
    ]);
    expect(loopWinding(cwTriangle)).toBe('clockwise');
    expect(loopWinding(reversed)).toBe('counterclockwise');
  });

  it('reverses a one-way trail swapping start and end', () => {
    const trail: Px[] = [
      [0, 0],
      [5, 5],
      [10, 10],
    ];
    expect(reverseOneWay(trail)).toEqual([
      [10, 10],
      [5, 5],
      [0, 0],
    ]);
  });

  it('chooses one-way start by endpoint side', () => {
    const trail: Px[] = [
      [0, 0],
      [5, 5],
      [10, 10],
    ];
    expect(chooseOneWayStart(trail, 0)).toEqual(trail);
    expect(chooseOneWayStart(trail, 1)).toEqual([
      [10, 10],
      [5, 5],
      [0, 0],
    ]);
  });

  it('validates closing open trails as a loop with snap tolerance', () => {
    // Trail with ends already touching
    const closedResult = canCloseAsLoop(cwTriangle, 10);
    expect(closedResult.ok).toBe(true);
    if (closedResult.ok) {
      expect(closedResult.direction).toBe('clockwise');
    }

    // Trail with endpoints 3px apart (within 10px tolerance)
    const nearTrail: Px[] = [
      [0, 0],
      [10, 0],
      [10, 10],
      [3, 0],
    ];
    const nearResult = canCloseAsLoop(nearTrail, 10);
    expect(nearResult.ok).toBe(true);
    if (nearResult.ok) {
      expect(nearResult.pts[nearResult.pts.length - 1]).toEqual([0, 0]);
      expect(nearResult.direction).toBe('clockwise');
    }

    // Trail with endpoints far apart (40px apart > 10px tolerance)
    const farTrail: Px[] = [
      [0, 0],
      [10, 0],
      [10, 10],
      [40, 0],
    ];
    const farResult = canCloseAsLoop(farTrail, 10);
    expect(farResult.ok).toBe(false);
    if (!farResult.ok) {
      expect(farResult.error).toContain('too far apart');
    }

    // Collinear trail
    const colResult = canCloseAsLoop(collinear, 10);
    expect(colResult.ok).toBe(false);
    if (!colResult.ok) {
      expect(colResult.error).toContain('zero area');
    }
  });

  it('validates route invariants for one-way and loop', () => {
    // Unclassified
    expect(validateRouteInvariants(cwTriangle, undefined).valid).toBe(true);

    // One-way on open trail: valid
    const openTrail: Px[] = [
      [0, 0],
      [10, 10],
    ];
    expect(validateRouteInvariants(openTrail, { kind: 'one-way' }).valid).toBe(true);

    // One-way on closed trail: invalid
    expect(validateRouteInvariants(cwTriangle, { kind: 'one-way' }).valid).toBe(false);

    // One-way degenerate (< 2 points): invalid
    expect(validateRouteInvariants([[0, 0]], { kind: 'one-way' }).valid).toBe(false);

    // Loop with matching winding: valid
    expect(validateRouteInvariants(cwTriangle, { kind: 'loop', direction: 'clockwise' }).valid).toBe(true);

    // Loop with opposite winding: invalid
    expect(validateRouteInvariants(cwTriangle, { kind: 'loop', direction: 'counterclockwise' }).valid).toBe(false);

    // Loop on open trail: invalid
    expect(validateRouteInvariants(openTrail, { kind: 'loop', direction: 'clockwise' }).valid).toBe(false);
  });
});
