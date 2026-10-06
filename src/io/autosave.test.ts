// @vitest-environment jsdom
import { Blob as NodeBlob } from 'node:buffer';
globalThis.Blob = NodeBlob as unknown as typeof Blob;
if (typeof window !== 'undefined') {
  window.Blob = NodeBlob as unknown as typeof Blob;
}

import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerMigration, resetMigrations } from '../core/project';
import type { Session, SessionBridge } from '../ui/contract';
import { makeMap, makeProject, makeSession } from '../state/fixtures.test.helper';
import {
  clearAutosave,
  DB_NAME,
  DB_VERSION,
  ensureAutosave,
  getDb,
  readAutosave,
  resetAutosaveForTests,
  startAutosave,
  stopAutosave,
  STORAGE_UNAVAILABLE_MESSAGE,
  STORE_NAME,
} from './autosave';
import { clearActiveGpx, setActiveGpx } from './gpxStorage';

function createFakeBridge(initialSession: Session | null = null): {
  bridge: SessionBridge;
  setSession: (s: Session | null) => void;
} {
  let current = initialSession;
  const listeners = new Set<(s: Session | null) => void>();

  const bridge: SessionBridge = {
    getSession: () => current,
    openSession: (s) => {
      current = s;
      listeners.forEach((l) => l(current));
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };

  return {
    bridge,
    setSession: (s) => {
      current = s;
      listeners.forEach((l) => l(current));
    },
  };
}

async function flushAsyncWork(ms = 850): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setImmediate(r));
  }
}

