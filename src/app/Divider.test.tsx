import React, { act, type RefObject } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Divider } from './Divider';

void React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
let container: HTMLDivElement;
let containerRef: RefObject<HTMLElement | null>;

function render(node: React.ReactNode) {
  act(() => root.render(node));
}
const separator = () => host.querySelector<HTMLElement>('[role="separator"]')!;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  container = document.createElement('div');
  document.body.appendChild(container);
  vi.spyOn(container, 'getBoundingClientRect').mockReturnValue({
    left: 0,
    top: 0,
    width: 1000,
    height: 500,
    right: 1000,
    bottom: 500,
    x: 0,
    y: 0,
    toJSON() {
      return this;
    },
  });
  containerRef = { current: container };
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  container.remove();
});

describe('Divider (T-212)', () => {
  it('exposes role, orientation and current value as ARIA attributes', () => {
    render(
      <Divider
        frac={0.55}
        orientation="vertical"
        onChange={() => {}}
        onCommit={() => {}}
        containerRef={containerRef}
      />,
    );
    const el = separator();
    expect(el.getAttribute('aria-orientation')).toBe('vertical');
    expect(el.getAttribute('aria-valuenow')).toBe('55');
    expect(el.getAttribute('aria-valuemin')).toBe('20');
    expect(el.getAttribute('aria-valuemax')).toBe('80');
    expect(el.tabIndex).toBe(0);
  });

  it('ArrowRight/ArrowLeft step the fraction when vertical (side-by-side)', () => {
    let frac = 0.5;
    const onChange = vi.fn((f: number) => (frac = f));
    const onCommit = vi.fn();
    render(
      <Divider
        frac={frac}
        orientation="vertical"
        onChange={onChange}
        onCommit={onCommit}
        containerRef={containerRef}
      />,
    );
    act(() => {
      separator().dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }),
      );
    });
    expect(onChange).toHaveBeenLastCalledWith(0.52);
    expect(onCommit).toHaveBeenLastCalledWith(0.52);
  });

  it('ArrowUp/ArrowDown step the fraction when horizontal (stacked), not Left/Right', () => {
    const onChange = vi.fn();
    const onCommit = vi.fn();
    render(
      <Divider
        frac={0.5}
        orientation="horizontal"
        onChange={onChange}
        onCommit={onCommit}
        containerRef={containerRef}
      />,
    );
    act(() => {
      separator().dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }),
      );
    });
    expect(onChange).not.toHaveBeenCalled();
    act(() => {
      separator().dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }),
      );
    });
    expect(onChange).toHaveBeenLastCalledWith(0.52);
  });

  it('Home and End jump to the min/max fraction', () => {
    const onCommit = vi.fn();
    render(
      <Divider
        frac={0.5}
        orientation="vertical"
        onChange={() => {}}
        onCommit={onCommit}
        containerRef={containerRef}
      />,
    );
    act(() => {
      separator().dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true }),
      );
    });
    expect(onCommit).toHaveBeenLastCalledWith(0.2);
    act(() => {
      separator().dispatchEvent(
        new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }),
      );
    });
    expect(onCommit).toHaveBeenLastCalledWith(0.8);
  });
});
