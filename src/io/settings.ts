/**
 * App settings persisted to localStorage (never in the project file, per D-018).
 * Manages network opt-in choices, basemap styles, camera position, and geocoder config.
 */

export const SETTINGS_STORAGE_KEY = 'trailmaker:settings';
export const SPLIT_LAYOUT_STORAGE_KEY = 'trailmaker:splitLayout';
export const TOUCH_HINT_STORAGE_KEY = 'trailmaker.touchHintCollapsed.v1';

/**
 * All device-local localStorage keys owned by the app (T-224).
 * Single registry so future settings cannot be forgotten on reset.
 */
export const APP_INTERFACE_STORAGE_KEYS = [
  SETTINGS_STORAGE_KEY,
  SPLIT_LAYOUT_STORAGE_KEY,
  TOUCH_HINT_STORAGE_KEY,
] as const;

export type AppInterfaceStorageKey = (typeof APP_INTERFACE_STORAGE_KEYS)[number];

export const RESET_INTERFACE_ITEMS: readonly string[] = [
  'Live basemap and geocoder permissions (the Live Basemap card will show again)',
  'Basemap style, imagery (Map/Satellite), provider, ArcGIS API key, and saved position',
  'Split layout, pane widths, and mode',
  'Stage view tabs and collapsed hints',
];

export const RESET_INTERFACE_NOTE =
  'Your project, map images, traced trails, and saved files are not touched.';

export const DEFAULT_BASEMAP_STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';
export const DEFAULT_GEOCODER_SERVICE_URL = 'https://nominatim.openstreetmap.org/search?format=jsonv2';
export const DEFAULT_OVERLAY_OPACITY = 0.6; // 60% default per T-309
export const DEFAULT_BASEMAP_IMAGERY: BasemapImageryType = 'vector';
export const DEFAULT_SATELLITE_PROVIDER: SatelliteProviderId = 'naip';

export type BasemapImageryType = 'vector' | 'satellite';
export type SatelliteProviderId = 'usgs' | 'naip' | 'esri';

export interface BasemapSettings {
  enabled: boolean;
  styleUrl: string;
  imagery: BasemapImageryType; // 'vector' (Map) | 'satellite' (Satellite)
  satelliteProvider: SatelliteProviderId; // 'usgs' | 'naip' | 'esri'
  /** User-owned Esri access token. Stored locally in browser settings only. */
  esriApiKey?: string;
  lastCenter?: [number, number]; // [lng, lat]
  lastZoom?: number;
  opacity: number; // 0..1
}

export interface GeocoderSettings {
  enabled: boolean;
  serviceUrl: string;
}

export interface AppSettings {
  basemap: BasemapSettings;
  geocoder: GeocoderSettings;
}

export function getDefaultSettings(): AppSettings {
  return {
    basemap: {
      enabled: false,
      styleUrl: DEFAULT_BASEMAP_STYLE_URL,
      imagery: DEFAULT_BASEMAP_IMAGERY,
      satelliteProvider: DEFAULT_SATELLITE_PROVIDER,
      opacity: DEFAULT_OVERLAY_OPACITY,
    },
    geocoder: {
      enabled: false,
      serviceUrl: DEFAULT_GEOCODER_SERVICE_URL,
    },
  };
}

let inMemorySettings: AppSettings | null = null;
const subscribers = new Set<(settings: AppSettings) => void>();

function notifySubscribers(settings: AppSettings): void {
  for (const sub of subscribers) {
    try {
      sub(settings);
    } catch {
      // Ignore subscriber errors
    }
  }
}

function getLocalStorage(): Storage | null {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      return window.localStorage;
    }
  } catch {
    // Storage access may throw SecurityError in private mode / sandboxed iframes
  }
  return null;
}

/**
 * Load settings from localStorage with schema validation and fallback to defaults.
 */