describe('T-305 IndexedDB autosave (with fake-indexeddb)', () => {
  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
    resetAutosaveForTests();
    clearActiveGpx({ silent: true });
    resetMigrations();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });

  afterEach(async () => {
    resetAutosaveForTests();
    clearActiveGpx({ silent: true });
    resetMigrations();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('creates database trailmaker with version 1 and object store kv', async () => {
    const db = await getDb();
    expect(db.name).toBe(DB_NAME);
    expect(db.version).toBe(DB_VERSION);
    expect(db.objectStoreNames.contains(STORE_NAME)).toBe(true);
  });

  it('debounces saves by 800ms and saves both project and image on first save', async () => {
    const { bridge, setSession } = createFakeBridge();
    const toasts: string[] = [];
    const stop = startAutosave(bridge, { showToast: (m) => toasts.push(m) });

    const session = makeSession(makeProject({ name: 'Pine Valley' }));
    setSession(session);

    // Before 800ms, nothing should be saved
    await vi.advanceTimersByTimeAsync(400);
    let data = await readAutosave();
    expect(data).toBeNull();

    // Advance past 800ms
    await flushAsyncWork(450);

    data = await readAutosave();
    expect(data).not.toBeNull();
    expect(data?.project.name).toBe('Pine Valley');
    expect(data?.image).toBeInstanceOf(Blob);

    stop();
  });

  it('coalesces multiple rapid edits into one save after 800ms', async () => {
    const { bridge, setSession } = createFakeBridge();
    const stop = startAutosave(bridge);

    const s1 = makeSession(makeProject({ name: 'Edit 1' }));
    const s2 = makeSession(makeProject({ name: 'Edit 2' }));
    const s3 = makeSession(makeProject({ name: 'Edit 3 (Final)' }));

    setSession(s1);
    await vi.advanceTimersByTimeAsync(200);

    setSession(s2);
    await vi.advanceTimersByTimeAsync(200);

    setSession(s3);
    await flushAsyncWork(850);

    const data = await readAutosave();
    expect(data?.project.name).toBe('Edit 3 (Final)');

    stop();
  });

  it('rewrites the image only when meta.sha256 changes', async () => {
    const { bridge, setSession } = createFakeBridge();
    const stop = startAutosave(bridge);

    const originalBlob1 = new Blob(['image1 bytes'], { type: 'image/png' });
    const p1 = makeProject({
      name: 'Trail A',
      image: {
        fileName: 'map1',
        width: 100,
        height: 100,
        originalWidth: 100,
        originalHeight: 100,
        source: { kind: 'image', mimeType: 'image/png' },
        sha256: 'aaaabbbbcccc1111',
      },
    });
    const s1: Session = {
      project: p1,
      map: {
        ...makeMap(p1),
        original: originalBlob1,
      },
    };

    const putSpy = vi.spyOn(IDBObjectStore.prototype, 'put');

    setSession(s1);
    await flushAsyncWork(850);

    // Initial save writes project, image, image_sha256 (3 puts)
    expect(putSpy).toHaveBeenCalledTimes(3);

    // Second edit on same map (e.g. rename project, same sha256)
    const p2 = { ...p1, name: 'Trail A Renamed' };
    const s2: Session = {
      project: p2,
      map: s1.map,
    };

    setSession(s2);
    await flushAsyncWork(850);

    // Only project should be rewritten (+1 put = 4 total)
    expect(putSpy).toHaveBeenCalledTimes(4);

    // Third edit with a DIFFERENT image sha256
    const originalBlob2 = new Blob(['image2 bytes'], { type: 'image/png' });
    const p3 = makeProject({
      name: 'Trail B',
      image: {
        fileName: 'map2',
        width: 100,
        height: 100,
        originalWidth: 100,
        originalHeight: 100,
        source: { kind: 'image', mimeType: 'image/png' },
        sha256: 'ddddffff22223333',
      },
    });
    const s3: Session = {
      project: p3,
      map: {
        ...makeMap(p3),
        original: originalBlob2,
      },
    };

    setSession(s3);
    await flushAsyncWork(850);

    // Both project, image, and sha256 rewritten (+3 puts = 7 total)
    expect(putSpy).toHaveBeenCalledTimes(7);

    stop();
  });

  it('flushes immediately on visibilitychange to hidden', async () => {
    const { bridge, setSession } = createFakeBridge();
    const stop = startAutosave(bridge);

    const session = makeSession(makeProject({ name: 'Hidden Flush Park' }));
    setSession(session);

    // Only 100ms passed (less than 800ms debounce)
    await vi.advanceTimersByTimeAsync(100);

    // Trigger visibilitychange with hidden state
    Object.defineProperty(document, 'visibilityState', {
      value: 'hidden',
      writable: true,
      configurable: true,
    });
    document.dispatchEvent(new Event('visibilitychange'));

    await flushAsyncWork(10);

    const data = await readAutosave();
    expect(data?.project.name).toBe('Hidden Flush Park');

    stop();
  });

  it('flushes immediately on pagehide event', async () => {
    const { bridge, setSession } = createFakeBridge();
    const stop = startAutosave(bridge);

    const session = makeSession(makeProject({ name: 'Pagehide Park' }));
    setSession(session);

    await vi.advanceTimersByTimeAsync(200);

    // Dispatch pagehide
    window.dispatchEvent(new Event('pagehide'));
    await flushAsyncWork(10);

    const data = await readAutosave();
    expect(data?.project.name).toBe('Pagehide Park');

    stop();
  });

  it('clearAutosave clears saved data from the database', async () => {
    const { bridge, setSession } = createFakeBridge();
    const stop = startAutosave(bridge);

    setSession(makeSession(makeProject({ name: 'To be cleared' })));
    await flushAsyncWork(850);

    let data = await readAutosave();
    expect(data).not.toBeNull();

    await clearAutosave();
    data = await readAutosave();
    expect(data).toBeNull();

    stop();
  });

  it('restores a saved project from an older schema version via registered migration', async () => {
    // Register fake migration from version 0 to 1
    registerMigration(0, (raw) => ({
      ...raw,
      version: 1,
      name: `${String(raw.name)} (migrated)`,
    }));

    const olderProject = {
      ...makeProject({ name: 'Old Schema Park' }),
      version: 0,
    };

    const db = await getDb();
    await db.put(STORE_NAME, olderProject, 'project');
    await db.put(STORE_NAME, new Blob(['bytes']), 'image');

    const restored = await readAutosave();
    expect(restored).not.toBeNull();
    expect(restored?.project.version).toBe(4);
    expect(restored?.project.name).toBe('Old Schema Park (migrated)');
  });

  it('handles unavailable storage (private browsing / SecurityError) with a single non-blocking notice', async () => {
    vi.spyOn(globalThis.indexedDB, 'open').mockImplementation(() => {
      throw new DOMException('Storage is restricted', 'SecurityError');
    });

    const { bridge, setSession } = createFakeBridge();
    const toasts: string[] = [];
    const stop = startAutosave(bridge, { showToast: (m) => toasts.push(m) });

    // Should not throw unhandled rejection
    setSession(makeSession(makeProject({ name: 'Private Mode' })));
    await flushAsyncWork(850);

    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toBe(STORAGE_UNAVAILABLE_MESSAGE);

    // Subsequent changes should not toast again (single notice)
    setSession(makeSession(makeProject({ name: 'Private Mode 2' })));
    await flushAsyncWork(850);
    expect(toasts).toHaveLength(1);

    // readAutosave returns null and does not double-toast
    const data = await readAutosave({ showToast: (m) => toasts.push(m) });
    expect(data).toBeNull();
    expect(toasts).toHaveLength(1);

    stop();
  });

  it('handles read failure when storage is unavailable with a non-blocking notice', async () => {
    vi.spyOn(globalThis.indexedDB, 'open').mockImplementation(() => {
      throw new DOMException('Storage is restricted', 'SecurityError');
    });

    const toasts: string[] = [];
    const data = await readAutosave({ showToast: (m) => toasts.push(m) });
    expect(data).toBeNull();
    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toBe(STORAGE_UNAVAILABLE_MESSAGE);
  });

  it('handles quota exceeded errors gracefully with a single non-blocking notice', async () => {
    const { bridge, setSession } = createFakeBridge();
    const toasts: string[] = [];
    const stop = startAutosave(bridge, { showToast: (m) => toasts.push(m) });

    // Pre-initialize db
    await getDb();
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(() => {
      throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    });

    setSession(makeSession(makeProject({ name: 'Quota Park' })));
    await flushAsyncWork(850);

    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toBe(STORAGE_UNAVAILABLE_MESSAGE);

    stop();
  });

  it('ensureAutosave and stopAutosave manages singleton lifecycle', async () => {
    const { bridge, setSession } = createFakeBridge();
    const toasts: string[] = [];

    const stop1 = ensureAutosave(bridge, { showToast: (m) => toasts.push(m) });
    const stop2 = ensureAutosave(bridge, { showToast: (m) => toasts.push(m) });

    setSession(makeSession(makeProject({ name: 'Singleton Park' })));
    await flushAsyncWork(850);

    const data = await readAutosave();
    expect(data?.project.name).toBe('Singleton Park');

    stop1();
    // After stop1, stop2 is still active
    setSession(makeSession(makeProject({ name: 'Singleton Park 2' })));
    await flushAsyncWork(850);
    const data2 = await readAutosave();
    expect(data2?.project.name).toBe('Singleton Park 2');

    stop2();
    stopAutosave();
  });

  it('migrates v1 autosave to version 4 upon reading', async () => {
    const db = await getDb();
    const v1Proj = { ...makeProject({ name: 'V1 Autosaved Park' }), version: 1 };
    await db.put(STORE_NAME, JSON.stringify(v1Proj), 'project');
    await db.put(STORE_NAME, new Blob(['bytes'], { type: 'image/png' }), 'image');

    const restored = await readAutosave();
    expect(restored).not.toBeNull();
    expect(restored?.project.version).toBe(4);
    expect(restored?.project.name).toBe('V1 Autosaved Park');
  });

  it('saving an opened v1 project writes version 4 into IndexedDB autosave', async () => {
    const db = await getDb();
    const v1Proj = { ...makeProject({ name: 'V1 Resave Park' }), version: 1 };
    await db.put(STORE_NAME, JSON.stringify(v1Proj), 'project');
    await db.put(STORE_NAME, new Blob(['bytes'], { type: 'image/png' }), 'image');

    const restored = await readAutosave();
    expect(restored?.project.version).toBe(4);

    const { bridge, setSession } = createFakeBridge();
    const stop = startAutosave(bridge);

    setSession(makeSession(restored!.project));
    await flushAsyncWork(850);

    const savedProject = await db.get(STORE_NAME, 'project');
    expect(savedProject.version).toBe(4);
    expect(savedProject.name).toBe('V1 Resave Park');

    stop();
  });

  it('schedules autosave write on GPX import and clears on GPX removal without session bridge edits', async () => {
    const { bridge, setSession } = createFakeBridge();
    const stop = startAutosave(bridge);

    const session = makeSession(makeProject({ name: 'GPX Autosave Trail' }));
    setSession(session);
    await flushAsyncWork(850);

    let saved = await readAutosave();
    expect(saved?.project.name).toBe('GPX Autosave Trail');
    expect(saved?.gpx).toBeNull();

    // 1. Import GPX: setActiveGpx schedules autosave without bridge.openSession / setSession
    const gpxLayer = {
      fileName: 'survey.gpx',
      points: [
        { id: 'wpt-1', name: 'Trailhead Marker', ll: [38.5971, -78.3952] as [number, number], kind: 'wpt' as const },
      ],
      tracks: [],
      totalPointsInFile: 1,
      wasDecimated: false,
    };
    setActiveGpx(gpxLayer);

    // Before debounce fires, not saved yet
    await vi.advanceTimersByTimeAsync(400);
    saved = await readAutosave();
    expect(saved?.gpx).toBeNull();

    // After debounce fires
    await flushAsyncWork(450);
    saved = await readAutosave();
    expect(saved?.gpx).not.toBeNull();
    expect(saved?.gpx?.fileName).toBe('survey.gpx');
    expect(saved?.gpx?.points).toHaveLength(1);
    expect(saved?.gpx?.points[0]?.name).toBe('Trailhead Marker');

    // 2. Removal: clearActiveGpx schedules autosave clear without bridge.openSession / setSession
    clearActiveGpx();

    // Before debounce fires, still present
    await vi.advanceTimersByTimeAsync(400);
    saved = await readAutosave();
    expect(saved?.gpx?.fileName).toBe('survey.gpx');

    // After debounce fires, imported_gpx is cleared
    await flushAsyncWork(450);
    saved = await readAutosave();
    expect(saved?.gpx).toBeNull();
    expect(saved?.project.name).toBe('GPX Autosave Trail');

    stop();
  });
});
