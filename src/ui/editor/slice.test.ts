import { describe, expect, it } from 'vitest';
import { JOB_CANCELLED } from '../../core/types';
import { SLICE_MS, Slicer, postTask, runSliced } from './slice';
import { manualTasks } from './slice.test.helper';

describe('Slicer', () => {
  it('runs a step in slices of the budget, each in its own task, then calls onDone', () => {
    const tasks = manualTasks();
    const slicer = new Slicer(tasks.post, tasks.now);
    let units = 0;
    let done = 0;
    // 40 units of 1 ms each: 8 per slice, 5 slices.
    slicer.run(
      (timeUp) => {
        while (units < 40) {
          if (timeUp()) return false;
          units++;
          tasks.advance(1);
        }
        return true;
      },
      () => done++,
    );
    expect(units).toBe(0);
    expect(slicer.busy).toBe(true);
    tasks.runOne();
    expect(units).toBe(SLICE_MS);
    expect(done).toBe(0);
    expect(tasks.runAll()).toBe(4);
    expect(units).toBe(40);
    expect(done).toBe(1);
    expect(slicer.busy).toBe(false);
    expect(slicer.stats.slices).toBe(5);
    expect(slicer.stats.maxSliceMs).toBe(SLICE_MS);
  });

  it('cancel drops the queued slice; run replaces the job in progress', () => {
    const tasks = manualTasks();
    const slicer = new Slicer(tasks.post, tasks.now);
    const ran: string[] = [];
    const job = (name: string) => () => {
      ran.push(name);
      return true;
    };
    slicer.run(job('a'), () => ran.push('a done'));
    slicer.cancel();
    expect(slicer.busy).toBe(false);
    expect(tasks.runAll()).toBe(0);
    slicer.run(job('b'), () => ran.push('b done'));
    slicer.run(job('c'), () => ran.push('c done'));
    tasks.runAll();
    expect(ran).toStrictEqual(['c', 'c done']);
  });
});

describe('postTask', () => {
  it('runs the function in a later task, and not at all once unqueued', async () => {
    const ran: string[] = [];
    postTask(() => ran.push('a'));
    const off = postTask(() => ran.push('b'));
    off();
    expect(ran).toStrictEqual([]);
    await new Promise((r) => setTimeout(r, 20));
    expect(ran).toStrictEqual(['a']);
  });
});

describe('runSliced', () => {
  function* units(n: number, tick: () => void): Generator<void, string, undefined> {
    for (let i = 0; i < n; i++) {
      tick();
      yield;
    }
    return 'done';
  }

  it('runs steps in budget-sized slices, one task each, and resolves with the result', async () => {
    const tasks = manualTasks();
    const p = runSliced(
      units(20, () => tasks.advance(1)),
      { post: tasks.post, now: tasks.now },
    );
    let slices = 0;
    for (;;) {
      await Promise.resolve();
      if (!tasks.runOne()) break;
      slices++;
    }
    await expect(p).resolves.toBe('done');
    // 20 one-ms steps in 8 ms slices.
    expect(slices).toBe(3);
  });

  it('rejects with a JobCancelled error at the next slice once cancelled', async () => {
    const tasks = manualTasks();
    let cancelled = false;
    let ran = 0;
    const p = runSliced(
      units(40, () => {
        ran++;
        tasks.advance(1);
      }),
      { post: tasks.post, now: tasks.now, cancelled: () => cancelled },
    );
    const flush = async () => {
      for (let i = 0; i < 5; i++) await Promise.resolve();
    };
    tasks.runOne();
    await flush();
    cancelled = true;
    tasks.runOne();
    await flush();
    await expect(p).rejects.toMatchObject({ name: JOB_CANCELLED });
    expect(ran).toBe(SLICE_MS);
  });
});
