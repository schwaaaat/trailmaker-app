// Lane C. Tests for SatelliteFramingOverlay (card T-318).
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Map as MapLibreMap } from 'maplibre-gl';
import { SatelliteFramingOverlay } from './SatelliteFramingOverlay';
import { satelliteCaptureTestSeam } from '../../io/satellite-capture';
import * as imageModule from '../../io/image';
import { makeMap, makeProject } from '../../state/fixtures.test.helper';

void React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('SatelliteFramingOverlay', () => {
  let container: HTMLDivElement;
  let root: Root;

  const mockMap = {
    on: vi.fn(),
    off: vi.fn(),
    getContainer: vi.fn(() => ({
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
    })),
    getCenter: vi.fn(() => ({ lng: -80.145, lat: 27.135 })),
    getZoom: vi.fn(() => 14),
    unproject: vi.fn(([x, y]: [number, number]) => ({
      lng: -80.145 + (x - 400) * 0.0001,
      lat: 27.135 - (y - 300) * 0.0001,
    })),
  };
  const typedMap = mockMap as unknown as MapLibreMap;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    vi.spyOn(imageModule, 'loadImageFile').mockResolvedValue(makeMap(makeProject()));

    satelliteCaptureTestSeam.createCanvas = () => ({
      getContext: () =>
        ({
          fillStyle: '',
          strokeStyle: '',
          fillRect: vi.fn(),
          strokeRect: vi.fn(),
          beginPath: vi.fn(),
          moveTo: vi.fn(),
          lineTo: vi.fn(),
          stroke: vi.fn(),
          drawImage: vi.fn(),
          save: vi.fn(),
          restore: vi.fn(),
        }) as unknown as CanvasRenderingContext2D,
      convertToBlob: async () => new Blob(['fake-png'], { type: 'image/png' }),
      toBlob: (cb: (b: Blob) => void) => cb(new Blob(['fake-png'], { type: 'image/png' })),
    });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    satelliteCaptureTestSeam.createCanvas = null;
    vi.restoreAllMocks();
  });

  it('renders nothing when closed', () => {
    act(() => {
      root.render(
        <SatelliteFramingOverlay
          map={typedMap}
          isOpen={false}
          onClose={vi.fn()}
        />
      );
    });

    expect(container.querySelector('.trailmaker-satellite-framing-overlay')).toBeNull();
  });

  it('renders framing reticle, dimensions, ground resolution, and zoom controls when open', () => {
    act(() => {
      root.render(
        <SatelliteFramingOverlay
          map={typedMap}
          isOpen={true}
          onClose={vi.fn()}
        />
      );
    });

    expect(container.querySelector('.trailmaker-satellite-framing-overlay')).not.toBeNull();
    expect(container.querySelector('.trailmaker-framing-box')).not.toBeNull();

    // Check specifications display: px dimensions and ground resolution
    const specs = container.querySelector('.trailmaker-framing-specs');
    expect(specs).not.toBeNull();
    expect(specs?.textContent).toMatch(/px/);
    expect(specs?.textContent).toMatch(/per pixel/);

    // Check zoom control
    const zoomRow = container.querySelector('.trailmaker-framing-zoom-row');
    expect(zoomRow).not.toBeNull();
    expect(zoomRow?.textContent).toContain('Capture zoom:');
  });

  it('displays Esri license notice and switch button when Esri provider is active', () => {
    const handleSwitch = vi.fn();

    act(() => {
      root.render(
        <SatelliteFramingOverlay
          map={typedMap}
          isOpen={true}
          onClose={vi.fn()}
          activeProvider="esri"
          onSwitchProvider={handleSwitch}
        />
      );
    });

    const esriNotice = container.querySelector('.trailmaker-framing-esri-notice');
    expect(esriNotice).not.toBeNull();
    expect(esriNotice?.textContent).toContain('capture uses public-domain NAIP where available and USGS imagery elsewhere');
    expect(esriNotice?.textContent).toContain('Esri does not permit offline tile export');
    expect(esriNotice?.textContent).toContain('tracing with Esri is allowed');

    const switchBtn = esriNotice?.querySelector('button');
    expect(switchBtn).not.toBeNull();
    act(() => {
      switchBtn?.click();
    });
    expect(handleSwitch).toHaveBeenCalledWith('usgs');
  });

  it('allows stepping zoom up and down', () => {
    act(() => {
      root.render(
        <SatelliteFramingOverlay
          map={typedMap}
          isOpen={true}
          onClose={vi.fn()}
        />
      );
    });

    const decBtn = container.querySelector('button[aria-label="Decrease capture zoom"]') as HTMLButtonElement;
    const incBtn = container.querySelector('button[aria-label="Increase capture zoom"]') as HTMLButtonElement;
    const valueEl = container.querySelector('.trailmaker-framing-zoom-value');

    const initialZoom = Number(valueEl?.textContent);

    act(() => {
      decBtn.click();
    });
    expect(Number(valueEl?.textContent)).toBe(initialZoom - 1);

    act(() => {
      incBtn.click();
    });
    expect(Number(valueEl?.textContent)).toBe(initialZoom);
  });

  it('triggers capture and handles cancel', async () => {
    const handleClose = vi.fn();
    const showToast = vi.fn();

    const mockTileLoader = vi.fn(async () => null);

    act(() => {
      root.render(
        <SatelliteFramingOverlay
          map={typedMap}
          isOpen={true}
          onClose={handleClose}
          showToast={showToast}
          tileLoader={mockTileLoader}
        />
      );
    });

    const captureBtn = container.querySelector('.trailmaker-framing-actions .btn.primary') as HTMLButtonElement;
    expect(captureBtn).not.toBeNull();

    await act(async () => {
      captureBtn.click();
    });

    expect(handleClose).toHaveBeenCalled();
    expect(showToast).toHaveBeenCalled();
  });
});
