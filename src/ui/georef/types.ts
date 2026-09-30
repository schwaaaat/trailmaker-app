import type { CSSProperties, ReactNode, Ref } from 'react';
import type { Map as MapLibreMap } from 'maplibre-gl';
import type { LatLon } from '../../core/types';

export interface BasemapHandle {
  /** Get the active MapLibre instance, or null if not yet initialized/enabled. */
  getMap(): MapLibreMap | null;
  /** Check if the MapLibre instance is initialized and idle. */
  isReady(): boolean;
  /** Fly the camera to a target center and zoom. */
  flyTo(options: { center: [number, number]; zoom?: number }): void;
  /** Fit the camera to bounding coordinates [[minLng, minLat], [maxLng, maxLat]]. */
  fitBounds(
    bounds: [[number, number], [number, number]],
    options?: { padding?: number; animate?: boolean },
  ): void;
  /** Get the map DOM container element. */
  getContainer(): HTMLElement | null;
}

export interface BasemapPaneProps {
  className?: string;
  style?: CSSProperties;
  /** Imperative handle ref for map operations. */
  handleRef?: Ref<BasemapHandle>;
  /** Callback fired when the user clicks on the basemap (passes [lat, lng] and viewport pixel). */
  onMapClick?: (coords: LatLon, point: { x: number; y: number }) => void;
  /** Style URL override (used e.g. for offline test fixture). */
  overrideStyleUrl?: string;
  /** Custom confirmation callback for testing or modal dialogs. */
  confirm?: (message: string) => boolean;
  /** Callback to reset interface to defaults (T-224). */
  onResetInterface?: (() => void) | undefined;
  /** Child elements to overlay inside the basemap pane (e.g. markers, preview canvas). */
  children?: ReactNode;
}

export interface OverlayPreviewProps {
  className?: string;
  style?: CSSProperties;
  /** Imperative handle ref for map operations. */
  handleRef?: Ref<BasemapHandle>;
  /** Style URL override (used e.g. for offline test fixture). */
  overrideStyleUrl?: string;
}
