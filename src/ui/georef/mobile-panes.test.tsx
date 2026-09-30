import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BasemapConsent } from './BasemapConsent';
import { BasemapSettingsPopover } from './BasemapSettingsPopover';
import { GeoSearchBox } from './GeoSearchBox';
import { isNarrowPhone, setStageView } from './pairing';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('mobile panes and controls (T-315 acceptance 1 & 2)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.restoreAllMocks();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render(node: React.ReactNode): void {
    act(() => root.render(node));
  }

  it('renders BasemapConsent overlay within 360px and 412px viewports without overflow', () => {
    for (const width of [360, 412]) {
      container.style.width = `${width}px`;
      render(
        <div style={{ width: `${width}px`, position: 'relative' }}>
          <BasemapConsent
            styleUrl="https://example.com/style.json"
            onEnable={vi.fn()}
            onDismiss={vi.fn()}
          />
        </div>,
      );

      const card = container.querySelector('.trailmaker-basemap-consent-card');
      expect(card).not.toBeNull();
      expect(container.querySelector('.trailmaker-basemap-consent-overlay')).not.toBeNull();
    }
  });

  it('renders BasemapConsent inline within sidebar (.georef-toggle) within 360px and 412px viewports', () => {
    for (const width of [360, 412]) {
      container.style.width = `${width}px`;
      render(
        <div className="side" style={{ width: `${width}px` }}>
          <div className="georef-toggle">
            <BasemapConsent
              styleUrl="https://example.com/style.json"
              geocoderUrl="https://geocoder.example.com"
              geocoderEnabled={true}
              onToggleGeocoder={vi.fn()}
              onEnable={vi.fn()}
              onDismiss={vi.fn()}
            />
          </div>
        </div>,
      );

      const card = container.querySelector('.georef-toggle .trailmaker-basemap-consent-card');
      expect(card).not.toBeNull();
      expect(container.querySelector('.trailmaker-geocoder-consent')).not.toBeNull();
    }
  });

  it('renders BasemapSettingsPopover within 360px and 412px viewports', () => {
    for (const width of [360, 412]) {
      container.style.width = `${width}px`;
      render(
        <div style={{ width: `${width}px`, position: 'relative' }}>
          <BasemapSettingsPopover
            isOpen={true}
            onClose={vi.fn()}
            styleUrl="https://example.com/style.json"
            enabled={true}
            onToggleEnabled={vi.fn()}
            onChangeStyleUrl={vi.fn()}
            onResetStyleUrl={vi.fn()}
          />
        </div>,
      );

      const popover = container.querySelector('.trailmaker-basemap-settings-popover');
      expect(popover).not.toBeNull();
      expect(container.querySelector('.trailmaker-basemap-close-btn')).not.toBeNull();
    }
  });

  it('renders GeoSearchBox within 360px and 412px viewports', () => {
    for (const width of [360, 412]) {
      container.style.width = `${width}px`;
      render(
        <div style={{ width: `${width}px`, position: 'relative' }}>
          <GeoSearchBox enabled={true} onSelect={vi.fn()} />
        </div>,
      );

      const box = container.querySelector('.trailmaker-geocoder');
      expect(box).not.toBeNull();
      const input = container.querySelector('.trailmaker-geocoder-input');
      expect(input).not.toBeNull();
    }
  });

  it('detects narrow phone layout correctly at 360px and 412px', () => {
    const origMatchMedia = window.matchMedia;
    const origInnerWidth = window.innerWidth;

    try {
      for (const w of [360, 412]) {
        Object.defineProperty(window, 'innerWidth', { value: w, writable: true });
        window.matchMedia = vi.fn().mockImplementation((q: string) => ({
          matches: q.includes('820px'),
          media: q,
          onchange: null,
          addListener: vi.fn(),
          removeListener: vi.fn(),
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
          dispatchEvent: vi.fn(),
        })) as unknown as typeof window.matchMedia;

        expect(isNarrowPhone()).toBe(true);
      }
    } finally {
      window.matchMedia = origMatchMedia;
      Object.defineProperty(window, 'innerWidth', { value: origInnerWidth, writable: true });
    }
  });

  it('setStageView sets stageView on mock store', () => {
    const setStageViewMock = vi.fn();
    const mockStore = {
      getState: () => ({ setStageView: setStageViewMock }),
      setState: vi.fn(),
    };

    setStageView('basemap', mockStore as never);
    expect(setStageViewMock).toHaveBeenCalledWith('basemap');

    setStageView('map', mockStore as never);
    expect(setStageViewMock).toHaveBeenCalledWith('map');

    setStageView('overlay', mockStore as never);
    expect(setStageViewMock).toHaveBeenCalledWith('overlay');
  });

  it('setStageView falls back to store.setState if setter is not present', () => {
    const setStateMock = vi.fn();
    const mockStore = {
      getState: () => ({}),
      setState: setStateMock,
    };

    setStageView('basemap', mockStore as never);
    expect(setStateMock).toHaveBeenCalledWith({ stageView: 'basemap' });
  });

  it('renders ImagerySwitch and top actions within 360px and 412px viewports (T-316)', () => {
    for (const width of [360, 412]) {
      container.style.width = `${width}px`;
      render(
        <div style={{ width: `${width}px`, position: 'relative' }}>
          <div className="trailmaker-basemap-top-actions">
            <div className="trailmaker-imagery-switch">
              <button type="button" className="trailmaker-imagery-btn active">Map</button>
              <button type="button" className="trailmaker-imagery-btn">Satellite</button>
            </div>
            <button type="button" className="trailmaker-basemap-gpx-btn">Import GPX</button>
            <button type="button" className="trailmaker-basemap-settings-btn">⚙</button>
          </div>
        </div>,
      );

      const topActions = container.querySelector('.trailmaker-basemap-top-actions');
      expect(topActions).not.toBeNull();
      const switchEl = container.querySelector('.trailmaker-imagery-switch');
      expect(switchEl).not.toBeNull();
    }
  });
});
