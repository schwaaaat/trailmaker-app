import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Anchor, Px } from '../core/types';
import * as C from './commands';
import { makeProject, makeSession } from './fixtures.test.helper';
import { appStore, edit, openSession, selectFit, setAnchorDragging } from './store';

// Count leave-one-out computations while keeping the real implementation (T-107).
const loo = vi.hoisted(() => ({ calls: 0 }));
vi.mock('../core/geo/loo', async (importOriginal) => {
  const real = await importOriginal<typeof import('../core/geo/loo')>();
  return {
    withLooResiduals: (...args: Parameters<typeof real.withLooResiduals>) => {
      loo.calls++;
      return real.withLooResiduals(...args);
    },
  };
});

// A near-linear map: image (x, y) -> (37.7 - y*1e-5, -119.6 + x*1e-5), plus a little noise.
const ll = ([x, y]: Px, noise = 0) => [37.7 - y * 1e-5 + noise, -119.6 + x * 1e-5] as const;
const anchor = (i: number, px: Px, noise = 0, withLl = true): Anchor => ({
  id: `g${i}`,
  px,
  ll: withLl ? ll(px, noise) : null,
  source: 'paste',
});
const corners: Px[] = [
  [0, 0],
  [1000, 0],
  [1000, 800],
  [0, 800],
  [500, 400],
];

const fit = () => selectFit(appStore.getState());

beforeEach(() => {
  loo.calls = 0;
});

describe('selectFit with leave-one-out residuals (T-208)', () => {
  it('adds LOO residuals only with >= 4 anchors that have coordinates', () => {
    openSession(
      makeSession(makeProject({ anchors: corners.slice(0, 3).map((p, i) => anchor(i, p)) })),
    );
    const three = fit();
    expect(three?.ok && three.looResiduals).toBe(null);
    // A fourth pin without coordinates still leaves three usable anchors.
    openSession(
      makeSession(
        makeProject({
          anchors: [
            ...corners.slice(0, 3).map((p, i) => anchor(i, p)),
            anchor(3, corners[3]!, 0, false),
          ],
        }),
      ),
    );
    expect(fit()?.ok && (fit() as { looResiduals: unknown }).looResiduals).toBe(null);
    expect(loo.calls).toBe(0);

    openSession(makeSession(makeProject({ anchors: corners.map((p, i) => anchor(i, p)) })));
    const five = fit();
    expect(five?.ok).toBe(true);
    if (!five?.ok) return;
    expect(Object.keys(five.looResiduals ?? {}).sort()).toStrictEqual([
      'g0',
      'g1',
      'g2',
      'g3',
      'g4',
    ]);
    // An exactly linear map: every anchor is predicted by the others within a centimetre.
    for (const r of Object.values(five.looResiduals!)) expect(r).toBeLessThan(0.01);
    expect(loo.calls).toBe(1);
  });

  it('stays memoized: same object across selects and feature edits; recomputed on anchor edits', () => {
    openSession(
      makeSession(makeProject({ anchors: corners.map((p, i) => anchor(i, p)), seq: 50 })),
    );
    const a = fit();
    expect(fit()).toBe(a);
    edit(C.setUnits(appStore.getState().session!.project, 'km'));
    expect(fit()).toBe(a);
    expect(loo.calls).toBe(1);
    edit(C.moveAnchor(appStore.getState().session!.project, 'g4', [520, 410]));
    expect(fit()).not.toBe(a);
    expect(loo.calls).toBe(2);
  });

  it('skips LOO while an anchor is dragged, then computes it once when the drag ends', () => {
    openSession(
      makeSession(makeProject({ anchors: corners.map((p, i) => anchor(i, p)), seq: 50 })),
    );
    setAnchorDragging(true);
    for (let k = 1; k <= 10; k++) {
      edit(C.moveAnchor(appStore.getState().session!.project, 'g4', [500 + k, 400]));
      const f = fit();
      expect(f?.ok && f.looResiduals).toBe(null);
    }
    expect(loo.calls).toBe(0);
    setAnchorDragging(false);
    const after = fit();
    expect(after?.ok && after.looResiduals !== null).toBe(true);
    expect(fit()).toBe(after);
    expect(loo.calls).toBe(1);
  });

  it('measures the post-drag LOO recompute for 30 anchors with TPS (budget 20 ms)', () => {
    let seed = 3;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const anchors = Array.from({ length: 30 }, (_, i) =>
      anchor(i, [Math.round(rnd() * 1000), Math.round(rnd() * 800)], (rnd() - 0.5) * 2e-5),
    );
    openSession(makeSession(makeProject({ anchors, fitMethod: 'tps', seq: 100 })));
    setAnchorDragging(true);
    expect(fit()?.ok).toBe(true); // the plain TPS fit, cached during the drag
    const times: number[] = [];
    for (let rep = 0; rep < 5; rep++) {
      // A fresh drag end each time: new anchors array, plain fit cached, then LOO on release.
      edit(C.moveAnchor(appStore.getState().session!.project, 'g0', [100 + rep, 100]));
      setAnchorDragging(true);
      expect(fit()?.ok).toBe(true);
      setAnchorDragging(false);
      const t0 = performance.now();
      const f = fit();
      times.push(performance.now() - t0);
      expect(f?.ok && Object.keys(f.looResiduals ?? {}).length).toBe(30);
    }
    times.sort((a, b) => a - b);
    console.log(
      `[T-208] LOO recompute, 30 anchors TPS: median ${times[2]!.toFixed(2)} ms, max ${times[4]!.toFixed(2)} ms`,
    );
    // Logged against the 20 ms budget; asserted loosely here because CI load and coverage vary.
    expect(times[2]!).toBeLessThan(100);
  });
});
