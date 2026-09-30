import { describe, expect, it } from 'vitest';
import {
  buildSatelliteStyle,
  getAllSatelliteHosts,
  getEffectiveStyle,
  getSatelliteHost,
  SATELLITE_PROVIDERS,
} from './satellite';
import { DEFAULT_BASEMAP_STYLE_URL, type BasemapSettings } from '../../io/settings';

describe('satellite basemap (card T-316)', () => {
  describe('SATELLITE_PROVIDERS configuration', () => {
    it('configures USGS NAIP exportImage as the sharp public-domain provider', () => {
      const naip = SATELLITE_PROVIDERS.naip;
      expect(naip.host).toBe('imagery.nationalmap.gov');
      expect(naip.tileUrl).toContain('/USGSNAIPImagery/ImageServer/exportImage?bbox={bbox-epsg-3857}');
      expect(naip.tileUrl).toContain('format=jpgpng&f=image');
      expect(naip.name).toBe('USGS NAIP (US, sharpest)');
    });
    it('configures keyless USGS Imagery Only with public domain terms', () => {
      const usgs = SATELLITE_PROVIDERS.usgs;
      expect(usgs.id).toBe('usgs');
      expect(usgs.host).toBe('basemap.nationalmap.gov');
      expect(usgs.tileUrl).toBe(
        'https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}',
      );
      expect(usgs.attribution).toContain('USGS The National Map');
      expect(usgs.maxZoom).toBe(16);
      expect(usgs.tileSize).toBe(256);
    });

    it('configures keyed Esri World Imagery with current attribution', () => {
      const esri = SATELLITE_PROVIDERS.esri;
      expect(esri.id).toBe('esri');
      expect(esri.host).toBe('ibasemaps-api.arcgis.com');
      expect(esri.tileUrl).toBe(
        'https://ibasemaps-api.arcgis.com/arcgis/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      );
      expect(esri.attribution).toBe('Esri, Vantor, Earthstar Geographics, and the GIS User Community');
      expect(esri.maxZoom).toBe(19);
      expect(esri.tileSize).toBe(256);
    });
  });

  describe('buildSatelliteStyle', () => {
    it('renders USGS underneath transparent NAIP coverage', () => {
      const style = buildSatelliteStyle('naip');
      expect(style.sources['usgs-fallback-source']).toBeDefined();
      expect(style.layers.map((layer) => layer.id)).toEqual(['usgs-fallback-layer', 'satellite-raster-layer']);
    });

    it('builds an inline raster MapLibre StyleSpecification for USGS', () => {
      const style = buildSatelliteStyle('usgs');
      expect(style.version).toBe(8);
      expect(style.sources).toBeDefined();

      const source = style.sources['satellite-raster-source'] as {
        type: string;
        tiles: string[];
        tileSize: number;
        attribution: string;
        maxzoom: number;
      };
      expect(source.type).toBe('raster');
      expect(source.tiles).toEqual([SATELLITE_PROVIDERS.usgs.tileUrl]);
      expect(source.tileSize).toBe(256);
      expect(source.attribution).toBe(SATELLITE_PROVIDERS.usgs.attribution);
      expect(source.maxzoom).toBe(16);

      expect(style.layers).toHaveLength(1);
      const layer = style.layers[0] as {
        id: string;
        type: string;
        source: string;
      };
      expect(layer.id).toBe('satellite-raster-layer');
      expect(layer.type).toBe('raster');
      expect(layer.source).toBe('satellite-raster-source');
    });

    it('builds an inline raster MapLibre StyleSpecification for Esri', () => {
      const style = buildSatelliteStyle('esri', 'api key');
      expect(style.version).toBe(8);
      const source = style.sources['satellite-raster-source'] as {
        type: string;
        tiles: string[];
        maxzoom: number;
        attribution: string;
      };
      expect(source.type).toBe('raster');
      expect(source.tiles).toEqual([`${SATELLITE_PROVIDERS.esri.tileUrl}?token=api%20key`]);
      expect(source.attribution).toBe('Esri, Vantor, Earthstar Geographics, and the GIS User Community');
      expect(source.maxzoom).toBe(19);
    });

    it('falls back to default NAIP when an Esri key is absent', () => {
      const style = buildSatelliteStyle('esri');
      const source = style.sources['satellite-raster-source'] as { tiles: string[] };
      expect(source.tiles).toEqual([SATELLITE_PROVIDERS.naip.tileUrl]);
    });

    it('falls back safely to USGS if an unknown provider is passed', () => {
      // @ts-expect-error testing fallback
      const style = buildSatelliteStyle('unknown');
      const source = style.sources['satellite-raster-source'] as { tiles: string[] };
      expect(source.tiles).toEqual([SATELLITE_PROVIDERS.usgs.tileUrl]);
    });
  });

  describe('getEffectiveStyle', () => {
    const baseSettings: BasemapSettings = {
      enabled: true,
      styleUrl: 'https://tiles.openfreemap.org/styles/liberty',
      imagery: 'vector',
      satelliteProvider: 'usgs',
      opacity: 0.6,
    };

    it('returns overrideStyleUrl when provided regardless of settings', () => {
      const override = '/__test_basemap/style.json';
      expect(getEffectiveStyle(baseSettings, override)).toBe(override);

      const satelliteSettings: BasemapSettings = {
        ...baseSettings,
        imagery: 'satellite',
      };
      expect(getEffectiveStyle(satelliteSettings, override)).toBe(override);
    });

    it('returns vector styleUrl when imagery is vector', () => {
      const style = getEffectiveStyle(baseSettings);
      expect(style).toBe('https://tiles.openfreemap.org/styles/liberty');
    });

    it('falls back to default basemap style URL when styleUrl is empty', () => {
      const emptyUrlSettings: BasemapSettings = {
        ...baseSettings,
        styleUrl: '',
      };
      expect(getEffectiveStyle(emptyUrlSettings)).toBe(DEFAULT_BASEMAP_STYLE_URL);
    });

    it('returns an inline StyleSpecification when imagery is satellite', () => {
      const satelliteSettings: BasemapSettings = {
        ...baseSettings,
        imagery: 'satellite',
        satelliteProvider: 'esri',
        esriApiKey: 'api-key',
      };
      const style = getEffectiveStyle(satelliteSettings);
      expect(typeof style).toBe('object');
      const spec = style as import('maplibre-gl').StyleSpecification;
      expect(spec.version).toBe(8);
      const source = spec.sources['satellite-raster-source'] as { tiles: string[] };
      expect(source.tiles).toEqual([`${SATELLITE_PROVIDERS.esri.tileUrl}?token=api-key`]);
    });
  });

  describe('host utilities', () => {
    it('returns correct hostname for NAIP, USGS and Esri', () => {
      expect(getSatelliteHost('naip')).toBe('imagery.nationalmap.gov');
      expect(getSatelliteHost('usgs')).toBe('basemap.nationalmap.gov');
      expect(getSatelliteHost('esri')).toBe('ibasemaps-api.arcgis.com');
      expect(getSatelliteHost()).toBe('imagery.nationalmap.gov');
    });

    it('returns all satellite hosts', () => {
      const hosts = getAllSatelliteHosts();
      expect(hosts).toContain('imagery.nationalmap.gov');
      expect(hosts).toContain('basemap.nationalmap.gov');
      expect(hosts).toContain('ibasemaps-api.arcgis.com');
    });
  });
});
