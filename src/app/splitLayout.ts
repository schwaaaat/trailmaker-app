// Lane B. Side-by-side georef layout state (T-212): which pane shows, and the divider's
// position. This is device-local UI layout, not project data or a network opt-in (D-018 keeps
// those in src/io/settings.ts, owned by Lane C), so it gets its own localStorage key.
import { useEffect, useState } from 'react';
import { SPLIT_LAYOUT_STORAGE_KEY } from '../io/settings';

export { SPLIT_LAYOUT_STORAGE_KEY };
export const NARROW_QUERY = '(max-width: 899px)';
const STORAGE_KEY = SPLIT_LAYOUT_STORAGE_KEY;

export type PaneMode = 'pair' | 'overlay';
export type StageMode = 'side-by-side' | 'tabs';

export interface SplitLayoutState {
  readonly show: boolean;
  readonly mode: PaneMode;
  /** The editor pane's share of the split, 0..1 (side-by-side) or top pane's share (stacked). */
  readonly frac: number;
  /** Desktop arrangement for the editor and live basemap. */
  readonly stageMode: StageMode;
  readonly stepsCollapsed: boolean;
}

type PersistedSplitLayout = Omit<SplitLayoutState, 'stageMode' | 'stepsCollapsed'> &
  Partial<Pick<SplitLayoutState, 'stageMode' | 'stepsCollapsed'>>;

export const MIN_FRAC = 0.2;
export const MAX_FRAC = 0.8;
export const DEFAULT_FRAC = 0.55;

const DEFAULTS: SplitLayoutState = {
  show: false,
  mode: 'pair',
  frac: DEFAULT_FRAC,
  stageMode: 'tabs',
  stepsCollapsed: false,
};

const subscribers = new Set<(state: SplitLayoutState) => void>();

export function subscribeSplitLayout(callback: (state: SplitLayoutState) => void): () => void {
  subscribers.add(callback);
  return () => {
    subscribers.delete(callback);
  };
}

export function resetSplitLayout(): SplitLayoutState {
  const defaults: SplitLayoutState = { ...DEFAULTS };
  saveSplitLayout(defaults);
  for (const sub of subscribers) {
    try {
      sub(defaults);
    } catch {
      // Ignore subscriber errors
    }
  }
  return defaults;
}

export function clampFrac(v: number): number {
  if (!Number.isFinite(v)) return DEFAULT_FRAC;
  return Math.min(MAX_FRAC, Math.max(MIN_FRAC, v));
}

function getLocalStorage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

export function loadSplitLayout(): SplitLayoutState {
  const storage = getLocalStorage();
  if (!storage) return { ...DEFAULTS };
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<SplitLayoutState>;
    return {
      show: typeof parsed.show === 'boolean' ? parsed.show : DEFAULTS.show,
      mode: parsed.mode === 'overlay' ? 'overlay' : 'pair',
      frac: typeof parsed.frac === 'number' ? clampFrac(parsed.frac) : DEFAULTS.frac,
      // A missing localStorage value is a new profile and defaults to Tabs. A present value
      // without stageMode is the pre-T-325 shape, whose saved side-by-side layout is preserved.
      stageMode:
        parsed.stageMode === 'tabs' || parsed.stageMode === 'side-by-side'
          ? parsed.stageMode
          : 'side-by-side',
      stepsCollapsed: parsed.stepsCollapsed === true,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSplitLayout(state: PersistedSplitLayout): void {
  const storage = getLocalStorage();
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Ignore quota or security errors, matching src/io/settings.ts.
  }
}

function matchesNow(query: string): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  try {
    return window.matchMedia(query).matches;
  } catch {
    return false;
  }
}

/** True under the narrow-viewport breakpoint. jsdom has no matchMedia, so this is false there. */
export function useNarrowViewport(query: string = NARROW_QUERY): boolean {
  const [narrow, setNarrow] = useState(() => matchesNow(query));
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    let mql: MediaQueryList;
    try {
      mql = window.matchMedia(query);
    } catch {
      return;
    }
    const onChange = () => setNarrow(mql.matches);
    onChange();
    if (mql.addEventListener) {
      mql.addEventListener('change', onChange);
      return () => mql.removeEventListener('change', onChange);
    }
    // Safari < 14 fallback.
    mql.addListener(onChange);
    return () => mql.removeListener(onChange);
  }, [query]);
  return narrow;
}
