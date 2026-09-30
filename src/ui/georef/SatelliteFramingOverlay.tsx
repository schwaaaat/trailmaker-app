// Lane C. Satellite capture framing overlay, resolution calculation, zoom selection and progress UI (card T-318, D-031).
import React, {
  type FC,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import type { Map as MapLibreMap } from 'maplibre-gl';
import {
  captureSatelliteView,
  buildSatelliteProject,
  computeOptimalNaipZoom,
  getCaptureDimensions,
  planNaipRequests,
  MAX_NAIP_CAPTURE_LONG_SIDE,
  MAX_NAIP_EXPORT_REQUESTS,
  type CaptureDimensions,
  type CaptureProgress,
  type FramedBounds,
} from '../../io/satellite-capture';
import { loadSettings, type SatelliteProviderId } from '../../io/settings';
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
  readonly tileLoader?: ((x: number, y: number, z: number, signal?: AbortSignal) => Promise<CanvasImageSource | null>) | undefined;
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

  useFocusTrap({
    active: isOpen && !capturing,
    containerRef,
    onClose,
  });

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
      const center = typeof map.getCenter === 'function' ? map.getCenter() : { lng: -80.145, lat: 27.135 };
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
  const currentOptimalZoom = bounds ? computeOptimalNaipZoom(bounds) : 18;
  const zoomRange = bounds
    ? { minZoom: Math.max(0, currentOptimalZoom - 4), maxZoom: currentOptimalZoom, defaultZoom: currentOptimalZoom }
    : { minZoom: 0, maxZoom: 18, defaultZoom: 18 };

  const effectiveZoom = selectedZoom !== null
    ? Math.min(zoomRange.maxZoom, Math.max(zoomRange.minZoom, selectedZoom))
    : currentOptimalZoom;

  const dims: CaptureDimensions | null = bounds
    ? getCaptureDimensions(bounds, effectiveZoom)
    : null;

  const naipRequestCount = dims ? planNaipRequests(dims).length : 0;
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
        providerId: 'naip',
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
          `Captured satellite map (${result.width.toLocaleString()} × ${result.height.toLocaleString()} px) with ${result.missingTiles} missing tiles`
        );
      } else {
        showToast(
          `Captured satellite map (${result.width.toLocaleString()} × ${result.height.toLocaleString()} px)`
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

        {activeProvider === 'esri' && (
          <div className="trailmaker-framing-esri-notice" role="status">
            <span>
              Esri does not permit offline tile export, so capture uses public-domain NAIP where available and USGS imagery elsewhere; tracing with Esri is allowed.
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
              <strong>{dims.width.toLocaleString()} × {dims.height.toLocaleString()} px</strong>
            </span>
            <span className="trailmaker-framing-sep">•</span>
            <span className="trailmaker-framing-res">
              USGS NAIP · about {dims.metersPerPixel.toFixed(1)} m per pixel
            </span>
            <span className="trailmaker-framing-sep">•</span>
            <span className="trailmaker-framing-tiles">
              {naipRequestCount} export {naipRequestCount === 1 ? 'request' : 'requests'}
            </span>
          </div>
        )}

        {exceedsLimits && (
          <div className="trailmaker-framing-warning" role="alert">
            Framed area exceeds maximum capture limits (12,000 px or 16 requests). Zoom out or frame a smaller area.
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
            <span className="trailmaker-framing-zoom-value" aria-label={`Zoom level ${effectiveZoom.toFixed(1)}`}>
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
          <div className="trailmaker-framing-progress" role="progressbar" aria-valuenow={progress.loaded} aria-valuemax={progress.total}>
            <div className="trailmaker-framing-progress-label">
              {progress.stage}
            </div>
            <div className="trailmaker-framing-progress-track">
              <div
                className="trailmaker-framing-progress-fill"
                style={{ width: `${progress.total ? Math.round((progress.loaded / progress.total) * 100) : 0}%` }}
              />
            </div>
          </div>
        )}

        {/* Action buttons */}
        <div className="trailmaker-framing-actions">
          <button
            type="button"
            className="btn"
            onClick={handleCancelCapture}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={exceedsLimits || capturing || !dims}
            onClick={handleStartCapture}
          >
            {capturing ? 'Capturing…' : 'Capture map'}
          </button>
        </div>
      </div>
    </div>
  );
};
