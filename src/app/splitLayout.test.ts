import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clampFrac,
  DEFAULT_FRAC,
  loadSplitLayout,
  MAX_FRAC,
  MIN_FRAC,
  resetSplitLayout,
  saveSplitLayout,
  subscribeSplitLayout,
  SPLIT_LAYOUT_STORAGE_KEY,
  useNarrowViewport,
} from './splitLayout';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Tiny harness: renders the hook's current value as the host's text content. */
function renderNarrowProbe(): { host: HTMLDivElement; root: Root } {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  function Probe() {
    const narrow = useNarrowViewport('(max-width: 899px)');
    return narrow ? 'narrow' : 'wide';
  }
  act(() => root.render(React.createElement(Probe)));
  return { host, root };
}

const KEY = 'trailmaker:splitLayout';

beforeEach(() => {
  window.localStorage.clear();
});

describe('clampFrac', () => {
  it('clamps to the 20/80 band and falls back to the default for non-finite input', () => {
    expect(clampFrac(0.5)).toBe(0.5);
    expect(clampFrac(0)).toBe(MIN_FRAC);
    expect(clampFrac(1)).toBe(MAX_FRAC);
    expect(clampFrac(NaN)).toBe(DEFAULT_FRAC);
  });
});

describe('loadSplitLayout / saveSplitLayout', () => {
  it('defaults to hidden, pair mode, and the default fraction', () => {
    expect(loadSplitLayout()).toStrictEqual({
      show: false,
      mode: 'pair',
      frac: DEFAULT_FRAC,
      stageMode: 'tabs',
      stepsCollapsed: false,
    });
  });

  it('round-trips a saved layout', () => {
    saveSplitLayout({
      show: true,
      mode: 'overlay',
      frac: 0.4,
      stageMode: 'tabs',
      stepsCollapsed: true,
    });
    expect(loadSplitLayout()).toStrictEqual({
      show: true,
      mode: 'overlay',
      frac: 0.4,
      stageMode: 'tabs',
      stepsCollapsed: true,
    });
  });

  it('migrates an existing saved layout without stageMode to side by side', () => {
    window.localStorage.setItem(KEY, JSON.stringify({ show: true, mode: 'pair', frac: 0.55 }));
    expect(loadSplitLayout()).toStrictEqual({
      show: true,
      mode: 'pair',
      frac: 0.55,
      stageMode: 'side-by-side',
      stepsCollapsed: false,
    });
  });

  it('falls back to defaults for corrupt storage, and clamps an out-of-range fraction', () => {
    window.localStorage.setItem(KEY, '{not json');
    expect(loadSplitLayout()).toStrictEqual({
      show: false,
      mode: 'pair',
      frac: DEFAULT_FRAC,
      stageMode: 'tabs',
      stepsCollapsed: false,
    });

    window.localStorage.setItem(KEY, JSON.stringify({ show: true, mode: 'overlay', frac: 5 }));
    expect(loadSplitLayout()).toStrictEqual({
      show: true,
      mode: 'overlay',
      frac: MAX_FRAC,
      stageMode: 'side-by-side',
      stepsCollapsed: false,
    });
  });
});

describe('useNarrowViewport', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reflects matchMedia and updates on a change event', () => {
    const listeners = new Set<() => void>();
    let matches = false;
    const mql = {
      get matches() {
        return matches;
      },
      addEventListener: (_: string, fn: () => void) => listeners.add(fn),
      removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
    };
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue(mql));

    const { host, root } = renderNarrowProbe();
    expect(host.textContent).toBe('wide');

    act(() => {
      matches = true;
      for (const fn of listeners) fn();
    });
    expect(host.textContent).toBe('narrow');
    act(() => root.unmount());
    host.remove();
  });

  it('defaults to false when matchMedia is unavailable (jsdom)', () => {
    const { host, root } = renderNarrowProbe();
    expect(host.textContent).toBe('wide');
    act(() => root.unmount());
    host.remove();
  });
});

describe('subscribeSplitLayout / resetSplitLayout', () => {
  it('notifies subscribers when resetSplitLayout is called', () => {
    saveSplitLayout({ show: true, mode: 'overlay', frac: 0.7 });
    const listener = vi.fn();
    const unsub = subscribeSplitLayout(listener);

    try {
      const reset = resetSplitLayout();
      const defaults = {
        show: false,
        mode: 'pair',
        frac: DEFAULT_FRAC,
        stageMode: 'tabs',
        stepsCollapsed: false,
      } as const;
      expect(reset).toStrictEqual(defaults);
      expect(listener).toHaveBeenCalledWith(defaults);
      expect(loadSplitLayout()).toStrictEqual(defaults);
    } finally {
      unsub();
    }
  });

  it('exports SPLIT_LAYOUT_STORAGE_KEY matching storage key constant', () => {
    expect(SPLIT_LAYOUT_STORAGE_KEY).toBe('trailmaker:splitLayout');
  });
});
