// Lane C. Tests for StartSatelliteButton (card T-318).
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StartSatelliteButton } from './StartSatelliteButton';
import { loadSettings, resetSettings, updateBasemapSettings } from '../../io/settings';
import * as satelliteModule from '../georef/satellite';
import { appStore, clearSatelliteCaptureRequest } from '../../state/store';

void React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('StartSatelliteButton', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    resetSettings();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.restoreAllMocks();
  });

  it('renders disabled with explanation when offline', () => {
    vi.spyOn(satelliteModule, 'useOnlineStatus').mockReturnValue(false);

    act(() => {
      root.render(<StartSatelliteButton />);
    });

    const btn = container.querySelector('#startSatelliteBtn') as HTMLButtonElement;
    expect(btn).not.toBeNull();
    expect(btn.disabled).toBe(true);
    expect(btn.title).toContain('Satellite view requires an internet connection');
    expect(btn.getAttribute('aria-label')).toContain('Satellite view requires an internet connection');
  });

  it('renders enabled when online', () => {
    vi.spyOn(satelliteModule, 'useOnlineStatus').mockReturnValue(true);

    act(() => {
      root.render(<StartSatelliteButton />);
    });

    const btn = container.querySelector('#startSatelliteBtn') as HTMLButtonElement;
    expect(btn).not.toBeNull();
    expect(btn.disabled).toBe(false);
  });

  it('opens BasemapConsent dialog when clicked without prior consent', () => {
    vi.spyOn(satelliteModule, 'useOnlineStatus').mockReturnValue(true);
    updateBasemapSettings({ enabled: false });

    act(() => {
      root.render(<StartSatelliteButton />);
    });

    const btn = container.querySelector('#startSatelliteBtn') as HTMLButtonElement;
    act(() => {
      btn.click();
    });

    // BasemapConsent dialog should appear
    expect(document.querySelector('.trailmaker-basemap-consent-overlay')).not.toBeNull();
  });

  it('switches to satellite and requests satellite capture in store when clicked with consent', () => {
    vi.spyOn(satelliteModule, 'useOnlineStatus').mockReturnValue(true);
    updateBasemapSettings({ enabled: true });
    clearSatelliteCaptureRequest();

    const onStart = vi.fn();
    act(() => {
      root.render(<StartSatelliteButton onStart={onStart} />);
    });

    const btn = container.querySelector('#startSatelliteBtn') as HTMLButtonElement;
    act(() => {
      btn.click();
    });

    expect(appStore.getState().satelliteCaptureRequested).toBe(true);
    expect(loadSettings().basemap.imagery).toBe('satellite');
    expect(onStart).toHaveBeenCalled();
  });
});
