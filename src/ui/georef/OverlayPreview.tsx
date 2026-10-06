// Lane C. Georeferenced overlay preview component for live basemap (card T-309).
import React, {
  forwardRef,
  type ForwardRefRenderFunction,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import type { GeoJSONSource, Map as MapLibreMap } from 'maplibre-gl';
import { exportDocumentSteps } from '../../core/export/document';
import type { GeoFit } from '../../core/types';
import { encodeOverlayJpeg } from '../../io/overlay';
import {
  type AppSettings,
  DEFAULT_OVERLAY_OPACITY,
  loadSettings,
  subscribeSettings,
  updateBasemapSettings,
} from '../../io/settings';
import { useApp, useFit } from '../../state/hooks';
import { runSliced } from '../editor/slice';
import { BasemapConsent } from './BasemapConsent';
import { ImagerySwitch } from './ImagerySwitch';
import { computeInitialView } from './initialView';
import { loadMapLibre } from './loader';
import { getEffectiveStyle, getSatelliteHost } from './satellite';
import {
  buildOverlaySpec,
  debounce,
  DEFAULT_TPS_CELLS,
  FEATURES_SOURCE_ID,
  featuresToGeoJson,
  OVERLAY_LAYER_ID,
  OVERLAY_SOURCE_ID,
  type OverlaySpec,
  renderMeshToCanvas,
} from './overlaySource';
import type { BasemapHandle, OverlayPreviewProps } from './types';
import './georef.css';

const AREA_FILL_LAYER = 'trailmaker-overlay-areas-fill';
const AREA_STROKE_LAYER = 'trailmaker-overlay-areas-stroke';
const TRAIL_CASING_LAYER = 'trailmaker-overlay-trails-casing';
const TRAIL_LINE_LAYER = 'trailmaker-overlay-trails-line';
const POI_CASING_LAYER = 'trailmaker-overlay-pois-casing';
const POI_CIRCLE_LAYER = 'trailmaker-overlay-pois-circle';

function createObjectUrl(blob: Blob): string | null {
  return typeof URL.createObjectURL === 'function' ? URL.createObjectURL(blob) : null;
}

function revokeObjectUrl(url: string): void {
  if (typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(url);
}

const OverlayPreviewComponent: ForwardRefRenderFunction<BasemapHandle, OverlayPreviewProps> = (
  { className = '', style, overrideStyleUrl, handleRef },
  forwardedRef,
) => {
  const [settings, setSettings] = useState<AppSettings>(loadSettings);
  const [isDismissed, setIsDismissed] = useState(false);
  const [opacity, setOpacity] = useState<number>(() => {
    const s = loadSettings();
    return typeof s.basemap.opacity === 'number' ? s.basemap.opacity : DEFAULT_OVERLAY_OPACITY;
  });
  const [isReady, setIsReady] = useState(false);

  const [jpegUrl, setJpegUrl] = useState<string | null>(null);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapInstanceRef = useRef<MapLibreMap | null>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const jpegUrlRef = useRef<string | null>(null);

  const fit = useFit();
  const session = useApp((s) => s.session);
  const project = session?.project;
  const sessionMap = session?.map;
  const selectedFeatureId = useApp((s) => s.selectedFeatureId);

  const fitRef = useRef(fit);
  fitRef.current = fit;
  const projectRef = useRef(project);
  projectRef.current = project;
  const sessionMapRef = useRef(sessionMap);
  sessionMapRef.current = sessionMap;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const opacityRef = useRef(opacity);
  opacityRef.current = opacity;

  const isEnabled = settings.basemap.enabled && !isDismissed;
  const effectiveStyle = React.useMemo(() => {
    return getEffectiveStyle(settings.basemap, overrideStyleUrl);
  }, [settings.basemap, overrideStyleUrl]);

  // Subscribe to external settings changes
  useEffect(() => {
    return subscribeSettings((next) => {
      setSettings(next);
      if (typeof next.basemap.opacity === 'number') {
        setOpacity(next.basemap.opacity);
      }
    });
  }, []);

  // Expose imperative handle
  useImperativeHandle(
    forwardedRef || handleRef,
    (): BasemapHandle => ({
      getMap: () => mapInstanceRef.current,
      isReady: () => isReady && mapInstanceRef.current !== null,
      flyTo: (options) => {
        if (!mapInstanceRef.current) return;
        const flyOpts: { center: [number, number]; zoom?: number } = { center: options.center };
        if (typeof options.zoom === 'number') {
          flyOpts.zoom = options.zoom;
        }
        mapInstanceRef.current.flyTo(flyOpts);
      },
      fitBounds: (bounds, options) => {
        mapInstanceRef.current?.fitBounds(bounds, options);
      },
      getContainer: () => containerRef.current,
    }),
    [isReady],
  );

  // Encode overlay JPEG off the interaction path when sessionMap changes
  useEffect(() => {
    if (!sessionMap) {
      if (jpegUrlRef.current) {
        revokeObjectUrl(jpegUrlRef.current);
        jpegUrlRef.current = null;
      }
      setJpegUrl(null);
      return;
    }

    let isCancelled = false;
    encodeOverlayJpeg(sessionMap, 4096)
      .then((bytes) => {
        if (isCancelled) return;
        if (jpegUrlRef.current) {
          revokeObjectUrl(jpegUrlRef.current);
        }
        const blob = new Blob([bytes as unknown as BlobPart], {
          type: 'image/jpeg',
        });
        const url = createObjectUrl(blob);
        if (!url) {
          setJpegUrl(null);
          return;
        }
        jpegUrlRef.current = url;
        setJpegUrl(url);
      })
      .catch(() => {
        if (isCancelled) return;
        // Fallback for headless/JSDOM environments where canvas.toBlob is unavailable
        const fallbackBlob = new Blob([], { type: 'image/jpeg' });
        const fallbackUrl = createObjectUrl(fallbackBlob);
        if (!fallbackUrl) {
          setJpegUrl(null);
          return;
        }
        jpegUrlRef.current = fallbackUrl;
        setJpegUrl(fallbackUrl);
      });

    return () => {
      isCancelled = true;
    };
  }, [sessionMap]);

  // Clean up object URL on unmount
  useEffect(() => {
    return () => {
      if (jpegUrlRef.current) {
        revokeObjectUrl(jpegUrlRef.current);
        jpegUrlRef.current = null;
      }
    };
  }, []);

  // Update MapLibre raster layer opacity live
  const updateMapOpacity = useCallback((val: number) => {
    const map = mapInstanceRef.current;
    if (map && map.getLayer(OVERLAY_LAYER_ID)) {
      map.setPaintProperty(OVERLAY_LAYER_ID, 'raster-opacity', val);
    }
  }, []);

  const handleOpacityChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = Number(e.target.value) / 100;
    setOpacity(val);
    updateBasemapSettings({ opacity: val });
    updateMapOpacity(val);
  };

  // Helper to attach/update overlay layers
  const syncOverlaySource = useCallback(
    (currentFit: GeoFit, currentMap: MapLibreMap, currentOpacity: number) => {
      if (!sessionMap) return;

      const w = sessionMap.meta.width;
      const h = sessionMap.meta.height;
      const spec: OverlaySpec = buildOverlaySpec(currentFit, w, h, DEFAULT_TPS_CELLS);

      // Remove existing overlay layer and source if present
      if (currentMap.getLayer(OVERLAY_LAYER_ID)) {
        currentMap.removeLayer(OVERLAY_LAYER_ID);
      }
      if (currentMap.getSource(OVERLAY_SOURCE_ID)) {
        currentMap.removeSource(OVERLAY_SOURCE_ID);
      }

      if (spec.type === 'quad') {
        const url =
          jpegUrl ??
          jpegUrlRef.current ??
          'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
        currentMap.addSource(OVERLAY_SOURCE_ID, {
          type: 'image',
          url,
          coordinates: spec.coordinates,
        });
      } else {
        if (!overlayCanvasRef.current) {
          overlayCanvasRef.current = document.createElement('canvas');
        }
        const canvas = overlayCanvasRef.current;
        canvas.width = Math.min(4096, w);
        canvas.height = Math.min(4096, h);

        const imgSource = sessionMap.display;
        if (imgSource) {
          renderMeshToCanvas(spec, imgSource, canvas);
        }

        currentMap.addSource(OVERLAY_SOURCE_ID, {
          type: 'canvas',
          canvas,
          coordinates: spec.coordinates,
          animate: false,
        });
      }

      // Add overlay layer before feature layers so features render on top
      const beforeId = currentMap.getLayer(AREA_FILL_LAYER) ? AREA_FILL_LAYER : undefined;
      currentMap.addLayer(
        {
          id: OVERLAY_LAYER_ID,
          type: 'raster',
          source: OVERLAY_SOURCE_ID,
          paint: {
            'raster-opacity': currentOpacity,
            'raster-fade-duration': 0,
          },
        },
        beforeId,
      );
    },
    [sessionMap, jpegUrl],
  );

  // Helper to attach/update GeoJSON feature layers
  const syncFeatureLayers = useCallback(
    (currentMap: MapLibreMap) => {
      if (!currentMap.getSource(FEATURES_SOURCE_ID)) {
        currentMap.addSource(FEATURES_SOURCE_ID, {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: [] },
        });

        // Areas fill
        currentMap.addLayer({
          id: AREA_FILL_LAYER,
          type: 'fill',
          source: FEATURES_SOURCE_ID,
          filter: ['==', '$type', 'Polygon'],
          paint: {
            'fill-color': ['get', 'color'],
            'fill-opacity': 0.35,
          },
        });

        // Areas stroke
        currentMap.addLayer({
          id: AREA_STROKE_LAYER,
          type: 'line',
          source: FEATURES_SOURCE_ID,
          filter: ['==', '$type', 'Polygon'],
          paint: {
            'line-color': ['get', 'color'],
            'line-width': ['case', ['get', 'selected'], 4, 2],
          },
        });

        // Trails casing (white outline)
        currentMap.addLayer({
          id: TRAIL_CASING_LAYER,
          type: 'line',
          source: FEATURES_SOURCE_ID,
          filter: ['==', '$type', 'LineString'],
          paint: {
            'line-color': '#ffffff',
            'line-width': ['case', ['get', 'selected'], 7, 4],
          },
        });

        // Trails colored line
        currentMap.addLayer({
          id: TRAIL_LINE_LAYER,
          type: 'line',
          source: FEATURES_SOURCE_ID,
          filter: ['==', '$type', 'LineString'],
          paint: {
            'line-color': ['get', 'color'],
            'line-width': ['case', ['get', 'selected'], 4, 2],
          },
        });

        // POIs casing (white circle)
        currentMap.addLayer({
          id: POI_CASING_LAYER,
          type: 'circle',
          source: FEATURES_SOURCE_ID,
          filter: ['==', '$type', 'Point'],
          paint: {
            'circle-color': '#ffffff',
            'circle-radius': ['case', ['get', 'selected'], 9, 6],
          },
        });

        // POIs inner circle
        currentMap.addLayer({
          id: POI_CIRCLE_LAYER,
          type: 'circle',
          source: FEATURES_SOURCE_ID,
          filter: ['==', '$type', 'Point'],
          paint: {
            'circle-color': ['get', 'color'],
            'circle-radius': ['case', ['get', 'selected'], 7, 4],
          },
        });
      }
    },
    [],
  );

  const syncOverlaySourceRef = useRef(syncOverlaySource);
  syncOverlaySourceRef.current = syncOverlaySource;
  const syncFeatureLayersRef = useRef(syncFeatureLayers);
  syncFeatureLayersRef.current = syncFeatureLayers;

  // Initialize MapLibre instance
  useEffect(() => {
    if (!isEnabled || !containerRef.current || !fit?.ok) {
      if (mapInstanceRef.current) {
        mapInstanceRef.current.remove();
        mapInstanceRef.current = null;
        setIsReady(false);
      }
      return;
    }

    let isCancelled = false;

    loadMapLibre()
      .then((maplibre) => {
        if (isCancelled || !containerRef.current || mapInstanceRef.current) return;

        const currentFit = fitRef.current;
        const currentSessionMap = sessionMapRef.current;
        const currentProject = projectRef.current;
        const currentSettings = settingsRef.current;
        const currentOpacity = opacityRef.current;

        const imageDimensions = currentSessionMap?.meta
          ? { width: currentSessionMap.meta.width, height: currentSessionMap.meta.height }
          : undefined;

        const view = computeInitialView(
          currentFit,
          imageDimensions,
          currentProject?.anchors,
          currentSettings.basemap,
        );

        try {
          const map = new maplibre.Map({
            container: containerRef.current,
            style: effectiveStyle,
            center: view.center ?? [0, 20],
            zoom: view.zoom ?? (view.bounds ? 10 : 1),
            attributionControl: {
              compact: typeof window !== 'undefined' ? window.innerWidth <= 820 : true,
            },
          });

          map.addControl(new maplibre.NavigationControl({ showCompass: true }), 'top-left');
          map.addControl(new maplibre.ScaleControl({ unit: 'imperial' }), 'bottom-left');

          if (view.bounds) {
            map.fitBounds(view.bounds, { padding: 40, animate: false });
          }

          mapInstanceRef.current = map;
          if (!isCancelled) {
            setIsReady(true);
            syncFeatureLayersRef.current(map);
            if (currentFit && currentFit.ok) {
              syncOverlaySourceRef.current(currentFit, map, currentOpacity);
            }
          }
        } catch {
          // Ignore initialization error
        }
      })
      .catch(() => {
        // Ignore load error
      });

    return () => {
      isCancelled = true;
      if (mapInstanceRef.current) {
        mapInstanceRef.current.remove();
        mapInstanceRef.current = null;
        setIsReady(false);
      }
    };
  }, [isEnabled, effectiveStyle, fit?.ok]);

  // Debounced 300 ms re-warp on anchor/fit changes (Acceptance 4)
  useEffect(() => {
    if (!isReady || !mapInstanceRef.current || !fit?.ok) return;

    const debouncedWarp = debounce(() => {
      const map = mapInstanceRef.current;
      if (map && fit.ok) {
        syncOverlaySource(fit, map, opacityRef.current);
      }
    }, 300);

    debouncedWarp();
    return () => debouncedWarp.cancel();
  }, [isReady, fit, syncOverlaySource]);

  // Debounced 150 ms features update on feature edits (Acceptance 3, D-025 item 4 / T-313 acceptance 5)
  useEffect(() => {
    if (!isReady || !mapInstanceRef.current || !fit?.ok || !project) return;

    let cancelled = false;

    const debouncedFeatures = debounce(() => {
      const map = mapInstanceRef.current;
      if (!map || !fit.ok || cancelled) return;

      const source = map.getSource(FEATURES_SOURCE_ID) as GeoJSONSource | undefined;
      if (source && source.setData) {
        runSliced(exportDocumentSteps(project, fit), {
          cancelled: () => cancelled,
        })
          .then((doc) => {
            if (cancelled) return;
            const geojson = featuresToGeoJson(doc.features, selectedFeatureId);
            source.setData(geojson as never);
          })
          .catch((err) => {
            if ((err as Error)?.name === 'JobCancelled') return;
            console.error('[OverlayPreview] exportDocumentSteps error:', err);
          });
      }
    }, 150);

    debouncedFeatures();
    return () => {
      cancelled = true;
      debouncedFeatures.cancel();
    };
  }, [isReady, fit, project, project?.features, selectedFeatureId]);

  const handleContainerKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    const map = mapInstanceRef.current;
    if (!map) return;

    const step = e.shiftKey ? 250 : 80;

    if (e.key === 'ArrowUp') {
      e.preventDefault();
      map.panBy?.([0, -step], { duration: 0 });
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      map.panBy?.([0, step], { duration: 0 });
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      map.panBy?.([-step, 0], { duration: 0 });
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      map.panBy?.([step, 0], { duration: 0 });
    } else if (e.key === '+' || e.key === '=') {
      e.preventDefault();
      map.zoomIn?.({ duration: 0 });
    } else if (e.key === '-' || e.key === '_') {
      e.preventDefault();
      map.zoomOut?.({ duration: 0 });
    }
  }, []);

  // Hidden until the fit is ok ("Pin at least 2 anchors to preview", Acceptance 5)
  if (!fit || !fit.ok) {
    return (
      <div
        className={`trailmaker-overlay-preview trailmaker-overlay-empty-container ${className}`}
        style={style}
        role="region"
        aria-label="Overlay preview"
      >
        <div className="trailmaker-overlay-empty" role="status">
          Pin at least 2 anchors to preview
        </div>
      </div>
    );
  }

  // Network opt-in / consent overlay
  if (!isEnabled) {
    return (
      <div
        className={`trailmaker-overlay-preview ${className}`}
        style={style}
        role="region"
        aria-label="Overlay preview"
      >
        <BasemapConsent
          styleUrl={typeof effectiveStyle === 'string' ? effectiveStyle : settings.basemap.styleUrl}
          satelliteHost={getSatelliteHost(settings.basemap.satelliteProvider)}
          onEnable={() => {
            updateBasemapSettings({ enabled: true });
            setIsDismissed(false);
          }}
          onDismiss={() => setIsDismissed(true)}
        />
      </div>
    );
  }

  return (
    <div
      className={`trailmaker-overlay-preview ${className}`}
      style={style}
      role="region"
      aria-label="Overlay preview"
    >
      <div
        ref={containerRef}
        id="trailmaker-overlay-map-container"
        className="trailmaker-overlay-map-container"
        tabIndex={0}
        role="region"
        aria-label="Georeferenced overlay map. Use arrow keys to pan, plus and minus to zoom."
        onKeyDown={handleContainerKeyDown}
      />

      <div className="trailmaker-overlay-controls" role="toolbar" aria-label="Overlay controls">
        <ImagerySwitch
          imagery={settings.basemap.imagery ?? 'vector'}
          onChange={(imagery) => updateBasemapSettings({ imagery })}
        />
        <div className="trailmaker-overlay-opacity-control">
          <label htmlFor="trailmaker-overlay-opacity">Map opacity</label>
          <input
            id="trailmaker-overlay-opacity"
            type="range"
            min="0"
            max="100"
            value={Math.round(opacity * 100)}
            onChange={handleOpacityChange}
            aria-label="Map opacity"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(opacity * 100)}
            aria-valuetext={`${Math.round(opacity * 100)}%`}
          />
          <span className="trailmaker-overlay-opacity-value">{Math.round(opacity * 100)}%</span>
        </div>
      </div>
    </div>
  );
};

export const OverlayPreview = forwardRef<BasemapHandle, OverlayPreviewProps>(OverlayPreviewComponent);
OverlayPreview.displayName = 'OverlayPreview';
