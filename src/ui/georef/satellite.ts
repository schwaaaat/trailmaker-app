// Lane C: Satellite basemap configuration, style builder, and connectivity hook (card T-316).
import { useEffect, useState } from 'react';
import type { StyleSpecification } from 'maplibre-gl';
import {
  DEFAULT_BASEMAP_STYLE_URL,
  type BasemapSettings,
  type SatelliteProviderId,
} from '../../io/settings';

export interface SatelliteProviderConfig {
  id: SatelliteProviderId;
  name: string;
  tileUrl: string;
  host: string;
  attribution: string;
  maxZoom: number;
  tileSize: number;
  description: string;
}

export const SATELLITE_PROVIDERS: Record<SatelliteProviderId, SatelliteProviderConfig> = {
  naip: {
    id: 'naip',
    name: 'USGS NAIP (US, sharpest)',
    tileUrl:
      'https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPImagery/ImageServer/exportImage?bbox={bbox-epsg-3857}&bboxSR=3857&imageSR=3857&size=256,256&format=jpgpng&f=image',
    host: 'imagery.nationalmap.gov',
    attribution: 'USGS, USDA, The National Map: Orthoimagery',
    maxZoom: 22,
    tileSize: 256,
    description: 'US public-domain aerial imagery at up to 0.3 m/px where available.',
  },
  usgs: {
    id: 'usgs',
    name: 'USGS Imagery Only',
    tileUrl:
      'https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}',
    host: 'basemap.nationalmap.gov',
    attribution: 'USGS The National Map',
    maxZoom: 16,
    tileSize: 256,
    description: 'US government public domain aerial/satellite imagery (US coverage).',
  },
  esri: {
    id: 'esri',
    name: 'Esri World Imagery',
    tileUrl:
      'https://ibasemaps-api.arcgis.com/arcgis/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    host: 'ibasemaps-api.arcgis.com',
    attribution: 'Esri, Vantor, Earthstar Geographics, and the GIS User Community',
    maxZoom: 19,
    tileSize: 256,
    description: 'Live imagery only. Requires your ArcGIS API key; Esri prohibits offline tile export.',
  },
};

/**
 * Builds an inline MapLibre StyleSpecification for raster satellite imagery.
 * Does not require external style JSON or font glyph downloads.
 */
export function buildSatelliteStyle(
  providerId: SatelliteProviderId = 'naip',
  esriApiKey?: string,
): StyleSpecification {
  if (providerId === 'esri' && !esriApiKey?.trim()) providerId = 'naip';
  const config = SATELLITE_PROVIDERS[providerId] ?? SATELLITE_PROVIDERS.usgs;
  const isNaip = config.id === 'naip';
  const tileUrl = providerId === 'esri'
    ? `${config.tileUrl}?token=${encodeURIComponent(esriApiKey!.trim())}`
    : config.tileUrl;
  return {
    version: 8,
    sources: {
      ...(isNaip ? {
        'usgs-fallback-source': {
          type: 'raster' as const,
          tiles: [SATELLITE_PROVIDERS.usgs.tileUrl],
          tileSize: SATELLITE_PROVIDERS.usgs.tileSize,
          attribution: SATELLITE_PROVIDERS.usgs.attribution,
          maxzoom: SATELLITE_PROVIDERS.usgs.maxZoom,
        },
      } : {}),
      'satellite-raster-source': {
        type: 'raster',
        tiles: [tileUrl],
        tileSize: config.tileSize,
        attribution: config.attribution,
        maxzoom: config.maxZoom,
      },
    },
    layers: [
      ...(isNaip ? [{
        id: 'usgs-fallback-layer',
        type: 'raster' as const,
        source: 'usgs-fallback-source',
        minzoom: 0,
        maxzoom: 22,
      }] : []),
      {
        id: 'satellite-raster-layer',
        type: 'raster',
        source: 'satellite-raster-source',
        minzoom: 0,
        maxzoom: 22,
      },
    ],
  };
}

/**
 * Returns the effective MapLibre style (StyleSpecification object or style URL string)
 * taking into account vector vs satellite imagery choice and potential test overrides.
 */
export function getEffectiveStyle(
  settings: BasemapSettings,
  overrideStyleUrl?: string,
): StyleSpecification | string {
  if (overrideStyleUrl) {
    return overrideStyleUrl;
  }
  if (settings.imagery === 'satellite') {
    return buildSatelliteStyle(settings.satelliteProvider ?? 'naip', settings.esriApiKey);
  }
  return settings.styleUrl || DEFAULT_BASEMAP_STYLE_URL;
}

export function getSatelliteHost(providerId: SatelliteProviderId = 'naip'): string {
  return SATELLITE_PROVIDERS[providerId]?.host ?? 'imagery.nationalmap.gov';
}

export function getAllSatelliteHosts(): string[] {
  return Object.values(SATELLITE_PROVIDERS).map((p) => p.host);
}

/**
 * React hook that monitors network connectivity.
 * Used to indicate when satellite imagery cannot be loaded offline.
 */
export function useOnlineStatus(): boolean {
  const [isOnline, setIsOnline] = useState<boolean>(() => {
    if (typeof navigator !== 'undefined' && typeof navigator.onLine === 'boolean') {
      return navigator.onLine;
    }
    return true;
  });

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  return isOnline;
}
