// Lane C. Satellite capture framing overlay, resolution calculation, zoom selection and progress UI (card T-318, D-031).
import React, { type FC, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { GeoJSONSource, Map as MapLibreMap } from 'maplibre-gl';
import {
  captureSatelliteView,
  buildSatelliteProject,
  computeOptimalNaipZoom,
  getCaptureDimensions,
  planNaipRequests,
  MAX_NAIP_CAPTURE_LONG_SIDE,
  MAX_NAIP_EXPORT_REQUESTS,
  groundResolution,
  type CaptureDimensions,
  type CaptureProgress,
  type FramedBounds,
} from '../../io/satellite-capture';
import { loadSettings, updateBasemapSettings, type SatelliteProviderId } from '../../io/settings';
import { DEFAULT_TILE_ZOOM, planTiledBoundary, tileLevelPyramid } from '../../io/tiled-capture';
import type { TiledBoundaryPlan } from '../../io/tiled-capture';
import {
  inspectTiledMapServer,
  MARTIN_TILE_MAPSERVER_URL,
  tiledBoundaryWithinCoverage,
  type TiledImagerySource,
} from '../../io/tile-service';
import { createTileCaptureSession } from '../../io/tile-capture-session';
import { countPlannedTileKeys, tileDownloadProgress } from '../../io/tile-downloader';
import {
  isTiledDownloadDisabled,
  resetTiledDownloadUiState,
  type TileEstimateState,
  type TileProgressState,
} from '../../io/tiled-download-ui-state';
import { deleteTiledMap, listResumableTileDownloads, tiledMapStorageId } from '../../io/tile-store';
import type { TileDownloadManifest } from '../../io/tile-store';
import { buildOverviewPyramid, invalidateTiledMapHandle, loadTiledMap } from '../../io/tile-raster';
import { createProjectForTiledMap } from '../../io/tiled-project';
import {
  achievableImageryResolution,
  IMAGERY_SOURCES,
  containsFrame,
  parseArcGisService,
  planServiceRequests,
  type ArcGisServiceJson,
  type ImagerySource,
} from '../../io/imagery-sources';
import { clearActiveGpx } from '../../io/gpxStorage';
import { sessionBridge } from '../../state/bridge';
import { showToast as storeShowToast } from '../../state/store';
import { useFocusTrap } from './focusTrap';

void React;

export interface SatelliteFramingOverlayProps {
  readonly map: MapLibreMap | null;
  readonly isOpen: boolean;
  readonly onClose: () => void;
  readonly activeProvider?: SatelliteProviderId | undefined;
  readonly onSwitchProvider?: ((provider: SatelliteProviderId) => void) | undefined;
  readonly showToast?: ((message: string) => void) | undefined;
  readonly placeName?: string | undefined;
  readonly tileLoader?:
    | ((x: number, y: number, z: number, signal?: AbortSignal) => Promise<CanvasImageSource | null>)
    | undefined;
}

export const SatelliteFramingOverlay: FC<SatelliteFramingOverlayProps> = ({
  map,
  isOpen,
  onClose,
  activeProvider = 'usgs',
  onSwitchProvider,
  showToast = storeShowToast,
  placeName,
  tileLoader,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const framingBoxRef = useRef<HTMLDivElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const tileSourceRequestRef = useRef<Promise<TiledImagerySource | null> | null>(null);

  const [bounds, setBounds] = useState<FramedBounds | null>(null);
  const [selectedZoom, setSelectedZoom] = useState<number | null>(null);
  const [capturing, setCapturing] = useState(false);
  const [progress, setProgress] = useState<CaptureProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedSourceId, setSelectedSourceId] = useState('naip');
  const [customSource, setCustomSource] = useState<ImagerySource | null>(null);
  const [serviceUrl, setServiceUrl] = useState(() => loadSettings().basemap.customImageryUrl ?? '');
  const [serviceLoading, setServiceLoading] = useState(false);
  const [rightsConfirmed, setRightsConfirmed] = useState(false);
  const [tileSource, setTileSource] = useState<TiledImagerySource | null>(null);
  const [tileSourceLoading, setTileSourceLoading] = useState(false);
  const [drawingBoundary, setDrawingBoundary] = useState(false);
  const [tileBoundary, setTileBoundary] = useState<readonly (readonly [number, number])[]>([]);
  const [selectedBoundaryIndex, setSelectedBoundaryIndex] = useState<number | null>(null);
  const [tileZoom, setTileZoom] = useState(DEFAULT_TILE_ZOOM);
  const [tileEstimate, setTileEstimate] = useState<TileEstimateState | null>(null);
  const [tileProgress, setTileProgress] = useState<TileProgressState | null>(null);
  const [tileDownloading, setTileDownloading] = useState(false);
  const [tileDeleting, setTileDeleting] = useState(false);
  const [tilePaused, setTilePaused] = useState(false);
  const [tileError, setTileError] = useState<string | null>(null);
  const [tileStorageConfirmed, setTileStorageConfirmed] = useState(false);
  const [resumableTileDownloads, setResumableTileDownloads] = useState<
    readonly TileDownloadManifest[]
  >([]);
  const [deletedTileMapId, setDeletedTileMapId] = useState<string | null>(null);
  const tileCaptureRef = useRef<ReturnType<typeof createTileCaptureSession> | null>(null);
  const tileCompletionRef = useRef<(() => Promise<void>) | null>(null);

  useFocusTrap({
    active: isOpen && !capturing,
    containerRef,
    onClose,
  });

  useEffect(() => {
    if (!isOpen) return;
    void listResumableTileDownloads()
      .then(setResumableTileDownloads)
      .catch(() => setResumableTileDownloads([]));
  }, [isOpen]);

  const inspectService = useCallback(async (value: string) => {
    const url = value.trim().replace(/\/$/, '');
    if (!url) return;
    setServiceLoading(true);
    setError(null);
    setRightsConfirmed(false);
    try {
      const metadataUrl = new URL(url);
      metadataUrl.search = 'f=json';
      const response = await fetch(metadataUrl, { mode: 'cors', cache: 'no-store' });
      if (!response.ok) throw new Error(`ArcGIS service returned HTTP ${response.status}.`);
      const rootMetadata = (await response.json()) as ArcGisServiceJson;
      let metadata = rootMetadata;
      if (/\/MapServer\/?$/i.test(url) && rootMetadata.layers?.length) {
        const layerUrl = new URL(`${url.replace(/\/$/, '')}/${rootMetadata.layers[0]!.id}`);
        layerUrl.search = 'f=json';
        const layerResponse = await fetch(layerUrl, { mode: 'cors', cache: 'no-store' });
        if (!layerResponse.ok)
          throw new Error(`ArcGIS layer returned HTTP ${layerResponse.status}.`);
        const layer = (await layerResponse.json()) as ArcGisServiceJson;
        metadata = {
          ...rootMetadata,
          ...(layer.description ? { description: layer.description } : {}),
          ...(layer.copyrightText || rootMetadata.copyrightText
            ? { copyrightText: layer.copyrightText || rootMetadata.copyrightText }
            : {}),
        };
      }
      const source = parseArcGisService(url, metadata);
      setCustomSource(source);
      setSelectedSourceId(source.id);
      setServiceUrl(url);
      updateBasemapSettings({ customImageryUrl: url });
      setError(null);
    } catch (cause) {
      const message =
        cause instanceof TypeError
          ? 'Could not read this service. It may block CORS requests or require a network connection.'
          : cause instanceof Error
            ? cause.message
            : 'Could not read the ArcGIS service.';
      setCustomSource(null);
      setError(message);
    } finally {
      setServiceLoading(false);
    }
  }, []);

  useEffect(() => {
    const savedUrl = loadSettings().basemap.customImageryUrl;
    if (savedUrl && !customSource) void inspectService(savedUrl);
  }, [inspectService, customSource]);

  // Calculate current framed bounds from the framing box element and map coordinates
  const updateBounds = useCallback(() => {
    if (!map) {
      try {
        const settings = loadSettings();
        const center = settings.basemap.lastCenter ?? [-80.145, 27.135];
        const currentZoom = settings.basemap.lastZoom ?? 14;
        const span = 360 / Math.pow(2, currentZoom);
        const latSpan = span * 0.5;
        const lngSpan = span * 0.7;
        setBounds({
          north: center[1] + latSpan / 2,
          south: center[1] - latSpan / 2,
          west: center[0] - lngSpan / 2,
          east: center[0] + lngSpan / 2,
        });
      } catch {
        setBounds({
          north: 27.14,
          south: 27.13,
          west: -80.15,
          east: -80.14,
        });
      }
      return;
    }

    try {
      const box = framingBoxRef.current;
      const mapContainer = typeof map.getContainer === 'function' ? map.getContainer() : null;

      if (box && mapContainer && typeof map.unproject === 'function') {
        const boxRect = box.getBoundingClientRect();
        const containerRect = mapContainer.getBoundingClientRect();

        const x1 = Math.max(0, boxRect.left - containerRect.left);
        const y1 = Math.max(0, boxRect.top - containerRect.top);
        const x2 = Math.min(containerRect.width, boxRect.right - containerRect.left);
        const y2 = Math.min(containerRect.height, boxRect.bottom - containerRect.top);

        const nw = map.unproject([x1, y1]);
        const se = map.unproject([x2, y2]);

        setBounds({
          north: Math.max(nw.lat, se.lat),
          south: Math.min(nw.lat, se.lat),
          west: Math.min(nw.lng, se.lng),
          east: Math.max(nw.lng, se.lng),
        });
        return;
      }
    } catch {
      // Fallback below
    }

    // Fallback: use map center and zoom
    try {
      const center =
        typeof map.getCenter === 'function' ? map.getCenter() : { lng: -80.145, lat: 27.135 };
      const currentZoom = typeof map.getZoom === 'function' ? map.getZoom() : 14;
      const span = 360 / Math.pow(2, currentZoom);
      const latSpan = span * 0.5;
      const lngSpan = span * 0.7;

      setBounds({
        north: center.lat + latSpan / 2,
        south: center.lat - latSpan / 2,
        west: center.lng - lngSpan / 2,
        east: center.lng + lngSpan / 2,
      });
    } catch {
      setBounds({
        north: 27.14,
        south: 27.13,
        west: -80.15,
        east: -80.14,
      });
    }
  }, [map]);

  // Update bounds on mount, map movement, or resize
  useEffect(() => {
    if (!isOpen) return;

    updateBounds();

    if (!map) return;

    const handleMapMove = () => updateBounds();
    if (typeof map.on === 'function') {
      map.on('move', handleMapMove);
      map.on('zoom', handleMapMove);
      map.on('resize', handleMapMove);
    }

    window.addEventListener('resize', handleMapMove);

    return () => {
      if (typeof map.off === 'function') {
        map.off('move', handleMapMove);
        map.off('zoom', handleMapMove);
        map.off('resize', handleMapMove);
      }
      window.removeEventListener('resize', handleMapMove);
    };
  }, [isOpen, map, updateBounds]);

  useEffect(() => {
    if (!map || !isOpen || !drawingBoundary) return;
    const addVertex = (event: {
      lngLat: { lng: number; lat: number };
      originalEvent?: { detail?: number };
    }) => {
      if (event.originalEvent?.detail && event.originalEvent.detail > 1) return;
      const point = [event.lngLat.lat, event.lngLat.lng] as const;
      setTileBoundary((current) => [...current, point]);
      setSelectedBoundaryIndex(tileBoundary.length);
    };
    const closeOnDoubleClick = (event: {
      preventDefault?: () => void;
      lngLat: { lng: number; lat: number };
    }) => {
      event.preventDefault?.();
      if (tileBoundary.length >= 3) {
        const previous = tileBoundary[tileBoundary.length - 1];
        if (
          previous &&
          Math.abs(previous[0] - event.lngLat.lat) < 0.000001 &&
          Math.abs(previous[1] - event.lngLat.lng) < 0.000001
        ) {
          setTileBoundary((current) => current.slice(0, -1));
        }
        setDrawingBoundary(false);
      }
    };
    map.on('click', addVertex);
    map.on('dblclick', closeOnDoubleClick);
    return () => {
      map.off('click', addVertex);
      map.off('dblclick', closeOnDoubleClick);
    };
  }, [drawingBoundary, isOpen, map, tileBoundary]);

  useEffect(() => {
    if (!map || !isOpen || drawingBoundary || tileBoundary.length < 3) return;
    let draggedIndex: number | null = null;
    const dragPanWasEnabled = map.dragPan.isEnabled();
    const move = (event: { lngLat: { lat: number; lng: number } }) => {
      if (draggedIndex === null) return;
      const point = [event.lngLat.lat, event.lngLat.lng] as const;
      setTileBoundary((current) =>
        current.map((value, index) => (index === draggedIndex ? point : value)),
      );
    };
    const endDrag = () => {
      if (draggedIndex === null) return;
      draggedIndex = null;
      map.off('mousemove', move);
      if (dragPanWasEnabled) map.dragPan.enable();
    };
    const startDrag = (event: { point: { x: number; y: number } }) => {
      const selected = tileBoundary
        .map(([lat, lon], index) => {
          const point = map.project([lon, lat]);
          return { index, distance: Math.hypot(point.x - event.point.x, point.y - event.point.y) };
        })
        .sort((a, b) => a.distance - b.distance)[0];
      if (!selected || selected.distance > 18) return;
      draggedIndex = selected.index;
      setSelectedBoundaryIndex(selected.index);
      map.dragPan.disable();
      map.on('mousemove', move);
      map.once('mouseup', endDrag);
    };
    map.on('mousedown', startDrag);
    return () => {
      map.off('mousedown', startDrag);
      map.off('mousemove', move);
      if (dragPanWasEnabled) map.dragPan.enable();
    };
  }, [drawingBoundary, isOpen, map, tileBoundary]);

  useEffect(() => {
    if (!map || !isOpen || typeof map.isStyleLoaded !== 'function' || !map.isStyleLoaded()) return;
    const sourceId = 'trailmaker-tiled-boundary';
    const coordinates = tileBoundary.map(([lat, lon]) => [lon, lat]);
    const polygonReady = tileBoundary.length >= 3 && !drawingBoundary;
    const geometry = polygonReady
      ? { type: 'Polygon' as const, coordinates: [[...coordinates, coordinates[0]!]] }
      : { type: 'LineString' as const, coordinates };
    const data = {
      type: 'Feature' as const,
      properties: {},
      geometry,
    };
    const existing = map.getSource(sourceId) as GeoJSONSource | undefined;
    if (existing) {
      existing.setData(data);
    } else {
      map.addSource(sourceId, { type: 'geojson', data });
      map.addLayer({
        id: `${sourceId}-fill`,
        type: 'fill',
        source: sourceId,
        paint: { 'fill-color': '#f3b61f', 'fill-opacity': 0.18 },
      });
      map.addLayer({
        id: `${sourceId}-line`,
        type: 'line',
        source: sourceId,
        paint: { 'line-color': '#f3b61f', 'line-width': 3 },
      });
    }
    const vertexSourceId = `${sourceId}-vertices`;
    const vertexData = {
      type: 'FeatureCollection' as const,
      features: coordinates.map((coordinate) => ({
        type: 'Feature' as const,
        properties: {},
        geometry: { type: 'Point' as const, coordinates: coordinate },
      })),
    };
    const vertices = map.getSource(vertexSourceId) as GeoJSONSource | undefined;
    if (vertices) {
      vertices.setData(vertexData);
    } else {
      map.addSource(vertexSourceId, { type: 'geojson', data: vertexData });
      map.addLayer({
        id: `${vertexSourceId}-circles`,
        type: 'circle',
        source: vertexSourceId,
        paint: {
          'circle-radius': 6,
          'circle-color': '#f3b61f',
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 2,
        },
      });
    }
  }, [drawingBoundary, isOpen, map, tileBoundary]);

  const ensureTileSource = async () => {
    if (tileSource) return tileSource;
    if (tileSourceRequestRef.current) return tileSourceRequestRef.current;
    setTileSourceLoading(true);
    setTileError(null);
    const url = activeSource?.id.startsWith('custom:')
      ? activeSource.url
      : MARTIN_TILE_MAPSERVER_URL;
    const request = inspectTiledMapServer(url)
      .then((source) => {
        setTileSource(source);
        setTileZoom(
          source.levels.some((level) => level.z === DEFAULT_TILE_ZOOM)
            ? DEFAULT_TILE_ZOOM
            : source.levels[0]!.z,
        );
        return source;
      })
      .catch((cause: unknown) => {
        setTileError(
          cause instanceof Error ? cause.message : 'Could not read Martin County tile service.',
        );
        return null;
      })
      .finally(() => {
        setTileSourceLoading(false);
        tileSourceRequestRef.current = null;
      });
    tileSourceRequestRef.current = request;
    return request;
  };

  const handleUseCustomTiledService = async () => {
    if (!rightsConfirmed) return;
    setTileSourceLoading(true);
    setTileError(null);
    try {
      const source = await inspectTiledMapServer(serviceUrl);
      setTileSource(source);
      setTileZoom(
        source.levels.some((level) => level.z === DEFAULT_TILE_ZOOM)
          ? DEFAULT_TILE_ZOOM
          : source.levels[0]!.z,
      );
    } catch (cause) {
      setTileError(
        cause instanceof Error ? cause.message : 'This is not a cached tiled MapServer.',
      );
    } finally {
      setTileSourceLoading(false);
    }
  };

  const handleStartBoundary = async () => {
    if (!map) {
      setTileError('Open the basemap before drawing a tiled imagery boundary.');
      return;
    }
    if (activeSource?.id.startsWith('custom:') && !rightsConfirmed) {
      setTileError('Confirm that you have the right to use this tiled imagery service.');
      return;
    }
    setTileBoundary([]);
    setTileEstimate(null);
    setTileProgress(null);
    setTileStorageConfirmed(false);
    setTileError(null);
    setDrawingBoundary(true);
    if (!(await ensureTileSource())) setDrawingBoundary(false);
  };

  const prepareTiledCapture = (
    source: TiledImagerySource,
    plan: TiledBoundaryPlan,
    boundary: readonly (readonly [number, number])[],
    mapId?: string,
    onFullDownload?: (loadedMap: Awaited<ReturnType<typeof loadTiledMap>>) => void,
  ) => {
    const session = createTileCaptureSession({
      source,
      plan,
      boundary,
      ...(mapId ? { mapId } : {}),
      onProgress: (complete, total, missing) => setTileProgress({ complete, total, missing }),
    });
    tileCompletionRef.current = async () => {
      const levels = tileLevelPyramid(plan.width, plan.height, plan.tileSize);
      await buildOverviewPyramid(session.mapId, levels, plan.tileSize);
      const image = {
        fileName: `${source.name} tiled imagery`,
        width: plan.width,
        height: plan.height,
        originalWidth: plan.width,
        originalHeight: plan.height,
        source: {
          kind: 'tiles' as const,
          sourceId: source.id,
          z: plan.z,
          tileSize: plan.tileSize,
          origin: plan.origin,
          boundary,
          tileCount: plan.tiles.length,
        },
        sha256: 'tiled-map-overview-pending',
        attribution: source.attribution,
        ...(source.year ? { acquisitionYear: source.year } : {}),
      };
      const loadedMap = await loadTiledMap(image, session.mapId);
      if (onFullDownload) {
        onFullDownload(loadedMap);
        return;
      }
      const project = createProjectForTiledMap(loadedMap.meta, source, plan, boundary);
      clearActiveGpx();
      sessionBridge.openSession({ project, map: loadedMap });
      showToast('Tiled map is ready for tracing and offline use.');
      onClose();
    };
    tileCaptureRef.current = session;
    return session;
  };

  const handleRedownloadTiledMap = async () => {
    const existingSession = sessionBridge.getSession();
    const image = existingSession?.project.image;
    if (!image || image.source.kind !== 'tiles') return;
    const expectedMap = existingSession.map;
    setTileSourceLoading(true);
    const clearedTileState = resetTiledDownloadUiState();
    setTileEstimate(clearedTileState.estimate);
    setTileProgress(clearedTileState.progress);
    setTileStorageConfirmed(false);
    setTilePaused(false);
    setTileError(null);
    try {
      if (image.source.sourceId.startsWith('custom:') && !rightsConfirmed) {
        throw new Error(
          'Confirm that you have the right to use this custom tiled service before re-downloading.',
        );
      }
      const url =
        image.source.sourceId === 'martin-county'
          ? MARTIN_TILE_MAPSERVER_URL
          : image.source.sourceId.slice('custom:'.length);
      const source = await inspectTiledMapServer(url);
      const boundary = image.source.boundary;
      const plan = planTiledBoundary(boundary, image.source.z, { tileSize: image.source.tileSize });
      setTileSource(source);
      setTileBoundary(boundary);
      setTileZoom(image.source.z);
      setDrawingBoundary(false);
      const session = prepareTiledCapture(source, plan, boundary, undefined, (loadedMap) => {
        if (!sessionBridge.replaceMap?.(expectedMap, loadedMap)) {
          setTileError(
            'The open map changed before tiles were restored; downloaded tiles were kept on this device.',
          );
          return;
        }
        setDeletedTileMapId(null);
        showToast('Offline tiles are restored to the open project.');
        onClose();
      });
      setTileEstimate(await session.estimate());
    } catch (cause) {
      setTileError(
        cause instanceof Error ? cause.message : 'Could not prepare imagery re-download.',
      );
    } finally {
      setTileSourceLoading(false);
    }
  };

  const handleEstimateTiles = async () => {
    setTileEstimate(null);
    setTileProgress(null);
    setTileStorageConfirmed(false);
    const source = await ensureTileSource();
    if (!source || tileBoundary.length < 3) return;
    try {
      setTileError(null);
      if (!tiledBoundaryWithinCoverage(source, tileBoundary)) {
        throw new Error('The drawn boundary extends outside this tiled service coverage.');
      }
      const plan = planTiledBoundary(tileBoundary, tileZoom, { tileSize: source.tileSize });
      const session = prepareTiledCapture(source, plan, tileBoundary);
      setTileEstimate(await session.estimate());
      setTileStorageConfirmed(false);
    } catch (cause) {
      setTileError(
        cause instanceof Error ? cause.message : 'Could not estimate the tile download.',
      );
    }
  };

  const handleResumeTileDownload = async (manifest: TileDownloadManifest) => {
    setTileError(null);
    setTileSourceLoading(true);
    const clearedTileState = resetTiledDownloadUiState();
    setTileEstimate(clearedTileState.estimate);
    setTileProgress(clearedTileState.progress);
    setTileStorageConfirmed(false);
    setTilePaused(false);
    try {
      const url =
        manifest.sourceId === 'martin-county'
          ? MARTIN_TILE_MAPSERVER_URL
          : manifest.sourceId.startsWith('custom:')
            ? manifest.sourceId.slice('custom:'.length)
            : '';
      if (!url) throw new Error('The saved tile service reference is not supported.');
      if (manifest.sourceId.startsWith('custom:') && !rightsConfirmed) {
        throw new Error(
          'Confirm that you have the right to use this custom tiled service before resuming.',
        );
      }
      const source = await inspectTiledMapServer(url);
      const boundary = manifest.boundary;
      const plan = planTiledBoundary(boundary, manifest.z, { tileSize: manifest.tileSize });
      setTileSource(source);
      setTileBoundary(boundary);
      setTileZoom(manifest.z);
      setDrawingBoundary(false);
      const session = prepareTiledCapture(
        source,
        { ...plan, tiles: manifest.tiles },
        boundary,
        manifest.mapId,
      );
      tileCaptureRef.current = session;
      setTileEstimate(await session.estimate());
      setTileProgress({
        complete: countPlannedTileKeys(manifest.tiles, manifest.completedKeys),
        total: manifest.tiles.length,
        missing: countPlannedTileKeys(manifest.tiles, manifest.missingKeys),
      });
      setTileStorageConfirmed(false);
    } catch (cause) {
      setTileError(cause instanceof Error ? cause.message : 'Could not resume the tiled download.');
    } finally {
      setTileSourceLoading(false);
    }
  };

  const handleDeleteDownloadedImagery = async () => {
    const session = sessionBridge.getSession();
    const source = session?.project.image.source;
    if (!source || source.kind !== 'tiles') return;
    const mapId = tiledMapStorageId(source);
    const clearedTileState = resetTiledDownloadUiState();
    setTileEstimate(clearedTileState.estimate);
    setTileProgress(clearedTileState.progress);
    setTileStorageConfirmed(false);
    setTilePaused(false);
    setTileError(null);
    setTileDeleting(true);
    const overviewMap = { ...session.map, tiles: null };
    if (!sessionBridge.replaceMap?.(session.map, overviewMap)) {
      setTileError('The open map changed; downloaded imagery was not deleted.');
      setTileDeleting(false);
      return;
    }
    invalidateTiledMapHandle(session.map.tiles);
    try {
      await deleteTiledMap(mapId);
      setDeletedTileMapId(mapId);
    } catch (cause) {
      setTileError(
        cause instanceof Error
          ? `Could not remove all local tile records: ${cause.message}`
          : 'Could not remove all local tile records.',
      );
      return;
    } finally {
      setTileDeleting(false);
    }
    showToast('Downloaded imagery removed from this device.');
  };

  const handleDownloadTiles = async () => {
    const source = tileSource;
    if (tileSourceLoading || tileDeleting || !source || !tileEstimate || !tileCaptureRef.current)
      return;
    if (tileEstimate.enoughSpace === false && !tileStorageConfirmed) return;
    const plan = planTiledBoundary(tileBoundary, tileZoom, { tileSize: source.tileSize });
    const capture = tileCaptureRef.current;
    setTileDownloading(true);
    setTilePaused(false);
    setTileError(null);
    try {
      const result = await capture.download();
      setTileProgress(tileDownloadProgress(result, plan.tiles.length));
      if (result.missing.length)
        showToast(`Downloaded tiled imagery with ${result.missing.length} missing tiles.`);
      else await tileCompletionRef.current?.();
    } catch (cause) {
      setTileError(cause instanceof Error ? cause.message : 'Tiled imagery download failed.');
    } finally {
      setTileDownloading(false);
      setTilePaused(false);
    }
  };

  // Derive optimal zoom whenever bounds change (if user has not manually locked a zoom)
  const mercatorFrame = useMemo(
    () =>
      bounds
        ? (() => {
            const project = (lon: number, lat: number): [number, number] => [
              (lon * 20037508.342789244) / 180,
              (Math.log(
                Math.tan(((90 + Math.max(-85.051129, Math.min(85.051129, lat))) * Math.PI) / 360),
              ) *
                20037508.342789244) /
                Math.PI,
            ];
            const [west, south] = project(bounds.west, bounds.south);
            const [east, north] = project(bounds.east, bounds.north);
            return { west, south, east, north };
          })()
        : null,
    [bounds],
  );
  const sources = mercatorFrame
    ? [
        ...IMAGERY_SOURCES.filter((s) => containsFrame(s.coverage, mercatorFrame)),
        ...(customSource && containsFrame(customSource.coverage, mercatorFrame)
          ? [customSource]
          : []),
      ]
    : [];
  const sourceResolution = useCallback(
    (source: ImagerySource) => {
      if (!bounds || !mercatorFrame) return Number.POSITIVE_INFINITY;
      return achievableImageryResolution(mercatorFrame, source.nominalResolutionM, source.maxSize, {
        maxLongSide: MAX_NAIP_CAPTURE_LONG_SIDE,
        maxRequests: MAX_NAIP_EXPORT_REQUESTS,
      });
    },
    [bounds, mercatorFrame],
  );
  const sourceFitsCapture = useCallback(
    (source: ImagerySource) => {
      if (!bounds || !mercatorFrame) return false;
      const centerLat = (bounds.north + bounds.south) / 2;
      const resolution = sourceResolution(source);
      const zoom = Math.log2(
        (40075016.686 * Math.cos((centerLat * Math.PI) / 180)) / (256 * resolution),
      );
      const captureDims = getCaptureDimensions(bounds, zoom);
      const requests = planServiceRequests(
        mercatorFrame,
        resolution,
        source.maxSize,
        source.nominalResolutionM,
      );
      return (
        Math.max(captureDims.width, captureDims.height) <= MAX_NAIP_CAPTURE_LONG_SIDE &&
        requests.length <= MAX_NAIP_EXPORT_REQUESTS
      );
    },
    [bounds, mercatorFrame, sourceResolution],
  );
  const activeSource = sources.find((s) => s.id === selectedSourceId);
  const tileDetailLevels = tileSource
    ? tileSource.id === 'martin-county'
      ? tileSource.levels.filter((level) => level.z === DEFAULT_TILE_ZOOM)
      : tileSource.levels
    : [];
  const tiledPlan = useMemo(() => {
    if (!tileSource || tileBoundary.length < 3) return null;
    try {
      return planTiledBoundary(tileBoundary, tileZoom, { tileSize: tileSource.tileSize });
    } catch {
      return null;
    }
  }, [tileBoundary, tileSource, tileZoom]);
  useEffect(() => {
    if (
      selectedSourceId.startsWith('custom:') &&
      customSource &&
      !sources.some((source) => source.id === customSource.id)
    ) {
      setSelectedSourceId(sources[0]?.id ?? 'naip');
      return;
    }
    if (selectedSourceId === 'naip' && sources.length) {
      const naipResolution = bounds
        ? groundResolution((bounds.north + bounds.south) / 2, computeOptimalNaipZoom(bounds))
        : 0.3;
      const sharpest = sources
        .filter(sourceFitsCapture)
        .sort((a, b) => sourceResolution(a) - sourceResolution(b))[0];
      setSelectedSourceId(
        sharpest && sourceResolution(sharpest) < naipResolution ? sharpest.id : 'naip',
      );
    }
    // The framing bounds determine which curated sources are available.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    bounds?.north,
    bounds?.south,
    bounds?.east,
    bounds?.west,
    customSource,
    sourceFitsCapture,
    sourceResolution,
  ]);
  const isCustomSource = !!activeSource && activeSource.id.startsWith('custom:');
  const currentOptimalZoom = bounds
    ? activeSource
      ? Math.log2(
          (40075016.686 * Math.cos((((bounds.north + bounds.south) / 2) * Math.PI) / 180)) /
            (256 * sourceResolution(activeSource)),
        )
      : computeOptimalNaipZoom(bounds)
    : 18;
  const zoomRange = bounds
    ? {
        minZoom: Math.max(0, currentOptimalZoom - 4),
        maxZoom: currentOptimalZoom,
        defaultZoom: currentOptimalZoom,
      }
    : { minZoom: 0, maxZoom: 18, defaultZoom: 18 };

  const effectiveZoom =
    selectedZoom !== null
      ? Math.min(zoomRange.maxZoom, Math.max(zoomRange.minZoom, selectedZoom))
      : currentOptimalZoom;

  const dims: CaptureDimensions | null = bounds
    ? getCaptureDimensions(bounds, effectiveZoom)
    : null;

  const serviceRequests =
    dims && activeSource && mercatorFrame
      ? planServiceRequests(
          mercatorFrame,
          groundResolution((bounds!.north + bounds!.south) / 2, effectiveZoom),
          activeSource.maxSize,
          activeSource.nominalResolutionM,
        )
      : [];
  const naipRequestCount = dims
    ? activeSource
      ? serviceRequests.length
      : planNaipRequests(dims).length
    : 0;
  const exceedsLimits = dims
    ? dims.width > MAX_NAIP_CAPTURE_LONG_SIDE ||
      dims.height > MAX_NAIP_CAPTURE_LONG_SIDE ||
      naipRequestCount > MAX_NAIP_EXPORT_REQUESTS
    : false;

  const handleStartCapture = async () => {
    if (!bounds || !dims || exceedsLimits || capturing) return;

    setError(null);
    setCapturing(true);
    const controller = new AbortController();
    abortControllerRef.current = controller;

    try {
      const result = await captureSatelliteView({
        bounds,
        zoom: effectiveZoom,
        providerId: activeSource ? undefined : 'naip',
        imagerySource: activeSource,
        placeName,
        signal: controller.signal,
        tileLoader,
        onProgress: (p) => setProgress(p),
      });

      const { project, map: loadedMap } = await buildSatelliteProject(result);
      clearActiveGpx();
      sessionBridge.openSession({ project, map: loadedMap });

      if (result.missingTiles > 0) {
        showToast(
          `Captured satellite map (${result.width.toLocaleString()} × ${result.height.toLocaleString()} px) with ${result.missingTiles} missing tiles`,
        );
      } else {
        showToast(
          `Captured satellite map (${result.width.toLocaleString()} × ${result.height.toLocaleString()} px)`,
        );
      }
      if (result.fallbackReason) showToast(result.fallbackReason);

      onClose();
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        showToast('Satellite capture cancelled');
      } else {
        const msg = err instanceof Error ? err.message : 'Satellite capture failed';
        setError(msg);
        showToast(msg);
      }
    } finally {
      setCapturing(false);
      setProgress(null);
      abortControllerRef.current = null;
    }
  };

  const handleCancelCapture = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    setCapturing(false);
    if (tileDownloading) tileCaptureRef.current?.cancel();
    setProgress(null);
    onClose();
  };

  const activeSession = sessionBridge.getSession();
  const activeTiledSource = activeSession?.project.image.source;
  const activeTiledMapId =
    activeTiledSource?.kind === 'tiles' ? tiledMapStorageId(activeTiledSource) : null;
  const activeTiledMapNeedsDownload =
    activeTiledSource?.kind === 'tiles' &&
    (!activeSession?.map.tiles || deletedTileMapId === activeTiledMapId);
  if (!isOpen) return null;

  const boundaryEditor = (
    <div className="trailmaker-boundary-editor">
      {drawingBoundary && (
        <p className="trailmaker-boundary-status" role="status">
          {tileBoundary.length} {tileBoundary.length === 1 ? 'point' : 'points'} · Tap map to add
        </p>
      )}
      <p className="trailmaker-framing-hint" hidden={drawingBoundary}>
        {drawingBoundary
          ? 'Click the basemap to add boundary points, then close the boundary when it surrounds the park. Press Enter to add a point at the map center; C closes it.'
          : 'Select a point, then use arrow keys to nudge or drag its marker. Delete removes the selected point.'}
      </p>
      <div
        role="group"
        aria-label="Park boundary points"
        className="trailmaker-boundary-points"
        aria-description={
          drawingBoundary
            ? 'Enter adds a point at the map center; C closes the boundary; Escape cancels.'
            : 'Select a point, use arrow keys to nudge it, or Delete to remove it.'
        }
      >
        <div
          tabIndex={0}
          onKeyDown={(event) => {
            if (drawingBoundary && event.key === 'Enter' && map) {
              event.preventDefault();
              const center = map.getCenter();
              setTileBoundary((current) => [...current, [center.lat, center.lng]]);
              setSelectedBoundaryIndex(tileBoundary.length);
              return;
            }
            if (drawingBoundary && event.key.toLowerCase() === 'c' && tileBoundary.length >= 3) {
              event.preventDefault();
              setDrawingBoundary(false);
              return;
            }
            if (drawingBoundary && event.key === 'Escape') {
              event.preventDefault();
              setDrawingBoundary(false);
              setTileBoundary([]);
              return;
            }
            if (selectedBoundaryIndex === null || !tileBoundary[selectedBoundaryIndex]) return;
            const [lat, lon] = tileBoundary[selectedBoundaryIndex]!;
            const delta = event.shiftKey ? 0.0001 : 0.00002;
            const offsets: Record<string, readonly [number, number]> = {
              ArrowUp: [delta, 0],
              ArrowDown: [-delta, 0],
              ArrowLeft: [0, -delta],
              ArrowRight: [0, delta],
            };
            const offset = offsets[event.key];
            if (offset) {
              event.preventDefault();
              setTileBoundary((current) =>
                current.map((point, index) =>
                  index === selectedBoundaryIndex ? [lat + offset[0], lon + offset[1]] : point,
                ),
              );
            } else if (event.key === 'Delete' || event.key === 'Backspace') {
              event.preventDefault();
              setTileBoundary((current) =>
                current.filter((_, index) => index !== selectedBoundaryIndex),
              );
              setSelectedBoundaryIndex(null);
            }
          }}
        >
          {tileBoundary.map(([lat, lon], index) => (
            <button
              key={`${index}-${lat}-${lon}`}
              type="button"
              aria-pressed={selectedBoundaryIndex === index}
              onClick={() => setSelectedBoundaryIndex(index)}
            >
              Point {index + 1} · {lat.toFixed(5)}, {lon.toFixed(5)}
            </button>
          ))}
        </div>
      </div>
      <div className="trailmaker-boundary-actions">
        {drawingBoundary && (
          <button
            type="button"
            className="btn small"
            disabled={tileBoundary.length < 3}
            onClick={() => setDrawingBoundary(false)}
          >
            Close boundary
          </button>
        )}
        <button
          type="button"
          className="btn small"
          onClick={() => {
            setDrawingBoundary(false);
            setTileBoundary([]);
            setTileEstimate(null);
          }}
        >
          Cancel boundary
        </button>
      </div>
    </div>
  );

  return (
    <div
      ref={containerRef}
      className="trailmaker-satellite-framing-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Capture satellite map"
    >
      {/* Visual framing reticle and dimmed backdrop */}
      <div
        ref={framingBoxRef}
        className={`trailmaker-framing-box${drawingBoundary ? ' is-hidden' : ''}`}
        data-testid="framing-box"
        aria-hidden="true"
      >
        <div className="trailmaker-framing-corner tl" />
        <div className="trailmaker-framing-corner tr" />
        <div className="trailmaker-framing-corner bl" />
        <div className="trailmaker-framing-corner br" />
      </div>

      {/* Top Banner / Framing controls */}
      <div className={`trailmaker-framing-banner${drawingBoundary ? ' is-drawing-boundary' : ''}`}>
        <div className="trailmaker-framing-title-row">
          <h3 className="trailmaker-framing-title">
            {drawingBoundary ? 'Draw park boundary' : 'Frame area to capture'}
          </h3>
          <button
            type="button"
            className="trailmaker-basemap-close-btn"
            onClick={handleCancelCapture}
            aria-label="Close framing"
            disabled={capturing}
          >
            ×
          </button>
        </div>

        {drawingBoundary && boundaryEditor}
        {!drawingBoundary && (
          <>
            <p className="trailmaker-framing-hint">
              {drawingBoundary
                ? 'Click the basemap to outline the park boundary, or use the keyboard controls below.'
                : 'Pan and zoom the satellite map to position your park or trail area inside the frame.'}
            </p>

            <section className="trailmaker-tiled-capture" aria-label="Tiled imagery capture">
              {activeTiledMapNeedsDownload && (
                <button
                  type="button"
                  className="btn small"
                  disabled={tileSourceLoading || tileDownloading || tileDeleting}
                  onClick={() => void handleRedownloadTiledMap()}
                >
                  Re-download offline tiles
                </button>
              )}
              {activeTiledMapId && !activeTiledMapNeedsDownload && (
                <button
                  type="button"
                  className="btn small"
                  disabled={tileDeleting || tileDownloading}
                  onClick={() => void handleDeleteDownloadedImagery()}
                >
                  Delete downloaded imagery
                </button>
              )}
              {resumableTileDownloads.map((manifest) => (
                <button
                  key={manifest.mapId}
                  type="button"
                  className="btn small"
                  disabled={tileSourceLoading || tileDownloading}
                  onClick={() => void handleResumeTileDownload(manifest)}
                >
                  Resume saved z{manifest.z} download ·{' '}
                  {countPlannedTileKeys(manifest.tiles, manifest.completedKeys)}/
                  {manifest.tiles.length} tiles saved
                </button>
              ))}
              <button
                type="button"
                className="btn small"
                disabled={capturing || tileDownloading || tileSourceLoading || !map}
                onClick={() => void handleStartBoundary()}
              >
                {tileSourceLoading
                  ? 'Checking county tiles…'
                  : !map
                    ? 'Waiting for basemap…'
                    : drawingBoundary
                      ? 'Drawing boundary…'
                      : 'Draw tiled boundary'}
              </button>
              {tileError && (
                <p role="alert" className="trailmaker-framing-error">
                  {tileError}
                </p>
              )}
              {tileBoundary.length > 0 && boundaryEditor}
              {tileSource && !drawingBoundary && (
                <div>
                  <label htmlFor="tiled-capture-zoom">Tile detail</label>
                  <select
                    id="tiled-capture-zoom"
                    value={tileZoom}
                    disabled={tileDownloading}
                    onChange={(event) => {
                      setTileZoom(Number(event.target.value));
                      setTileEstimate(null);
                    }}
                  >
                    {tileDetailLevels.map((level) => (
                      <option key={level.z} value={level.z}>
                        {tileSource.id === 'martin-county' && level.z === DEFAULT_TILE_ZOOM
                          ? 'Standard · '
                          : ''}
                        z{level.z} · {(level.resolutionM * 100).toFixed(1)} cm/px
                      </option>
                    ))}
                  </select>
                  {tiledPlan && (
                    <p className="trailmaker-framing-hint">
                      {(tiledPlan.areaSqMeters / 1_000_000).toFixed(2)} km² ·{' '}
                      {tiledPlan.tiles.length.toLocaleString()} tiles
                    </p>
                  )}
                  <button
                    type="button"
                    className="btn small"
                    disabled={!tiledPlan || tileDownloading}
                    onClick={() => void handleEstimateTiles()}
                  >
                    Estimate download
                  </button>
                  {tileEstimate && (
                    <p role="status">
                      About {(tileEstimate.estimatedBytes / 1_048_576).toFixed(1)} MB · about{' '}
                      {Math.ceil(tileEstimate.estimatedSeconds / 60)} min at the service request
                      limit.
                    </p>
                  )}
                  {tileEstimate?.enoughSpace === false && (
                    <label className="trailmaker-framing-warning">
                      <input
                        type="checkbox"
                        checked={tileStorageConfirmed}
                        onChange={(event) => setTileStorageConfirmed(event.target.checked)}
                      />{' '}
                      Available storage is below 1.5× the estimate. Continue anyway?
                    </label>
                  )}
                  {tileProgress && (
                    <p role="status">
                      Tiles: {tileProgress.complete}/{tileProgress.total}; missing:{' '}
                      {tileProgress.missing}
                    </p>
                  )}
                  {tileDownloading && (
                    <>
                      <button
                        type="button"
                        className="btn small"
                        onClick={() => {
                          if (tilePaused) tileCaptureRef.current?.resume();
                          else tileCaptureRef.current?.pause();
                          setTilePaused(!tilePaused);
                        }}
                      >
                        {tilePaused ? 'Resume download' : 'Pause download'}
                      </button>
                      <button
                        type="button"
                        className="btn small"
                        onClick={() => tileCaptureRef.current?.cancel()}
                      >
                        Cancel tile download
                      </button>
                    </>
                  )}
                  {tileEstimate && (
                    <button
                      type="button"
                      className="btn small"
                      disabled={isTiledDownloadDisabled(
                        tileSourceLoading || tileDeleting,
                        tileDownloading,
                        tileEstimate.enoughSpace,
                        tileStorageConfirmed,
                      )}
                      onClick={() => void handleDownloadTiles()}
                    >
                      {tileDownloading
                        ? 'Downloading…'
                        : tileProgress?.missing
                          ? `Retry ${tileProgress.missing} missing tiles`
                          : 'Download offline tiles'}
                    </button>
                  )}
                </div>
              )}
            </section>

            <div className="trailmaker-imagery-source-picker">
              <label htmlFor="capture-imagery-source">Capture imagery source</label>
              <select
                id="capture-imagery-source"
                value={activeSource?.id ?? 'naip'}
                onChange={(event) => {
                  setSelectedSourceId(event.target.value);
                  setSelectedZoom(null);
                  setRightsConfirmed(false);
                  setTileSource(null);
                }}
                disabled={capturing}
              >
                <option value="naip">USGS NAIP (fallback)</option>
                {sources.map((source) => (
                  <option key={source.id} value={source.id}>
                    {source.name}
                    {source.year ? ` (${source.year})` : ''} · about{' '}
                    {sourceResolution(source).toFixed(2)} m/px
                  </option>
                ))}
              </select>
              {activeSource && (
                <p className="trailmaker-framing-hint">
                  {activeSource.name}
                  {activeSource.year
                    ? ` (${activeSource.year}${activeSource.id === 'martin-county' ? ', as reported by the service' : ''})`
                    : ''}{' '}
                  · {(activeSource.nominalResolutionM * 100).toFixed(1)} cm/px
                  {activeSource.nominalResolutionM < 0.3 ? ', sharper than NAIP here' : ''} ·{' '}
                  {activeSource.attribution}
                </p>
              )}
              <label htmlFor="capture-imagery-url">
                Use another imagery service (ArcGIS REST URL)
              </label>
              <div className="trailmaker-imagery-url-row">
                <input
                  id="capture-imagery-url"
                  type="url"
                  value={serviceUrl}
                  onChange={(event) => setServiceUrl(event.target.value)}
                  placeholder="https://…/MapServer or /ImageServer"
                  autoComplete="url"
                />
                <button
                  type="button"
                  className="btn small"
                  disabled={serviceLoading || capturing || !serviceUrl.trim()}
                  onClick={() => void inspectService(serviceUrl)}
                >
                  {serviceLoading ? 'Checking…' : 'Check service'}
                </button>
              </div>
              {activeSource && isCustomSource && (
                <>
                  <p className="trailmaker-framing-hint">Credit: {activeSource.attribution}</p>
                  <label className="trailmaker-imagery-rights">
                    <input
                      type="checkbox"
                      checked={rightsConfirmed}
                      onChange={(event) => setRightsConfirmed(event.target.checked)}
                      disabled={capturing}
                    />{' '}
                    I have the right to use this imagery.
                  </label>
                  <button
                    type="button"
                    className="btn small"
                    disabled={!rightsConfirmed || tileSourceLoading}
                    onClick={() => void handleUseCustomTiledService()}
                  >
                    Use this cached service for tiled capture
                  </button>
                </>
              )}
            </div>

            {activeProvider === 'esri' && (
              <div className="trailmaker-framing-esri-notice" role="status">
                <span>
                  Esri doesn't permit offline export, so the captured map uses public-domain NAIP
                  (USGS elsewhere). After capture, switch the editor backdrop to Esri (live) to
                  trace on Esri imagery.
                </span>
                {onSwitchProvider && (
                  <button
                    type="button"
                    className="btn small"
                    onClick={() => onSwitchProvider('usgs')}
                  >
                    Switch to USGS
                  </button>
                )}
              </div>
            )}

            {dims && (
              <div className="trailmaker-framing-specs" aria-live="polite">
                <span className="trailmaker-framing-dim">
                  <strong>
                    {dims.width.toLocaleString()} × {dims.height.toLocaleString()} px
                  </strong>
                </span>
                <span className="trailmaker-framing-sep">•</span>
                <span className="trailmaker-framing-res">
                  {activeSource
                    ? `${activeSource.name} · about ${groundResolution((bounds!.north + bounds!.south) / 2, effectiveZoom).toFixed(3)} m per pixel`
                    : `USGS NAIP · about ${dims.metersPerPixel.toFixed(1)} m per pixel`}
                </span>
                <span className="trailmaker-framing-sep">•</span>
                <span className="trailmaker-framing-tiles">
                  {naipRequestCount} export {naipRequestCount === 1 ? 'request' : 'requests'}
                </span>
              </div>
            )}

            {exceedsLimits && (
              <div className="trailmaker-framing-warning" role="alert">
                Framed area exceeds maximum capture limits (12,000 px or 16 requests). Zoom out or
                frame a smaller area.
              </div>
            )}

            {error && (
              <div className="trailmaker-framing-error" role="alert">
                {error}
              </div>
            )}

            {/* Zoom adjustment control */}
            <div className="trailmaker-framing-zoom-row">
              <label htmlFor="satellite-zoom-stepper" className="trailmaker-framing-zoom-label">
                Capture zoom:
              </label>
              <div className="trailmaker-framing-zoom-controls" id="satellite-zoom-stepper">
                <button
                  type="button"
                  className="trailmaker-framing-zoom-btn"
                  disabled={effectiveZoom <= zoomRange.minZoom || capturing}
                  onClick={() => setSelectedZoom(effectiveZoom - 1)}
                  aria-label="Decrease capture zoom"
                  title="Decrease zoom (smaller image, faster)"
                >
                  −
                </button>
                <span
                  className="trailmaker-framing-zoom-value"
                  aria-label={`Zoom level ${effectiveZoom.toFixed(1)}`}
                >
                  {effectiveZoom.toFixed(1)}
                </span>
                <button
                  type="button"
                  className="trailmaker-framing-zoom-btn"
                  disabled={effectiveZoom >= zoomRange.maxZoom || capturing}
                  onClick={() => setSelectedZoom(effectiveZoom + 1)}
                  aria-label="Increase capture zoom"
                  title="Increase zoom (higher detail)"
                >
                  +
                </button>
              </div>
            </div>

            {/* Progress indicator during tile fetching */}
            {capturing && progress && (
              <div
                className="trailmaker-framing-progress"
                role="progressbar"
                aria-valuenow={progress.loaded}
                aria-valuemax={progress.total}
              >
                <div className="trailmaker-framing-progress-label">{progress.stage}</div>
                <div className="trailmaker-framing-progress-track">
                  <div
                    className="trailmaker-framing-progress-fill"
                    style={{
                      width: `${progress.total ? Math.round((progress.loaded / progress.total) * 100) : 0}%`,
                    }}
                  />
                </div>
              </div>
            )}

            {/* Action buttons */}
            <div className="trailmaker-framing-actions">
              <button type="button" className="btn" onClick={handleCancelCapture}>
                Cancel
              </button>
              <button
                type="button"
                className="btn primary"
                disabled={
                  exceedsLimits || capturing || !dims || (isCustomSource && !rightsConfirmed)
                }
                onClick={handleStartCapture}
              >
                {capturing ? 'Capturing…' : 'Capture map'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
};
