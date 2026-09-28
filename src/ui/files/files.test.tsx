// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Anchor, Feature } from '../../core/types';
import type { LoadedMap, Session, SessionBridge } from '../contract';
import { makeMap, makeProject, makeSession } from '../../state/fixtures.test.helper';

void React;
import {
  EmptyState,
  hasWork,
  MapDropZone,
  openFileBlob,
  OpenMapButton,
  OpenProjectButton,
  PdfPagePicker,
  ResumePrompt,
  formatResumeButtonText,
  formatResumeDate,
  RESUME_FAILED_MESSAGE,
  SaveProjectButton,
  slug,
  UNSUPPORTED_FILE_MESSAGE,
  REPLACE_MAP_HINT_MESSAGE,
  PAGE_CHANGE_CONFIRM_MESSAGE,
  usePasteToOpen,
} from './index';
import * as downloadModule from '../../io/download';
import * as imageModule from '../../io/image';
import { clearActiveGpx, getActiveGpx } from '../../io/gpxStorage';
import * as pdfModule from '../../io/pdf';
import * as projectModule from '../../core/project';
import * as autosaveModule from '../../io/autosave';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Fake SessionBridge implementation
function createFakeBridge(initialSession: Session | null = null): {
  bridge: SessionBridge;
  sessions: Session[];
  setSession: (s: Session | null) => void;
} {
  let current: Session | null = initialSession;
  const listeners = new Set<(s: Session | null) => void>();
  const sessions: Session[] = [];

  const bridge: SessionBridge = {
    getSession: () => current,
    subscribe: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    openSession: (s) => {
      current = s;
      sessions.push(s);
      for (const fn of listeners) fn(current);
    },
  };

  return {
    bridge,
    sessions,
    setSession: (s) => {
      current = s;
      for (const fn of listeners) fn(current);
    },
  };
}

