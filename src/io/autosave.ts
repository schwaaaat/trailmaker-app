// Lane C. IndexedDB autosave and session restore (card T-305).
import { openDB, type IDBPDatabase } from 'idb';
import { migrateProject } from '../core/project';
import type { Project } from '../core/types';
import type { Session, SessionBridge } from '../ui/contract';
import { sessionBridge } from '../state/bridge';
import { showToast as storeShowToast } from '../state/store';
import {
  clearActiveGpx,
  getActiveGpx,
  subscribeActiveGpx,
  type StoredGpxLayer,
} from './gpxStorage';

interface ActiveAutosaveController {
  cancelPending(): void;
}

const activeAutosaveControllers = new Set<ActiveAutosaveController>();

export const DB_NAME = 'trailmaker';
export const DB_VERSION = 1;
export const STORE_NAME = 'kv';
export const DEFAULT_DEBOUNCE_MS = 800;

export const STORAGE_UNAVAILABLE_MESSAGE =
  'Autosave is unavailable. Your work will not be saved automatically.';

export interface AutosaveOptions {
  readonly debounceMs?: number;
  readonly showToast?: (msg: string) => void;
}

let dbPromise: Promise<IDBPDatabase> | null = null;
let notifiedStorageUnavailable = false;

/** Open or reuse the versioned IndexedDB database. */
export async function getDb(): Promise<IDBPDatabase> {
  if (typeof indexedDB === 'undefined') {
    throw new Error('IndexedDB is not available');
  }
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME);
        }
      },
    }).catch((err) => {
      dbPromise = null;
      throw err;
    });
  }
  return dbPromise;
}

/** Shows the one-time non-blocking storage unavailable notice. */
export function notifyStorageUnavailable(showToast: (msg: string) => void = storeShowToast): void {
  if (!notifiedStorageUnavailable) {
    notifiedStorageUnavailable = true;
    showToast(STORAGE_UNAVAILABLE_MESSAGE);
  }
}

export interface RestoredAutosave {
  readonly project: Project;
  readonly image: Blob;
  readonly gpx?: StoredGpxLayer | null;
}

/**
 * Reads the autosaved project and its original map image from IndexedDB.
 * Returns null if no autosaved session exists or if storage is unavailable.
 * Runs migrateProject so older project versions are migrated.
 * Notifies storage unavailable if reading fails.
 */
export async function readAutosave(
  options?: AutosaveOptions,
): Promise<RestoredAutosave | null> {
  const showToast = options?.showToast ?? storeShowToast;
  try {
    const db = await getDb();
    const rawProject = await db.get(STORE_NAME, 'project');
    const rawImage = await db.get(STORE_NAME, 'image');
    const rawGpx = (await db.get(STORE_NAME, 'imported_gpx')) as StoredGpxLayer | undefined;

    if (!rawProject || !rawImage) {
      return null;
    }

    const parsed = typeof rawProject === 'string' ? JSON.parse(rawProject) : rawProject;
    const project = migrateProject(parsed);

    let image: Blob;
    if (rawImage instanceof Blob) {
      image = rawImage;
    } else if (rawImage instanceof Uint8Array || rawImage instanceof ArrayBuffer) {
      const mimeType =
        project.image.source.kind === 'image'
          ? project.image.source.mimeType
          : 'application/pdf';
      image = new Blob([rawImage as unknown as BlobPart], { type: mimeType });
    } else {
      return null;
    }

    return { project, image, gpx: rawGpx ?? null };
  } catch {
    notifyStorageUnavailable(showToast);
    return null;
  }
}

/** Clears any autosaved session data from IndexedDB. */
export async function clearAutosave(): Promise<void> {
  try {
    for (const ctrl of activeAutosaveControllers) {
      ctrl.cancelPending();
    }
    const db = await getDb();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.done.catch(() => undefined);
    await Promise.all([
      tx.objectStore(STORE_NAME).delete('project'),
      tx.objectStore(STORE_NAME).delete('image'),
      tx.objectStore(STORE_NAME).delete('image_sha256'),
      tx.objectStore(STORE_NAME).delete('imported_gpx'),
      tx.done,
    ]);
    clearActiveGpx({ silent: true });
  } catch {
    // Storage unavailable: catch without unhandled rejection
  }
}

