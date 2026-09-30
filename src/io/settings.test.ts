import fs from 'node:fs';
import path from 'node:path';
import { strFromU8, unzipSync } from 'fflate';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as settingsModule from './settings';
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
  SPLIT_LAYOUT_STORAGE_KEY,
  TOUCH_HINT_STORAGE_KEY,
  APP_INTERFACE_STORAGE_KEYS,
  resetAppStorageKeys,
} from './settings';
import { serializeProject } from '../core/project';
import type { GeoFit } from '../core/types';
import { toExportDocument } from '../core/export/document';
import { toGeoJson } from '../core/export/geojson';
import { toGpx } from '../core/export/gpx';
import { toKml } from '../core/export/kml';
import { buildKmz } from '../core/export/kmz';
import { makeProject } from '../state/fixtures.test.helper';

describe('settings (localStorage persistence per D-018)', () => {
  beforeEach(() => {
    localStorage.clear();
    resetSettings();
  });

  it('loads defaults when localStorage is empty', () => {
    const settings = loadSettings();
    expect(settings.basemap.enabled).toBe(false);
    expect(settings.basemap.styleUrl).toBe(DEFAULT_BASEMAP_STYLE_URL);
    expect(settings.basemap.imagery).toBe('vector');
    expect(settings.basemap.satelliteProvider).toBe('naip');
    expect(settings.basemap.opacity).toBe(DEFAULT_OVERLAY_OPACITY);
    expect(settings.basemap.lastCenter).toBeUndefined();
    expect(settings.basemap.lastZoom).toBeUndefined();

    expect(settings.geocoder.enabled).toBe(false);
    expect(settings.geocoder.serviceUrl).toBe(DEFAULT_GEOCODER_SERVICE_URL);
  });

  it('persists and loads updated basemap settings including satellite choice', () => {
    const updated = updateBasemapSettings({
      enabled: true,
      styleUrl: 'https://example.com/custom-style.json',
      imagery: 'satellite',
      satelliteProvider: 'esri',
      esriApiKey: '  test-access-token  ',
      lastCenter: [-78.123, 38.456],
      lastZoom: 12,
      opacity: 0.8,
    });

    expect(updated.basemap.enabled).toBe(true);
    expect(updated.basemap.styleUrl).toBe('https://example.com/custom-style.json');
    expect(updated.basemap.imagery).toBe('satellite');
    expect(updated.basemap.satelliteProvider).toBe('esri');
    expect(updated.basemap.esriApiKey).toBe('test-access-token');
    expect(updated.basemap.lastCenter).toEqual([-78.123, 38.456]);
    expect(updated.basemap.lastZoom).toBe(12);
    expect(updated.basemap.opacity).toBe(0.8);

    const reloaded = loadSettings();
    expect(reloaded.basemap).toEqual(updated.basemap);
    expect(reloaded.geocoder.enabled).toBe(false);

    // Verify stored JSON
    const stored = JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY) || '{}');
    expect(stored.basemap.styleUrl).toBe('https://example.com/custom-style.json');
    expect(stored.basemap.imagery).toBe('satellite');
    expect(stored.basemap.satelliteProvider).toBe('esri');
    expect(stored.basemap.esriApiKey).toBe('test-access-token');
  });

  it('falls back to defaults for invalid imagery and satellite provider values', () => {
    localStorage.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({
        basemap: {
          enabled: true,
          imagery: 'invalid-imagery',
          satelliteProvider: 'unknown-provider',
        },
      }),
    );

    const reloaded = loadSettings();
    expect(reloaded.basemap.imagery).toBe('vector');
    expect(reloaded.basemap.satelliteProvider).toBe('naip');
  });

  it('requires an API key to enable Esri and falls back to NAIP when the key is cleared', () => {
    const rejected = updateBasemapSettings({ satelliteProvider: 'esri' });
    expect(rejected.basemap.satelliteProvider).toBe('naip');

    updateBasemapSettings({ esriApiKey: 'token-1', satelliteProvider: 'esri' });
    expect(loadSettings().basemap.satelliteProvider).toBe('esri');

    const cleared = updateBasemapSettings({ esriApiKey: '' });
    expect(cleared.basemap.satelliteProvider).toBe('naip');
    expect(cleared.basemap.esriApiKey).toBeUndefined();
  });

  it('keeps the browser-local Esri key out of project files and exports', () => {
    const key = 'local-only-esri-token';
    updateBasemapSettings({ esriApiKey: key });
    const project = makeProject();
    const projectFile = serializeProject(project, {
      bytes: new Uint8Array([1, 2, 3]),
      mimeType: 'image/png',
    });
    expect(strFromU8(unzipSync(projectFile)['project.json']!)).not.toContain(key);

    const doc = toExportDocument(project, {} as GeoFit);
    const options = { units: 'mi' as const, time: '2026-09-29T12:00:00.000Z' };
    const outputs = [
      toGpx(doc, options),
      toKml(doc, options, null),
      toGeoJson(doc, options),
      strFromU8(buildKmz({ doc, options, overlayImage: null, quad: null })),
    ];
    expect(outputs.every((output) => !output.includes(key))).toBe(true);
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
        imagery: 'vector',
        satelliteProvider: 'usgs',
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
    updateBasemapSettings({ enabled: true, styleUrl: 'https://temp.org/style.json', esriApiKey: 'secret-token' });
    updateGeocoderSettings({ enabled: true });

    const reset = resetSettings();
    expect(reset.basemap.enabled).toBe(false);
    expect(reset.basemap.styleUrl).toBe(DEFAULT_BASEMAP_STYLE_URL);
    expect(reset.geocoder.enabled).toBe(false);
    expect(reset.basemap.esriApiKey).toBeUndefined();

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

  it('registry includes every storage key constant exported by settings.ts (Acceptance 4)', () => {
    // Scan all exported constants in settings.ts whose name ends with _KEY or _STORAGE_KEY
    const exportedKeyConstants = Object.entries(settingsModule).filter(
      ([name, val]) =>
        (name.endsWith('_KEY') || name.endsWith('_STORAGE_KEY')) && typeof val === 'string',
    );

    expect(exportedKeyConstants.length).toBeGreaterThan(0);
    for (const [name, value] of exportedKeyConstants) {
      expect(
        APP_INTERFACE_STORAGE_KEYS,
        `Expected key ${name} (${String(value)}) to be included in APP_INTERFACE_STORAGE_KEYS`,
      ).toContain(value);
    }
  });

  it('every localStorage key used in src/ is registered in APP_INTERFACE_STORAGE_KEYS (Acceptance 4)', () => {
    const srcDir = path.resolve(__dirname, '..');
    const filesToScan: string[] = [];

    function walk(dir: string) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (
          /\.(ts|tsx)$/.test(entry.name) &&
          !entry.name.endsWith('.test.ts') &&
          !entry.name.endsWith('.test.tsx')
        ) {
          filesToScan.push(full);
        }
      }
    }
    walk(srcDir);

    const localStorageKeyRegex =
      /localStorage\s*\.\s*(?:getItem|setItem|removeItem)\s*\(\s*['"]([^'"]+)['"]/g;
    const foundKeys = new Set<string>();

    for (const file of filesToScan) {
      const content = fs.readFileSync(file, 'utf8');
      let match: RegExpExecArray | null;
      while ((match = localStorageKeyRegex.exec(content)) !== null) {
        foundKeys.add(match[1]!);
      }
    }

    for (const key of foundKeys) {
      expect(
        APP_INTERFACE_STORAGE_KEYS,
        `Found unregistered localStorage key "${key}" in source code. All app-owned keys must be in APP_INTERFACE_STORAGE_KEYS.`,
      ).toContain(key);
    }
  });

  it('resetAppStorageKeys resets all registered keys without touching other storage', () => {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ basemap: { enabled: true } }));
    localStorage.setItem(SPLIT_LAYOUT_STORAGE_KEY, JSON.stringify({ show: true, frac: 0.7 }));
    localStorage.setItem(TOUCH_HINT_STORAGE_KEY, 'true');
    localStorage.setItem('unrelated:external_key', 'do_not_touch');

    resetAppStorageKeys();

    expect(localStorage.getItem(SPLIT_LAYOUT_STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem(TOUCH_HINT_STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem('unrelated:external_key')).toBe('do_not_touch');

    // SETTINGS_STORAGE_KEY is reset to defaults
    const resetSettingsObj = JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY) || '{}');
    expect(resetSettingsObj.basemap.enabled).toBe(false);
  });
});
