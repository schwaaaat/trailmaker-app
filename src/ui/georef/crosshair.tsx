// Lane C. Cross-hair and hover synchronization between park map and basemap (card T-307).
import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Map as MapLibreMap, Marker as MapLibreMarker } from 'maplibre-gl';
import { forward, inverse } from '../../core/geo/fit';
import type { FitResult, LatLon, Px } from '../../core/types';
import { currentEditor, onEditor } from '../editor/EditorStage';

void React;

export class BasemapCrosshair {
  private marker: MapLibreMarker | null = null;

  update(
    px: Px | null,
    fit: FitResult | null,
    map: MapLibreMap | null,
    maplibre: typeof import('maplibre-gl') | null,
  ): void {
    if (!px || !fit?.ok || !map || !maplibre) {
      this.destroy();
      return;
    }

    const [lat, lon] = forward(fit, px);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      this.destroy();
      return;
    }

    if (this.marker) {
      this.marker.setLngLat([lon, lat]);
    } else {
      const el = document.createElement('div');
      el.className = 'georef-crosshair';
      el.setAttribute('aria-hidden', 'true');
      this.marker = new maplibre.Marker({
        element: el,
        anchor: 'center',
      })
        .setLngLat([lon, lat])
        .addTo(map);
    }
  }

  destroy(): void {
    if (this.marker) {
      this.marker.remove();
      this.marker = null;
    }
  }
}

/**
 * Computes matching park-map pixel from basemap LatLon, or null if fit is not ok or outside image.
 */
export function computeParkMapMatch(
  latLon: LatLon | null,
  fit: FitResult | null,
  imageDimensions?: { width: number; height: number },
): Px | null {
  if (!latLon || !fit?.ok) return null;
  const px = inverse(fit, latLon);
  if (!px) return null;

  if (imageDimensions) {
    const [x, y] = px;
    if (x < 0 || x > imageDimensions.width || y < 0 || y > imageDimensions.height) {
      return null;
    }
  }

  return px;
}

/**
 * Component that displays the matching point on the park map when hovering over the basemap.
 */
export function ParkMapIndicator({ px }: { px: Px | null }) {
  const [clientPos, setClientPos] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (!px) {
      setClientPos(null);
      return;
    }

    const updatePosition = () => {
      const editor = currentEditor();
      if (!editor) {
        setClientPos(null);
        return;
      }
      try {
        const client = editor.imageToClient(px);
        setClientPos(client);
      } catch {
        setClientPos(null);
      }
    };

    updatePosition();

    // Re-check position if editor changes
    const unsub = onEditor(() => {
      updatePosition();
    });

    window.addEventListener('resize', updatePosition);
    return () => {
      unsub();
      window.removeEventListener('resize', updatePosition);
    };
  }, [px]);

  if (!clientPos || typeof document === 'undefined') return null;

  return createPortal(
    <div
      className="georef-park-map-indicator"
      style={{
        position: 'fixed',
        left: `${clientPos.x}px`,
        top: `${clientPos.y}px`,
        transform: 'translate(-50%, -50%)',
        pointerEvents: 'none',
        zIndex: 1000,
      }}
      aria-hidden="true"
    />,
    document.body,
  );
}
