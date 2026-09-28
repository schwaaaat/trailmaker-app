import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  loadSettings,
  saveSettings,
  updateBasemapSettings,
  updateGeocoderSettings,
  resetSettings,
  resetBasemapStyleUrl,
  resetGeocoderServiceUrl,
  subscribeSettings,
  DEFAULT_BASEMAP_STYLE_URL,
  DEFAULT_GEOCODER_SERVICE_URL,
  DEFAULT_OVERLAY_OPACITY,
  SETTINGS_STORAGE_KEY,
} from './settings';

describe('settings (localStorage persistence per D-018)', () => {
  beforeEach(() => {
    localStorage.clear();
    resetSettings();
  });

  it('loads defaults when localStorage is empty', () => {
    const settings = loadSettings();
    expect(settings.basemap.enabled).toBe(false);
    expect(settings.basemap.styleUrl).toBe(DEFAULT_BASEMAP_STYLE_URL);
    expect(settings.basemap.opacity).toBe(DEFAULT_OVERLAY_OPACITY);
    expect(settings.basemap.lastCenter).toBeUndefined();
    expect(settings.basemap.lastZoom).toBeUndefined();

    expect(settings.geocoder.enabled).toBe(false);
    expect(settings.geocoder.serviceUrl).toBe(DEFAULT_GEOCODER_SERVICE_URL);
  });

  it('persists and loads updated basemap settings', () => {
    const updated = updateBasemapSettings({
      enabled: true,
      styleUrl: 'https://example.com/custom-style.json',
      lastCenter: [-78.123, 38.456],
      lastZoom: 12,
      opacity: 0.8,
    });

    expect(updated.basemap.enabled).toBe(true);
    expect(updated.basemap.styleUrl).toBe('https://example.com/custom-style.json');
    expect(updated.basemap.lastCenter).toEqual([-78.123, 38.456]);
    expect(updated.basemap.lastZoom).toBe(12);
    expect(updated.basemap.opacity).toBe(0.8);

    const reloaded = loadSettings();
    expect(reloaded.basemap).toEqual(updated.basemap);
    expect(reloaded.geocoder.enabled).toBe(false);

    // Verify stored JSON
    const stored = JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY) || '{}');
    expect(stored.basemap.styleUrl).toBe('https://example.com/custom-style.json');
  });

  it('persists and loads updated geocoder settings', () => {
    const updated = updateGeocoderSettings({
      enabled: true,
      serviceUrl: 'https://custom-geocoder.org/search',
    });

    expect(updated.geocoder.enabled).toBe(true);
    expect(updated.geocoder.serviceUrl).toBe('https://custom-geocoder.org/search');

    const reloaded = loadSettings();
    expect(reloaded.geocoder.enabled).toBe(true);
    expect(reloaded.geocoder.serviceUrl).toBe('https://custom-geocoder.org/search');
    expect(reloaded.basemap.enabled).toBe(false);
  });

  it('directly saves and reloads whole settings object', () => {
    saveSettings({
      basemap: {
        enabled: true,
        styleUrl: 'https://direct-save.org/style.json',
        opacity: 0.5,
      },
      geocoder: {
        enabled: true,
        serviceUrl: 'https://direct-save.org/search',
      },
    });

    const reloaded = loadSettings();
    expect(reloaded.basemap.styleUrl).toBe('https://direct-save.org/style.json');
    expect(reloaded.geocoder.serviceUrl).toBe('https://direct-save.org/search');
  });

  it('resets basemap style and geocoder URLs to defaults', () => {
    updateBasemapSettings({ styleUrl: 'https://temp.org/style.json' });
    updateGeocoderSettings({ serviceUrl: 'https://temp.org/search' });

    expect(resetBasemapStyleUrl()).toBe(DEFAULT_BASEMAP_STYLE_URL);
    expect(loadSettings().basemap.styleUrl).toBe(DEFAULT_BASEMAP_STYLE_URL);

    expect(resetGeocoderServiceUrl()).toBe(DEFAULT_GEOCODER_SERVICE_URL);
    expect(loadSettings().geocoder.serviceUrl).toBe(DEFAULT_GEOCODER_SERVICE_URL);
  });

  it('resets all settings to defaults', () => {
    updateBasemapSettings({ enabled: true, styleUrl: 'https://temp.org/style.json' });
    updateGeocoderSettings({ enabled: true });

    const reset = resetSettings();
    expect(reset.basemap.enabled).toBe(false);
    expect(reset.basemap.styleUrl).toBe(DEFAULT_BASEMAP_STYLE_URL);
    expect(reset.geocoder.enabled).toBe(false);

    const reloaded = loadSettings();
    expect(reloaded.basemap.enabled).toBe(false);
  });

  it('safely handles corrupted or invalid JSON in localStorage', () => {
    localStorage.setItem(SETTINGS_STORAGE_KEY, 'not-valid-json{{{');
    const settings = loadSettings();
    expect(settings.basemap.enabled).toBe(false);
    expect(settings.basemap.styleUrl).toBe(DEFAULT_BASEMAP_STYLE_URL);
  });

  it('safely handles partial objects in localStorage', () => {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ basemap: { enabled: true } }));
    const settings = loadSettings();
    expect(settings.basemap.enabled).toBe(true);
    expect(settings.basemap.styleUrl).toBe(DEFAULT_BASEMAP_STYLE_URL);
    expect(settings.geocoder.enabled).toBe(false);
  });

  it('clamps opacity between 0 and 1', () => {
    updateBasemapSettings({ opacity: 1.5 });
    expect(loadSettings().basemap.opacity).toBe(1);

    updateBasemapSettings({ opacity: -0.2 });
    expect(loadSettings().basemap.opacity).toBe(0);
  });

  it('notifies subscribers on change and supports unsubscribe', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeSettings(listener);

    updateBasemapSettings({ enabled: true });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({
      basemap: expect.objectContaining({ enabled: true }),
    }));

    unsubscribe();
    updateBasemapSettings({ enabled: false });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('gracefully handles localStorage throwing SecurityError (e.g. private mode)', () => {
    const originalGetItem = Storage.prototype.getItem;
    const originalSetItem = Storage.prototype.setItem;

    try {
      vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
        throw new DOMException('Access denied', 'SecurityError');
      });
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new DOMException('Access denied', 'SecurityError');
      });

      // Should not throw and should operate via in-memory store
      expect(() => loadSettings()).not.toThrow();
      expect(() => updateBasemapSettings({ enabled: true })).not.toThrow();
      expect(loadSettings().basemap.enabled).toBe(true);
    } finally {
      Storage.prototype.getItem = originalGetItem;
      Storage.prototype.setItem = originalSetItem;
    }
  });
});
