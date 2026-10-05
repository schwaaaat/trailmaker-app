// Lane C. Satellite capture framing overlay, resolution calculation, zoom selection and progress UI (card T-318, D-031).
import React, { type FC, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Map as MapLibreMap } from 'maplibre-gl';
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

  useFocusTrap({
    active: isOpen && !capturing,
    containerRef,
    onClose,
  });

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
    setProgress(null);
    onClose();
  };

  if (!isOpen) return null;

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
        className="trailmaker-framing-box"
        data-testid="framing-box"
        aria-hidden="true"
      >
        <div className="trailmaker-framing-corner tl" />
        <div className="trailmaker-framing-corner tr" />
        <div className="trailmaker-framing-corner bl" />
        <div className="trailmaker-framing-corner br" />
      </div>

      {/* Top Banner / Framing controls */}
      <div className="trailmaker-framing-banner">
        <div className="trailmaker-framing-title-row">
          <h3 className="trailmaker-framing-title">Frame area to capture</h3>
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

        <p className="trailmaker-framing-hint">
          Pan and zoom the satellite map to position your park or trail area inside the frame.
        </p>

        <div className="trailmaker-imagery-source-picker">
          <label htmlFor="capture-imagery-source">Capture imagery source</label>
          <select
            id="capture-imagery-source"
            value={activeSource?.id ?? 'naip'}
            onChange={(event) => {
              setSelectedSourceId(event.target.value);
              setSelectedZoom(null);
              setRightsConfirmed(false);
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
          <label htmlFor="capture-imagery-url">Use another imagery service (ArcGIS REST URL)</label>
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
            </>
          )}
        </div>

        {activeProvider === 'esri' && (
          <div className="trailmaker-framing-esri-notice" role="status">
            <span>
              Esri doesn't permit offline export, so the captured map uses public-domain NAIP (USGS
              elsewhere). After capture, switch the editor backdrop to Esri (live) to trace on Esri
              imagery.
            </span>
            {onSwitchProvider && (
              <button type="button" className="btn small" onClick={() => onSwitchProvider('usgs')}>
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
            Framed area exceeds maximum capture limits (12,000 px or 16 requests). Zoom out or frame
            a smaller area.
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
            disabled={exceedsLimits || capturing || !dims || (isCustomSource && !rightsConfirmed)}
            onClick={handleStartCapture}
          >
            {capturing ? 'Capturing…' : 'Capture map'}
          </button>
        </div>
      </div>
    </div>
  );
};
