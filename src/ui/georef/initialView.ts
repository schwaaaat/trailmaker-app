import { overlayQuad } from '../../core/geo/fit';
import type { Anchor, FitResult, LatLon } from '../../core/types';
import type { BasemapSettings } from '../../io/settings';

export interface InitialCameraView {
  bounds?: [[number, number], [number, number]];
  center?: [number, number];
  zoom?: number;
}

/**
 * Computes the initial camera view for the basemap according to Acceptance 5:
 * 1. If project has a fit, frame image overlayQuad bounds.
 * 2. Otherwise anchors' ll bounds.
 * 3. Otherwise last viewed basemap position from settings.
 * 4. Otherwise world view.
 */
export function computeInitialView(
  fit: FitResult | null,
  imageDimensions: { width: number; height: number } | undefined,
  anchors: readonly Anchor[] | undefined,
  settings: BasemapSettings,
): InitialCameraView {
  // 1. If project has a valid fit and image dimensions, frame overlayQuad bounds
  if (fit && fit.ok && imageDimensions && imageDimensions.width > 0 && imageDimensions.height > 0) {
    const quad = overlayQuad(fit, imageDimensions.width, imageDimensions.height);
    const lats = quad.map((p: LatLon) => p[0]);
    const lngs = quad.map((p: LatLon) => p[1]);
    const minLat = Math.min(...lats);
    const maxLat = Math.max(...lats);
    const minLng = Math.min(...lngs);
    const maxLng = Math.max(...lngs);
    return {
      bounds: [
        [minLng, minLat],
        [maxLng, maxLat],
      ],
    };
  }

  // 2. Otherwise anchors' ll bounds
  if (anchors && anchors.length > 0) {
    const withLl = anchors.filter(
      (a): a is Anchor & { ll: LatLon } =>
        a.ll !== null && Array.isArray(a.ll) && a.ll.length === 2,
    );
    if (withLl.length === 1) {
      const [lat, lng] = withLl[0]!.ll;
      return {
        center: [lng, lat],
        zoom: 14,
      };
    }
    if (withLl.length > 1) {
      const lats = withLl.map((a) => a.ll[0]);
      const lngs = withLl.map((a) => a.ll[1]);
      const minLat = Math.min(...lats);
      const maxLat = Math.max(...lats);
      const minLng = Math.min(...lngs);
      const maxLng = Math.max(...lngs);
      return {
        bounds: [
          [minLng, minLat],
          [maxLng, maxLat],
        ],
      };
    }
  }

  // 3. Otherwise last viewed basemap position (settings)
  if (
    settings.lastCenter &&
    Array.isArray(settings.lastCenter) &&
    settings.lastCenter.length === 2
  ) {
    return {
      center: settings.lastCenter,
      zoom: settings.lastZoom ?? 10,
    };
  }

  // 4. Otherwise world view
  return {
    center: [0, 20],
    zoom: 1,
  };
}
