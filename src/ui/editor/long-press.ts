export const LONG_PRESS_DELAY_MS = 500;
export const LONG_PRESS_TOLERANCE_PX = 8;

/** Recognizes a stationary pointer press and cancels when a second pointer joins. */
export class LongPressRecognizer {
  private active: { id: number; x: number; y: number } | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly fire: (id: number, point: readonly [number, number]) => void,
    private readonly delayMs = LONG_PRESS_DELAY_MS,
    private readonly tolerancePx = LONG_PRESS_TOLERANCE_PX,
  ) {}

  pointerDown(id: number, x: number, y: number, eligible: boolean): void {
    if (this.active) {
      if (this.active.id !== id) this.cancel();
      return;
    }
    if (!eligible) return;
    this.active = { id, x, y };
    this.timer = setTimeout(() => {
      const press = this.active;
      this.clear();
      if (press) this.fire(press.id, [press.x, press.y]);
    }, this.delayMs);
  }

  pointerMove(id: number, x: number, y: number): void {
    const press = this.active;
    if (press && press.id === id && Math.hypot(x - press.x, y - press.y) > this.tolerancePx)
      this.cancel();
  }

  pointerUp(id: number): void {
    if (this.active?.id === id) this.cancel();
  }

  cancel(): void {
    this.clear();
  }

  private clear(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.active = null;
  }
}
