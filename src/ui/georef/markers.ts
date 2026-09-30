// Lane C. Basemap anchor markers synchronization (cards T-307, T-317).
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
  originalLngLat: [number, number] | null;
  dragCancelled: boolean;
}

export class MarkerManager {
  private readonly markers = new Map<AnchorId, MarkerEntry>();
  private container: HTMLElement | null = null;
  private readonly activePointerIds = new Set<number>();
  private lastDragEndCallback?: ((id: AnchorId) => void) | undefined;

  private readonly onTouchStart = (e: TouchEvent): void => {
    if (e.touches && e.touches.length > 1) {
      this.cancelAllDrags();
    }
  };

  private readonly onTouchMove = (e: TouchEvent): void => {
    if (e.touches && e.touches.length > 1) {
      this.cancelAllDrags();
    }
  };

  private readonly onPointerDown = (e: PointerEvent): void => {
    this.activePointerIds.add(e.pointerId);
    if (this.activePointerIds.size > 1) {
      this.cancelAllDrags();
    }
  };

  private readonly onPointerUp = (e: PointerEvent): void => {
    this.activePointerIds.delete(e.pointerId);
  };

  private readonly onPointerCancel = (e: PointerEvent): void => {
    this.activePointerIds.delete(e.pointerId);
  };

  private attachTouchListeners(container: HTMLElement): void {
    container.addEventListener('touchstart', this.onTouchStart, { capture: true, passive: true });
    container.addEventListener('touchmove', this.onTouchMove, { capture: true, passive: true });
    container.addEventListener('pointerdown', this.onPointerDown, { capture: true, passive: true });
    container.addEventListener('pointerup', this.onPointerUp, { capture: true, passive: true });
    container.addEventListener('pointercancel', this.onPointerCancel, { capture: true, passive: true });
  }

  private detachTouchListeners(): void {
    if (this.container) {
      this.container.removeEventListener('touchstart', this.onTouchStart, { capture: true });
      this.container.removeEventListener('touchmove', this.onTouchMove, { capture: true });
      this.container.removeEventListener('pointerdown', this.onPointerDown, { capture: true });
      this.container.removeEventListener('pointerup', this.onPointerUp, { capture: true });
      this.container.removeEventListener('pointercancel', this.onPointerCancel, { capture: true });
      this.container = null;
    }
    this.activePointerIds.clear();
  }

  cancelAllDrags(): void {
    for (const [id, entry] of this.markers) {
      // MapLibre internal marker drag state
      const m = entry.marker as unknown as {
        _state?: string;
        _onUp?: () => void;
      };
      const isPending = m._state === 'pending';
      const isActive = m._state === 'active';

      if (entry.isDragging || isPending || isActive) {
        entry.dragCancelled = true;
        if (entry.originalLngLat) {
          entry.marker.setLngLat(entry.originalLngLat);
        }
        if (typeof m._onUp === 'function') {
          m._onUp();
        }
        if (entry.originalLngLat) {
          entry.marker.setLngLat(entry.originalLngLat);
        }
        if (entry.isDragging) {
          entry.isDragging = false;
          this.lastDragEndCallback?.(id);
        }
      }
    }
  }

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

    this.lastDragEndCallback = onDragEnd;

    const mapContainer = typeof map.getContainer === 'function' ? map.getContainer() : null;
    if (mapContainer && this.container !== mapContainer) {
      this.detachTouchListeners();
      this.container = mapContainer;
      this.attachTouchListeners(mapContainer);
    }

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
        // T-317: Preserve MapLibre's classes (e.g. maplibregl-marker) by using classList.toggle
        existing.element.classList.add('georef-marker');
        existing.element.classList.toggle('selected', isSelected);
        existing.element.classList.toggle('outlier', isOutlier);
        existing.element.setAttribute('aria-label', `Anchor ${n}`);
        const b = existing.element.querySelector('b');
        if (b) b.textContent = String(n);

        // Update position only if not currently dragging
        if (!existing.isDragging) {
          existing.marker.setLngLat([lon, lat]);
          existing.originalLngLat = [lon, lat];
        }

        // T-317: Only the selected anchor's pin is draggable
        if (typeof existing.marker.setDraggable === 'function') {
          existing.marker.setDraggable(isSelected);
        }

        // Ensure marker element is attached to DOM if it was detached
        if (!existing.element.parentElement) {
          existing.marker.addTo(map);
        }
      } else {
        // Create new marker element
        const el = document.createElement('div');
        el.className = 'georef-marker';
        el.classList.toggle('selected', isSelected);
        el.classList.toggle('outlier', isOutlier);
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

        // T-317: Capture original coords on touch/mouse start before MapLibre moves the marker
        el.addEventListener(
          'touchstart',
          (e) => {
            if (e.touches && e.touches.length > 1) {
              this.cancelAllDrags();
              return;
            }
            const cur = marker.getLngLat();
            entry.originalLngLat = [cur.lng, cur.lat];
          },
          { passive: true },
        );

        el.addEventListener('mousedown', () => {
          const cur = marker.getLngLat();
          entry.originalLngLat = [cur.lng, cur.lat];
        });

        // T-317: Only selected anchor is draggable
        const marker = new maplibre.Marker({
          element: el,
          draggable: isSelected,
          anchor: 'bottom',
        })
          .setLngLat([lon, lat])
          .addTo(map);

        const entry: MarkerEntry = {
          marker,
          element: el,
          isDragging: false,
          originalLngLat: [lon, lat],
          dragCancelled: false,
        };

        marker.on('dragstart', () => {
          if (this.activePointerIds.size > 1) {
            entry.dragCancelled = true;
            if (entry.originalLngLat) {
              marker.setLngLat(entry.originalLngLat);
            }
            const m = marker as unknown as { _onUp?: () => void };
            if (typeof m._onUp === 'function') {
              m._onUp();
            }
            return;
          }

          entry.isDragging = true;
          entry.dragCancelled = false;
          const pos = marker.getLngLat();
          entry.originalLngLat = [pos.lng, pos.lat];
          onDragStart?.(anchor.id);
        });

        marker.on('drag', () => {
          if (entry.dragCancelled && entry.originalLngLat) {
            marker.setLngLat(entry.originalLngLat);
          }
        });

        marker.on('dragend', () => {
          if (entry.dragCancelled) {
            entry.isDragging = false;
            entry.dragCancelled = false;
            if (entry.originalLngLat) {
              marker.setLngLat(entry.originalLngLat);
            }
            onDragEnd?.(anchor.id);
            return;
          }

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
    this.detachTouchListeners();
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
