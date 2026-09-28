import { describe, expect, it, vi } from 'vitest';
import type { Anchor, GeoFit } from '../../core/types';
import { MarkerManager } from './markers';

function makeMockFit(outlierIds: string[] = []): GeoFit {
  const residuals: Record<string, number> = {};
  outlierIds.forEach((id) => {
    residuals[id] = 1000;
  });

  return {
    ok: true,
    method: 'affine',
    requested: 'auto',
    frame: { lat0: 0, lon0: 0, kx: 1, ky: 1, cx: 0, cy: 0, scale: 1 },
    model: { kind: 'affine', affine: [1, 0, 0, 0, 1, 0] },
    anchorCount: 4,
    residuals,
    rms: 10,
    checked: true,
    looResiduals: null,
    metersPerPixel: 1,
    mirrored: false,
    implausibleScale: false,
  };
}

describe('MarkerManager', () => {
  it('creates, updates, and deletes markers in sync with anchors', () => {
    const manager = new MarkerManager();

    const mockListeners: Record<string, ((...args: unknown[]) => void)[]> = {};
    const mockMarker = {
      setLngLat: vi.fn().mockReturnThis(),
      addTo: vi.fn().mockReturnThis(),
      remove: vi.fn().mockReturnThis(),
      getLngLat: vi.fn(() => ({ lng: -78.4, lat: 38.5 })),
      on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        mockListeners[event] = mockListeners[event] || [];
        mockListeners[event]!.push(handler);
        return mockMarker;
      }),
    };

    class MockMarkerClass {
      element: HTMLElement;
      draggable: boolean;
      constructor(options?: { element?: HTMLElement; draggable?: boolean }) {
        this.element = options?.element ?? document.createElement('div');
        this.draggable = options?.draggable ?? false;
        return mockMarker as unknown as MockMarkerClass;
      }
    }

    const mockMap = {} as import('maplibre-gl').Map;
    const mockMapLibre = {
      Marker: MockMarkerClass as unknown as typeof import('maplibre-gl').Marker,
    } as typeof import('maplibre-gl');

    const a1: Anchor = { id: 'g0', px: [100, 200], ll: [38.5, -78.4], source: 'basemap' };
    const a2: Anchor = { id: 'g1', px: [300, 400], ll: null, source: 'paste' };
    const a3: Anchor = { id: 'g2', px: [500, 600], ll: [38.6, -78.3], source: 'basemap' };

    const onSelect = vi.fn();
    const onMove = vi.fn();
    const onDragStart = vi.fn();

    // 1. Initial sync with 3 anchors (1 has null coords)
    manager.sync({
      map: mockMap,
      maplibre: mockMapLibre,
      anchors: [a1, a2, a3],
      selectedAnchorId: 'g0',
      fit: makeMockFit(['g2']),
      onSelectAnchor: onSelect,
      onMoveAnchor: onMove,
      onDragStart,
    });

    // Anchor 2 has null coords -> only 2 markers created
    expect(manager.getAllMarkers().size).toBe(2);
    const entry1 = manager.getMarker('g0')!;
    const entry3 = manager.getMarker('g2')!;
    expect(entry1).toBeDefined();
    expect(entry3).toBeDefined();

    // Anchor 1 is selected
    expect(entry1.element.classList.contains('selected')).toBe(true);
    expect(entry1.element.getAttribute('aria-label')).toBe('Anchor 1');

    // Anchor 3 is outlier
    expect(entry3.element.classList.contains('outlier')).toBe(true);
    expect(entry3.element.getAttribute('aria-label')).toBe('Anchor 3');

    // Clicking marker triggers onSelectAnchor
    entry1.element.click();
    expect(onSelect).toHaveBeenCalledWith('g0');

    // Drag events
    mockListeners['dragstart']?.[0]?.();
    expect(onDragStart).toHaveBeenCalledWith('g0');

    mockListeners['dragend']?.[0]?.();
    expect(onMove).toHaveBeenCalledWith('g0', [38.5, -78.4]);

    // 2. Remove anchor 1
    manager.sync({
      map: mockMap,
      maplibre: mockMapLibre,
      anchors: [a3],
      selectedAnchorId: null,
      fit: makeMockFit(),
      onSelectAnchor: onSelect,
      onMoveAnchor: onMove,
    });

    expect(manager.getAllMarkers().size).toBe(1);
    expect(manager.getMarker('g0')).toBeUndefined();
    expect(mockMarker.remove).toHaveBeenCalled();

    // 3. Destroy removes all
    manager.destroy();
    expect(manager.getAllMarkers().size).toBe(0);
  });
});
