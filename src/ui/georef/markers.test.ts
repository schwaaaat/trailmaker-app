import { describe, expect, it, vi } from 'vitest';
import type { Anchor, GeoFit } from '../../core/types';
import { MarkerManager } from './markers';

const PointerEventClass =
  typeof PointerEvent !== 'undefined'
    ? PointerEvent
    : class MockPointerEvent extends MouseEvent {
        pointerId: number;
        constructor(type: string, dict?: MouseEventInit & { pointerId?: number }) {
          super(type, dict);
          this.pointerId = dict?.pointerId ?? 0;
        }
      };

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

interface MockMarkerInstance {
  element: HTMLElement;
  draggable: boolean;
  lngLat: [number, number];
  setLngLat: ReturnType<typeof vi.fn>;
  setDraggable: ReturnType<typeof vi.fn>;
  addTo: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
  getLngLat: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  listeners: Record<string, ((...args: unknown[]) => void)[]>;
  _state?: string;
  _onUp?: () => void;
}

function createMockMapLibre(container: HTMLElement = document.createElement('div')) {
  const markers: MockMarkerInstance[] = [];

  class MockMarker {
    element: HTMLElement;
    draggable: boolean;
    lngLat: [number, number] = [0, 0];
    listeners: Record<string, ((...args: unknown[]) => void)[]> = {};
    _state = 'inactive';

    setLngLat = vi.fn((pos: [number, number]) => {
      this.lngLat = pos;
      return this;
    });

    setDraggable = vi.fn((draggable: boolean) => {
      this.draggable = draggable;
      return this;
    });

    addTo = vi.fn((_map: unknown) => {
      container.appendChild(this.element);
      return this;
    });

    remove = vi.fn(() => {
      if (this.element.parentElement) {
        this.element.parentElement.removeChild(this.element);
      }
      return this;
    });

    getLngLat = vi.fn(() => ({ lng: this.lngLat[0], lat: this.lngLat[1] }));

    on = vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      this.listeners[event] = this.listeners[event] || [];
      this.listeners[event].push(handler);
      return this;
    });

    _onUp = vi.fn(() => {
      const wasActive = this._state === 'active';
      this._state = 'inactive';
      if (wasActive) {
        this.listeners['dragend']?.forEach((h) => h());
      }
    });

    constructor(options?: { element?: HTMLElement; draggable?: boolean }) {
      this.element = options?.element ?? document.createElement('div');
      this.draggable = options?.draggable ?? false;
      // MapLibre natively adds maplibregl-marker to its element
      this.element.classList.add('maplibregl-marker');
      markers.push(this as unknown as MockMarkerInstance);
    }
  }

  const mockMap = {
    getContainer: vi.fn(() => container),
  } as unknown as import('maplibre-gl').Map;

  const mockMapLibre = {
    Marker: MockMarker as unknown as typeof import('maplibre-gl').Marker,
  } as typeof import('maplibre-gl');

  return { mockMap, mockMapLibre, markers, container };
}

