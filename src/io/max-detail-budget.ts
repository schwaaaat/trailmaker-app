export interface RollingExportBudgetOptions {
  readonly limit?: number;
  readonly windowMs?: number;
  readonly starts?: readonly number[];
}

export interface RollingExportBudget {
  tryStart(now: number): boolean;
  remaining(now: number): number;
  timestamps(now: number): readonly number[];
}

/** In-memory rolling request budget; callers persist timestamps when a start is reserved. */
export function createRollingExportBudget(
  options: RollingExportBudgetOptions = {},
): RollingExportBudget {
  const limit = Math.max(1, Math.floor(options.limit ?? 60));
  const windowMs = options.windowMs ?? 60 * 60 * 1000;
  if (!Number.isFinite(windowMs) || windowMs <= 0) {
    throw new Error('The export budget window must be a positive duration.');
  }
  const starts = (options.starts ?? []).filter(Number.isFinite).sort((a, b) => a - b);

  const prune = (now: number) => {
    while (starts.length && (!Number.isFinite(starts[0]) || now - starts[0]! >= windowMs)) {
      starts.shift();
    }
    while (starts.length && starts[starts.length - 1]! > now) starts.pop();
  };

  return {
    tryStart(now) {
      if (!Number.isFinite(now)) return false;
      prune(now);
      if (starts.length >= limit) return false;
      starts.push(now);
      return true;
    },
    remaining(now) {
      if (!Number.isFinite(now)) return 0;
      prune(now);
      return Math.max(0, limit - starts.length);
    },
    timestamps(now) {
      if (Number.isFinite(now)) prune(now);
      return [...starts];
    },
  };
}
