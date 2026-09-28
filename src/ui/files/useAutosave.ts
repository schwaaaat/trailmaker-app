// Lane C. Autosave startup and storage notice hook (card T-305, D-017).
import { useEffect } from 'react';
import {
  ensureAutosave,
  getDb,
  notifyStorageUnavailable,
  type AutosaveOptions,
} from '../../io/autosave';
import { sessionBridge } from '../../state/bridge';
import { showToast as storeShowToast } from '../../state/store';
import type { SessionBridge } from '../contract';

export interface UseAutosaveOptions extends AutosaveOptions {
  readonly bridge?: SessionBridge | undefined;
}

/**
 * Starts autosave and probes storage availability once per app lifetime.
 * Automatically notifies if storage is unavailable on startup.
 */
export function useAutosave(
  bridge: SessionBridge = sessionBridge,
  options: AutosaveOptions = {},
): void {
  const showToast = options.showToast ?? storeShowToast;
  const debounceMs = options.debounceMs;

  useEffect(() => {
    const autosaveOptions: AutosaveOptions =
      debounceMs !== undefined ? { showToast, debounceMs } : { showToast };
    const stop = ensureAutosave(bridge, autosaveOptions);
    void getDb().catch(() => {
      notifyStorageUnavailable(showToast);
    });
    return () => {
      stop();
    };
  }, [bridge, showToast, debounceMs]);
}
