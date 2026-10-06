import { describe, expect, it } from 'vitest';
import { createRollingExportBudget } from './max-detail-budget';

describe('maximum-detail hourly export budget', () => {
  it('enforces a rolling window and reports remaining requests', () => {
    const budget = createRollingExportBudget({ limit: 2, windowMs: 60_000 });
    expect(budget.remaining(0)).toBe(2);
    expect(budget.tryStart(0)).toBe(true);
    expect(budget.tryStart(30_000)).toBe(true);
    expect(budget.remaining(59_999)).toBe(0);
    expect(budget.tryStart(59_999)).toBe(false);
    expect(budget.remaining(60_000)).toBe(1);
    expect(budget.tryStart(60_000)).toBe(true);
  });

  it('drops future, invalid, and expired stored timestamps', () => {
    const budget = createRollingExportBudget({
      limit: 3,
      windowMs: 60_000,
      starts: [-60_001, 10, Number.NaN, 20],
    });
    expect(budget.remaining(30)).toBe(1);
    expect(budget.timestamps(30)).toEqual([10, 20]);
  });
});
