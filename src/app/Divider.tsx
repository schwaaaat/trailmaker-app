/** @jsxRuntime automatic */
// Lane B. Accessible, keyboard- and pointer-operable divider for the georef split (T-212).
// `onChange` is called on every drag frame (coalesced to rAF) for a live preview; `onCommit`
// is called once on pointerup or after a keyboard step, which is when layout persists.
import { useRef, type RefObject } from 'react';
import { clampFrac, MAX_FRAC, MIN_FRAC } from './splitLayout';

const KEY_STEP = 0.02;

export interface DividerProps {
  /** Editor pane's current share of the split, 0..1. */
  frac: number;
  /** 'vertical': a vertical bar dividing left/right panes, dragged/keyed horizontally.
   *  'horizontal': a horizontal bar dividing stacked top/bottom panes. */
  orientation: 'vertical' | 'horizontal';
  onChange: (frac: number) => void;
  onCommit: (frac: number) => void;
  containerRef: RefObject<HTMLElement | null>;
}

export function Divider({ frac, orientation, onChange, onCommit, containerRef }: DividerProps) {
  const rafRef = useRef<number | null>(null);
  const draggingRef = useRef(false);

  const fracAt = (clientX: number, clientY: number): number | null => {
    const el = containerRef.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    const raw =
      orientation === 'vertical'
        ? (clientX - rect.left) / rect.width
        : (clientY - rect.top) / rect.height;
    return clampFrac(raw);
  };

  const step = (delta: number) => {
    const next = clampFrac(frac + delta);
    onChange(next);
    onCommit(next);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const decKey = orientation === 'vertical' ? 'ArrowLeft' : 'ArrowUp';
    const incKey = orientation === 'vertical' ? 'ArrowRight' : 'ArrowDown';
    if (e.key === decKey) {
      e.preventDefault();
      step(-KEY_STEP);
    } else if (e.key === incKey) {
      e.preventDefault();
      step(KEY_STEP);
    } else if (e.key === 'Home') {
      e.preventDefault();
      step(-1);
    } else if (e.key === 'End') {
      e.preventDefault();
      step(1);
    }
  };

  const onPointerDown = (e: React.PointerEvent) => {
    draggingRef.current = true;
    (e.target as Element).setPointerCapture(e.pointerId);

    const move = (ev: PointerEvent) => {
      if (!draggingRef.current || rafRef.current !== null) return;
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        const next = fracAt(ev.clientX, ev.clientY);
        if (next !== null) onChange(next);
      });
    };
    const up = (ev: PointerEvent) => {
      draggingRef.current = false;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      const next = fracAt(ev.clientX, ev.clientY);
      if (next !== null) onCommit(next);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <div
      className={`split-divider ${orientation}`}
      role="separator"
      aria-orientation={orientation}
      aria-label="Resize park map and basemap panes"
      aria-valuemin={Math.round(MIN_FRAC * 100)}
      aria-valuemax={Math.round(MAX_FRAC * 100)}
      aria-valuenow={Math.round(frac * 100)}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
    />
  );
}
