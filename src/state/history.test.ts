import { describe, expect, it } from 'vitest';
import { HISTORY_LIMIT, type Feature, type HistoryCommand } from '../core/types';
import * as C from './commands';
import { makeProject } from './fixtures.test.helper';
import { History } from './history';

const withTrail = () =>
  makeProject({
    features: [
      {
        kind: 'trail',
        id: 'f1',
        name: '',
        color: '#D9480F',
        notes: '',
        pts: [
          [0, 0],
          [1, 1],
        ],
        ink: null,
      } satisfies Feature,
    ],
  });

function type(h: History, p: ReturnType<typeof makeProject>, text: string) {
  for (const ch of text) {
    const name = p.features[0]!.name + ch;
    p = h.execute(p, C.updateFeature(p, 'f1', { name }));
  }
  return p;
}

describe('History', () => {
  it('coalesces typing into one undo step with the command label', () => {
    const h = new History();
    const start = withTrail();
    const p = type(h, start, 'Ridge');
    expect(p.features[0]!.name).toBe('Ridge');
    expect(h.depth).toBe(1);
    expect(h.undoLabel).toBe('Edit feature');
    const back = h.undo(p)!;
    expect(back).toStrictEqual(start);
    expect(h.canUndo).toBe(false);
    expect(h.redoLabel).toBe('Edit feature');
    expect(h.redo(back)).toStrictEqual(p);
  });

  it('breaks the coalescing run on seal, undo, a different key and a null key', () => {
    const h = new History();
    let p = type(h, withTrail(), 'ab');
    h.seal();
    p = type(h, p, 'cd');
    expect(h.depth).toBe(2);

    p = h.execute(p, C.updateFeature(p, 'f1', { color: '#000000' }));
    p = type(h, p, 'e');
    expect(h.depth).toBe(4);

    p = h.execute(p, C.setUnits(p, 'km'));
    p = type(h, p, 'f');
    expect(h.depth).toBe(6);

    p = h.undo(p)!;
    p = h.redo(p)!;
    p = type(h, p, 'g');
    expect(h.depth).toBe(7);
    expect(p.features[0]!.name).toBe('abcdefg');
  });

  it('clears redo on a new command', () => {
    const h = new History();
    let p = withTrail();
    p = h.execute(p, C.setUnits(p, 'km'));
    p = h.undo(p)!;
    expect(h.canRedo).toBe(true);
    p = h.execute(p, C.setFitMethod(p, 'affine'));
    expect(h.canRedo).toBe(false);
    expect(h.redo(p)).toBeNull();
  });

  it(`keeps at most HISTORY_LIMIT (${HISTORY_LIMIT}) steps, dropping the oldest`, () => {
    const h = new History();
    const extra = 7;
    let p = makeProject();
    const states = [p];
    for (let i = 0; i < HISTORY_LIMIT + extra; i++) {
      p = h.execute(p, C.addAnchor(p, [i, i]).command);
      states.push(p);
    }
    expect(h.depth).toBe(HISTORY_LIMIT);
    let undone = 0;
    while (h.canUndo) {
      p = h.undo(p)!;
      undone++;
    }
    expect(undone).toBe(HISTORY_LIMIT);
    expect(p).toStrictEqual(states[extra]);
    expect(p.anchors).toHaveLength(extra);
    expect(h.undo(p)).toBeNull();
  });

  it('counts a coalesced run as one step toward the limit', () => {
    const h = new History(3);
    const start = withTrail();
    let p = h.execute(start, C.setUnits(start, 'km'));
    p = type(h, p, 'many letters');
    p = h.execute(p, C.setUnits(p, 'mi'));
    expect(h.depth).toBe(3);
    // Nothing was dropped: three undos reach the very start.
    for (let i = 0; i < 3; i++) p = h.undo(p)!;
    expect(p).toStrictEqual(start);
  });

  it('undoes and redoes a very long same-key run exactly, without recursion (review T-201)', () => {
    const h = new History();
    const start = withTrail();
    let p = start;
    for (let i = 1; i <= 12_000; i++) {
      p = h.execute(p, C.setTraceSettings(p, { tolerance: i % 400 }));
    }
    const end = p;
    expect(h.depth).toBe(1);
    const undone = h.undo(p)!;
    expect(undone).toStrictEqual(start);
    expect([h.canUndo, h.canRedo]).toStrictEqual([false, true]);
    expect(h.redo(undone)).toStrictEqual(end);
  });

  it('leaves both stacks untouched when apply or revert throws', () => {
    const boom: HistoryCommand = {
      label: 'Boom',
      coalesceKey: null,
      apply: (p) => p,
      revert: () => {
        throw new Error('revert failed');
      },
    };
    const h = new History();
    let p = withTrail();
    p = h.execute(p, C.setUnits(p, 'km'));
    p = h.execute(p, boom);
    expect(() => h.undo(p)).toThrow('revert failed');
    expect([h.depth, h.canRedo, h.undoLabel]).toStrictEqual([2, false, 'Boom']);

    // Redo whose apply throws: stays on the redo stack.
    let applies = 0;
    const flaky: HistoryCommand = {
      label: 'Flaky',
      coalesceKey: null,
      apply: (q) => {
        if (applies++ > 0) throw new Error('apply failed');
        return q;
      },
      revert: (q) => q,
    };
    const h2 = new History();
    const q = h2.undo(h2.execute(withTrail(), flaky))!;
    expect(() => h2.redo(q)).toThrow('apply failed');
    expect([h2.canUndo, h2.canRedo, h2.redoLabel]).toStrictEqual([false, true, 'Flaky']);

    // Execute whose apply throws: nothing recorded, redo kept.
    const h3 = new History();
    let r = withTrail();
    r = h3.undo(h3.execute(r, C.setUnits(r, 'km')))!;
    const bad: HistoryCommand = {
      ...boom,
      apply: () => {
        throw new Error('nope');
      },
    };
    expect(() => h3.execute(r, bad)).toThrow('nope');
    expect([h3.canUndo, h3.canRedo]).toStrictEqual([false, true]);
  });

  it('forgets everything on clear', () => {
    const h = new History();
    const p = withTrail();
    h.undo(h.execute(p, C.setUnits(p, 'km')));
    h.clear();
    expect([h.canUndo, h.canRedo, h.undoLabel, h.redoLabel]).toStrictEqual([
      false,
      false,
      null,
      null,
    ]);
  });
});
