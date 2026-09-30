import { afterEach, describe, expect, it, vi } from 'vitest';
import { LongPressRecognizer } from './long-press';

describe('LongPressRecognizer', () => {
  afterEach(() => vi.useRealTimers());

  it('fires after 500 ms for an eligible stationary pointer', () => {
    vi.useFakeTimers();
    const fire = vi.fn();
    const press = new LongPressRecognizer(fire);
    press.pointerDown(1, 12, 20, true);
    vi.advanceTimersByTime(499);
    expect(fire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fire).toHaveBeenCalledWith(1, [12, 20]);
  });

  it('cancels when movement exceeds eight CSS pixels', () => {
    vi.useFakeTimers();
    const fire = vi.fn();
    const press = new LongPressRecognizer(fire);
    press.pointerDown(1, 12, 20, true);
    press.pointerMove(1, 21, 20);
    vi.advanceTimersByTime(500);
    expect(fire).not.toHaveBeenCalled();
  });

  it('cancels when a second finger touches', () => {
    vi.useFakeTimers();
    const fire = vi.fn();
    const press = new LongPressRecognizer(fire);
    press.pointerDown(1, 12, 20, true);
    press.pointerDown(2, 32, 20, false);
    vi.advanceTimersByTime(500);
    expect(fire).not.toHaveBeenCalled();
  });
});
