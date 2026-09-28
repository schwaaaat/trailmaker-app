import React, { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { newProject } from '../../core/project';
import type { Anchor } from '../../core/types';
import type { LoadedMap } from '../contract';
import {
  resetSettings,
  updateBasemapSettings,
  updateGeocoderSettings,
} from '../../io/settings';
import { clearActiveGpx, setActiveGpx } from '../../io/gpxStorage';
import { appStore, edit, openSession, redo, selectAnchor, setTool, undo } from '../../state/store';
import { addAnchor } from '../../state/commands';
import { BasemapPane } from './BasemapPane';
import * as loader from './loader';
import type { BasemapHandle } from './types';

void React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('BasemapPane', () => {
  let container: HTMLDivElement;
  let root: Root;
  const mockListeners: Record<string, ((...args: unknown[]) => void)[]> = {};

  const mockMap = {
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      mockListeners[event] = mockListeners[event] || [];
      mockListeners[event]!.push(handler);
    }),
    once: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      mockListeners[event] = mockListeners[event] || [];
      mockListeners[event]!.push(handler);
    }),
    remove: vi.fn(),
    flyTo: vi.fn(),
    fitBounds: vi.fn(),
    setStyle: vi.fn(),
    addControl: vi.fn(),
    getCenter: vi.fn(() => ({ lng: -78.4, lat: 38.5 })),
    getZoom: vi.fn(() => 14),
    panBy: vi.fn(),
    zoomIn: vi.fn(),
    zoomOut: vi.fn(),
  };

  class MockMapClass {
    constructor() {
      return mockMap;
    }
  }

  class MockControlClass {}

  const createdMarkers: {
    element: HTMLElement;
    draggable: boolean;
    lngLat: { lng: number; lat: number };
    listeners: Record<string, ((...args: unknown[]) => void)[]>;
    on(event: string, handler: (...args: unknown[]) => void): unknown;
    setLngLat(coords: [number, number]): unknown;
    getLngLat(): { lng: number; lat: number };
    addTo(map: unknown): unknown;
    remove(): unknown;
  }[] = [];

  class MockMarkerClass {
    element: HTMLElement;
    draggable: boolean;
    lngLat = { lng: 0, lat: 0 };
    listeners: Record<string, ((...args: unknown[]) => void)[]> = {};

    constructor(options?: { element?: HTMLElement; draggable?: boolean }) {
      this.element = options?.element ?? document.createElement('div');
      this.draggable = options?.draggable ?? false;
      createdMarkers.push(this);
    }

    setLngLat(coords: [number, number]) {
      this.lngLat = { lng: coords[0], lat: coords[1] };
      return this;
    }

    getLngLat() {
      return this.lngLat;
    }

    addTo() {
      return this;
    }

    remove() {
      this.element.remove();
      const idx = createdMarkers.indexOf(this);
      if (idx >= 0) createdMarkers.splice(idx, 1);
      return this;
    }

    on(event: string, handler: (...args: unknown[]) => void) {
      this.listeners[event] = this.listeners[event] || [];
      this.listeners[event]!.push(handler);
      return this;
    }
  }

  const mockMapLibreModule = {
    Map: MockMapClass as unknown as typeof import('maplibre-gl').Map,
    Marker: MockMarkerClass as unknown as typeof import('maplibre-gl').Marker,
    NavigationControl:
      MockControlClass as unknown as typeof import('maplibre-gl').NavigationControl,
    ScaleControl: MockControlClass as unknown as typeof import('maplibre-gl').ScaleControl,
    AttributionControl:
      MockControlClass as unknown as typeof import('maplibre-gl').AttributionControl,
    setWorkerUrl: vi.fn(),
  } as unknown as typeof import('maplibre-gl');

  function setupSession(anchors: Anchor[] = []): void {
    const project = newProject(
      {
        fileName: 'test.png',
        width: 1000,
        height: 800,
        originalWidth: 1000,
        originalHeight: 800,
        source: { kind: 'image', mimeType: 'image/png' },
        sha256: 'abc123',
      },
      'Test Project',
      new Date().toISOString(),
    );
    const p = { ...project, anchors };
    const mockMapData: LoadedMap = {
      meta: p.image,
      display: {} as ImageBitmap,
      raster: { width: 1000, height: 800, data: new Uint8ClampedArray(1000 * 800 * 4) },
      original: new Blob(),
      pdf: null,
    };
    openSession({ project: p, map: mockMapData });
  }

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    resetSettings();
    clearActiveGpx();
    for (const key of Object.keys(mockListeners)) {
      delete mockListeners[key];
    }
    createdMarkers.length = 0;
    vi.clearAllMocks();

    vi.spyOn(loader, 'loadMapLibre').mockResolvedValue(mockMapLibreModule);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    resetSettings();
    clearActiveGpx();
    vi.restoreAllMocks();
  });

  function render(node: React.ReactNode): void {
    act(() => root.render(node));
  }

  it('renders consent panel and does not load MapLibre when basemap is disabled', () => {
    render(<BasemapPane />);

    const dialog = container.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();

    const enableBtn = container.querySelector('button[aria-label="Enable basemap"]');
    const notNowBtn = container.querySelector('button[aria-label="Not now"]');
    expect(enableBtn).not.toBeNull();
    expect(notNowBtn).not.toBeNull();

    const settingsBtn = container.querySelector('button[aria-label="Basemap settings"]');
    expect(settingsBtn).not.toBeNull();

    expect(loader.loadMapLibre).not.toHaveBeenCalled();
  });

  it('loads MapLibre and instantiates map when Enable button is clicked', async () => {
    render(<BasemapPane />);

    const enableBtn = container.querySelector(
      'button[aria-label="Enable basemap"]',
    ) as HTMLButtonElement | null;
    await act(async () => {
      enableBtn?.click();
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(loader.loadMapLibre).toHaveBeenCalled();
    expect(mockMap.addControl).toHaveBeenCalled();
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it('instantiates map directly when basemap is already enabled in settings', async () => {
    updateBasemapSettings({ enabled: true });

    render(<BasemapPane />);

    await act(async () => {
      await Promise.resolve();
    });

    expect(loader.loadMapLibre).toHaveBeenCalled();
    expect(mockMap.addControl).toHaveBeenCalled();
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it('does not mount place search until the map instance is ready', async () => {
    updateBasemapSettings({ enabled: true });
    updateGeocoderSettings({ enabled: true });

    let resolveMapLibre!: (module: typeof import('maplibre-gl')) => void;
    const mapLibrePending = new Promise<typeof import('maplibre-gl')>((resolve) => {
      resolveMapLibre = resolve;
    });
    vi.spyOn(loader, 'loadMapLibre').mockReturnValue(mapLibrePending);

    render(<BasemapPane />);

    expect(container.querySelector('[role="combobox"]')).toBeNull();

    await act(async () => {
      resolveMapLibre(mockMapLibreModule);
      await mapLibrePending;
    });

    expect(mockMap.addControl).toHaveBeenCalled();
    expect(container.querySelector('[role="combobox"]')).not.toBeNull();
  });

  it('shows search disclosure and opt-in in Settings while the basemap is already enabled', async () => {
    updateBasemapSettings({ enabled: true });

    render(<BasemapPane />);

    await act(async () => {
      await Promise.resolve();
    });

    const settingsButton = container.querySelector(
      'button[aria-label="Basemap settings"]',
    ) as HTMLButtonElement | null;
    act(() => settingsButton?.click());

    const dialog = container.querySelector('[role="dialog"][aria-label="Basemap settings"]');
    expect(dialog?.textContent).toContain(
      'Sends your search text to nominatim.openstreetmap.org. No map image, coordinates, or project data is sent.',
    );
    const searchOptIn = dialog?.querySelector(
      'input[aria-label="Enable place search"]',
    ) as HTMLInputElement | null;
    expect(searchOptIn?.checked).toBe(false);

    act(() => searchOptIn?.click());
    expect(container.querySelector('input[role="combobox"]')).not.toBeNull();
  });

  it('displays non-blocking error banner on map error event and allows dismissing it', async () => {
    updateBasemapSettings({ enabled: true });

    render(<BasemapPane />);

    await act(async () => {
      await Promise.resolve();
    });

    const errorHandlers = mockListeners['error'] || [];
    expect(errorHandlers.length).toBeGreaterThan(0);

    act(() => {
      errorHandlers[0]!({ error: new Error('Network tile error') });
    });

    expect(container.textContent).toContain(
      'Basemap unavailable — pasting coordinates still works',
    );

    const dismissBtn = container.querySelector(
      'button[aria-label="Dismiss error"]',
    ) as HTMLButtonElement | null;
    expect(dismissBtn).not.toBeNull();

    act(() => {
      dismissBtn?.click();
    });

    expect(container.textContent).not.toContain(
      'Basemap unavailable — pasting coordinates still works',
    );
  });

  it('forwards map clicks to onMapClick callback with coordinates and pixel points', async () => {
    updateBasemapSettings({ enabled: true });
    const onMapClick = vi.fn();

    render(<BasemapPane onMapClick={onMapClick} />);

    await act(async () => {
      await Promise.resolve();
    });

    const clickHandlers = mockListeners['click'] || [];
    expect(clickHandlers.length).toBeGreaterThan(0);

    act(() => {
      clickHandlers[0]!({
        lngLat: { lat: 38.5, lng: -78.4 },
        point: { x: 250, y: 180 },
      });
    });

    expect(onMapClick).toHaveBeenCalledWith([38.5, -78.4], { x: 250, y: 180 });
  });

  it('provides imperative handle operations via ref', async () => {
    updateBasemapSettings({ enabled: true });
    const ref = createRef<BasemapHandle>();

    render(<BasemapPane ref={ref} />);

    await act(async () => {
      await Promise.resolve();
    });

    expect(ref.current).toBeDefined();
    expect(ref.current?.getMap()).toBe(mockMap);

    ref.current?.flyTo({ center: [-78.4, 38.5], zoom: 15 });
    expect(mockMap.flyTo).toHaveBeenCalledWith({ center: [-78.4, 38.5], zoom: 15 });

    ref.current?.fitBounds([
      [-78.5, 38.4],
      [-78.3, 38.6],
    ]);
    expect(mockMap.fitBounds).toHaveBeenCalledWith(
      [
        [-78.5, 38.4],
        [-78.3, 38.6],
      ],
      undefined,
    );

    expect(ref.current?.getContainer()).toBeInstanceOf(HTMLDivElement);
  });

  it('pairing flow: arms anchor tool, clicks park map to create anchor with ll: null, shows prompt, then basemap click sets coordinates with source basemap', async () => {
    updateBasemapSettings({ enabled: true });
    setupSession();

    render(<BasemapPane />);
    await act(async () => {
      await Promise.resolve();
    });

    // 1. Arm anchor tool and create anchor on park map
    act(() => {
      setTool('anchor');
      const p = appStore.getState().session!.project;
      const { command, id } = addAnchor(p, [150, 250]);
      edit(command, { anchor: id });
    });

    // Verify pending pairing prompt appears and container has pairing-pending class
    const prompt = container.querySelector('.trailmaker-georef-prompt-banner');
    expect(prompt).not.toBeNull();
    expect(prompt?.textContent).toBe('Now click the same spot on the basemap');

    const mapContainer = container.querySelector('#trailmaker-basemap-container');
    expect(mapContainer?.classList.contains('pairing-pending')).toBe(true);

    // 2. Basemap click sets coordinates
    const clickHandlers = mockListeners['click'] || [];
    expect(clickHandlers.length).toBeGreaterThan(0);

    act(() => {
      clickHandlers[0]!({
        lngLat: { lat: 38.65, lng: -78.35 },
        point: { x: 300, y: 200 },
      });
    });

    // Assert coordinates were set with source 'basemap'
    const updatedAnchors = appStore.getState().session!.project.anchors;
    expect(updatedAnchors).toHaveLength(1);
    expect(updatedAnchors[0]!.ll).toEqual([38.65, -78.35]);
    expect(updatedAnchors[0]!.source).toBe('basemap');

    // Prompt disappears after setting coords
    expect(container.querySelector('.trailmaker-georef-prompt-banner')).toBeNull();
    expect(mapContainer?.classList.contains('pairing-pending')).toBe(false);

    // Marker was created for the new anchor
    expect(createdMarkers.length).toBe(1);
    expect(createdMarkers[0]!.element.getAttribute('aria-label')).toBe('Anchor 1');
  });

  it('Esc cancels pending pairing: removes incomplete anchor and prompt', async () => {
    updateBasemapSettings({ enabled: true });
    setupSession();

    render(<BasemapPane />);
    await act(async () => {
      await Promise.resolve();
    });

    // Create pending anchor
    act(() => {
      setTool('anchor');
      const p = appStore.getState().session!.project;
      const { command, id } = addAnchor(p, [200, 300]);
      edit(command, { anchor: id });
    });

    expect(container.querySelector('.trailmaker-georef-prompt-banner')).not.toBeNull();
    expect(appStore.getState().session!.project.anchors).toHaveLength(1);

    // Press Escape
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });

    // Anchor is removed, selection cleared, prompt banner gone
    expect(appStore.getState().session!.project.anchors).toHaveLength(0);
    expect(appStore.getState().selectedAnchorId).toBeNull();
    expect(container.querySelector('.trailmaker-georef-prompt-banner')).toBeNull();
  });

  it('moves existing anchor with confirmation dialog', async () => {
    updateBasemapSettings({ enabled: true });
    const a1: Anchor = { id: 'g0', px: [100, 200], ll: [38.5, -78.4], source: 'basemap' };
    setupSession([a1]);

    const confirmMock = vi.fn(() => true);
    render(<BasemapPane confirm={confirmMock} />);

    await act(async () => {
      await Promise.resolve();
    });

    // Select existing anchor
    act(() => {
      selectAnchor('g0');
    });

    // Click basemap
    const clickHandlers = mockListeners['click'] || [];
    act(() => {
      clickHandlers[0]!({
        lngLat: { lat: 38.55, lng: -78.45 },
        point: { x: 320, y: 220 },
      });
    });

    expect(confirmMock).toHaveBeenCalledWith('Move anchor 1 here?');
    const updatedAnchors = appStore.getState().session!.project.anchors;
    expect(updatedAnchors[0]!.ll).toEqual([38.55, -78.45]);
  });

  it('does not move existing anchor if confirm is cancelled', async () => {
    updateBasemapSettings({ enabled: true });
    const a1: Anchor = { id: 'g0', px: [100, 200], ll: [38.5, -78.4], source: 'basemap' };
    setupSession([a1]);

    const confirmMock = vi.fn(() => false);
    render(<BasemapPane confirm={confirmMock} />);

    await act(async () => {
      await Promise.resolve();
    });

    act(() => {
      selectAnchor('g0');
    });

    const clickHandlers = mockListeners['click'] || [];
    act(() => {
      clickHandlers[0]!({
        lngLat: { lat: 38.55, lng: -78.45 },
        point: { x: 320, y: 220 },
      });
    });

    expect(confirmMock).toHaveBeenCalledWith('Move anchor 1 here?');
    const updatedAnchors = appStore.getState().session!.project.anchors;
    expect(updatedAnchors[0]!.ll).toEqual([38.5, -78.4]);
  });

  it('synchronizes draggable markers and handles marker dragging as one undo step', async () => {
    updateBasemapSettings({ enabled: true });
    const a1: Anchor = { id: 'g0', px: [100, 200], ll: [38.5, -78.4], source: 'basemap' };
    setupSession([a1]);

    render(<BasemapPane />);
    await act(async () => {
      await Promise.resolve();
    });

    expect(createdMarkers).toHaveLength(1);
    const m = createdMarkers[0]!;
    expect(m.draggable).toBe(true);

    // Clicking marker selects it
    act(() => {
      m.element.click();
    });
    expect(appStore.getState().selectedAnchorId).toBe('g0');

    // Drag marker
    act(() => {
      m.listeners['dragstart']?.[0]?.();
    });
    expect(appStore.getState().anchorDragging).toBe(true);

    act(() => {
      m.setLngLat([-78.3, 38.6]);
      m.listeners['dragend']?.[0]?.();
    });

    expect(appStore.getState().anchorDragging).toBe(false);
    expect(appStore.getState().session!.project.anchors[0]!.ll).toEqual([38.6, -78.3]);

    // Undo reverts drag
    act(() => {
      undo();
    });
    expect(appStore.getState().session!.project.anchors[0]!.ll).toEqual([38.5, -78.4]);

    // Redo restores drag
    act(() => {
      redo();
    });
    expect(appStore.getState().session!.project.anchors[0]!.ll).toEqual([38.6, -78.3]);
  });

  it('supports keyboard navigation (arrow keys pan, +/- zoom) on basemap container', async () => {
    updateBasemapSettings({ enabled: true });
    setupSession();
    render(<BasemapPane />);
    await act(async () => {
      await Promise.resolve();
    });

    const basemapContainer = container.querySelector(
      '#trailmaker-basemap-container',
    ) as HTMLElement;
    expect(basemapContainer).not.toBeNull();
    expect(basemapContainer.getAttribute('tabindex')).toBe('0');
    expect(basemapContainer.getAttribute('role')).toBe('application');
    expect(basemapContainer.getAttribute('aria-label')).toContain('Live basemap');

    // Arrow keys pan
    act(() => {
      basemapContainer.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }),
      );
    });
    expect(mockMap.panBy).toHaveBeenCalledWith([0, -80], { duration: 0 });

    act(() => {
      basemapContainer.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }),
      );
    });
    expect(mockMap.panBy).toHaveBeenCalledWith([0, 80], { duration: 0 });

    act(() => {
      basemapContainer.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }),
      );
    });
    expect(mockMap.panBy).toHaveBeenCalledWith([-80, 0], { duration: 0 });

    act(() => {
      basemapContainer.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'ArrowRight',
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    expect(mockMap.panBy).toHaveBeenCalledWith([250, 0], { duration: 0 });

    // +/- zoom
    act(() => {
      basemapContainer.dispatchEvent(
        new KeyboardEvent('keydown', { key: '+', bubbles: true, cancelable: true }),
      );
    });
    expect(mockMap.zoomIn).toHaveBeenCalledWith({ duration: 0 });

    act(() => {
      basemapContainer.dispatchEvent(
        new KeyboardEvent('keydown', { key: '-', bubbles: true, cancelable: true }),
      );
    });
    expect(mockMap.zoomOut).toHaveBeenCalledWith({ duration: 0 });
  });

  it('renders center crosshair, polite live banner, and pairs via Enter key', async () => {
    updateBasemapSettings({ enabled: true });
    // Session with a pending anchor (ll is null)
    const pendingAnchor: Anchor = { id: 'p0', px: [120, 150], ll: null, source: 'basemap' };
    setupSession([pendingAnchor]);
    appStore.setState({ selectedAnchorId: 'p0' });

    const confirm = vi.fn(() => true);
    render(<BasemapPane confirm={confirm} />);
    await act(async () => {
      await Promise.resolve();
    });

    // Center crosshair is displayed
    const crosshair = container.querySelector('.trailmaker-basemap-center-crosshair');
    expect(crosshair).not.toBeNull();
    expect(crosshair?.getAttribute('aria-hidden')).toBe('true');

    // Prompt banner has role="status" and aria-live="polite"
    const promptBanner = container.querySelector('.trailmaker-georef-prompt-banner');
    expect(promptBanner).not.toBeNull();
    expect(promptBanner?.getAttribute('role')).toBe('status');
    expect(promptBanner?.getAttribute('aria-live')).toBe('polite');

    // Basemap settings button has accessible attributes
    const settingsBtn = container.querySelector(
      '.trailmaker-basemap-settings-btn',
    ) as HTMLElement;
    expect(settingsBtn.getAttribute('aria-haspopup')).toBe('dialog');
    expect(settingsBtn.getAttribute('aria-expanded')).toBe('false');

    // Pressing Enter pairs anchor to map center coordinates [38.5, -78.4]
    const basemapContainer = container.querySelector(
      '#trailmaker-basemap-container',
    ) as HTMLElement;
    act(() => {
      basemapContainer.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
      );
    });

    const updatedAnchor = appStore.getState().session!.project.anchors[0]!;
    expect(updatedAnchor.ll).toEqual([38.5, -78.4]);
  });

  it('renders Import GPX button and toggles points list when GPX is loaded (card T-312)', async () => {
    updateBasemapSettings({ enabled: true });
    setupSession();
    render(<BasemapPane />);

    await act(async () => {
      await Promise.resolve();
    });

    const gpxBtn = container.querySelector('.trailmaker-basemap-gpx-btn') as HTMLButtonElement;
    expect(gpxBtn).not.toBeNull();
    expect(gpxBtn.textContent).toContain('Import GPX');

    act(() => {
      setActiveGpx({
        fileName: 'track.gpx',
        points: [
          { id: 'wpt-1', name: 'Trailhead', ll: [38.55, -78.35], kind: 'wpt' },
          { id: 'wpt-2', name: 'Peak', ll: [38.58, -78.33], kind: 'wpt' },
        ],
        tracks: [],
        totalPointsInFile: 2,
        wasDecimated: false,
      });
    });

    expect(gpxBtn.textContent).toContain('GPX points');
    expect(gpxBtn.textContent).toContain('2');

    // Click button to open points list
    act(() => gpxBtn.click());

    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    expect(container.textContent).toContain('Trailhead');
    expect(container.textContent).toContain('Peak');
  });

  it('choosing a point from the GPX points list completes pending pair with source basemap (card T-312)', async () => {
    updateBasemapSettings({ enabled: true });
    setupSession();
    render(<BasemapPane />);

    await act(async () => {
      await Promise.resolve();
    });

    act(() => {
      setActiveGpx({
        fileName: 'track.gpx',
        points: [
          { id: 'wpt-1', name: 'Trailhead', ll: [38.55, -78.35], kind: 'wpt' },
        ],
        tracks: [],
        totalPointsInFile: 1,
        wasDecimated: false,
      });
    });

    // Arm anchor tool and create pending anchor
    act(() => setTool('anchor'));
    const curProject = appStore.getState().session!.project;
    const { command, id } = addAnchor(curProject, [150, 250]);
    act(() => {
      edit(command, { anchor: id });
    });

    const pending = appStore.getState().session!.project.anchors[0]!;
    expect(pending.ll).toBeNull();

    // Open GPX list
    const gpxBtn = container.querySelector('.trailmaker-basemap-gpx-btn') as HTMLButtonElement;
    act(() => gpxBtn.click());

    // Click the point in the list
    const ptBtn = container.querySelector('.trailmaker-gpx-point-btn') as HTMLButtonElement;
    expect(ptBtn).not.toBeNull();
    act(() => ptBtn.click());

    // Pair is completed with the GPX point coordinates and source 'basemap'
    const paired = appStore.getState().session!.project.anchors[0]!;
    expect(paired.ll).toEqual([38.55, -78.35]);
    expect(paired.source).toBe('basemap');
  });
});
