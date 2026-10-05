import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setAnchorCoords } from '../state/commands';
import { updateBasemapSettings, resetSettings } from '../io/settings';
import {
  appStore,
  edit,
  openSession,
  requestSatelliteCapture,
  selectAnchor,
  setStageView,
} from '../state/store';
import { makeProject, makeSession } from '../state/fixtures.test.helper';
import App from './App';
import { loadSplitLayout, saveSplitLayout } from './splitLayout';

void React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

function render() {
  act(() => root.render(<App />));
}
const showBasemapButton = () =>
  [...host.querySelectorAll('button')].find((b) => /show basemap/i.test(b.textContent ?? ''))!;
const q = (sel: string) => host.querySelector(sel);

beforeEach(() => {
  window.localStorage.clear();
  resetSettings();
  openSession(makeSession(makeProject({ seq: 5 })));
  setStageView('map');
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  window.localStorage.clear();
  resetSettings();
  vi.unstubAllGlobals();
});

describe('App georef split (T-212)', () => {
  it('the "Show basemap" toggle is unreachable-but-focusable until the network opt-in is accepted', () => {
    render();
    const btn = showBasemapButton();
    expect(btn.getAttribute('aria-disabled')).toBe('true');
    expect(btn.hasAttribute('disabled')).toBe(false); // stays focusable so its hint is reachable
    expect(q('.trailmaker-basemap-consent-overlay')).toBeTruthy();

    act(() => btn.click());
    expect(q('.stage.split')).toBeFalsy(); // clicking a still-disabled toggle does nothing

    act(() => updateBasemapSettings({ enabled: true }));
    render();
    expect(showBasemapButton().getAttribute('aria-disabled')).toBe('false');
  });

  it('toggling on splits the stage into labelled "Park map" and "Basemap" regions', () => {
    saveSplitLayout({
      show: false,
      mode: 'pair',
      frac: 0.55,
      stageMode: 'side-by-side',
      stepsCollapsed: false,
    });
    act(() => updateBasemapSettings({ enabled: true }));
    render();
    act(() => showBasemapButton().click());
    render();
    expect(q('.stage.split')).toBeTruthy();
    expect(host.querySelector('[role="region"][aria-label="Park map"]')).toBeTruthy();
    expect(host.querySelector('.stage-georef')).toBeTruthy();
    expect(host.querySelector('[role="separator"]')).toBeTruthy();
  });

  it('opens the Basemap tab when shown and returns to Map when hidden in desktop Tabs mode', () => {
    act(() => updateBasemapSettings({ enabled: true }));
    render();
    expect(q('.stage-header')).toBeNull();

    act(() => showBasemapButton().click());
    render();
    expect(host.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe('Basemap');

    act(() =>
      [...host.querySelectorAll('button')].find((b) => b.textContent === 'Hide basemap')!.click(),
    );
    render();
    expect(appStore.getState().stageView).toBe('map');
    expect(q('.stage-header')).toBeNull();
  });

  it('persists show/mode/frac to localStorage and restores them on the next mount', () => {
    act(() => updateBasemapSettings({ enabled: true }));
    render();
    act(() => showBasemapButton().click());
    expect(loadSplitLayout().show).toBe(true);
    expect(loadSplitLayout().stageMode).toBe('tabs');

    act(() => root.unmount());
    root = createRoot(host);
    render();
    expect(q('.stage-tabs')).toBeTruthy();
  });

  it('falls back from overlay to pair mode once the fit stops being ok', () => {
    saveSplitLayout({ show: true, mode: 'overlay', frac: 0.5 });
    act(() => updateBasemapSettings({ enabled: true }));
    render();
    // No anchors placed, so fit isn't ok: mode should have been forced back to 'pair'.
    expect(loadSplitLayout().mode).toBe('pair');
    const overlayBtn = [...host.querySelectorAll('button')].find(
      (b) => b.textContent === 'Overlay preview',
    )!;
    expect(overlayBtn.hasAttribute('disabled')).toBe(true);
  });

  it('stacks the panes vertically under the narrow-viewport breakpoint', () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn((query: string) => ({
        matches: query === '(max-width: 899px)',
        addEventListener: () => {},
        removeEventListener: () => {},
      })),
    );
    act(() => updateBasemapSettings({ enabled: true }));
    saveSplitLayout({ show: true, mode: 'pair', frac: 0.5 });
    render();
    expect(q('.stage.narrow')).toBeTruthy();
    expect(host.querySelector('[role="separator"]')?.getAttribute('aria-orientation')).toBe(
      'horizontal',
    );
  });

  it('uses stage tabs at phone widths and stores the selected pane for Lane C', () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn((query: string) => ({
        matches: query === '(max-width: 899px)' || query === '(max-width: 820px)',
        addEventListener: () => {},
        removeEventListener: () => {},
      })),
    );
    act(() => updateBasemapSettings({ enabled: true }));
    saveSplitLayout({ show: true, mode: 'pair', frac: 0.5 });
    render();
    expect(q('.stage-tabs')).toBeTruthy();
    expect(host.querySelector('[role="separator"]')).toBeNull();
    act(() =>
      [...host.querySelectorAll('button')].find((b) => b.textContent === 'Basemap')!.click(),
    );
    expect(appStore.getState().stageView).toBe('basemap');
    act(() => [...host.querySelectorAll('button')].find((b) => b.textContent === 'Map')!.click());
    expect(appStore.getState().stageView).toBe('map');
  });

  it('shows basemap when satelliteCaptureRequested is set in store (T-318)', () => {
    act(() => updateBasemapSettings({ enabled: true }));
    render();
    expect(q('.stage.split')).toBeFalsy();
    act(() => requestSatelliteCapture());
    render();
    expect(q('.stage-tabs')).toBeTruthy();
    expect(host.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe('Basemap');
  });

  it('defaults new desktop profiles to Tabs and exposes a labelled single-monitor layout control', () => {
    render();
    expect(loadSplitLayout().stageMode).toBe('tabs');
    expect(q('.stage-header')).toBeNull();
    act(() => updateBasemapSettings({ enabled: true }));
    act(() => showBasemapButton().click());
    render();
    expect(
      host.querySelector('[role="group"][aria-label="Stage layout"] [aria-pressed="true"]')
        ?.textContent,
    ).toBe('Tabs');
    expect(host.querySelector('.stage-tabs')).toBeTruthy();
  });

  it('keeps a pending pair on Map while the basemap is hidden', () => {
    act(() => {
      openSession(
        makeSession(
          makeProject({
            anchors: [{ id: 'pending-pair', px: [40, 60], ll: null, source: 'paste' }],
          }),
        ),
      );
      selectAnchor('pending-pair');
      render();
    });
    expect(loadSplitLayout().show).toBe(false);
    expect(appStore.getState().stageView).toBe('map');
  });

  it('switches Map -> Basemap -> Map for a pending pair when the basemap is already shown', () => {
    saveSplitLayout({
      show: true,
      mode: 'pair',
      frac: 0.55,
      stageMode: 'tabs',
      stepsCollapsed: false,
    });
    act(() => {
      setStageView('map');
      updateBasemapSettings({ enabled: true });
      render();
      openSession(
        makeSession(
          makeProject({
            anchors: [{ id: 'pending-pair', px: [40, 60], ll: null, source: 'paste' }],
          }),
        ),
      );
      selectAnchor('pending-pair');
    });
    expect(host.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe('Basemap');

    act(() => {
      const session = appStore.getState().session!;
      edit(setAnchorCoords(session.project, 'pending-pair', [38.5, -78.4]));
    });
    expect(host.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe('Map');
  });

  it('does not return to Map when a pending pair starts while already on Basemap', () => {
    saveSplitLayout({
      show: true,
      mode: 'pair',
      frac: 0.55,
      stageMode: 'tabs',
      stepsCollapsed: false,
    });
    act(() => {
      updateBasemapSettings({ enabled: true });
      render();
      openSession(
        makeSession(
          makeProject({
            anchors: [{ id: 'pending-pair', px: [40, 60], ll: null, source: 'paste' }],
          }),
        ),
      );
      setStageView('basemap');
      selectAnchor('pending-pair');
    });
    expect(appStore.getState().stageView).toBe('basemap');

    act(() => {
      const session = appStore.getState().session!;
      edit(setAnchorCoords(session.project, 'pending-pair', [38.5, -78.4]));
    });
    expect(appStore.getState().stageView).toBe('basemap');
  });

  it('collapses to numbered steps and expands at the selected step; backslash is the shortcut', () => {
    render();
    act(() => host.querySelector<HTMLButtonElement>('.side-collapse')!.click());
    expect(host.querySelector('.side.collapsed')).toBeTruthy();
    expect(loadSplitLayout().stepsCollapsed).toBe(true);
    const expand = host.querySelector<HTMLButtonElement>(
      'button[aria-label="Expand steps at Trace"]',
    )!;
    act(() => expand.click());
    expect(host.querySelector('.side.collapsed')).toBeNull();
    expect(loadSplitLayout().stepsCollapsed).toBe(false);

    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: '\\', bubbles: true })));
    expect(host.querySelector('.side.collapsed')).toBeTruthy();
  });
});
