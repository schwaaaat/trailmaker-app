import { describe, expect, it, vi } from 'vitest';
import type { Anchor, Project } from '../../core/types';
import { appStore, type AppState } from '../../state/store';
import {
  getPairingState,
  handleBasemapClick,
  handleCancelPairing,
  initPairingPhoneSync,
  isNarrowPhone,
  PAIRING_PROMPT,
  stopPairingPhoneSync,
} from './pairing';

import { newProject } from '../../core/project';

function makeProject(anchors: Anchor[] = []): Project {
  const p = newProject(
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
  return { ...p, anchors };
}

function makeState(overrides: Partial<AppState> = {}): AppState {
  return {
    session: {
      project: makeProject(),
      map: {} as unknown as AppState['session'] extends { map: infer M } ? M : never,
    },
    tool: 'select',
    prevTool: 'trail',
    selectedFeatureId: null,
    selectedAnchorId: null,
    secondSelectedFeatureId: null,
    vertexMenu: null,
    vertexFocus: null,
    keyboardMode: false,
    helpOpen: false,
    announcement: null,
    draft: null,
    candidates: null,
    busy: null,
    toast: null,
    focusRequest: null,
    imageId: null,
    job: null,
    inkFor: null,
    lastInk: null,
    anchorDragging: false,
    mergeAcrossColors: true,
    reviewUndoStack: [],
    reviewEpoch: 0,
    history: { canUndo: false, canRedo: false, undoLabel: null, redoLabel: null },
    ...overrides,
  };
}

describe('pairing state machine', () => {
  it('reports idle when no session is open', () => {
    const s = makeState({ session: null });
    const info = getPairingState(s);
    expect(info.status).toBe('idle');
    expect(info.pendingAnchor).toBeNull();
  });

  it('reports armed when tool is anchor and no anchor is pending', () => {
    const s = makeState({ tool: 'anchor' });
    const info = getPairingState(s);
    expect(info.status).toBe('armed');
    expect(info.pendingAnchor).toBeNull();
  });

  it('reports pending when an anchor with null coords is selected', () => {
    const a1: Anchor = { id: 'g0', px: [100, 200], ll: null, source: 'paste' };
    const p = makeProject([a1]);
    const s = makeState({
      session: { project: p, map: {} as never },
      tool: 'anchor',
      selectedAnchorId: 'g0',
    });

    const info = getPairingState(s);
    expect(info.status).toBe('pending');
    expect(info.pendingAnchor).toEqual(a1);
    expect(info.pendingAnchorNumber).toBe(1);
    expect(PAIRING_PROMPT).toBe('Now click the same spot on the basemap');
  });

  it('sets coordinates on pending anchor with source basemap', () => {
    const a1: Anchor = { id: 'g0', px: [100, 200], ll: null, source: 'paste' };
    const p = makeProject([a1]);
    const s = makeState({
      session: { project: p, map: {} as never },
      tool: 'anchor',
      selectedAnchorId: 'g0',
    });

    const editMock = vi.fn();
    const result = handleBasemapClick([38.5, -78.4], {
      project: p,
      state: s,
      edit: editMock,
    });

    expect(result.action).toBe('set');
    if (result.action === 'set') {
      expect(result.anchorId).toBe('g0');
      expect(result.ll).toEqual([38.5, -78.4]);
    }
    expect(editMock).toHaveBeenCalledTimes(1);
    const cmd = editMock.mock.calls[0]![0];
    const updated = cmd.apply(p);
    expect(updated.anchors[0]!.ll).toEqual([38.5, -78.4]);
    expect(updated.anchors[0]!.source).toBe('basemap');
  });

  it('cancels pending pairing: removes incomplete anchor and deselects', () => {
    const a1: Anchor = { id: 'g0', px: [100, 200], ll: null, source: 'paste' };
    const p = makeProject([a1]);
    const s = makeState({
      session: { project: p, map: {} as never },
      tool: 'anchor',
      selectedAnchorId: 'g0',
    });

    const editMock = vi.fn();
    const selectMock = vi.fn();

    const result = handleCancelPairing({
      project: p,
      state: s,
      edit: editMock,
      selectAnchor: selectMock,
    });

    expect(result.action).toBe('cancel');
    if (result.action === 'cancel') {
      expect(result.anchorId).toBe('g0');
    }
    expect(editMock).toHaveBeenCalledTimes(1);
    const cmd = editMock.mock.calls[0]![0];
    const updated = cmd.apply(p);
    expect(updated.anchors).toHaveLength(0);
    expect(selectMock).toHaveBeenCalledWith(null);
  });

  it('does nothing on cancel if no anchor is pending', () => {
    const a1: Anchor = { id: 'g0', px: [100, 200], ll: [38.5, -78.4], source: 'paste' };
    const p = makeProject([a1]);
    const s = makeState({
      session: { project: p, map: {} as never },
      tool: 'anchor',
      selectedAnchorId: 'g0',
    });

    const editMock = vi.fn();
    const selectMock = vi.fn();

    const result = handleCancelPairing({
      project: p,
      state: s,
      edit: editMock,
      selectAnchor: selectMock,
    });

    expect(result.action).toBe('none');
    expect(editMock).not.toHaveBeenCalled();
  });

  it('prompts confirmation when clicking basemap with an existing anchor selected', () => {
    const a1: Anchor = { id: 'g0', px: [100, 200], ll: [38.5, -78.4], source: 'basemap' };
    const a2: Anchor = { id: 'g1', px: [300, 400], ll: [38.6, -78.3], source: 'basemap' };
    const a3: Anchor = { id: 'g2', px: [500, 600], ll: [38.7, -78.2], source: 'basemap' };
    const p = makeProject([a1, a2, a3]);
    const s = makeState({
      session: { project: p, map: {} as never },
      tool: 'select',
      selectedAnchorId: 'g2', // anchor 3
    });

    const editMock = vi.fn();
    const confirmMock = vi.fn(() => true);

    const result = handleBasemapClick([38.8, -78.1], {
      project: p,
      state: s,
      edit: editMock,
      confirm: confirmMock,
    });

    expect(confirmMock).toHaveBeenCalledWith('Move anchor 3 here?');
    expect(result.action).toBe('move-with-confirm');
    if (result.action === 'move-with-confirm') {
      expect(result.confirmed).toBe(true);
      expect(result.anchorId).toBe('g2');
      expect(result.anchorNumber).toBe(3);
    }
    expect(editMock).toHaveBeenCalledTimes(1);
    const cmd = editMock.mock.calls[0]![0];
    const updated = cmd.apply(p);
    expect(updated.anchors[2]!.ll).toEqual([38.8, -78.1]);
    expect(updated.anchors[2]!.source).toBe('basemap');
  });

  it('does not move existing anchor if confirm is rejected', () => {
    const a1: Anchor = { id: 'g0', px: [100, 200], ll: [38.5, -78.4], source: 'basemap' };
    const p = makeProject([a1]);
    const s = makeState({
      session: { project: p, map: {} as never },
      tool: 'select',
      selectedAnchorId: 'g0',
    });

    const editMock = vi.fn();
    const confirmMock = vi.fn(() => false);

    const result = handleBasemapClick([38.9, -78.0], {
      project: p,
      state: s,
      edit: editMock,
      confirm: confirmMock,
    });

    expect(confirmMock).toHaveBeenCalledWith('Move anchor 1 here?');
    expect(result.action).toBe('move-with-confirm');
    if (result.action === 'move-with-confirm') {
      expect(result.confirmed).toBe(false);
    }
    expect(editMock).not.toHaveBeenCalled();
  });

  describe('phone pairing tab switch (T-315 acceptance 2)', () => {
    it('detects narrow phone layout when viewport <= 820px', () => {
      const origMatchMedia = window.matchMedia;
      const origInnerWidth = window.innerWidth;

      try {
        // Mock matching narrow query
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

        // Mock desktop query
        window.matchMedia = vi.fn().mockImplementation(() => ({
          matches: false,
          media: '',
          onchange: null,
          addListener: vi.fn(),
          removeListener: vi.fn(),
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
          dispatchEvent: vi.fn(),
        })) as unknown as typeof window.matchMedia;
        Object.defineProperty(window, 'innerWidth', { value: 1200, writable: true });

        expect(isNarrowPhone()).toBe(false);
      } finally {
        window.matchMedia = origMatchMedia;
        Object.defineProperty(window, 'innerWidth', { value: origInnerWidth, writable: true });
      }
    });

    it('switches to basemap tab when spot tapped on park map on a phone', () => {
      const origMatchMedia = window.matchMedia;
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

      stopPairingPhoneSync();

      const listeners: Array<(state: AppState) => void> = [];
      let currentState = makeState({ tool: 'anchor' });
      const setStageViewMock = vi.fn();

      const mockStore = {
        getState: () => ({ ...currentState, setStageView: setStageViewMock }),
        setState: vi.fn(),
        subscribe: (cb: (state: AppState) => void) => {
          listeners.push(cb);
          return () => {
            const idx = listeners.indexOf(cb);
            if (idx >= 0) listeners.splice(idx, 1);
          };
        },
      };

      try {
        const cleanup = initPairingPhoneSync(mockStore as never);

        // State changes to pending anchor (spot tapped on park map)
        const pendingAnchor: Anchor = { id: 'g0', px: [100, 200], ll: null, source: 'paste' };
        const project = makeProject([pendingAnchor]);
        currentState = makeState({
          session: { project, map: {} as never },
          tool: 'anchor',
          selectedAnchorId: 'g0',
        });

        // Trigger store subscribers
        listeners.forEach((l) => l(currentState));

        expect(setStageViewMock).toHaveBeenCalledWith('basemap');

        cleanup();
      } finally {
        window.matchMedia = origMatchMedia;
        stopPairingPhoneSync();
      }
    });

    it('does NOT switch tabs on desktop when spot tapped on park map', () => {
      const origMatchMedia = window.matchMedia;
      window.matchMedia = vi.fn().mockImplementation(() => ({
        matches: false,
        media: '',
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })) as unknown as typeof window.matchMedia;
      Object.defineProperty(window, 'innerWidth', { value: 1200, writable: true });

      stopPairingPhoneSync();

      const listeners: Array<(state: AppState) => void> = [];
      let currentState = makeState({ tool: 'anchor' });
      const setStageViewMock = vi.fn();

      const mockStore = {
        getState: () => ({ ...currentState, setStageView: setStageViewMock }),
        setState: vi.fn(),
        subscribe: (cb: (state: AppState) => void) => {
          listeners.push(cb);
          return () => {
            const idx = listeners.indexOf(cb);
            if (idx >= 0) listeners.splice(idx, 1);
          };
        },
      };

      try {
        const cleanup = initPairingPhoneSync(mockStore as never);

        const pendingAnchor: Anchor = { id: 'g0', px: [100, 200], ll: null, source: 'paste' };
        const project = makeProject([pendingAnchor]);
        currentState = makeState({
          session: { project, map: {} as never },
          tool: 'anchor',
          selectedAnchorId: 'g0',
        });

        listeners.forEach((l) => l(currentState));

        expect(setStageViewMock).not.toHaveBeenCalled();

        cleanup();
      } finally {
        window.matchMedia = origMatchMedia;
        stopPairingPhoneSync();
      }
    });

    it('returns to map tab after basemap tap completes the pair on a phone', () => {
      const origMatchMedia = window.matchMedia;
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

      const setStageViewMock = vi.fn();
      // Mock store's setStageView
      const appStoreAny = appStore as unknown as {
        getState: () => { setStageView?: (v: string) => void };
      };
      const origStoreGetState = appStoreAny.getState;
      appStoreAny.getState = () => ({
        ...origStoreGetState(),
        setStageView: setStageViewMock,
      });

      try {
        const a1: Anchor = { id: 'g0', px: [100, 200], ll: null, source: 'paste' };
        const p = makeProject([a1]);
        const s = makeState({
          session: { project: p, map: {} as never },
          tool: 'anchor',
          selectedAnchorId: 'g0',
        });

        const editMock = vi.fn();
        const result = handleBasemapClick([38.5, -78.4], {
          project: p,
          state: s,
          edit: editMock,
        });

        expect(result.action).toBe('set');
        expect(setStageViewMock).toHaveBeenCalledWith('map');
      } finally {
        window.matchMedia = origMatchMedia;
        appStoreAny.getState = origStoreGetState;
      }
    });

    it('does NOT switch to map tab on desktop after basemap tap completes the pair', () => {
      const origMatchMedia = window.matchMedia;
      window.matchMedia = vi.fn().mockImplementation(() => ({
        matches: false,
        media: '',
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })) as unknown as typeof window.matchMedia;
      Object.defineProperty(window, 'innerWidth', { value: 1200, writable: true });

      const setStageViewMock = vi.fn();
      const appStoreAny = appStore as unknown as {
        getState: () => { setStageView?: (v: string) => void };
      };
      const origStoreGetState = appStoreAny.getState;
      appStoreAny.getState = () => ({
        ...origStoreGetState(),
        setStageView: setStageViewMock,
      });

      try {
        const a1: Anchor = { id: 'g0', px: [100, 200], ll: null, source: 'paste' };
        const p = makeProject([a1]);
        const s = makeState({
          session: { project: p, map: {} as never },
          tool: 'anchor',
          selectedAnchorId: 'g0',
        });

        const editMock = vi.fn();
        const result = handleBasemapClick([38.5, -78.4], {
          project: p,
          state: s,
          edit: editMock,
        });

        expect(result.action).toBe('set');
        expect(setStageViewMock).not.toHaveBeenCalled();
      } finally {
        window.matchMedia = origMatchMedia;
        appStoreAny.getState = origStoreGetState;
      }
    });

    it('returns to map tab on phone when pending pairing is cancelled', () => {
      const origMatchMedia = window.matchMedia;
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

      const setStageViewMock = vi.fn();
      const appStoreAny = appStore as unknown as {
        getState: () => { setStageView?: (v: string) => void };
      };
      const origStoreGetState = appStoreAny.getState;
      appStoreAny.getState = () => ({
        ...origStoreGetState(),
        setStageView: setStageViewMock,
      });

      try {
        const a1: Anchor = { id: 'g0', px: [100, 200], ll: null, source: 'paste' };
        const p = makeProject([a1]);
        const s = makeState({
          session: { project: p, map: {} as never },
          tool: 'anchor',
          selectedAnchorId: 'g0',
        });

        const editMock = vi.fn();
        const selectMock = vi.fn();

        const result = handleCancelPairing({
          project: p,
          state: s,
          edit: editMock,
          selectAnchor: selectMock,
        });

        expect(result.action).toBe('cancel');
        expect(setStageViewMock).toHaveBeenCalledWith('map');
      } finally {
        window.matchMedia = origMatchMedia;
        appStoreAny.getState = origStoreGetState;
      }
    });
  });
});
