import React, { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { newProject } from '../../core/project';
import type { Anchor, AnchorId, Feature, FeatureId, Project } from '../../core/types';
import { resetSettings, updateBasemapSettings } from '../../io/settings';
import { appStore, edit, openSession } from '../../state/store';
import { addFeature, setAnchorCoords } from '../../state/commands';
import type { LoadedMap } from '../contract';
import * as loader from './loader';
import { OverlayPreview } from './OverlayPreview';
import { mountOverlayPreview } from './testMount';
import type { BasemapHandle } from './types';
import { FEATURES_SOURCE_ID, OVERLAY_LAYER_ID } from './overlaySource';

void React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('OverlayPreview', () => {
  let container: HTMLDivElement;
  let root: Root;
  const mockListeners: Record<string, ((...args: unknown[]) => void)[]> = {};
  const mockSources: Record<string, unknown> = {};
  const mockLayers: Record<string, unknown> = {};
  const mockPaintProperties: Record<string, Record<string, unknown>> = {};

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
    addSource: vi.fn((id: string, source: unknown) => {
      mockSources[id] = source;
    }),
    getSource: vi.fn((id: string) => mockSources[id]),
    removeSource: vi.fn((id: string) => {
      delete mockSources[id];
    }),
    addLayer: vi.fn((layer: { id: string; paint?: Record<string, unknown> }) => {
      mockLayers[layer.id] = layer;
      if (layer.paint) {
        mockPaintProperties[layer.id] = { ...layer.paint };
      }
    }),
    getLayer: vi.fn((id: string) => mockLayers[id]),
    removeLayer: vi.fn((id: string) => {
      delete mockLayers[id];
      delete mockPaintProperties[id];
    }),
    setPaintProperty: vi.fn((layerId: string, prop: string, val: unknown) => {
      mockPaintProperties[layerId] = mockPaintProperties[layerId] || {};
      mockPaintProperties[layerId]![prop] = val;
    }),
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

  function createTestSession(anchorsList: Anchor[] = [], featuresList: Feature[] = []): void {
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
    const p: Project = { ...project, anchors: anchorsList, features: featuresList };
    const mockLoadedMap: LoadedMap = {
      meta: p.image,
      display: {} as ImageBitmap,
      raster: {
        data: new Uint8ClampedArray(1000 * 800 * 4),
        width: 1000,
        height: 800,
      },
      original: new Blob(),
      pdf: null,
    };

    openSession({ project: p, map: mockLoadedMap });
  }

  const validAnchors: Anchor[] = [
    { id: 'a1' as AnchorId, px: [0, 0], ll: [38.0, -78.0], source: 'paste' },
    { id: 'a2' as AnchorId, px: [1000, 0], ll: [38.0, -77.0], source: 'paste' },
    { id: 'a3' as AnchorId, px: [1000, 800], ll: [37.0, -77.0], source: 'paste' },
    { id: 'a4' as AnchorId, px: [0, 800], ll: [37.0, -78.0], source: 'paste' },
  ];

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    resetSettings();
    for (const key of Object.keys(mockListeners)) delete mockListeners[key];
    for (const key of Object.keys(mockSources)) delete mockSources[key];
    for (const key of Object.keys(mockLayers)) delete mockLayers[key];
    for (const key of Object.keys(mockPaintProperties)) delete mockPaintProperties[key];
    vi.clearAllMocks();

    // Mock HTMLCanvasElement 2D context for jsdom
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => {
      const dummyCtx = {
        save: () => {},
        restore: () => {},
        beginPath: () => {},
        moveTo: () => {},
        lineTo: () => {},
        closePath: () => {},
        clip: () => {},
        transform: () => {},
        drawImage: () => {},
        clearRect: () => {},
        fillRect: () => {},
      };
      return new Proxy(dummyCtx, {
        get: (target, prop: string) => (prop in target ? (target as Record<string, unknown>)[prop] : () => {}),
      }) as unknown as CanvasRenderingContext2D;
    });

    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (
      this: HTMLCanvasElement,
      cb: (blob: Blob | null) => void,
    ) {
      cb(new Blob(['fake-image-bytes'], { type: 'image/jpeg' }));
    });

    if (!URL.createObjectURL) {
      URL.createObjectURL = vi.fn(() => 'blob:mock-url');
    }
    if (!URL.revokeObjectURL) {
      URL.revokeObjectURL = vi.fn();
    }

    vi.spyOn(loader, 'loadMapLibre').mockResolvedValue({
      Map: MockMapClass as unknown as typeof import('maplibre-gl').Map,
      NavigationControl: MockControlClass as unknown as typeof import('maplibre-gl').NavigationControl,
      ScaleControl: MockControlClass as unknown as typeof import('maplibre-gl').ScaleControl,
      AttributionControl: MockControlClass as unknown as typeof import('maplibre-gl').AttributionControl,
      setWorkerUrl: vi.fn(),
    } as unknown as typeof import('maplibre-gl'));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    resetSettings();
    vi.restoreAllMocks();
  });

  function render(node: React.ReactNode): void {
    act(() => root.render(node));
  }

  it('renders placeholder with "Pin at least 2 anchors to preview" when fit is not ok', async () => {
    createTestSession([]); // 0 anchors -> fit not ok

    render(<OverlayPreview />);
    await act(async () => {
      await Promise.resolve();
    });

    const empty = container.querySelector('.trailmaker-overlay-empty');
    expect(empty).not.toBeNull();
    expect(empty?.textContent?.trim()).toBe('Pin at least 2 anchors to preview');
    expect(loader.loadMapLibre).not.toHaveBeenCalled();
  });

  it('renders consent panel when fit is ok but basemap is disabled', async () => {
    updateBasemapSettings({ enabled: false });
    createTestSession(validAnchors); // 4 anchors -> fit ok

    render(<OverlayPreview />);
    await act(async () => {
      await Promise.resolve();
    });

    expect(container.querySelector('.trailmaker-overlay-empty')).toBeNull();
    const consent = container.querySelector('[role="dialog"]');
    expect(consent).not.toBeNull();
    const enableBtn = container.querySelector('button[aria-label="Enable basemap"]');
    expect(enableBtn).not.toBeNull();
    expect(loader.loadMapLibre).not.toHaveBeenCalled();
  });

  it('loads MapLibre, mounts overlay, feature layers, and controls when enabled', async () => {
    updateBasemapSettings({ enabled: true });
    createTestSession(validAnchors);

    render(<OverlayPreview />);
    await act(async () => {
      await Promise.resolve();
    });

    expect(loader.loadMapLibre).toHaveBeenCalled();
    expect(mockMap.addControl).toHaveBeenCalled();

    // Map container and overlay controls rendered
    expect(container.querySelector('#trailmaker-overlay-map-container')).not.toBeNull();
    const opacitySlider = container.querySelector('input[type="range"]#trailmaker-overlay-opacity') as HTMLInputElement | null;
    expect(opacitySlider).not.toBeNull();
    expect(opacitySlider?.getAttribute('aria-label')).toBe('Map opacity');
    expect(opacitySlider?.value).toBe('60');

    // Layers were added
    expect(mockMap.addLayer).toHaveBeenCalled();
  });

  it('updates opacity slider and paint property live, persisting in settings', async () => {
    updateBasemapSettings({ enabled: true });
    createTestSession(validAnchors);

    render(<OverlayPreview />);
    await act(async () => {
      await Promise.resolve();
    });

    const opacitySlider = container.querySelector('input[type="range"]#trailmaker-overlay-opacity') as HTMLInputElement | null;
    expect(opacitySlider).not.toBeNull();

    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value',
    )?.set;

    act(() => {
      nativeInputValueSetter?.call(opacitySlider, '80');
      opacitySlider!.dispatchEvent(new Event('input', { bubbles: true }));
      opacitySlider!.dispatchEvent(new Event('change', { bubbles: true }));
    });

    expect(container.querySelector('.trailmaker-overlay-opacity-value')?.textContent).toBe('80%');
    expect(mockMap.setPaintProperty).toHaveBeenCalledWith(OVERLAY_LAYER_ID, 'raster-opacity', 0.8);
  });

  it('debounces feature updates on project feature edits by 150 ms', async () => {
    vi.useFakeTimers();
    updateBasemapSettings({ enabled: true });
    createTestSession(validAnchors);

    const mockGeoJsonSource = {
      setData: vi.fn(),
    };
    mockSources[FEATURES_SOURCE_ID] = mockGeoJsonSource;

    render(<OverlayPreview />);
    await act(async () => {
      await Promise.resolve();
    });

    // Add a trail
    act(() => {
      const p = appStore.getState().session!.project;
      const { command } = addFeature(p, {
        kind: 'trail',
        name: 'New Trail',
        color: '#ff0000',
        notes: '',
        pts: [
          [50, 50],
          [100, 100],
        ],
        ink: null,
      });
      edit(command);
    });

    // Not yet called immediately
    expect(mockGeoJsonSource.setData).not.toHaveBeenCalled();

    // Advance 140 ms -> still debouncing
    act(() => {
      vi.advanceTimersByTime(140);
    });
    expect(mockGeoJsonSource.setData).not.toHaveBeenCalled();

    // Advance to 150 ms -> called
    act(() => {
      vi.advanceTimersByTime(20);
    });
    vi.useRealTimers();
    await act(async () => {
      for (let i = 0; i < 5; i++) {
        await new Promise((r) => setTimeout(r, 10));
      }
    });
    expect(mockGeoJsonSource.setData).toHaveBeenCalledTimes(1);
  });

  it('debounces re-warp on anchor coordinates change by 300 ms', async () => {
    vi.useFakeTimers();
    updateBasemapSettings({ enabled: true });
    createTestSession(validAnchors);

    render(<OverlayPreview />);
    await act(async () => {
      await Promise.resolve();
    });

    const initialCalls = mockMap.addSource.mock.calls.length;

    // Move an anchor
    act(() => {
      const p = appStore.getState().session!.project;
      const cmd = setAnchorCoords(p, 'a1' as AnchorId, [38.05, -78.05], 'paste');
      edit(cmd);
    });

    // Advance 250 ms -> still debouncing
    act(() => {
      vi.advanceTimersByTime(250);
    });
    expect(mockMap.addSource.mock.calls.length).toBe(initialCalls);

    // Advance past 300 ms -> re-warps
    act(() => {
      vi.advanceTimersByTime(60);
    });
    expect(mockMap.addSource.mock.calls.length).toBeGreaterThan(initialCalls);

    vi.useRealTimers();
  });

  it('updates selected feature highlight in GeoJSON source data', async () => {
    vi.useFakeTimers();
    updateBasemapSettings({ enabled: true });
    createTestSession(validAnchors);

    const mockGeoJsonSource = {
      setData: vi.fn(),
    };
    mockSources[FEATURES_SOURCE_ID] = mockGeoJsonSource;

    render(<OverlayPreview />);
    await act(async () => {
      await Promise.resolve();
    });

    // Add a trail and select it
    let trailId: FeatureId;
    act(() => {
      const p = appStore.getState().session!.project;
      const { command, id } = addFeature(p, {
        kind: 'trail',
        name: 'Selected Trail',
        color: '#00ff00',
        notes: '',
        pts: [
          [10, 10],
          [20, 20],
        ],
        ink: null,
      });
      trailId = id;
      edit(command, { feature: id });
    });

    act(() => {
      vi.advanceTimersByTime(160);
    });
    vi.useRealTimers();
    await act(async () => {
      for (let i = 0; i < 5; i++) {
        await new Promise((r) => setTimeout(r, 10));
      }
    });

    expect(mockGeoJsonSource.setData).toHaveBeenCalled();
    const lastCall = mockGeoJsonSource.setData.mock.calls.at(-1)?.[0] as {
      features: { properties: { id: string; selected: boolean } }[];
    };
    expect(lastCall.features[0]?.properties.id).toBe(trailId!);
    expect(lastCall.features[0]?.properties.selected).toBe(true);
  });

  it('provides imperative handle operations via ref', async () => {
    updateBasemapSettings({ enabled: true });
    createTestSession(validAnchors);
    const ref = createRef<BasemapHandle>();

    render(<OverlayPreview ref={ref} />);
    await act(async () => {
      await Promise.resolve();
    });

    expect(ref.current).toBeDefined();
    expect(ref.current?.getMap()).toBe(mockMap);
    expect(ref.current?.isReady()).toBe(true);

    ref.current?.flyTo({ center: [-78.0, 38.0], zoom: 12 });
    expect(mockMap.flyTo).toHaveBeenCalledWith({ center: [-78.0, 38.0], zoom: 12 });

    expect(ref.current?.getContainer()).toBeInstanceOf(HTMLDivElement);
  });

  it('forwards handleRef in mountOverlayPreview helper', async () => {
    updateBasemapSettings({ enabled: true });
    createTestSession(validAnchors);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const handleRef: { current: BasemapHandle | null } = { current: null };
    let mounted: { unmount: () => void } | undefined;
    await act(async () => {
      mounted = mountOverlayPreview(host, { handleRef });
      await Promise.resolve();
    });

    expect(handleRef.current).toBeDefined();
    expect(handleRef.current?.getMap()).toBe(mockMap);
    expect(handleRef.current?.isReady()).toBe(true);

    act(() => {
      mounted?.unmount();
    });
    host.remove();
  });

  it('supports keyboard pan/zoom and accessible slider attributes', async () => {
    updateBasemapSettings({ enabled: true, opacity: 0.6 });
    createTestSession(validAnchors);

    render(<OverlayPreview />);
    await act(async () => {
      await Promise.resolve();
    });

    const mapContainer = container.querySelector(
      '#trailmaker-overlay-map-container',
    ) as HTMLElement;
    expect(mapContainer).not.toBeNull();
    expect(mapContainer.getAttribute('tabindex')).toBe('0');
    expect(mapContainer.getAttribute('role')).toBe('region');
    expect(mapContainer.getAttribute('aria-label')).toContain('Georeferenced overlay map');

    // Pan with arrow keys
    act(() => {
      mapContainer.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }),
      );
    });
    expect(mockMap.panBy).toHaveBeenCalledWith([0, -80], { duration: 0 });

    act(() => {
      mapContainer.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'ArrowRight',
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    expect(mockMap.panBy).toHaveBeenCalledWith([250, 0], { duration: 0 });

    // Zoom with +/-
    act(() => {
      mapContainer.dispatchEvent(
        new KeyboardEvent('keydown', { key: '+', bubbles: true, cancelable: true }),
      );
    });
    expect(mockMap.zoomIn).toHaveBeenCalledWith({ duration: 0 });

    // Accessible slider attributes
    const slider = container.querySelector(
      '#trailmaker-overlay-opacity',
    ) as HTMLInputElement;
    expect(slider).not.toBeNull();
    expect(slider.getAttribute('aria-label')).toBe('Map opacity');
    expect(slider.getAttribute('aria-valuemin')).toBe('0');
    expect(slider.getAttribute('aria-valuemax')).toBe('100');
    expect(slider.getAttribute('aria-valuenow')).toBe('60');
    expect(slider.getAttribute('aria-valuetext')).toBe('60%');

    const toolbar = container.querySelector('[role="toolbar"]');
    expect(toolbar).not.toBeNull();
    expect(toolbar?.getAttribute('aria-label')).toBe('Overlay controls');
  });
});
