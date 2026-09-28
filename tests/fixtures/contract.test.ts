import { expect, test } from 'vitest';
import { HISTORY_LIMIT, MAX_WORKING_SIDE, POI_TYPES, PROJECT_VERSION } from '../../src/core/types';

test('the pure contract is importable in Node', () => {
  expect(POI_TYPES).toContain('Trailhead');
  expect(PROJECT_VERSION).toBe(2);
  expect(HISTORY_LIMIT).toBe(120);
  expect(MAX_WORKING_SIDE).toBe(7000);
});