/**
 * Subscribes to the session bridge and debounces autosaves to IndexedDB (default 800 ms).
 * Flushes on visibilitychange (hidden) and pagehide.
 * Rewrites the image only when meta.sha256 changes.
 * Returns an unsubscription function.
 */
export function startAutosave(
  bridge: SessionBridge = sessionBridge,
  options: AutosaveOptions = {},
): () => void {
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const showToast = options.showToast ?? storeShowToast;

  let timer: ReturnType<typeof setTimeout> | null = null;
  let pendingSession: Session | null = null;
  let lastSavedSha256: string | null = null;
  let isSaving = false;
  let queuedSave = false;

  async function performSave(session: Session): Promise<void> {
    if (isSaving) {
      queuedSave = true;
      pendingSession = session;
      return;
    }
    isSaving = true;

    try {
      const db = await getDb();
      const currentSha256 = session.map.meta.sha256;

      if (lastSavedSha256 === null) {
        const storedSha = await db.get(STORE_NAME, 'image_sha256');
        if (typeof storedSha === 'string' && storedSha) {
          lastSavedSha256 = storedSha;
        }
      }

      const needsImageWrite = lastSavedSha256 !== currentSha256;

      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.done.catch(() => undefined);
      const store = tx.objectStore(STORE_NAME);

      await store.put(session.project, 'project');
      if (needsImageWrite) {
        await store.put(session.map.original, 'image');
        await store.put(currentSha256, 'image_sha256');
      }

      const activeGpx = getActiveGpx();
      if (activeGpx) {
        await store.put(activeGpx, 'imported_gpx');
      } else {
        await store.delete('imported_gpx');
      }
      await tx.done;

      lastSavedSha256 = currentSha256;
    } catch {
      notifyStorageUnavailable(showToast);
    } finally {
      isSaving = false;
      if (queuedSave && pendingSession) {
        queuedSave = false;
        const next = pendingSession;
        pendingSession = null;
        void performSave(next);
      }
    }
  }

  function flush(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (pendingSession !== null) {
      const session = pendingSession;
      pendingSession = null;
      void performSave(session);
    }
  }

  const controller: ActiveAutosaveController = {
    cancelPending: () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      pendingSession = null;
    },
  };
  activeAutosaveControllers.add(controller);

  function scheduleSave(session: Session): void {
    pendingSession = session;
    if (timer !== null) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      timer = null;
      flush();
    }, debounceMs);
  }

  const unsubscribeBridge = bridge.subscribe((session) => {
    if (!session) {
      return;
    }
    scheduleSave(session);
  });

  const unsubscribeGpx = subscribeActiveGpx(() => {
    const session = bridge.getSession();
    if (!session) {
      return;
    }
    scheduleSave(session);
  });

  const onVisibilityChange = () => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
      flush();
    }
  };

  const onPageHide = () => {
    flush();
  };

  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibilityChange);
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', onPageHide);
  }

  return () => {
    activeAutosaveControllers.delete(controller);
    unsubscribeBridge();
    unsubscribeGpx();
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onVisibilityChange);
    }
    if (typeof window !== 'undefined') {
      window.removeEventListener('pagehide', onPageHide);
    }
  };
}

let activeAutosaveStop: (() => void) | null = null;
let activeAutosaveCount = 0;

/** Ensures autosave is running across app lifetime. */
export function ensureAutosave(
  bridge: SessionBridge = sessionBridge,
  options?: AutosaveOptions,
): () => void {
  if (!activeAutosaveStop) {
    activeAutosaveStop = startAutosave(bridge, options);
  }
  activeAutosaveCount++;
  return () => {
    activeAutosaveCount = Math.max(0, activeAutosaveCount - 1);
    if (activeAutosaveCount === 0 && activeAutosaveStop) {
      activeAutosaveStop();
      activeAutosaveStop = null;
    }
  };
}

/** Stops the singleton autosave listener. */
export function stopAutosave(): void {
  activeAutosaveCount = 0;
  if (activeAutosaveStop) {
    activeAutosaveStop();
    activeAutosaveStop = null;
  }
}

/** Resets all internal autosave state for test isolation. */
export function resetAutosaveForTests(): void {
  stopAutosave();
  activeAutosaveControllers.clear();
  notifiedStorageUnavailable = false;
  if (dbPromise) {
    void dbPromise.then((db) => db.close()).catch(() => undefined);
    dbPromise = null;
  }
}
