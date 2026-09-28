// Lane C. Basemap anchor markers synchronization (card T-307).
import type { Map as MapLibreMap, Marker as MapLibreMarker } from 'maplibre-gl';
import type { Anchor, AnchorId, FitResult, LatLon } from '../../core/types';
import { anchorOutlier } from '../../state/outliers';

export interface MarkerSyncOptions {
  readonly map: MapLibreMap;
  readonly maplibre: typeof import('maplibre-gl');
  readonly anchors: readonly Anchor[];
  readonly selectedAnchorId: AnchorId | null;
  readonly fit: FitResult | null;
  readonly onSelectAnchor: (id: AnchorId) => void;
  readonly onMoveAnchor: (id: AnchorId, ll: LatLon) => void;
  readonly onDragStart?: (id: AnchorId) => void;
  readonly onDragEnd?: (id: AnchorId) => void;
}

export interface MarkerEntry {
  marker: MapLibreMarker;
  element: HTMLElement;
  isDragging: boolean;
}

export class MarkerManager {
  private readonly markers = new Map<AnchorId, MarkerEntry>();

  sync(options: MarkerSyncOptions): void {
    const {
      map,
      maplibre,
      anchors,
      selectedAnchorId,
      fit,
      onSelectAnchor,
      onMoveAnchor,
      onDragStart,
      onDragEnd,
    } = options;

    const currentAnchorIds = new Set<AnchorId>();

    anchors.forEach((anchor, index) => {
      if (anchor.ll === null) return;
      currentAnchorIds.add(anchor.id);

      const n = index + 1;
      const isSelected = anchor.id === selectedAnchorId;
      const isOutlier = Boolean(fit?.ok && anchorOutlier(fit, anchor.id));
      const [lat, lon] = anchor.ll;

      const existing = this.markers.get(anchor.id);

      if (existing) {
        // Update classes and number
        existing.element.className =
          `georef-marker${isSelected ? ' selected' : ''}${isOutlier ? ' outlier' : ''}`;
        existing.element.setAttribute('aria-label', `Anchor ${n}`);
        const b = existing.element.querySelector('b');
        if (b) b.textContent = String(n);

        // Update position only if not currently dragging
        if (!existing.isDragging) {
          existing.marker.setLngLat([lon, lat]);
        }
      } else {
        // Create new marker
        const el = document.createElement('div');
        el.className = `georef-marker${isSelected ? ' selected' : ''}${isOutlier ? ' outlier' : ''}`;
        el.setAttribute('role', 'button');
        el.setAttribute('tabindex', '0');
        el.setAttribute('aria-label', `Anchor ${n}`);
        el.dataset.anchorId = anchor.id;
        el.innerHTML = `<span class="pin"><b>${n}</b></span>`;

        el.addEventListener('click', (e) => {
          e.stopPropagation();
          onSelectAnchor(anchor.id);
        });

        el.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            e.stopPropagation();
            onSelectAnchor(anchor.id);
          }
        });

        const marker = new maplibre.Marker({
          element: el,
          draggable: true,
          anchor: 'bottom',
        })
          .setLngLat([lon, lat])
          .addTo(map);

        const entry: MarkerEntry = {
          marker,
          element: el,
          isDragging: false,
        };

        marker.on('dragstart', () => {
          entry.isDragging = true;
          onDragStart?.(anchor.id);
        });

        marker.on('dragend', () => {
          entry.isDragging = false;
          const pos = marker.getLngLat();
          onMoveAnchor(anchor.id, [pos.lat, pos.lng]);
          onDragEnd?.(anchor.id);
        });

        this.markers.set(anchor.id, entry);
      }
    });

    // Remove deleted markers
    for (const [id, entry] of this.markers.entries()) {
      if (!currentAnchorIds.has(id)) {
        entry.marker.remove();
        this.markers.delete(id);
      }
    }
  }

  destroy(): void {
    for (const entry of this.markers.values()) {
      entry.marker.remove();
    }
    this.markers.clear();
  }

  getMarker(id: AnchorId): MarkerEntry | undefined {
    return this.markers.get(id);
  }

  getAllMarkers(): ReadonlyMap<AnchorId, MarkerEntry> {
    return this.markers;
  }
}