export function loadSettings(): AppSettings {
  const defaults = getDefaultSettings();
  const storage = getLocalStorage();

  if (!storage) {
    return inMemorySettings ? { ...inMemorySettings } : { ...defaults };
  }

  try {
    const raw = storage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) {
      return inMemorySettings ? { ...inMemorySettings } : { ...defaults };
    }

    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      return { ...defaults };
    }

    const obj = parsed as Record<string, unknown>;
    const basemapObj = (obj.basemap && typeof obj.basemap === 'object') ? (obj.basemap as Record<string, unknown>) : null;
    const geocoderObj = (obj.geocoder && typeof obj.geocoder === 'object') ? (obj.geocoder as Record<string, unknown>) : null;

    const imagery: BasemapImageryType =
      basemapObj && (basemapObj.imagery === 'vector' || basemapObj.imagery === 'satellite')
        ? basemapObj.imagery
        : defaults.basemap.imagery;

    const esriApiKey =
      basemapObj && typeof basemapObj.esriApiKey === 'string'
        ? basemapObj.esriApiKey.trim() || undefined
        : undefined;

    const requestedSatelliteProvider: SatelliteProviderId =
      basemapObj &&
      (basemapObj.satelliteProvider === 'usgs' ||
        basemapObj.satelliteProvider === 'naip' ||
        basemapObj.satelliteProvider === 'esri')
        ? basemapObj.satelliteProvider
        : defaults.basemap.satelliteProvider;
    const satelliteProvider: SatelliteProviderId =
      requestedSatelliteProvider === 'esri' && !esriApiKey
        ? defaults.basemap.satelliteProvider
        : requestedSatelliteProvider;

    const basemap: BasemapSettings = {
      enabled: basemapObj && typeof basemapObj.enabled === 'boolean'
        ? basemapObj.enabled
        : defaults.basemap.enabled,
      styleUrl: basemapObj && typeof basemapObj.styleUrl === 'string'
        ? basemapObj.styleUrl.trim() || defaults.basemap.styleUrl
        : defaults.basemap.styleUrl,
      imagery,
      satelliteProvider,
      ...(esriApiKey ? { esriApiKey } : {}),
      opacity: basemapObj && typeof basemapObj.opacity === 'number'
        ? Math.max(0, Math.min(1, basemapObj.opacity))
        : defaults.basemap.opacity,
    };

    if (basemapObj && Array.isArray(basemapObj.lastCenter) && basemapObj.lastCenter.length === 2) {
      const [lng, lat] = basemapObj.lastCenter;
      if (typeof lng === 'number' && typeof lat === 'number') {
        basemap.lastCenter = [lng, lat];
      }
    }

    if (basemapObj && typeof basemapObj.lastZoom === 'number') {
      basemap.lastZoom = basemapObj.lastZoom;
    }

    const geocoder: GeocoderSettings = {
      enabled: geocoderObj && typeof geocoderObj.enabled === 'boolean'
        ? geocoderObj.enabled
        : defaults.geocoder.enabled,
      serviceUrl: geocoderObj && typeof geocoderObj.serviceUrl === 'string'
        ? geocoderObj.serviceUrl.trim() || defaults.geocoder.serviceUrl
        : defaults.geocoder.serviceUrl,
    };

    const result: AppSettings = { basemap, geocoder };
    inMemorySettings = result;
    return result;
  } catch {
    return inMemorySettings ? { ...inMemorySettings } : { ...defaults };
  }
}

/**
 * Save settings to localStorage.
 */
export function saveSettings(settings: AppSettings): void {
  const basemap = { ...settings.basemap };
  const esriApiKey = basemap.esriApiKey?.trim();
  if (esriApiKey) basemap.esriApiKey = esriApiKey;
  else delete basemap.esriApiKey;
  if (basemap.satelliteProvider === 'esri' && !basemap.esriApiKey) {
    basemap.satelliteProvider = DEFAULT_SATELLITE_PROVIDER;
  }
  inMemorySettings = { ...settings, basemap };
  const storage = getLocalStorage();
  if (storage) {
    try {
      storage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(inMemorySettings));
    } catch {
      // Ignore quota or security errors
    }
  }
  notifySubscribers(inMemorySettings);
}

/**
 * Partially update basemap settings.
 */
export function updateBasemapSettings(patch: Partial<BasemapSettings>): AppSettings {
  const current = loadSettings();
  const basemap: BasemapSettings = {
    ...current.basemap,
    ...patch,
  };
  if (typeof patch.esriApiKey === 'string') {
    const key = patch.esriApiKey.trim();
    if (key) basemap.esriApiKey = key;
    else delete basemap.esriApiKey;
  }
  if (basemap.satelliteProvider === 'esri' && !basemap.esriApiKey) {
    basemap.satelliteProvider = DEFAULT_SATELLITE_PROVIDER;
  }
  const updated: AppSettings = {
    ...current,
    basemap,
  };
  saveSettings(updated);
  return updated;
}

/**
 * Partially update geocoder settings.
 */
export function updateGeocoderSettings(patch: Partial<GeocoderSettings>): AppSettings {
  const current = loadSettings();
  const updated: AppSettings = {
    ...current,
    geocoder: {
      ...current.geocoder,
      ...patch,
    },
  };
  saveSettings(updated);
  return updated;
}

/**
 * Reset all settings to defaults.
 */
export function resetSettings(): AppSettings {
  const defaults = getDefaultSettings();
  saveSettings(defaults);
  return defaults;
}

/**
 * Resets all app-owned interface keys in localStorage to defaults or removes them (T-224).
 * Does not touch IndexedDB, project data, or autosave.
 */
export function resetAppStorageKeys(): void {
  const storage = getLocalStorage();
  if (!storage) return;
  for (const key of APP_INTERFACE_STORAGE_KEYS) {
    try {
      if (key === SETTINGS_STORAGE_KEY) {
        storage.setItem(key, JSON.stringify(getDefaultSettings()));
      } else {
        storage.removeItem(key);
      }
    } catch {
      // Ignore quota or security errors
    }
  }
}

/**
 * Reset basemap style URL to the keyless default (OpenFreeMap liberty).
 */
export function resetBasemapStyleUrl(): string {
  updateBasemapSettings({ styleUrl: DEFAULT_BASEMAP_STYLE_URL });
  return DEFAULT_BASEMAP_STYLE_URL;
}

/**
 * Reset geocoder service URL to default (Nominatim).
 */
export function resetGeocoderServiceUrl(): string {
  updateGeocoderSettings({ serviceUrl: DEFAULT_GEOCODER_SERVICE_URL });
  return DEFAULT_GEOCODER_SERVICE_URL;
}

/**
 * Subscribe to settings changes.
 */
export function subscribeSettings(callback: (settings: AppSettings) => void): () => void {
  subscribers.add(callback);
  return () => {
    subscribers.delete(callback);
  };
}
