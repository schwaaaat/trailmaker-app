import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_BASEMAP_STYLE_URL,
  DEFAULT_GEOCODER_SERVICE_URL,
  DEFAULT_OVERLAY_OPACITY,
  loadSettings,
  updateBasemapSettings,
  updateGeocoderSettings,
  subscribeSettings,
  TOUCH_HINT_STORAGE_KEY,
} from '../io/settings';
import { appStore, setStageView } from '../state/store';
import { makeProject, makeSession } from '../state/fixtures.test.helper';
import {
  loadSplitLayout,
  saveSplitLayout,
  subscribeSplitLayout,
} from './splitLayout';
import { subscribeTouchHintCollapsed } from '../ui/editor/Toolbar';
import { resetInterface } from './resetInterface';
import type { AnchorId, FeatureId } from '../core/types';

describe('resetInterface (card T-224, D-030)', () => {
  beforeEach(() => {
    localStorage.clear();
    resetInterface();
  });

  it('resets every app-owned interface key and setting to defaults (Acceptance 2)', () => {
    // 1. Modify settings
    updateBasemapSettings({
      enabled: true,
      styleUrl: 'https://custom.tiles/style.json',
      imagery: 'satellite',
      satelliteProvider: 'esri',
      esriApiKey: 'reset-me-token',
      lastCenter: [-73.985, 40.748],
      lastZoom: 15,
      opacity: 0.9,
    });
    updateGeocoderSettings({
      enabled: true,
      serviceUrl: 'https://custom.geocoder/search',
    });

    // 2. Modify split layout
    saveSplitLayout({ show: true, mode: 'overlay', frac: 0.75 });

    // 3. Modify touch hint collapsed
    localStorage.setItem(TOUCH_HINT_STORAGE_KEY, 'true');

    // 4. Modify stage view tab
    setStageView('overlay');

    // Execute resetInterface
    resetInterface();

    // Verify settings are back to defaults
    const settings = loadSettings();
    expect(settings.basemap.enabled).toBe(false);
    expect(settings.basemap.styleUrl).toBe(DEFAULT_BASEMAP_STYLE_URL);
    expect(settings.basemap.imagery).toBe('vector');
    expect(settings.basemap.satelliteProvider).toBe('naip');
    expect(settings.basemap.esriApiKey).toBeUndefined();
    expect(settings.basemap.opacity).toBe(DEFAULT_OVERLAY_OPACITY);
    expect(settings.basemap.lastCenter).toBeUndefined();
    expect(settings.basemap.lastZoom).toBeUndefined();

    expect(settings.geocoder.enabled).toBe(false);
    expect(settings.geocoder.serviceUrl).toBe(DEFAULT_GEOCODER_SERVICE_URL);

    // Verify split layout is back to defaults
    const layout = loadSplitLayout();
    expect(layout.show).toBe(false);
    expect(layout.mode).toBe('pair');
    expect(layout.frac).toBe(0.55);

    // Verify touch hint collapsed is cleared
    expect(localStorage.getItem(TOUCH_HINT_STORAGE_KEY)).toBeNull();

    // Verify stage view is back to 'map'
    expect(appStore.getState().stageView).toBe('map');
  });

  it('notifies all live subscribers immediately without reload (Acceptance 3)', () => {
    // Modify states first
    updateBasemapSettings({ enabled: true, imagery: 'satellite' });
    saveSplitLayout({ show: true, mode: 'overlay', frac: 0.8 });
    localStorage.setItem(TOUCH_HINT_STORAGE_KEY, 'true');
    setStageView('basemap');

    const layoutListener = vi.fn();
    const hintListener = vi.fn();
    const settingsListener = vi.fn();

    const unsubLayout = subscribeSplitLayout(layoutListener);
    const unsubHint = subscribeTouchHintCollapsed(hintListener);
    const unsubSettings = subscribeSettings(settingsListener);

    try {
      resetInterface();

      // Layout subscriber fired with default layout
      expect(layoutListener).toHaveBeenCalledTimes(1);
      expect(layoutListener).toHaveBeenCalledWith({
        show: false,
        mode: 'pair',
        frac: 0.55,
      });

      // Hint subscriber fired with false (expanded)
      expect(hintListener).toHaveBeenCalledTimes(1);
      expect(hintListener).toHaveBeenCalledWith(false);

      // Settings subscriber fired with defaults
      expect(settingsListener).toHaveBeenCalledWith(
        expect.objectContaining({
          basemap: expect.objectContaining({
            enabled: false,
            imagery: 'vector',
          }),
          geocoder: expect.objectContaining({
            enabled: false,
          }),
        }),
      );

      // Store stageView is 'map'
      expect(appStore.getState().stageView).toBe('map');
    } finally {
      unsubLayout();
      unsubHint();
      unsubSettings();
    }
  });

  it('does NOT touch project data, features, anchors, units, or session (Acceptance 2)', () => {
    const dummyProject = makeProject({
      name: 'Existing Test Park',
      units: 'km',
      anchors: [
        { id: 'a1' as AnchorId, px: [100, 200], ll: [37.77, -122.41], source: 'paste' },
        { id: 'a2' as AnchorId, px: [300, 400], ll: [37.78, -122.42], source: 'paste' },
      ],
      features: [
        {
          id: 'f1' as FeatureId,
          kind: 'trail',
          name: 'Main Trail',
          color: '#ff0000',
          pts: [
            [10, 20],
            [30, 40],
          ],
          ink: null,
          notes: '',
        },
      ],
    });

    const session = makeSession(dummyProject);
    appStore.setState({ session });

    // Modify interface state
    updateBasemapSettings({ enabled: true });
    saveSplitLayout({ show: true, mode: 'overlay', frac: 0.6 });

    // Reset interface
    resetInterface();

    // Assert that session and project are identical and untouched
    const currentSession = appStore.getState().session;
    expect(currentSession).toBe(session);
    expect(currentSession?.project.name).toBe('Existing Test Park');
    expect(currentSession?.project.units).toBe('km');
    expect(currentSession?.project.anchors.length).toBe(2);
    expect(currentSession?.project.features.length).toBe(1);
    expect(currentSession?.project.features[0]!.name).toBe('Main Trail');
  });
});
