import { expect, test } from 'vitest';
import { measure, passesQuality } from './run';

test('only the exact seeded function stub counts as pending', () => {
  expect(
    measure(() => {
      throw new Error('not implemented: trace/astar.tracePath');
    }, 'trace/astar.tracePath'),
  ).toBeNull();
  expect(() =>
    measure(() => {
      throw new Error('not implemented: nested dependency');
    }, 'trace/astar.tracePath'),
  ).toThrow();
  expect(() =>
    measure(() => {
      throw new Error('unexpected crash');
    }, 'trace/astar.tracePath'),
  ).toThrow();
  expect(measure(() => [], 'stub')?.value).toEqual([]);
});
test('live targets enforce inclusive quality limits and reject NaN', () => {
  expect(passesQuality(0.95, 0.9)).toBe(true);
  expect(passesQuality(0.949, 1)).toBe(false);
  expect(passesQuality(1, 0.899)).toBe(false);
  expect(passesQuality(NaN, 1)).toBe(false);
});