describe('MarkerManager', () => {
  it('creates, updates, and deletes markers in sync with anchors', () => {
    const { mockMap, mockMapLibre, markers } = createMockMapLibre();
    const manager = new MarkerManager();

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

    // Drag events for selected marker
    const marker1 = markers[0]!;
    marker1.listeners['dragstart']?.[0]?.();
    expect(onDragStart).toHaveBeenCalledWith('g0');

    marker1.lngLat = [-78.39, 38.51];
    marker1.listeners['dragend']?.[0]?.();
    expect(onMove).toHaveBeenCalledWith('g0', [38.51, -78.39]);

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
    expect(marker1.remove).toHaveBeenCalled();

    // 3. Destroy removes all
    manager.destroy();
    expect(manager.getAllMarkers().size).toBe(0);
  });

  it('only allows dragging on the selected anchor (Acceptance 2)', () => {
    const { mockMap, mockMapLibre, markers } = createMockMapLibre();
    const manager = new MarkerManager();

    const a1: Anchor = { id: 'a0', px: [100, 200], ll: [38.5, -78.4], source: 'basemap' };
    const a2: Anchor = { id: 'a1', px: [300, 400], ll: [38.6, -78.3], source: 'basemap' };

    // Initially anchor a0 is selected, anchor a1 is not selected
    manager.sync({
      map: mockMap,
      maplibre: mockMapLibre,
      anchors: [a1, a2],
      selectedAnchorId: 'a0',
      fit: null,
      onSelectAnchor: vi.fn(),
      onMoveAnchor: vi.fn(),
    });

    expect(markers[0]!.draggable).toBe(true);
    expect(markers[1]!.draggable).toBe(false);

    // Switch selection to a1
    manager.sync({
      map: mockMap,
      maplibre: mockMapLibre,
      anchors: [a1, a2],
      selectedAnchorId: 'a1',
      fit: null,
      onSelectAnchor: vi.fn(),
      onMoveAnchor: vi.fn(),
    });

    expect(markers[0]!.draggable).toBe(false);
    expect(markers[1]!.draggable).toBe(true);
    expect(markers[0]!.setDraggable).toHaveBeenCalledWith(false);
    expect(markers[1]!.setDraggable).toHaveBeenCalledWith(true);

    manager.destroy();
  });

  it('cancels drag and restores pin position when a second pointer lands (Acceptance 2)', () => {
    const container = document.createElement('div');
    const { mockMap, mockMapLibre, markers } = createMockMapLibre(container);
    const manager = new MarkerManager();

    const a1: Anchor = { id: 'a0', px: [100, 200], ll: [38.5, -78.4], source: 'basemap' };
    const onMove = vi.fn();
    const onDragStart = vi.fn();
    const onDragEnd = vi.fn();

    manager.sync({
      map: mockMap,
      maplibre: mockMapLibre,
      anchors: [a1],
      selectedAnchorId: 'a0',
      fit: null,
      onSelectAnchor: vi.fn(),
      onMoveAnchor: onMove,
      onDragStart,
      onDragEnd,
    });

    const m = markers[0]!;
    m.lngLat = [-78.4, 38.5];
    m._state = 'active';

    // Pointer 1 starts dragging the marker
    container.dispatchEvent(
      new PointerEventClass('pointerdown', { pointerId: 1, bubbles: true }),
    );
    m.listeners['dragstart']?.[0]?.();
    expect(onDragStart).toHaveBeenCalledWith('a0');

    // Marker moved during drag
    m.lngLat = [-78.35, 38.55];

    // Second pointer lands on container (e.g. pinch starts)
    container.dispatchEvent(
      new PointerEventClass('pointerdown', { pointerId: 2, bubbles: true }),
    );

    // Drag should be cancelled and position restored
    expect(m.setLngLat).toHaveBeenCalledWith([-78.4, 38.5]);
    expect(m._onUp).toHaveBeenCalled();

    // Position must be back at original and onMoveAnchor must NOT have been called with drifted coords
    expect(onMove).not.toHaveBeenCalled();
    expect(onDragEnd).toHaveBeenCalled();

    manager.destroy();
  });

  it('cancels drag when a multi-touch touchstart occurs (Acceptance 2)', () => {
    const container = document.createElement('div');
    const { mockMap, mockMapLibre, markers } = createMockMapLibre(container);
    const manager = new MarkerManager();

    const a1: Anchor = { id: 'a0', px: [100, 200], ll: [38.5, -78.4], source: 'basemap' };
    const onMove = vi.fn();

    manager.sync({
      map: mockMap,
      maplibre: mockMapLibre,
      anchors: [a1],
      selectedAnchorId: 'a0',
      fit: null,
      onSelectAnchor: vi.fn(),
      onMoveAnchor: onMove,
    });

    const m = markers[0]!;
    m.lngLat = [-78.4, 38.5];
    m._state = 'active';

    // Drag start
    m.listeners['dragstart']?.[0]?.();
    m.lngLat = [-78.2, 38.7];

    // Two-finger touch event
    const multiTouchEvent = new CustomEvent('touchstart', {
      bubbles: true,
      cancelable: true,
    }) as unknown as TouchEvent;
    Object.defineProperty(multiTouchEvent, 'touches', {
      value: [{}, {}],
    });

    container.dispatchEvent(multiTouchEvent);

    // Marker restored to original coords
    expect(m.setLngLat).toHaveBeenCalledWith([-78.4, 38.5]);
    expect(onMove).not.toHaveBeenCalled();

    manager.destroy();
  });

  it('preserves MapLibre marker class and survives re-sync and style reload without losing elements (Acceptance 3)', () => {
    const { mockMap, mockMapLibre } = createMockMapLibre();
    const manager = new MarkerManager();

    const a1: Anchor = { id: 'a0', px: [100, 200], ll: [38.5, -78.4], source: 'basemap' };

    // Initial sync
    manager.sync({
      map: mockMap,
      maplibre: mockMapLibre,
      anchors: [a1],
      selectedAnchorId: null,
      fit: null,
      onSelectAnchor: vi.fn(),
      onMoveAnchor: vi.fn(),
    });

    const entry = manager.getMarker('a0')!;
    expect(entry.element.classList.contains('maplibregl-marker')).toBe(true);
    expect(entry.element.classList.contains('georef-marker')).toBe(true);

    // Second sync (e.g. style reload or state update)
    manager.sync({
      map: mockMap,
      maplibre: mockMapLibre,
      anchors: [a1],
      selectedAnchorId: 'a0',
      fit: null,
      onSelectAnchor: vi.fn(),
      onMoveAnchor: vi.fn(),
    });

    // maplibregl-marker class must still be preserved!
    expect(entry.element.classList.contains('maplibregl-marker')).toBe(true);
    expect(entry.element.classList.contains('georef-marker')).toBe(true);
    expect(entry.element.classList.contains('selected')).toBe(true);

    manager.destroy();
  });
});
