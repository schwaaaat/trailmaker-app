import type { PostTask } from './slice';

/** A manual task queue and a clock the test advances. */
export function manualTasks() {
  const queue: (() => void)[] = [];
  let t = 0;
  const post: PostTask = (fn) => {
    queue.push(fn);
    return () => {
      const i = queue.indexOf(fn);
      if (i >= 0) queue.splice(i, 1);
    };
  };
  return {
    post,
    now: () => t,
    advance: (ms: number) => (t += ms),
    get queued() {
      return queue.length;
    },
    /** Run the next queued task; false when the queue is empty. */
    runOne(): boolean {
      const fn = queue.shift();
      fn?.();
      return !!fn;
    },
    /** Run tasks until the queue is empty; returns how many ran. */
    runAll(): number {
      let n = 0;
      while (this.runOne()) n++;
      return n;
    },
  };
}