describe('T-304 File UI & Open Routing', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    autosaveModule.resetAutosaveForTests();
    clearActiveGpx();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    autosaveModule.resetAutosaveForTests();
    clearActiveGpx();
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.restoreAllMocks();
  });

  describe('slug', () => {
    it('normalizes strings to url-friendly slugs matching prototype', () => {
      expect(slug('Red Reef Park trails')).toBe('red-reef-park-trails');
      expect(slug('  --Trail #42!!  ')).toBe('trail-42');
      expect(slug('')).toBe('park-map');
      expect(slug('   ')).toBe('park-map');
    });
  });

  describe('hasWork', () => {
    it('returns false for null session or empty project', () => {
      expect(hasWork(null)).toBe(false);
      expect(hasWork(makeSession(makeProject({ anchors: [], features: [] })))).toBe(false);
    });

    it('returns true when project has anchors or features', () => {
      const withAnchor = makeProject({
        anchors: [{ id: 'a1', px: [10, 10], ll: [0, 0], source: 'paste' } as Anchor],
      });
      expect(hasWork(makeSession(withAnchor))).toBe(true);

      const withFeature = makeProject({
        features: [{ id: 'f1', name: 'Trail', color: '#f00', notes: '', kind: 'trail', pts: [[0, 0], [1, 1]], ink: null } as Feature],
      });
      expect(hasWork(makeSession(withFeature))).toBe(true);
    });
  });

  describe('openFileBlob routing', () => {
    it('routes .trailmaker files via deserializeProject', async () => {
      const fakeProj = makeProject({ name: 'Deserialized Park' });
      const fakeMap = makeMap(fakeProj);
      const { bridge, sessions } = createFakeBridge();
      const toasts: string[] = [];

      vi.spyOn(projectModule, 'deserializeProjectAsync').mockResolvedValue({
        project: fakeProj,
        image: { bytes: new Uint8Array([1, 2, 3]), mimeType: 'image/png' },
      });
      vi.spyOn(imageModule, 'loadImageFile').mockResolvedValue(fakeMap);

      const blob = new Blob(['dummy zip'], { type: 'application/octet-stream' });
      const ok = await openFileBlob(blob, 'project.trailmaker', {
        bridge,
        showToast: (m) => toasts.push(m),
      });

      expect(ok).toBe(true);
      expect(sessions).toHaveLength(1);
      expect(sessions[0]?.project.name).toBe('Deserialized Park');
      expect(toasts).toContain('Project opened');
    });

    it('routes .json files via importPrototypeJson', async () => {
      const fakeProj = makeProject({ name: 'Prototype Park' });
      const fakeMap = makeMap(fakeProj);
      const { bridge, sessions } = createFakeBridge();
      const toasts: string[] = [];

      vi.spyOn(projectModule, 'importPrototypeJson').mockResolvedValue({
        project: fakeProj,
        image: { bytes: new Uint8Array([1, 2, 3]), mimeType: 'image/png' },
      });
      vi.spyOn(imageModule, 'loadImageFile').mockResolvedValue(fakeMap);

      const blob = new Blob(['{}'], { type: 'application/json' });
      const ok = await openFileBlob(blob, 'legacy.json', {
        bridge,
        showToast: (m) => toasts.push(m),
      });

      expect(ok).toBe(true);
      expect(sessions).toHaveLength(1);
      expect(sessions[0]?.project.name).toBe('Prototype Park');
      expect(toasts).toContain('Project opened');
    });

    it('routes PDF files via loadPdfFile and newProject', async () => {
      const fakeProj = makeProject({ name: 'Trail Map' });
      const fakeMap: LoadedMap = {
        ...makeMap(fakeProj),
        meta: { ...fakeProj.image, source: { kind: 'pdf', page: 1, pageCount: 2, renderScale: 2 } },
      };
      const { bridge, sessions } = createFakeBridge();

      vi.spyOn(pdfModule, 'loadPdfFile').mockResolvedValue(fakeMap);

      const blob = new Blob(['%PDF-1.4'], { type: 'application/pdf' });
      const ok = await openFileBlob(blob, 'Trail Map.pdf', { bridge });

      expect(ok).toBe(true);
      expect(sessions).toHaveLength(1);
      expect(sessions[0]?.project.name).toBe('Trail Map');
      expect(sessions[0]?.project.image.source.kind).toBe('pdf');
    });

    it('routes Image files via loadImageFile and newProject', async () => {
      const fakeProj = makeProject({ name: 'Park Scan' });
      const fakeMap = makeMap(fakeProj);
      const { bridge, sessions } = createFakeBridge();

      vi.spyOn(imageModule, 'loadImageFile').mockResolvedValue(fakeMap);

      const blob = new Blob(['PNG'], { type: 'image/png' });
      const ok = await openFileBlob(blob, 'Park Scan.png', { bridge });

      expect(ok).toBe(true);
      expect(sessions).toHaveLength(1);
      expect(sessions[0]?.project.name).toBe('Park Scan');
    });

    it('rejects unsupported files with prototype message', async () => {
      const { bridge, sessions } = createFakeBridge();
      const toasts: string[] = [];

      const blob = new Blob(['hello'], { type: 'text/plain' });
      const ok = await openFileBlob(blob, 'notes.txt', {
        bridge,
        showToast: (m) => toasts.push(m),
      });

      expect(ok).toBe(false);
      expect(sessions).toHaveLength(0);
      expect(toasts).toContain(UNSUPPORTED_FILE_MESSAGE);
    });

    it('sets busy state during loading and clears in finally', async () => {
      const fakeProj = makeProject();
      const fakeMap = makeMap(fakeProj);
      const { bridge } = createFakeBridge();
      const busyStates: (string | null)[] = [];

      vi.spyOn(imageModule, 'loadImageFile').mockResolvedValue(fakeMap);

      const blob = new Blob(['PNG'], { type: 'image/png' });
      await openFileBlob(blob, 'map.png', {
        bridge,
        setBusy: (b) => busyStates.push(b),
      });

      expect(busyStates).toContain('Opening file...');
      expect(busyStates.at(-1)).toBeNull();
    });

    it('surfaces errors as toasts', async () => {
      const { bridge } = createFakeBridge();
      const toasts: string[] = [];

      vi.spyOn(imageModule, 'loadImageFile').mockRejectedValue(new Error('Corrupt PNG image data'));

      const blob = new Blob(['BAD'], { type: 'image/png' });
      const ok = await openFileBlob(blob, 'corrupt.png', {
        bridge,
        showToast: (m) => toasts.push(m),
      });

      expect(ok).toBe(false);
      expect(toasts).toContain('Corrupt PNG image data');
    });

    it('imports .gpx file when an active session exists (card T-312)', async () => {
      const proj = makeProject();
      const map = makeMap(proj);
      const { bridge } = createFakeBridge({ project: proj, map });
      const toasts: string[] = [];

      const gpxContent = '<gpx version="1.1"><wpt lat="38.5" lon="-78.3"><name>Waypoint 1</name></wpt></gpx>';
      const blob = new Blob([gpxContent], { type: 'application/gpx+xml' });
      const ok = await openFileBlob(blob, 'hike.gpx', {
        bridge,
        showToast: (m) => toasts.push(m),
      });

      expect(ok).toBe(true);
      expect(getActiveGpx()).not.toBeNull();
      expect(getActiveGpx()?.points).toHaveLength(1);
      expect(toasts.some((t) => t.includes('Imported 1 GPX points'))).toBe(true);
    });

    it('warns when opening a .gpx file without an open map (card T-312)', async () => {
      const { bridge } = createFakeBridge(null);
      const toasts: string[] = [];

      const gpxContent = '<gpx version="1.1"><wpt lat="38.5" lon="-78.3"><name>Waypoint 1</name></wpt></gpx>';
      const blob = new Blob([gpxContent], { type: 'application/gpx+xml' });
      const ok = await openFileBlob(blob, 'hike.gpx', {
        bridge,
        showToast: (m) => toasts.push(m),
      });

      expect(ok).toBe(false);
      expect(toasts).toContain('Open a map image or PDF first, then import your GPX.');
    });
  });

  describe('OpenMapButton', () => {
    it('triggers input click directly when no work exists', () => {
      const { bridge } = createFakeBridge(null);
      act(() => {
        root.render(<OpenMapButton bridge={bridge} />);
      });

      const btn = container.querySelector('button')!;
      const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
      let inputClicked = false;
      input.click = () => {
        inputClicked = true;
      };

      act(() => {
        btn.click();
      });

      expect(inputClicked).toBe(true);
      expect(btn.textContent).toBe('Open image or PDF');
      expect(btn.classList.contains('arm')).toBe(false);
    });

    it('arms on first click and disarms/triggers on second click when work exists', () => {
      const projectWithWork = makeProject({
        anchors: [{ id: 'a1', px: [10, 10], ll: [0, 0], source: 'paste' } as Anchor],
      });
      const { bridge } = createFakeBridge(makeSession(projectWithWork));

      act(() => {
        root.render(<OpenMapButton bridge={bridge} />);
      });

      const btn = container.querySelector('button')!;
      const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
      let inputClicked = false;
      input.click = () => {
        inputClicked = true;
      };

      // First click: arms
      act(() => {
        btn.click();
      });

      expect(inputClicked).toBe(false);
      expect(btn.textContent).toBe('Click again to replace this map');
      expect(btn.getAttribute('aria-label')).toBe('Click again to replace this map');
      expect(btn.classList.contains('arm')).toBe(true);

      // Second click within 4s: triggers
      act(() => {
        btn.click();
      });

      expect(inputClicked).toBe(true);
      expect(btn.textContent).toBe('Open image or PDF');
      expect(btn.classList.contains('arm')).toBe(false);
    });

    it('automatically disarms after 4 seconds if not clicked again', () => {
      vi.useFakeTimers();
      try {
        const projectWithWork = makeProject({
          features: [{ id: 'f1', name: 'Trail', color: '#f00', notes: '', kind: 'trail', pts: [[0, 0], [1, 1]], ink: null } as Feature],
        });
        const { bridge } = createFakeBridge(makeSession(projectWithWork));

        act(() => {
          root.render(<OpenMapButton bridge={bridge} />);
        });

        const btn = container.querySelector('button')!;

        act(() => {
          btn.click();
        });
        expect(btn.textContent).toBe('Click again to replace this map');

        act(() => {
          vi.advanceTimersByTime(4000);
        });
        expect(btn.textContent).toBe('Open image or PDF');
        expect(btn.classList.contains('arm')).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('MapDropZone', () => {
    it('manages drag-over classes on dragenter, dragover and dragleave', () => {
      const { bridge } = createFakeBridge();

      act(() => {
        root.render(
          <MapDropZone bridge={bridge}>
            <div data-testid="stage">Stage content</div>
          </MapDropZone>,
        );
      });

      const zone = container.querySelector('.map-drop-zone')!;
      expect(zone.classList.contains('drag-over')).toBe(false);

      act(() => {
        zone.dispatchEvent(new Event('dragenter', { bubbles: true, cancelable: true }));
      });
      expect(zone.classList.contains('drag-over')).toBe(true);

      act(() => {
        zone.dispatchEvent(new Event('dragleave', { bubbles: true, cancelable: true }));
      });
      expect(zone.classList.contains('drag-over')).toBe(false);
    });

    it('rejects non-project drop with toast when work exists', () => {
      const projectWithWork = makeProject({
        anchors: [{ id: 'a1', px: [10, 10], ll: [0, 0], source: 'paste' } as Anchor],
      });
      const { bridge } = createFakeBridge(makeSession(projectWithWork));
      const toasts: string[] = [];

      act(() => {
        root.render(
          <MapDropZone bridge={bridge} showToast={(m) => toasts.push(m)}>
            <div>Stage</div>
          </MapDropZone>,
        );
      });

      const zone = container.querySelector('.map-drop-zone')!;
      const dropEvent = new Event('drop', { bubbles: true, cancelable: true });
      const fakeFile = new File(['image data'], 'park.png', { type: 'image/png' });
      Object.defineProperty(dropEvent, 'dataTransfer', {
        value: { files: [fakeFile] },
      });

      act(() => {
        zone.dispatchEvent(dropEvent);
      });

      expect(toasts).toContain(REPLACE_MAP_HINT_MESSAGE);
    });

    it('allows drop of .trailmaker even when work exists', async () => {
      const projectWithWork = makeProject({
        anchors: [{ id: 'a1', px: [10, 10], ll: [0, 0], source: 'paste' } as Anchor],
      });
      const { bridge, sessions } = createFakeBridge(makeSession(projectWithWork));

      vi.spyOn(projectModule, 'deserializeProjectAsync').mockResolvedValue({
        project: makeProject({ name: 'New Project' }),
        image: { bytes: new Uint8Array([1, 2]), mimeType: 'image/png' },
      });
      vi.spyOn(imageModule, 'loadImageFile').mockResolvedValue(makeMap(makeProject()));

      act(() => {
        root.render(
          <MapDropZone bridge={bridge}>
            <div>Stage</div>
          </MapDropZone>,
        );
      });

      const zone = container.querySelector('.map-drop-zone')!;
      const dropEvent = new Event('drop', { bubbles: true, cancelable: true });
      const fakeFile = new File(['zip'], 'new.trailmaker', { type: 'application/octet-stream' });
      Object.defineProperty(dropEvent, 'dataTransfer', {
        value: { files: [fakeFile] },
      });

      await act(async () => {
        zone.dispatchEvent(dropEvent);
        await new Promise((r) => setTimeout(r, 20));
      });

      expect(sessions).toHaveLength(1);
      expect(sessions[0]?.project.name).toBe('New Project');
    });

    it('initializes useAutosave on mount and reports storage unavailable if getDb fails', async () => {
      const { bridge } = createFakeBridge();
      const toasts: string[] = [];
      const ensureSpy = vi.spyOn(autosaveModule, 'ensureAutosave').mockReturnValue(() => {});
      const getDbSpy = vi.spyOn(autosaveModule, 'getDb').mockRejectedValue(new Error('IDB blocked'));

      await act(async () => {
        root.render(
          <MapDropZone bridge={bridge} showToast={(m) => toasts.push(m)}>
            <div>Stage</div>
          </MapDropZone>,
        );
      });

      await act(async () => {
        await new Promise((r) => setTimeout(r, 10));
      });

      expect(ensureSpy).toHaveBeenCalled();
      expect(getDbSpy).toHaveBeenCalled();
      expect(toasts).toContain(autosaveModule.STORAGE_UNAVAILABLE_MESSAGE);
    });
  });

  describe('usePasteToOpen', () => {
    function PasteHost({ bridge }: { bridge: SessionBridge }) {
      usePasteToOpen({ bridge });
      return <div>Paste Host</div>;
    }

    it('opens pasted image when no work exists', async () => {
      const { bridge, sessions } = createFakeBridge(null);
      vi.spyOn(imageModule, 'loadImageFile').mockResolvedValue(makeMap(makeProject()));

      act(() => {
        root.render(<PasteHost bridge={bridge} />);
      });

      const file = new File(['img'], 'Pasted map.png', { type: 'image/png' });
      const pasteEvent = new Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(pasteEvent, 'clipboardData', {
        value: {
          items: [
            {
              type: 'image/png',
              getAsFile: () => file,
            },
          ],
        },
      });

      await act(async () => {
        window.dispatchEvent(pasteEvent);
      });

      expect(sessions).toHaveLength(1);
    });

    it('ignores pasted image when work exists', async () => {
      const projectWithWork = makeProject({
        anchors: [{ id: 'a1', px: [10, 10], ll: [0, 0], source: 'paste' } as Anchor],
      });
      const { bridge, sessions } = createFakeBridge(makeSession(projectWithWork));

      act(() => {
        root.render(<PasteHost bridge={bridge} />);
      });

      const file = new File(['img'], 'Pasted map.png', { type: 'image/png' });
      const pasteEvent = new Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(pasteEvent, 'clipboardData', {
        value: {
          items: [{ type: 'image/png', getAsFile: () => file }],
        },
      });

      await act(async () => {
        window.dispatchEvent(pasteEvent);
      });

      expect(sessions).toHaveLength(0);
    });
  });

  describe('PdfPagePicker', () => {
    it('returns null if map is not a PDF with > 1 page', () => {
      const proj = makeProject();
      const { bridge } = createFakeBridge(makeSession(proj));

      act(() => {
        root.render(<PdfPagePicker bridge={bridge} />);
      });

      expect(container.querySelector('.page-picker')).toBeNull();
    });

    it('renders page options for multi-page PDF', () => {
      const proj = makeProject();
      const pdfMap: LoadedMap = {
        ...makeMap(proj),
        meta: { ...proj.image, source: { kind: 'pdf', page: 1, pageCount: 3, renderScale: 1 } },
        pdf: {
          pageCount: 3,
          renderPage: vi.fn(),
        },
      };
      const { bridge } = createFakeBridge({ project: proj, map: pdfMap });

      act(() => {
        root.render(<PdfPagePicker bridge={bridge} />);
      });

      const select = container.querySelector('select')!;
      expect(select).not.toBeNull();
      expect(select.getAttribute('aria-label')).toBe('Page');
      expect(select.options).toHaveLength(3);
      expect(select.value).toBe('1');
    });

    it('confirms and switches page, clearing anchors/features while keeping project name', async () => {
      const projWithWork = makeProject({
        name: 'My Park',
        anchors: [{ id: 'a1', px: [1, 1], ll: [0, 0], source: 'paste' } as Anchor],
        features: [{ id: 'f1', name: 'Trail', color: '#f00', notes: '', kind: 'trail', pts: [[0, 0], [1, 1]], ink: null } as Feature],
      });

      const newMap: LoadedMap = {
        ...makeMap(projWithWork),
        meta: { ...projWithWork.image, source: { kind: 'pdf', page: 2, pageCount: 3, renderScale: 1 } },
      };

      const renderPageMock = vi.fn().mockResolvedValue(newMap);
      const pdfMap: LoadedMap = {
        ...makeMap(projWithWork),
        meta: { ...projWithWork.image, source: { kind: 'pdf', page: 1, pageCount: 3, renderScale: 1 } },
        pdf: {
          pageCount: 3,
          renderPage: renderPageMock,
        },
      };

      const { bridge, sessions } = createFakeBridge({ project: projWithWork, map: pdfMap });
      const confirmMock = vi.fn().mockReturnValue(true);

      act(() => {
        root.render(<PdfPagePicker bridge={bridge} confirmFn={confirmMock} />);
      });

      const select = container.querySelector('select')!;

      await act(async () => {
        select.value = '2';
        select.dispatchEvent(new Event('change', { bubbles: true }));
      });

      expect(confirmMock).toHaveBeenCalledWith(PAGE_CHANGE_CONFIRM_MESSAGE);
      expect(renderPageMock).toHaveBeenCalledWith(2);
      expect(sessions).toHaveLength(1);
      expect(sessions[0]?.project.name).toBe('My Park');
      expect(sessions[0]?.project.anchors).toHaveLength(0);
      expect(sessions[0]?.project.features).toHaveLength(0);
    });

    it('aborts page switch when confirmation is declined', async () => {
      const projWithWork = makeProject({
        anchors: [{ id: 'a1', px: [1, 1], ll: [0, 0], source: 'paste' } as Anchor],
      });

      const renderPageMock = vi.fn();
      const pdfMap: LoadedMap = {
        ...makeMap(projWithWork),
        meta: { ...projWithWork.image, source: { kind: 'pdf', page: 1, pageCount: 2, renderScale: 1 } },
        pdf: {
          pageCount: 2,
          renderPage: renderPageMock,
        },
      };

      const { bridge, sessions } = createFakeBridge({ project: projWithWork, map: pdfMap });
      const confirmMock = vi.fn().mockReturnValue(false);

      act(() => {
        root.render(<PdfPagePicker bridge={bridge} confirmFn={confirmMock} />);
      });

      const select = container.querySelector('select')!;

      await act(async () => {
        select.value = '2';
        select.dispatchEvent(new Event('change', { bubbles: true }));
      });

      expect(confirmMock).toHaveBeenCalled();
      expect(renderPageMock).not.toHaveBeenCalled();
      expect(sessions).toHaveLength(0);
      expect(select.value).toBe('1');
    });
  });

  describe('SaveProjectButton', () => {
    it('is disabled when no session exists', () => {
      const { bridge } = createFakeBridge(null);

      act(() => {
        root.render(<SaveProjectButton bridge={bridge} />);
      });

      const btn = container.querySelector('button')!;
      expect(btn.disabled).toBe(true);
      expect(btn.getAttribute('aria-label')).toBe('Save project');
    });

    it('serializes project and triggers download when clicked', async () => {
      const proj = makeProject({ name: 'Pine Valley' });
      const { bridge } = createFakeBridge(makeSession(proj));

      const downloadSpy = vi.spyOn(downloadModule, 'downloadBlob').mockResolvedValue(true);
      const serializeSpy = vi.spyOn(projectModule, 'serializeProjectAsync').mockResolvedValue(new Uint8Array([5, 6, 7]));
      const toasts: string[] = [];

      act(() => {
        root.render(<SaveProjectButton bridge={bridge} showToast={(m) => toasts.push(m)} />);
      });

      const btn = container.querySelector('button')!;
      expect(btn.disabled).toBe(false);

      await act(async () => {
        btn.click();
        await new Promise((r) => setTimeout(r, 20));
      });

      expect(serializeSpy).toHaveBeenCalled();
      expect(downloadSpy).toHaveBeenCalledWith('pine-valley.trailmaker', expect.any(Blob));
      expect(toasts).toContain('Saved pine-valley.trailmaker');
    });
  });

  describe('OpenProjectButton', () => {
    it('has accessible name and hidden input accepting .trailmaker and .json', () => {
      const { bridge } = createFakeBridge();

      act(() => {
        root.render(<OpenProjectButton bridge={bridge} />);
      });

      const btn = container.querySelector('button')!;
      const input = container.querySelector('input[type="file"]')!;

      expect(btn.getAttribute('aria-label')).toBe('Open project');
      expect(input.getAttribute('accept')).toBe('.trailmaker,.json');
    });
  });

  describe('EmptyState', () => {
    it('renders drop area with icon, copy and OpenMapButton when no session is open', () => {
      const { bridge } = createFakeBridge(null);

      act(() => {
        root.render(<EmptyState bridge={bridge} resumeSlot={<button>Resume last</button>} />);
      });

      expect(container.querySelector('#empty')).not.toBeNull();
      expect(container.querySelector('h3')?.textContent).toBe('Drop a park map here');
      expect(container.querySelector('p')?.textContent).toContain('PNG, JPG, WebP or PDF');
      expect(container.querySelector('#openBtn2')).not.toBeNull();
      expect(container.querySelector('#resume')?.textContent).toBe('Resume last');
    });

    it('returns null when a session is active', () => {
      const { bridge } = createFakeBridge(makeSession(makeProject()));

      act(() => {
        root.render(<EmptyState bridge={bridge} />);
      });

      expect(container.querySelector('#empty')).toBeNull();
    });

    it('renders ResumePrompt by default when resumeSlot is omitted and autosave is available', async () => {
      const savedProj = makeProject({ name: 'Pine Peak', features: [] });
      const savedBlob = new Blob(['map'], { type: 'image/png' });
      vi.spyOn(autosaveModule, 'readAutosave').mockResolvedValue({
        project: savedProj,
        image: savedBlob,
      });

      const { bridge } = createFakeBridge(null);

      await act(async () => {
        root.render(<EmptyState bridge={bridge} />);
      });

      expect(container.querySelector('#resume')).not.toBeNull();
      expect(container.querySelector('#resumeBtn')).not.toBeNull();
      expect(container.querySelector('#resumeBtn')?.textContent).toContain('Resume “Pine Peak”');
    });
  });

  describe('ResumePrompt', () => {
    it('formats resume button text with singular and plural items', () => {
      const dt = '2026-09-25T14:30:00.000Z';
      const when = formatResumeDate(dt);

      expect(formatResumeButtonText('Pine Valley', 1, dt)).toBe(`Resume “Pine Valley” (1 item, ${when})`);
      expect(formatResumeButtonText('Pine Valley', 5, dt)).toBe(`Resume “Pine Valley” (5 items, ${when})`);
      expect(formatResumeButtonText('Pine Valley', 0, dt)).toBe(`Resume “Pine Valley” (0 items, ${when})`);
    });

    it('returns null if there is no saved autosave data', async () => {
      vi.spyOn(autosaveModule, 'readAutosave').mockResolvedValue(null);
      const { bridge } = createFakeBridge(null);

      await act(async () => {
        root.render(<ResumePrompt bridge={bridge} />);
      });

      expect(container.querySelector('#resume')).toBeNull();
      expect(container.querySelector('#resumeBtn')).toBeNull();
    });

    it('returns null if a session is already active', async () => {
      const savedProj = makeProject({ name: 'Active Park' });
      vi.spyOn(autosaveModule, 'readAutosave').mockResolvedValue({
        project: savedProj,
        image: new Blob(['bytes']),
      });
      const { bridge } = createFakeBridge(makeSession(makeProject()));

      await act(async () => {
        root.render(<ResumePrompt bridge={bridge} />);
      });

      expect(container.querySelector('#resume')).toBeNull();
    });

    it('restores image session on resume button click', async () => {
      const feature: Feature = {
        id: 'f1',
        name: 'Ridge Trail',
        color: '#e63946',
        notes: '',
        kind: 'trail',
        pts: [
          [10, 10],
          [20, 20],
        ],
        ink: null,
      };
      const savedProj = makeProject({
        name: 'Ridge Park',
        features: [feature],
      });
      const savedBlob = new Blob(['image bytes'], { type: 'image/png' });
      vi.spyOn(autosaveModule, 'readAutosave').mockResolvedValue({
        project: savedProj,
        image: savedBlob,
      });

      const fakeMap = makeMap(savedProj);
      vi.spyOn(imageModule, 'loadImageFile').mockResolvedValue(fakeMap);

      const { bridge } = createFakeBridge(null);
      const busyStates: (string | null)[] = [];
      const toasts: string[] = [];

      await act(async () => {
        root.render(
          <ResumePrompt
            bridge={bridge}
            setBusy={(b) => busyStates.push(b)}
            showToast={(m) => toasts.push(m)}
          />
        );
      });

      const btn = container.querySelector('#resumeBtn') as HTMLButtonElement;
      expect(btn).not.toBeNull();
      expect(btn.textContent).toContain('Resume “Ridge Park” (1 item');

      await act(async () => {
        btn.click();
      });

      expect(busyStates).toContain('Resuming session...');
      expect(busyStates[busyStates.length - 1]).toBeNull();
      expect(bridge.getSession()).not.toBeNull();
      expect(bridge.getSession()?.project.name).toBe('Ridge Park');
      expect(bridge.getSession()?.project.features).toHaveLength(1);
      expect(bridge.getSession()?.project.features[0]?.name).toBe('Ridge Trail');
    });

    it('restores PDF session on resume button click with correct page', async () => {
      const savedProj = makeProject({
        name: 'PDF Park',
        image: {
          fileName: 'park.pdf',
          width: 800,
          height: 600,
          originalWidth: 800,
          originalHeight: 600,
          source: { kind: 'pdf', page: 2, pageCount: 3, renderScale: 1 },
          sha256: 'pdfsha256',
        },
      });
      const savedBlob = new Blob(['pdf bytes'], { type: 'application/pdf' });
      vi.spyOn(autosaveModule, 'readAutosave').mockResolvedValue({
        project: savedProj,
        image: savedBlob,
      });

      const fakePdfMap = makeMap(savedProj);
      const loadPdfSpy = vi.spyOn(pdfModule, 'loadPdfFile').mockResolvedValue(fakePdfMap);

      const { bridge } = createFakeBridge(null);

      await act(async () => {
        root.render(<ResumePrompt bridge={bridge} />);
      });

      const btn = container.querySelector('#resumeBtn') as HTMLButtonElement;
      expect(btn).not.toBeNull();

      await act(async () => {
        btn.click();
      });

      expect(loadPdfSpy).toHaveBeenCalledWith(savedBlob, 'park.pdf', 2);
      expect(bridge.getSession()?.project.name).toBe('PDF Park');
    });

    it('shows toast when restoration fails', async () => {
      const savedProj = makeProject({ name: 'Broken Park' });
      vi.spyOn(autosaveModule, 'readAutosave').mockResolvedValue({
        project: savedProj,
        image: new Blob(['corrupt']),
      });
      vi.spyOn(imageModule, 'loadImageFile').mockRejectedValue(new Error('Corrupt image'));

      const { bridge } = createFakeBridge(null);
      const toasts: string[] = [];

      await act(async () => {
        root.render(<ResumePrompt bridge={bridge} showToast={(m) => toasts.push(m)} />);
      });

      const btn = container.querySelector('#resumeBtn') as HTMLButtonElement;
      expect(btn).not.toBeNull();

      await act(async () => {
        btn.click();
      });

      expect(toasts).toContain(RESUME_FAILED_MESSAGE);
    });
  });

  describe('Accessibility of Lane C file controls (card T-311)', () => {
    it('provides accessible names and hides hidden inputs from keyboard/assistive tech', async () => {
      const { bridge } = createFakeBridge(null);

      await act(async () => {
        root.render(
          <div>
            <OpenMapButton bridge={bridge} id="mapBtn" label="Open image or PDF" />
            <OpenProjectButton bridge={bridge} id="projBtn" label="Open project" />
            <SaveProjectButton bridge={bridge} id="saveBtn" label="Save project" />
          </div>,
        );
      });

      const mapBtn = container.querySelector('#mapBtn') as HTMLButtonElement;
      const projBtn = container.querySelector('#projBtn') as HTMLButtonElement;
      const saveBtn = container.querySelector('#saveBtn') as HTMLButtonElement;

      // Accessible names
      expect(mapBtn.getAttribute('aria-label')).toBe('Open image or PDF');
      expect(projBtn.getAttribute('aria-label')).toBe('Open project');
      expect(saveBtn.getAttribute('aria-label')).toBe('Save project');
      expect(saveBtn.disabled).toBe(true);

      // Hidden file inputs are not keyboard-accessible (tabindex=-1, aria-hidden=true)
      const inputs = container.querySelectorAll('input[type="file"]');
      expect(inputs.length).toBe(2);
      inputs.forEach((input) => {
        expect(input.getAttribute('tabindex')).toBe('-1');
        expect(input.getAttribute('aria-hidden')).toBe('true');
      });
    });

    it('MapDropZone and EmptyState have accessible regions and landmarks', async () => {
      const { bridge } = createFakeBridge(null);

      await act(async () => {
        root.render(
          <MapDropZone bridge={bridge}>
            <EmptyState bridge={bridge} />
          </MapDropZone>,
        );
      });

      const dropZone = container.querySelector('.map-drop-zone');
      expect(dropZone?.getAttribute('role')).toBe('region');
      expect(dropZone?.getAttribute('aria-label')).toBe('Map drop zone');

      const empty = container.querySelector('#empty');
      expect(empty?.getAttribute('aria-label')).toBe('Empty map stage');

      const svg = empty?.querySelector('svg');
      expect(svg?.getAttribute('aria-hidden')).toBe('true');
    });

    it('PdfPagePicker has accessible label and keyboard-operable select', async () => {
      const proj = makeProject({
        image: {
          fileName: 'map.pdf',
          width: 800,
          height: 600,
          originalWidth: 800,
          originalHeight: 600,
          source: { kind: 'pdf', page: 1, pageCount: 3, renderScale: 1 },
          sha256: 'h1',
        },
      });
      const pdfMap: LoadedMap = {
        ...makeMap(proj),
        meta: { ...proj.image, source: { kind: 'pdf', page: 1, pageCount: 3, renderScale: 1 } },
        pdf: {
          pageCount: 3,
          renderPage: vi.fn(),
        },
      };
      const { bridge } = createFakeBridge({ project: proj, map: pdfMap });

      await act(async () => {
        root.render(<PdfPagePicker bridge={bridge} />);
      });

      const select = container.querySelector('select');
      expect(select).not.toBeNull();
      expect(select?.getAttribute('aria-label')).toBe('Page');

      const label = container.querySelector('label');
      expect(label).not.toBeNull();
      expect(label?.getAttribute('for')).toBe(select?.id);
    });
  });
});
