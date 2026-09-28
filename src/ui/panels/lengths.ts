// Lane B. Feature/candidate lengths in meters, cached by object identity and fit (card T-211,
// D-020 item 3). Features, candidates and fits are immutable, so a length stays valid for as
// long as both objects live, and an edit only recomputes the feature it replaced.
//
// A fit change invalidates every cached length at once (new WeakMap key), so a stress-sized list
// (2,000 features, or a large candidate review) would otherwise recompute every row synchronously
// on the next render. `fillFeatureLengths`/`fillCandidateLengths` run that recompute in time
// slices instead (T-216, D-025 item 3); callers read with `peek`/`cached*` and show a placeholder
// for a still-pending row.
//
// Features are sliced through Lane A's `featureLengthSteps` (src/core/geo/feature-length.ts,
// T-114): it yields every ~5,000 projected vertices, splitting inside one long path, and returns
// meters per feature id. Candidates aren't `Feature`s (no `kind` discriminant), so they have no
// equivalent generator; `candidateCache.fill` still uses its own per-item generator, which yields
// once per candidate (each candidate polyline is short -- auto-trace/manual review sizes, not the
// 2,000 x 50 stress case -- so per-item granularity is enough).
import { pathLength } from '../../core/geo/distance';
import { projectPath } from '../../core/geo/fit';
import { featureLengthSteps } from '../../core/geo/feature-length';
import type { Area, GeoFit, Px, Trail } from '../../core/types';
import { runSliced } from '../editor/slice';

interface Pathlike {
  readonly pts: readonly Px[];
}

class LengthCache<T extends Pathlike> {
  private byFit = new WeakMap<GeoFit, WeakMap<T, number>>();

  /** Cached length, or undefined if never computed (sync or filled) for this fit. */
  peek(fit: GeoFit, item: T): number | undefined {
    return this.byFit.get(fit)?.get(item);
  }

  set(fit: GeoFit, item: T, m: number): void {
    let byItem = this.byFit.get(fit);
    if (!byItem) this.byFit.set(fit, (byItem = new WeakMap()));
    byItem.set(item, m);
  }

  /** Compute and cache synchronously: for single lookups and small totals, not stress lists. */
  sync(fit: GeoFit, item: T, closed: boolean): number {
    const cached = this.peek(fit, item);
    if (cached !== undefined) return cached;
    const m = pathLength(projectPath(fit, item.pts), closed);
    this.set(fit, item, m);
    return m;
  }

  /**
   * Fill every not-yet-cached item in time slices (SLICE_MS budget per slice, see slice.ts), so
   * a stress-sized batch never blocks one task. Calls `onDone` once, after the last item is
   * cached, unless the returned abandon function was called first (the caller should call it
   * when `fit` or `items` changes, so a superseded fill's completion is silently ignored --
   * whatever it already cached is harmless: it's keyed by the old fit, and nothing reads that
   * key once the caller has moved on).
   */
  fill(
    fit: GeoFit,
    items: readonly T[],
    closed: (item: T) => boolean,
    onDone: () => void,
  ): () => void {
    let abandoned = false;
    void runSliced(this.steps(fit, items, closed)).then(() => {
      if (!abandoned) onDone();
    });
    return () => {
      abandoned = true;
    };
  }

  private *steps(
    fit: GeoFit,
    items: readonly T[],
    closed: (item: T) => boolean,
  ): Generator<unknown, void, undefined> {
    for (const item of items) {
      if (this.peek(fit, item) === undefined) {
        this.set(fit, item, pathLength(projectPath(fit, item.pts), closed(item)));
        yield;
      }
    }
  }
}

const featureCache = new LengthCache<Trail | Area>();
const candidateCache = new LengthCache<Pathlike>();

/** Length of a trail, or the closed perimeter of an area, in meters under `fit`. */
export function featureLengthM(fit: GeoFit, f: Trail | Area): number {
  return featureCache.sync(fit, f, f.kind === 'area');
}

/** Cached feature length, or undefined while a fill (or no computation) is pending. */
export function cachedFeatureLengthM(fit: GeoFit, f: Trail | Area): number | undefined {
  return featureCache.peek(fit, f);
}

/**
 * Background-fill feature lengths not yet cached for `fit`, through Lane A's `featureLengthSteps`
 * (T-114). Returns an abandon function (call when `fit` or `features` changes).
 */
export function fillFeatureLengths(
  fit: GeoFit,
  features: readonly (Trail | Area)[],
  onDone: () => void,
): () => void {
  let abandoned = false;
  const pending = features.filter((f) => featureCache.peek(fit, f) === undefined);
  if (pending.length === 0) {
    void Promise.resolve().then(() => {
      if (!abandoned) onDone();
    });
    return () => {
      abandoned = true;
    };
  }
  const byId = new Map(pending.map((f) => [f.id, f]));
  void runSliced(featureLengthSteps(fit, pending)).then((lengths) => {
    if (abandoned) return;
    for (const [id, m] of lengths) {
      const f = byId.get(id);
      if (f) featureCache.set(fit, f, m);
    }
    onDone();
  });
  return () => {
    abandoned = true;
  };
}

/** Length of an auto-trace candidate's polyline, in meters under `fit`. */
export function candidateLengthM(fit: GeoFit, c: Pathlike): number {
  return candidateCache.sync(fit, c, false);
}

/** Cached candidate length, or undefined while a fill (or no computation) is pending. */
export function cachedCandidateLengthM(fit: GeoFit, c: Pathlike): number | undefined {
  return candidateCache.peek(fit, c);
}

/** Background-fill candidate lengths not yet cached for `fit`. Returns an abandon function. */
export function fillCandidateLengths(
  fit: GeoFit,
  candidates: readonly Pathlike[],
  onDone: () => void,
): () => void {
  return candidateCache.fill(fit, candidates, () => false, onDone);
}
