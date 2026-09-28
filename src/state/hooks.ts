// Lane B. React bindings for the app store; the only React code in src/state.
import { useStore } from 'zustand';
import type { FitResult } from '../core/types';
import { appStore, selectFit, type AppState } from './store';

/**
 * Subscribe a component to part of the app state. Zustand v5 compares with Object.is, so
 * the selector must return a primitive or an existing reference, never a fresh object.
 */
export function useApp<T>(selector: (state: AppState) => T): T {
  return useStore(appStore, selector);
}

/** The memoized georeference for the current project. */
export function useFit(): FitResult | null {
  return useStore(appStore, selectFit);
}
