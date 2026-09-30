import React, {
  type ForwardRefRenderFunction,
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';

void React;
import type { Map as MapLibreMap, GeoJSONSource } from 'maplibre-gl';
import type { LatLon, Px } from '../../core/types';
import {
  loadSettings,
  subscribeSettings,
  updateBasemapSettings,
  resetBasemapStyleUrl,
  updateGeocoderSettings,
  resetGeocoderServiceUrl,
  type AppSettings,
} from '../../io/settings';
import { setAnchorCoords } from '../../state/commands';
import { useApp, useFit } from '../../state/hooks';
import {
  appStore,
  clearSatelliteCaptureRequest,
  edit,
  sealHistory,
  selectAnchor,
  setAnchorDragging,
} from '../../state/store';
import { onEditor } from '../editor/EditorStage';
import { BasemapConsent } from './BasemapConsent';
import { BasemapSettingsPopover } from './BasemapSettingsPopover';
import { GeoSearchBox } from './GeoSearchBox';
import { ImagerySwitch } from './ImagerySwitch';
import { SatelliteFramingOverlay } from './SatelliteFramingOverlay';
import { getEffectiveStyle, getSatelliteHost } from './satellite';
import {
  clearActiveGpx,
  getActiveGpx,
  loadGpxBlob,
  subscribeActiveGpx,
  type StoredGpxLayer,
} from '../../io/gpxStorage';
import { GpxPointsList } from './GpxPointsList';
import { BasemapCrosshair, computeParkMapMatch, ParkMapIndicator } from './crosshair';
import { computeInitialView } from './initialView';
import { loadMapLibre } from './loader';
import { MarkerManager } from './markers';
import {
  getPairingState,
  handleBasemapClick,
  handleCancelPairing,
  PAIRING_PROMPT,
} from './pairing';
import type { BasemapHandle, BasemapPaneProps } from './types';
import './georef.css';

const BasemapPaneComponent: ForwardRefRenderFunction<BasemapHandle, BasemapPaneProps> = (
  {
    className = '',
    style,
    handleRef,
    onMapClick,
    overrideStyleUrl,
    confirm,
    onResetInterface,
    children,
  },
  forwardedRef,
) => {
  const [settings, setSettings] = useState<AppSettings>(loadSettings);
  const [isDismissed, setIsDismissed] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isFramingOpen, setIsFramingOpen] = useState(false);
  const [mapError, setMapError] = useState<string | null>(null);
  const [isReady, setIsReady] = useState(false);
  const [hoverPx, setHoverPx] = useState<Px | null>(null);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapInstanceRef = useRef<MapLibreMap | null>(null);
  const maplibreModuleRef = useRef<typeof import('maplibre-gl') | null>(null);
  const markerManagerRef = useRef<MarkerManager>(new MarkerManager());
  const crosshairRef = useRef<BasemapCrosshair>(new BasemapCrosshair());

  const appState = useApp((s) => s);
  const pairing = getPairingState(appState);
  const satelliteCaptureRequested = useApp((s) => s.satelliteCaptureRequested);

  const fit = useFit();
  const project = appState.session?.project;
  const imageDimensions = project?.image
    ? { width: project.image.width, height: project.image.height }
    : undefined;
  const anchors = project?.anchors;

  const onMapClickRef = useRef(onMapClick);
  onMapClickRef.current = onMapClick;

  const confirmRef = useRef(confirm);
  confirmRef.current = confirm;

  const fitRef = useRef(fit);
  fitRef.current = fit;

  const imageDimensionsRef = useRef(imageDimensions);
  imageDimensionsRef.current = imageDimensions;

  const anchorsRef = useRef(anchors);
  anchorsRef.current = anchors;

  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  const [gpxLayer, setGpxLayer] = useState<StoredGpxLayer | null>(getActiveGpx);
  const [isGpxListOpen, setIsGpxListOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Subscribe to external settings changes
  useEffect(() => {
    return subscribeSettings((newSettings) => {
      setSettings(newSettings);
      if (!newSettings.basemap.enabled) {
        setIsDismissed(false);
      }
    });
  }, []);

  // Subscribe to external active GPX changes
  useEffect(() => {
    return subscribeActiveGpx((newLayer) => {
      setGpxLayer(newLayer);
    });
  }, []);

  const handleStartFraming = useCallback(() => {
    const current = loadSettings();
    if (!current.basemap.enabled) {
      setIsDismissed(false);
      return;
    }
    if (current.basemap.imagery !== 'satellite') {
      updateBasemapSettings({ imagery: 'satellite' });
    }
    setSettings(current);
    setIsFramingOpen(true);
  }, []);

  // When satellite capture is requested via store, open framing overlay and clear flag (T-318)
  useEffect(() => {
    if (satelliteCaptureRequested) {
      handleStartFraming();
      clearSatelliteCaptureRequest();
    }
  }, [satelliteCaptureRequested, handleStartFraming]);

  const syncGpxLayer = useCallback((map: MapLibreMap, layer: StoredGpxLayer | null) => {
    const sourceId = 'trailmaker-imported-gpx';
    const linesLayerId = 'trailmaker-gpx-lines-layer';
    const pointsLayerId = 'trailmaker-gpx-points-layer';

    if (typeof map.isStyleLoaded === 'function' && !map.isStyleLoaded()) {
      if (typeof map.once === 'function') {
        map.once('style.load', () => syncGpxLayer(map, layer));
      }
      return;
    }

    if (typeof map.getSource !== 'function' || typeof map.addSource !== 'function') {
      return;
    }

    if (!layer || layer.points.length === 0) {
      if (typeof map.getLayer === 'function') {
        if (map.getLayer(pointsLayerId)) map.removeLayer(pointsLayerId);
        if (map.getLayer(linesLayerId)) map.removeLayer(linesLayerId);
      }
      if (map.getSource(sourceId)) map.removeSource(sourceId);
      return;
    }

    const geojson = {
      type: 'FeatureCollection' as const,
      features: [
        ...layer.tracks.map((t, idx) => ({
          type: 'Feature' as const,
          id: `trk-${idx}`,
          properties: { name: t.name, kind: 'track' },
          geometry: {
            type: 'LineString' as const,
            coordinates: t.points.map((p) => [p[1], p[0]]),
          },
        })),
        ...layer.points.map((p) => ({
          type: 'Feature' as const,
          id: p.id,
          properties: {
            id: p.id,
            name: p.name,
            kind: p.kind,
            lat: p.ll[0],
            lon: p.ll[1],
          },
          geometry: {
            type: 'Point' as const,
            coordinates: [p.ll[1], p.ll[0]],
          },
        })),
      ],
    };

    const existingSource = map.getSource(sourceId) as GeoJSONSource | undefined;
    if (existingSource && typeof existingSource.setData === 'function') {
      existingSource.setData(geojson);
    } else {
      if (existingSource) {
        if (map.getLayer(pointsLayerId)) map.removeLayer(pointsLayerId);
        if (map.getLayer(linesLayerId)) map.removeLayer(linesLayerId);
        map.removeSource(sourceId);
      }
      map.addSource(sourceId, {
        type: 'geojson',
        data: geojson,
      });

      if (!map.getLayer(linesLayerId)) {
        map.addLayer({
          id: linesLayerId,
          type: 'line',
          source: sourceId,
          filter: ['==', '$type', 'LineString'],
          paint: {
            'line-color': '#f59e0b',
            'line-width': 2.5,
            'line-opacity': 0.75,
            'line-dasharray': [2, 1],
          },
        });
      }

      if (!map.getLayer(pointsLayerId)) {
        map.addLayer({
          id: pointsLayerId,
          type: 'circle',
          source: sourceId,
          filter: ['==', '$type', 'Point'],
          paint: {
            'circle-color': '#f59e0b',
            'circle-radius': 6,
            'circle-stroke-width': 2,
            'circle-stroke-color': '#ffffff',
          },
        });

        map.on('click', pointsLayerId, (e) => {
          const feat = e.features?.[0];
          if (!feat || !feat.geometry) return;
          const coords = (feat.geometry as { coordinates: [number, number] }).coordinates;
          const latLon: LatLon = [coords[1]!, coords[0]!];
          const curState = appStore.getState();
          const curProject = curState.session?.project;
          if (curProject) {
            handleBasemapClick(latLon, {
              project: curProject,
              state: curState,
              edit,
              confirm: confirmRef.current,
            });
          }
          const containerRect = containerRef.current?.getBoundingClientRect();
          const pt = containerRect
            ? { x: e.point.x, y: e.point.y }
            : { x: 0, y: 0 };
          onMapClickRef.current?.(latLon, pt);
        });

        map.on('mouseenter', pointsLayerId, () => {
          const canvas = map.getCanvas();
          if (canvas) canvas.style.cursor = 'pointer';
        });

        map.on('mouseleave', pointsLayerId, () => {
          const canvas = map.getCanvas();
          if (canvas) canvas.style.cursor = '';
        });
      }
    }
  }, []);

  useEffect(() => {
    if (!isReady || !mapInstanceRef.current) return;
    syncGpxLayer(mapInstanceRef.current, gpxLayer);
  }, [isReady, gpxLayer, syncGpxLayer]);

  const effectiveStyle = React.useMemo(() => {
    return getEffectiveStyle(settings.basemap, overrideStyleUrl);
  }, [settings.basemap, overrideStyleUrl]);
  const effectiveStyleRef = useRef(effectiveStyle);
  effectiveStyleRef.current = effectiveStyle;
  const isEnabled = settings.basemap.enabled;

  // Imperative handle
  useImperativeHandle(
    forwardedRef || handleRef,
    (): BasemapHandle => ({
      getMap: () => mapInstanceRef.current,
      isReady: () => isReady,
      flyTo: (options) => {
        if (mapInstanceRef.current) {
          mapInstanceRef.current.flyTo(options);
        }
      },
      fitBounds: (bounds, options) => {
        if (mapInstanceRef.current) {
          mapInstanceRef.current.fitBounds(bounds, options);
        }
      },
      getContainer: () => containerRef.current,
    }),
    [isReady],
  );

  // Synchronize anchor markers with map
  const syncMarkers = useCallback(() => {
    if (!isReady || !mapInstanceRef.current || !maplibreModuleRef.current) return;

    markerManagerRef.current.sync({
      map: mapInstanceRef.current,
      maplibre: maplibreModuleRef.current,
      anchors: anchorsRef.current ?? [],
      selectedAnchorId: appStore.getState().selectedAnchorId,
      fit: fitRef.current,
      onSelectAnchor: (id) => selectAnchor(id),
      onMoveAnchor: (id, ll) => {
        const curProject = appStore.getState().session?.project;
        if (curProject) {
          edit(setAnchorCoords(curProject, id, ll, 'basemap'), { anchor: id });
          sealHistory();
        }
      },
      onDragStart: (id) => {
        selectAnchor(id);
        setAnchorDragging(true);
        sealHistory();
      },
      onDragEnd: () => {
        setAnchorDragging(false);
      },
    });
  }, [isReady]);

  // Update map style if effectiveStyle changes while map exists
  useEffect(() => {
    if (mapInstanceRef.current) {
      const map = mapInstanceRef.current;
      map.setStyle(effectiveStyle);
      if (typeof map.once === 'function') {
        map.once('style.load', () => {
          if (gpxLayer) syncGpxLayer(map, gpxLayer);
          syncMarkers();
        });
      }
    }
  }, [effectiveStyle, gpxLayer, syncGpxLayer, syncMarkers]);

  useEffect(() => {
    syncMarkers();
  }, [syncMarkers, anchors, appState.selectedAnchorId, fit]);

  // Listen to Esc key to cancel pending pairing
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        const curState = appStore.getState();
        const curProject = curState.session?.project;
        if (curProject) {
          handleCancelPairing({
            project: curProject,
            state: curState,
            edit,
            selectAnchor,
          });
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // Follow park-map cursor with a faint crosshair on the basemap
  useEffect(() => {
    if (!isReady || !mapInstanceRef.current || !maplibreModuleRef.current) return;

    const crosshair = crosshairRef.current;
    let unsubCursor: (() => void) | undefined;
    const unsubEditor = onEditor((editor) => {
      unsubCursor?.();
      if (!editor) {
        crosshair.destroy();
        return;
      }
      unsubCursor = editor.on('cursor', (e) => {
        crosshair.update(
          e?.inside ? e.px : null,
          fitRef.current,
          mapInstanceRef.current,
          maplibreModuleRef.current,
        );
      });
    });

    return () => {
      unsubCursor?.();
      unsubEditor();
      crosshair.destroy();
    };
  }, [isReady]);

  // Initialize and tear down MapLibre instance based on isEnabled
  useEffect(() => {
    if (!isEnabled || !containerRef.current) {
      if (mapInstanceRef.current) {
        markerManagerRef.current.destroy();
        crosshairRef.current.destroy();
        mapInstanceRef.current.remove();
        mapInstanceRef.current = null;
        maplibreModuleRef.current = null;
        setIsReady(false);
        setHoverPx(null);
      }
      return;
    }

    let isCancelled = false;

    loadMapLibre()
      .then((maplibre) => {
        if (isCancelled || !containerRef.current) return;

        if (mapInstanceRef.current) return;
        maplibreModuleRef.current = maplibre;

        const view = computeInitialView(
          fitRef.current,
          imageDimensionsRef.current,
          anchorsRef.current,
          settingsRef.current.basemap,
        );

        try {
          const map = new maplibre.Map({
            container: containerRef.current,
            style: effectiveStyleRef.current,
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

          map.on('error', () => {
            if (!isCancelled) {
              setMapError('Basemap unavailable — pasting coordinates still works');
            }
          });

          map.on('click', (e) => {
            const latLon: LatLon = [e.lngLat.lat, e.lngLat.lng];
            const curState = appStore.getState();
            const curProject = curState.session?.project;
            if (curProject) {
              handleBasemapClick(latLon, {
                project: curProject,
                state: curState,
                edit,
                confirm: confirmRef.current,
              });
            }
            onMapClickRef.current?.(latLon, { x: e.point.x, y: e.point.y });
          });

          map.on('mousemove', (e) => {
            const match = computeParkMapMatch(
              [e.lngLat.lat, e.lngLat.lng],
              fitRef.current,
              imageDimensionsRef.current,
            );
            setHoverPx(match);
          });

          map.on('mouseout', () => {
            setHoverPx(null);
          });

          map.on('moveend', () => {
            if (!mapInstanceRef.current) return;
            const c = map.getCenter();
            const z = map.getZoom();
            updateBasemapSettings({
              lastCenter: [c.lng, c.lat],
              lastZoom: z,
            });
          });

          mapInstanceRef.current = map;
          if (!isCancelled) {
            setIsReady(true);
          }
        } catch {
          if (!isCancelled) {
            setMapError('Basemap unavailable — pasting coordinates still works');
          }
        }
      })
      .catch(() => {
        if (!isCancelled) {
          setMapError('Basemap unavailable — pasting coordinates still works');
        }
      });

    const markerManager = markerManagerRef.current;
    const crosshair = crosshairRef.current;

    return () => {
      isCancelled = true;
      if (mapInstanceRef.current) {
        markerManager.destroy();
        crosshair.destroy();
        mapInstanceRef.current.remove();
        mapInstanceRef.current = null;
        maplibreModuleRef.current = null;
        setIsReady(false);
        setHoverPx(null);
      }
    };
  }, [isEnabled]);

  const isPending = pairing.status === 'pending';

  // Trigger pair point at the map center crosshair (Acceptance 4)
  const triggerCenterPairing = useCallback(() => {
    const map = mapInstanceRef.current;
    if (!map) return;
    const center = map.getCenter();
    const latLon: LatLon = [center.lat, center.lng];
    const curState = appStore.getState();
    const curProject = curState.session?.project;
    if (curProject) {
      handleBasemapClick(latLon, {
        project: curProject,
        state: curState,
        edit,
        confirm: confirmRef.current,
      });
    }
    const containerRect = containerRef.current?.getBoundingClientRect();
    const pt = containerRect
      ? { x: containerRect.width / 2, y: containerRect.height / 2 }
      : { x: 0, y: 0 };
    onMapClickRef.current?.(latLon, pt);
  }, []);

  // Keyboard navigation when basemap container is focused (Acceptance 4)
  const handleContainerKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
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
      } else if (e.key === 'Enter') {
        e.preventDefault();
        triggerCenterPairing();
      }
    },
    [triggerCenterPairing],
  );

  // Auto-focus basemap and handle keyboard navigation during pending pairing (Acceptance 4)
  useEffect(() => {
    if (!isPending) return;

    if (containerRef.current && typeof containerRef.current.focus === 'function') {
      containerRef.current.focus();
    }

    const onWindowKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const isElement = Boolean(target && typeof (target as Element).closest === 'function');
      const isEditing =
        isElement &&
        (target!.tagName === 'INPUT' ||
          target!.tagName === 'TEXTAREA' ||
          target!.tagName === 'SELECT' ||
          Boolean(target!.isContentEditable) ||
          Boolean((target as Element).closest('[role="dialog"]')));
      if (isEditing) return;

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
      } else if (e.key === 'Enter') {
        e.preventDefault();
        triggerCenterPairing();
      }
    };

    window.addEventListener('keydown', onWindowKeyDown);
    return () => window.removeEventListener('keydown', onWindowKeyDown);
  }, [isPending, triggerCenterPairing]);

  const handleEnable = (): void => {
    updateBasemapSettings({ enabled: true });
    setIsDismissed(false);
    setMapError(null);
  };

  const handleDismiss = (): void => {
    setIsDismissed(true);
  };

  return (
    <div
      className={`trailmaker-basemap-pane ${className}`}
      style={style}
      role="region"
      aria-label="Basemap"
    >
      <div
        ref={containerRef}
        id="trailmaker-basemap-container"
        className={`trailmaker-basemap-container${isPending ? ' pairing-pending' : ''}`}
        tabIndex={0}
        role="application"
        aria-label="Live basemap. Use arrow keys to pan, plus and minus to zoom, and Enter to place pair point."
        onKeyDown={handleContainerKeyDown}
      />

      {isPending && (
        <div
          className="trailmaker-basemap-center-crosshair"
          aria-hidden="true"
          title="Map center crosshair"
        />
      )}

      {isEnabled && settings.basemap.imagery === 'satellite' && settings.basemap.satelliteProvider === 'naip' && (
        <div className="trailmaker-naip-coverage-status" role="status">
          NAIP shown where available; USGS imagery fills areas with no NAIP.
        </div>
      )}

      {isPending && (
        <div
          className="trailmaker-georef-prompt-banner"
          role="status"
          aria-live="polite"
        >
          {PAIRING_PROMPT}
        </div>
      )}

      {isEnabled && !isReady && !mapError && (
        <div className="sr-only" role="status" aria-live="polite">
          Loading basemap…
        </div>
      )}

      <ParkMapIndicator px={hoverPx} />

      {!isEnabled && (
        <BasemapConsent
          styleUrl={typeof effectiveStyle === 'string' ? effectiveStyle : settings.basemap.styleUrl}
          satelliteHost={getSatelliteHost(settings.basemap.satelliteProvider)}
          geocoderUrl={settings.geocoder.serviceUrl}
          geocoderEnabled={settings.geocoder.enabled}
          onToggleGeocoder={(enabled) => updateGeocoderSettings({ enabled })}
          onEnable={handleEnable}
          onDismiss={handleDismiss}
          isDismissed={isDismissed}
          onOpenSettings={() => setIsSettingsOpen(true)}
        />
      )}

      {isEnabled && settings.geocoder.enabled && isReady && (
        <GeoSearchBox
          enabled={settings.geocoder.enabled}
          onSelect={(result) => {
            const map = mapInstanceRef.current;
            if (!map) return;
            if (result.bbox) {
              map.fitBounds(
                [
                  [result.bbox[0][0], result.bbox[0][1]],
                  [result.bbox[1][0], result.bbox[1][1]],
                ],
                { padding: 40 },
              );
            } else map.flyTo({ center: [result.ll[1], result.ll[0]], zoom: 15 });
          }}
        />
      )}

      {mapError && (
        <div
          className="trailmaker-basemap-error-banner"
          role="status"
          aria-live="polite"
        >
          <span>{mapError}</span>
          <button type="button" onClick={() => setMapError(null)} aria-label="Dismiss error">
            ×
          </button>
        </div>
      )}

      <input
        ref={fileInputRef}
        type="file"
        accept=".gpx,application/gpx+xml,text/xml"
        style={{ display: 'none' }}
        aria-hidden="true"
        onChange={async (e) => {
          const file = e.target.files?.[0];
          if (!file) return;
          e.target.value = '';
          const res = await loadGpxBlob(file, file.name);
          if (!res.ok) {
            setMapError(res.error);
          } else {
            setMapError(null);
            setIsGpxListOpen(true);
            if (mapInstanceRef.current && res.points.length > 0) {
              const first = res.points[0]!;
              mapInstanceRef.current.flyTo({
                center: [first.ll[1], first.ll[0]],
                zoom: Math.max(mapInstanceRef.current.getZoom(), 12),
              });
            }
          }
        }}
      />

      <div className="trailmaker-basemap-top-actions">
        <ImagerySwitch
          imagery={settings.basemap.imagery ?? 'vector'}
          onChange={(imagery) => updateBasemapSettings({ imagery })}
        />

        <button
          type="button"
          className="trailmaker-basemap-capture-btn"
          onClick={handleStartFraming}
          aria-label="Use this view as my map"
          title="Use this view as my map"
        >
          Use this view as my map
        </button>

        <button
          type="button"
          className={`trailmaker-basemap-gpx-btn ${gpxLayer ? 'has-gpx' : ''}`}
          onClick={() => {
            if (!gpxLayer) {
              fileInputRef.current?.click();
            } else {
              setIsGpxListOpen(!isGpxListOpen);
            }
          }}
          aria-label={
            gpxLayer ? `GPX points (${gpxLayer.points.length} points)` : 'Import GPX file'
          }
          aria-haspopup={gpxLayer ? 'dialog' : undefined}
          aria-expanded={gpxLayer ? isGpxListOpen : undefined}
          title={gpxLayer ? 'Toggle GPX points list' : 'Import GPX file'}
        >
          {gpxLayer ? (
            <>
              GPX points <span className="trailmaker-gpx-badge">{gpxLayer.points.length}</span>
            </>
          ) : (
            'Import GPX'
          )}
        </button>

        <button
          type="button"
          className="trailmaker-basemap-settings-btn"
          onClick={() => setIsSettingsOpen(!isSettingsOpen)}
          aria-label="Basemap settings"
          aria-haspopup="dialog"
          aria-expanded={isSettingsOpen}
          title="Basemap settings"
        >
          ⚙
        </button>
      </div>

      {gpxLayer && (
        <GpxPointsList
          gpx={gpxLayer}
          isOpen={isGpxListOpen}
          onClose={() => setIsGpxListOpen(false)}
          onClearGpx={() => {
            clearActiveGpx();
            setIsGpxListOpen(false);
          }}
          onSelectPoint={(pt) => {
            const curState = appStore.getState();
            const curProject = curState.session?.project;
            if (curProject) {
              handleBasemapClick(pt.ll, {
                project: curProject,
                state: curState,
                edit,
                confirm: confirmRef.current,
              });
            }
            if (mapInstanceRef.current) {
              mapInstanceRef.current.flyTo({
                center: [pt.ll[1], pt.ll[0]],
                zoom: Math.max(mapInstanceRef.current.getZoom(), 14),
              });
            }
            onMapClickRef.current?.(pt.ll, { x: 0, y: 0 });
          }}
        />
      )}

      <BasemapSettingsPopover
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        styleUrl={settings.basemap.styleUrl}
        enabled={settings.basemap.enabled}
        onToggleEnabled={(enabled) => {
          updateBasemapSettings({ enabled });
          if (enabled) {
            setIsDismissed(false);
            setMapError(null);
          }
        }}
        onChangeStyleUrl={(styleUrl) => {
          updateBasemapSettings({ styleUrl });
        }}
        onResetStyleUrl={() => {
          resetBasemapStyleUrl();
        }}
        onResetInterface={onResetInterface}
        satelliteProvider={settings.basemap.satelliteProvider ?? 'naip'}
        onChangeSatelliteProvider={(satelliteProvider) => {
          updateBasemapSettings({ satelliteProvider });
        }}
        esriApiKey={settings.basemap.esriApiKey ?? ''}
        onChangeEsriApiKey={(esriApiKey) => {
          updateBasemapSettings({ esriApiKey });
        }}
        onStartFraming={handleStartFraming}
        geocoderUrl={settings.geocoder.serviceUrl}
        geocoderEnabled={settings.geocoder.enabled}
        onToggleGeocoder={(enabled) => updateGeocoderSettings({ enabled })}
        onChangeGeocoderUrl={(serviceUrl) => updateGeocoderSettings({ serviceUrl })}
        onResetGeocoderUrl={() => {
          resetGeocoderServiceUrl();
        }}
      />

      <SatelliteFramingOverlay
        map={mapInstanceRef.current}
        isOpen={isFramingOpen}
        onClose={() => setIsFramingOpen(false)}
        activeProvider={settings.basemap.satelliteProvider ?? 'naip'}
        onSwitchProvider={(satelliteProvider) => updateBasemapSettings({ satelliteProvider })}
      />

      {children}
    </div>
  );
};

export const BasemapPane = forwardRef<BasemapHandle, BasemapPaneProps>(BasemapPaneComponent);
