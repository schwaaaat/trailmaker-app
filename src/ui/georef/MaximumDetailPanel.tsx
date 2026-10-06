import React, { type FC, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { GeoJSONSource, Map as MapLibreMap } from 'maplibre-gl';

void React;
import type { LatLon } from '../../core/types';
import type { Session } from '../contract';
import { detailExportLocalTiles, type DetailMapExtent } from '../../io/max-detail-export';
import { MAX_DETAIL_EXPORTS_PER_OPERATION, planDetailExports } from '../../io/max-detail-planner';
import {
  createMaximumDetailFillInController,
  maximumDetailExportsRemaining,
  startMaximumDetailDownload,
  type MaximumDetailFillInController,
} from '../../io/max-detail-session';
import { startDeviceLocationWatch } from '../../io/device-location';
import type { DeviceLocationFix } from './location-overlay';
import {
  deleteTileLevel,
  getTileDownload,
  listTileRecords,
  tiledMapStorageId,
} from '../../io/tile-store';
import type { PoliteExportDownloader } from '../../io/max-detail-downloader';

const DETAIL_EXPORT_BYTES_FALLBACK = 1_500_000;
const MAX_DETAIL_MIN_START_INTERVAL_MS = 3_000;

function estimateDuration(seconds: number): string {
  if (seconds < 60) return `${seconds} sec`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return remainingSeconds ? `${minutes} min ${remainingSeconds} sec` : `${minutes} min`;
}

export interface MaximumDetailPanelProps {
  readonly map: MapLibreMap | null;
  readonly isOpen: boolean;
  readonly session: Session | null;
  /** Current editor viewport center and scale, supplied by the Lane A editor seam. */
  readonly editorFocus?: { readonly location: LatLon; readonly scale: number } | null;
  /** Lets the editor draw the current device fix locally. */
  readonly onLocationFix?: ((fix: DeviceLocationFix | null) => void) | undefined;
  readonly disabled?: boolean;
  readonly compact?: boolean;
}

function boundsBoundary(map: MapLibreMap | null): readonly LatLon[] | null {
  if (!map || typeof map.getBounds !== 'function') return null;
  const bounds = map.getBounds();
  if (
    !bounds ||
    typeof bounds.getSouthWest !== 'function' ||
    typeof bounds.getNorthEast !== 'function'
  )
    return null;
  const sw = bounds.getSouthWest();
  const ne = bounds.getNorthEast();
  if (ne.lng - sw.lng >= 360 || ne.lng < sw.lng) return null;
  return [
    [ne.lat, sw.lng],
    [ne.lat, ne.lng],
    [sw.lat, ne.lng],
    [sw.lat, sw.lng],
  ];
}

export const MaximumDetailPanel: FC<MaximumDetailPanelProps> = ({
  map,
  isOpen,
  session,
  editorFocus = null,
  onLocationFix,
  disabled = false,
  compact = false,
}) => {
  const [boundary, setBoundary] = useState<readonly LatLon[]>([]);
  const [drawing, setDrawing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [estimateReady, setEstimateReady] = useState(false);
  const [averageTileBytes, setAverageTileBytes] = useState<number | null>(null);
  const [storedDetailTiles, setStoredDetailTiles] = useState(0);
  const [downloadProgress, setDownloadProgress] = useState<{
    completed: number;
    total: number;
    missing: number;
  } | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [downloadReady, setDownloadReady] = useState(false);
  const [paused, setPaused] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [showLocation, setShowLocation] = useState(false);
  const [locationFix, setLocationFix] = useState<DeviceLocationFix | null>(null);
  const [locationError, setLocationError] = useState<string | null>(null);
  const [fillInMapId, setFillInMapId] = useState<string | null>(null);
  const [fillInStopping, setFillInStopping] = useState(false);
  const [fillInProgress, setFillInProgress] = useState<{
    completed: number;
    total: number;
    missing: number;
    hourlyStartsRemaining?: number;
  } | null>(null);
  const [hourlyStartsRemaining, setHourlyStartsRemaining] = useState<number | null>(null);
  const [fillInError, setFillInError] = useState<string | null>(null);
  const downloaderRef = useRef<PoliteExportDownloader | null>(null);
  const fillInControllerRef = useRef<MaximumDetailFillInController | null>(null);

  const image = session?.project.image;
  const tiledSource = image?.source.kind === 'tiles' ? image.source : null;
  const mapId = tiledSource ? tiledMapStorageId(tiledSource) : null;
  const currentMapIdRef = useRef(mapId);
  currentMapIdRef.current = mapId;
  const extent: DetailMapExtent | null = useMemo(
    () =>
      tiledSource
        ? {
            origin: tiledSource.origin,
            sourceZoom: tiledSource.z,
            width: image!.width,
            height: image!.height,
            tileSize: tiledSource.tileSize,
          }
        : null,
    [image, tiledSource],
  );
  const isMartinZ20 = tiledSource?.sourceId === 'martin-county' && tiledSource.z === 20;
  const fillInEnabled = !!mapId && fillInMapId === mapId;

  const planning = useMemo(() => {
    if (boundary.length < 3) return { plan: null, error: null };
    try {
      const projected = planDetailExports(boundary);
      const cells = extent
        ? projected.cells.filter((cell) => detailExportLocalTiles(cell, extent).length > 0)
        : projected.cells;
      return {
        plan: {
          ...projected,
          cells,
          totalExports: cells.length,
          exceedsRecommendedLimit: cells.length > projected.recommendedLimit,
        },
        error: null,
      };
    } catch (cause) {
      return {
        plan: null,
        error: cause instanceof Error ? cause.message : 'Could not plan maximum-detail exports.',
      };
    }
  }, [boundary, extent]);
  const plan = planning.plan;
  const planError = planning.error;

  useEffect(() => {
    setEstimateReady(false);
  }, [boundary, mapId]);

  const refreshDetailState = useCallback(async () => {
    if (!mapId) return;
    const [records, manifest] = await Promise.all([listTileRecords(mapId), getTileDownload(mapId)]);
    if (currentMapIdRef.current !== mapId) return;
    setStoredDetailTiles(records.filter((record) => record.level === -1).length);
    setAverageTileBytes(manifest?.averageTileBytes ?? null);
  }, [mapId]);

  useEffect(() => {
    return () => {
      downloaderRef.current?.cancel();
      downloaderRef.current = null;
    };
  }, [mapId]);

  useEffect(() => {
    setBoundary([]);
    setDrawing(false);
    setEstimateReady(false);
    setDownloadProgress(null);
    setDownloading(false);
    setDownloadReady(false);
    setPaused(false);
    setDeleting(false);
    setStoredDetailTiles(0);
    setAverageTileBytes(null);
    setError(null);
    setFillInProgress(null);
    setHourlyStartsRemaining(null);
    setFillInError(null);
    setFillInStopping(false);
  }, [mapId]);

  useEffect(() => {
    if (!mapId || !isOpen) {
      setStoredDetailTiles(0);
      return;
    }
    void refreshDetailState().catch((cause: unknown) => {
      if (currentMapIdRef.current === mapId) {
        setError(cause instanceof Error ? cause.message : 'Could not read saved detail imagery.');
      }
    });
  }, [isOpen, mapId, refreshDetailState]);

  useEffect(() => {
    if (!map || !isOpen || !drawing || disabled) return;
    const addPoint = (event: {
      lngLat: { lng: number; lat: number };
      originalEvent?: { detail?: number };
    }) => {
      if (event.originalEvent?.detail && event.originalEvent.detail > 1) return;
      setBoundary((current) => [...current, [event.lngLat.lat, event.lngLat.lng]]);
    };
    map.on('click', addPoint);
    return () => {
      map.off('click', addPoint);
    };
  }, [disabled, drawing, isOpen, map]);

  useEffect(() => {
    if (!map || !isOpen || typeof map.isStyleLoaded !== 'function' || !map.isStyleLoaded()) return;
    const sourceId = 'trailmaker-maximum-detail-boundary';
    const coordinates = boundary.map(([lat, lon]) => [lon, lat]);
    const geometry =
      coordinates.length >= 3 && !drawing
        ? { type: 'Polygon' as const, coordinates: [[...coordinates, coordinates[0]!]] }
        : { type: 'LineString' as const, coordinates };
    const data = { type: 'Feature' as const, properties: {}, geometry };
    const source = map.getSource(sourceId) as GeoJSONSource | undefined;
    if (source) source.setData(data);
    else {
      map.addSource(sourceId, { type: 'geojson', data });
      map.addLayer({
        id: `${sourceId}-fill`,
        type: 'fill',
        source: sourceId,
        paint: { 'fill-color': '#d25a28', 'fill-opacity': 0.16 },
      });
      map.addLayer({
        id: `${sourceId}-line`,
        type: 'line',
        source: sourceId,
        paint: { 'line-color': '#d25a28', 'line-width': 3, 'line-dasharray': [2, 1] },
      });
      map.addLayer({
        id: `${sourceId}-points`,
        type: 'circle',
        source: sourceId,
        paint: {
          'circle-radius': 5,
          'circle-color': '#d25a28',
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 2,
        },
        filter: ['==', '$type', 'Point'],
      });
    }
    const pointsId = `${sourceId}-vertices`;
    const pointsData = {
      type: 'FeatureCollection' as const,
      features: coordinates.map((coordinate) => ({
        type: 'Feature' as const,
        properties: {},
        geometry: { type: 'Point' as const, coordinates: coordinate },
      })),
    };
    const pointsSource = map.getSource(pointsId) as GeoJSONSource | undefined;
    if (pointsSource) pointsSource.setData(pointsData);
    else {
      map.addSource(pointsId, { type: 'geojson', data: pointsData });
      map.addLayer({
        id: `${pointsId}-circles`,
        type: 'circle',
        source: pointsId,
        paint: {
          'circle-radius': 5,
          'circle-color': '#d25a28',
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 2,
        },
      });
    }
    return () => {
      for (const layerId of [
        `${sourceId}-fill`,
        `${sourceId}-line`,
        `${sourceId}-points`,
        `${pointsId}-circles`,
      ]) {
        if (map.getLayer(layerId)) map.removeLayer(layerId);
      }
      if (map.getSource(pointsId)) map.removeSource(pointsId);
      if (map.getSource(sourceId)) map.removeSource(sourceId);
    };
  }, [boundary, drawing, isOpen, map]);

  useEffect(() => {
    if (!showLocation || !isOpen) {
      setLocationFix(null);
      onLocationFix?.(null);
      setLocationError(null);
      return;
    }
    setLocationError(null);
    const stop = startDeviceLocationWatch(
      (fix) => {
        setLocationFix(fix);
        onLocationFix?.(fix);
      },
      (message) => setLocationError(message),
    );
    return () => stop();
  }, [isOpen, showLocation, onLocationFix]);

  useEffect(() => {
    if (!mapId || !extent || !isMartinZ20) {
      fillInControllerRef.current = null;
      return;
    }
    const controller = createMaximumDetailFillInController(mapId, tiledSource!.sourceId, extent, {
      onError: (cause) => {
        if (currentMapIdRef.current === mapId) {
          setFillInError(
            cause instanceof Error ? cause.message : 'Could not start fill-in detail.',
          );
        }
      },
      onProgress: (progress) => {
        if (currentMapIdRef.current !== mapId) return;
        setFillInProgress(progress);
        if (typeof progress.hourlyStartsRemaining === 'number') {
          setHourlyStartsRemaining(progress.hourlyStartsRemaining);
        }
      },
    });
    fillInControllerRef.current = controller;
    return () => {
      if (fillInControllerRef.current === controller) fillInControllerRef.current = null;
      void controller.cancel();
    };
  }, [extent, isMartinZ20, mapId, tiledSource]);

  const focus =
    showLocation && locationFix
      ? locationFix.location
      : editorFocus && editorFocus.scale > 1
        ? editorFocus.location
        : null;
  useEffect(() => {
    const controller = fillInControllerRef.current;
    if (!controller) return;
    if (!fillInEnabled) {
      setFillInStopping(true);
      void controller
        .setEnabled(false)
        .catch((cause: unknown) => {
          setFillInError(cause instanceof Error ? cause.message : 'Could not stop fill-in detail.');
        })
        .finally(() => setFillInStopping(false));
      return;
    }
    void controller.setEnabled(true).catch((cause: unknown) => {
      setFillInError(cause instanceof Error ? cause.message : 'Could not start fill-in detail.');
    });
  }, [fillInEnabled, mapId]);

  useEffect(() => {
    if (!fillInEnabled || !focus) return;
    void fillInControllerRef.current
      ?.updateFocus(focus)
      .catch((cause: unknown) =>
        setFillInError(cause instanceof Error ? cause.message : 'Could not update fill-in focus.'),
      );
  }, [fillInEnabled, focus]);

  useEffect(() => {
    if (!fillInEnabled || !isOpen) return;
    let alive = true;
    const refresh = () => {
      void maximumDetailExportsRemaining().then((count) => {
        if (alive) setHourlyStartsRemaining(count);
      });
    };
    refresh();
    const interval = window.setInterval(refresh, 30_000);
    return () => {
      alive = false;
      window.clearInterval(interval);
    };
  }, [fillInEnabled, isOpen]);

  if (!session || !isOpen) return null;

  const estimatedBytes = plan
    ? plan.totalExports * (averageTileBytes ? averageTileBytes * 64 : DETAIL_EXPORT_BYTES_FALLBACK)
    : 0;
  const estimatedSeconds = plan ? plan.totalExports * MAX_DETAIL_MIN_START_INTERVAL_MS : 0;
  const maxLimitExceeded = (plan?.totalExports ?? 0) > MAX_DETAIL_EXPORTS_PER_OPERATION;
  const pathAAvailable = !!map && !!mapId && !!extent && isMartinZ20;
  const canStartPathA = pathAAvailable && !!plan && plan.totalExports > 0 && !maxLimitExceeded;
  const fillHasFocus = !!focus;

  const useCurrentView = () => {
    const current = boundsBoundary(map);
    if (!current) {
      setError('Could not read the current map view.');
      return;
    }
    setBoundary(current);
    setDrawing(false);
    setError(null);
  };

  const startPathA = async () => {
    if (!canStartPathA || !plan || !mapId || !extent || !tiledSource) return;
    setError(null);
    setEstimateReady(true);
    setDownloading(true);
    setPaused(false);
    setDownloadProgress({ completed: 0, total: plan.totalExports, missing: 0 });
    setDownloadReady(false);
    try {
      const downloader = await startMaximumDetailDownload(
        mapId,
        tiledSource.sourceId,
        extent,
        plan.cells,
        {
          onProgress: (progress) => {
            if (currentMapIdRef.current !== mapId) return;
            setDownloadProgress(progress);
            if (typeof progress.hourlyStartsRemaining === 'number') {
              setHourlyStartsRemaining(progress.hourlyStartsRemaining);
            }
          },
        },
      );
      if (currentMapIdRef.current !== mapId) {
        downloader.cancel();
        await downloader.promise.catch(() => undefined);
        return;
      }
      downloaderRef.current = downloader;
      setDownloadReady(true);
      const result = await downloader.promise;
      if (currentMapIdRef.current !== mapId) return;
      setDownloadProgress({
        completed: result.completedKeys.length,
        total: plan.totalExports,
        missing: result.missing.length,
      });
      if (result.cancelled) setPaused(false);
      if (result.missing.length) setError(`${result.missing.length} exports need retrying.`);
      await refreshDetailState();
    } catch (cause) {
      if (currentMapIdRef.current === mapId) {
        setError(cause instanceof Error ? cause.message : 'Maximum-detail download failed.');
      }
    } finally {
      if (currentMapIdRef.current === mapId) {
        downloaderRef.current = null;
        setDownloadReady(false);
        setDownloading(false);
        setPaused(false);
      }
    }
  };

  const deleteDetail = async () => {
    if (!mapId || downloading || deleting) return;
    setDeleting(true);
    setError(null);
    try {
      if (fillInEnabled) {
        setFillInMapId(null);
        await fillInControllerRef.current?.setEnabled(false);
      }
      await deleteTileLevel(mapId, -1);
      setDownloadProgress(null);
      await refreshDetailState();
    } catch (cause) {
      if (currentMapIdRef.current === mapId) {
        setError(cause instanceof Error ? cause.message : 'Could not delete maximum-detail tiles.');
      }
    } finally {
      if (currentMapIdRef.current === mapId) setDeleting(false);
    }
  };

  const content = (
    <section className="trailmaker-max-detail" aria-label="Maximum-detail imagery">
      <h4>Maximum detail · z21 · about 7.6 cm/px</h4>
      {pathAAvailable ? (
        <>
          <p className="trailmaker-framing-hint">
            Martin County renders these exports on demand. Use the current view or draw a small
            boundary; exports start at least 3 seconds apart.
          </p>
          <div className="trailmaker-max-detail-actions">
            <button
              type="button"
              className="btn small"
              disabled={disabled || drawing || downloading}
              onClick={useCurrentView}
            >
              Use current view
            </button>
            <button
              type="button"
              className="btn small"
              disabled={disabled || downloading}
              onClick={() => {
                setBoundary([]);
                setDrawing(true);
                setEstimateReady(false);
                setError(null);
              }}
            >
              {drawing ? 'Click map to draw boundary' : 'Draw detail boundary'}
            </button>
            {drawing && (
              <button
                type="button"
                className="btn small"
                disabled={disabled || boundary.length < 3}
                onClick={() => setDrawing(false)}
              >
                Finish boundary
              </button>
            )}
            {!!boundary.length && (
              <button
                type="button"
                className="btn small"
                disabled={disabled || downloading}
                onClick={() => {
                  setBoundary([]);
                  setDrawing(false);
                  setEstimateReady(false);
                }}
              >
                Clear boundary
              </button>
            )}
          </div>
          {boundary.length > 0 && (
            <p role="status">
              {boundary.length} boundary points{drawing ? ' · click the map to add points' : ''}
            </p>
          )}
          {plan && (
            <p role="status">
              {plan.totalExports.toLocaleString()} exports · approx.{' '}
              {(estimatedBytes / 1_048_576).toFixed(1)} MB · at least{' '}
              {estimateDuration(estimatedSeconds)}
              {averageTileBytes
                ? ' (estimated from the saved base-tile average)'
                : ' (rough size estimate)'}
            </p>
          )}
          {maxLimitExceeded && (
            <p className="trailmaker-framing-warning" role="alert">
              This plan exceeds the 40-export cap. Large plans add load to the county export
              service; draw a smaller area to continue.
            </p>
          )}
          {planError && (
            <p role="alert" className="trailmaker-framing-error">
              {planError}
            </p>
          )}
          {estimateReady && downloadProgress && (
            <p role="status">
              Exports: {downloadProgress.completed}/{downloadProgress.total}; missing:{' '}
              {downloadProgress.missing}
            </p>
          )}
          {downloading && downloadReady && (
            <div className="trailmaker-max-detail-actions">
              <button
                type="button"
                className="btn small"
                onClick={() => {
                  if (paused) downloaderRef.current?.resume();
                  else downloaderRef.current?.pause();
                  setPaused(!paused);
                }}
              >
                {paused ? 'Resume maximum-detail download' : 'Pause maximum-detail download'}
              </button>
              <button
                type="button"
                className="btn small"
                onClick={() => downloaderRef.current?.cancel()}
              >
                Cancel maximum-detail download
              </button>
            </div>
          )}
          <button
            type="button"
            className="btn small"
            disabled={
              !canStartPathA ||
              disabled ||
              downloading ||
              deleting ||
              fillInEnabled ||
              fillInStopping
            }
            onClick={() => void startPathA()}
          >
            {downloadProgress?.missing && !downloading
              ? `Retry ${downloadProgress.missing} missing exports`
              : 'Download maximum detail'}
          </button>
        </>
      ) : (
        <p className="trailmaker-framing-hint">
          Maximum-detail exports need an open Martin County z20 tiled map.
        </p>
      )}

      {isMartinZ20 && (
        <>
          <p role="status">
            {storedDetailTiles.toLocaleString()} detail tiles stored on this device.
          </p>
          <button
            type="button"
            className="btn small"
            disabled={!storedDetailTiles || disabled || deleting || downloading || fillInStopping}
            onClick={() => void deleteDetail()}
          >
            {deleting ? 'Deleting detail…' : 'Delete detail imagery'}
          </button>
        </>
      )}

      <div className="trailmaker-max-detail-location">
        <label>
          <input
            type="checkbox"
            checked={showLocation}
            disabled={disabled || downloading || deleting}
            onChange={(event) => setShowLocation(event.target.checked)}
          />{' '}
          Show my location
        </label>
        {locationFix && (
          <p role="status">
            Location accuracy ±{Math.round(locationFix.accuracyMeters)} m. This position stays on
            this device.
          </p>
        )}
        {locationError && (
          <p role="alert" className="trailmaker-framing-error">
            {locationError}
          </p>
        )}
        {isMartinZ20 && (
          <>
            <label>
              <input
                type="checkbox"
                checked={fillInEnabled}
                disabled={disabled || downloading || deleting || fillInStopping}
                onChange={(event) => {
                  setFillInError(null);
                  if (!event.target.checked) setFillInStopping(true);
                  setFillInMapId(event.target.checked ? mapId : null);
                }}
              />{' '}
              Fill in maximum detail as I go
            </label>
            <p className="trailmaker-framing-hint">
              Off by default. Coordinates stay on this device; when detail is enabled, export bounds
              are sent to Martin County. The limit is 60 exports per hour.
            </p>
            {fillInEnabled && (
              <p role="status">
                {hourlyStartsRemaining ?? '…'} of 60 export starts remain this hour.
                {!fillHasFocus && ' Turn on Show my location or zoom the editor in past level 0.'}
              </p>
            )}
            {fillInProgress && (
              <p role="status">
                Fill-in: {fillInProgress.completed}/{fillInProgress.total} exports complete;
                missing: {fillInProgress.missing}
              </p>
            )}
            {fillInError && (
              <p role="alert" className="trailmaker-framing-error">
                {fillInError}
              </p>
            )}
          </>
        )}
        {error && (
          <p role="alert" className="trailmaker-framing-error">
            {error}
          </p>
        )}
      </div>
    </section>
  );

  return compact ? (
    <details className="trailmaker-max-detail-details">
      <summary>Maximum detail and location</summary>
      {content}
    </details>
  ) : (
    content
  );
};
