// Lane B. Reset the interface to default settings (card T-224, D-030, D-032).
import { resetAppStorageKeys, resetSettings } from '../io/settings';
import { setStageView } from '../state/store';
import { resetTouchHintCollapsed } from '../ui/editor/Toolbar';
import { resetSplitLayout } from './splitLayout';

/**
 * Resets all device-local interface state to defaults:
 * - App settings (basemap style, imagery, provider, saved camera view, geocoder, opt-ins/consent)
 * - Split layout (pane widths, pair/overlay mode, show basemap)
 * - Mobile stage tab (resets to 'map')
 * - Collapsed touch hints (expands)
 * - All app-owned localStorage interface keys
 *
 * Does NOT touch project data, features, anchors, map images, units, autosave or IndexedDB.
 */
export function resetInterface(): void {
  // 1. Reset all app settings in localStorage and notify subscribers (Lane C)
  resetSettings();

  // 2. Ensure all registered storage keys in localStorage are reset
  resetAppStorageKeys();

  // 3. Reset split layout state in memory and localStorage, and notify subscribers (Lane B)
  resetSplitLayout();

  // 4. Reset touch hint collapsed state in memory and localStorage (Lane B)
  resetTouchHintCollapsed();

  // 5. Reset mobile stage view to 'map' (Lane B)
  setStageView('map');
}
