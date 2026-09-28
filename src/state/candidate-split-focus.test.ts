import { describe, expect, it } from 'vitest';
import {
  candidateSplitAnnouncement,
  initialCandidateSplitPoint,
  stepCandidateSplitPoint,
} from './candidate-split-focus';

describe('candidate split keyboard focus', () => {
  it('starts on an interior vertex and rejects lines too short to split', () => {
    expect(initialCandidateSplitPoint(52)).toBe(25);
    expect(initialCandidateSplitPoint(3)).toBe(1);
    expect(initialCandidateSplitPoint(2)).toBeNull();
    expect(initialCandidateSplitPoint(2.5)).toBeNull();
  });

  it('steps by one or ten vertices and clamps to valid split points', () => {
    expect(stepCandidateSplitPoint(25, 52, 1)).toBe(26);
    expect(stepCandidateSplitPoint(25, 52, -1, 10)).toBe(15);
    expect(stepCandidateSplitPoint(1, 52, -1)).toBe(1);
    expect(stepCandidateSplitPoint(50, 52, 1, 10)).toBe(50);
    expect(stepCandidateSplitPoint(0, 2, 1)).toBeNull();
  });

  it('announces one-based point numbers', () => {
    expect(candidateSplitAnnouncement(13, 52)).toBe('Split point 14 of 52');
  });
});
