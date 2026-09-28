// Lane B test support: a laid-out canvas for jsdom and synthetic pointer events.
// Excluded from the app build by the `*.test.*` pattern.

/** Canvas at client (10, 20), 500 x 400 CSS px. */
export const RECT = { left: 10, top: 20, width: 500, height: 400 };

export function makeCanvas(): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.getBoundingClientRect = () =>
    ({
      ...RECT,
      x: RECT.left,
      y: RECT.top,
      right: RECT.left + RECT.width,
      bottom: RECT.top + RECT.height,
      toJSON: () => ({}),
    }) as DOMRect;
  // jsdom has no 2D context; the editor must cope (it skips drawing).
  c.getContext = (() => null) as HTMLCanvasElement['getContext'];
  c.tabIndex = 0;
  document.body.appendChild(c);
  return c;
}

/** Dispatch a pointer-like event at canvas-local CSS coordinates. */
export function ptr(
  c: HTMLCanvasElement,
  type: string,
  x: number,
  y: number,
  init: { button?: number; id?: number; shiftKey?: boolean; altKey?: boolean } = {},
): MouseEvent {
  const e = new MouseEvent(type, {
    clientX: RECT.left + x,
    clientY: RECT.top + y,
    button: init.button ?? 0,
    shiftKey: init.shiftKey ?? false,
    altKey: init.altKey ?? false,
    bubbles: true,
    cancelable: true,
  });
  Object.defineProperty(e, 'pointerId', { value: init.id ?? 1 });
  c.dispatchEvent(e);
  return e;
}

/** Press and release without moving: a click. */
export function tap(c: HTMLCanvasElement, [x, y]: readonly [number, number], button = 0): void {
  ptr(c, 'pointerdown', x, y, { button });
  ptr(c, 'pointerup', x, y, { button });
}

/** Press, move in `steps` to `to`, release. */
export function dragFrom(
  c: HTMLCanvasElement,
  [x0, y0]: readonly [number, number],
  [x1, y1]: readonly [number, number],
  steps = 3,
  button = 0,
): void {
  ptr(c, 'pointerdown', x0, y0, { button });
  for (let i = 1; i <= steps; i++) {
    ptr(c, 'pointermove', x0 + ((x1 - x0) * i) / steps, y0 + ((y1 - y0) * i) / steps, { button });
  }
  ptr(c, 'pointerup', x1, y1, { button });
}

/** A keydown on `target` (default: window). */
export function key(
  k: string,
  mods: { ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean } = {},
  target: EventTarget = window,
): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...mods });
  target.dispatchEvent(e);
  return e;
}
