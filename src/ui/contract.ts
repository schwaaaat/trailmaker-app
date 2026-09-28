// UI CONTRACT (DOM-bound). Architect-owned like src/core/types.ts (DECISIONS D-005).
// Cross-lane interfaces that need browser types and so cannot live in src/core.
// Implementers: SessionBridge + TestHook -> Lane B (src/state); LoadedMap producers -> Lane C (src/io).
import type { MapImage, Project, Px, RasterImage } from '../core/types';

/** A map opened in the browser, ready to display and trace. Produced by src/io loaders. */
export interface LoadedMap {
  /** Metadata; meta.width/height match display and raster. */
  readonly meta: MapImage;
  /** Working-resolution bitmap for the canvas editor. */
  readonly display: ImageBitmap;
  /**
   * Working-resolution RGBA pixels. Transferred to the worker exactly once
   * (WorkerApi.loadImage); main-thread code must not read it afterwards.
   */
  readonly raster: RasterImage;
  /** Original file bytes, kept for autosave, project files and the KMZ overlay. */
  readonly original: Blob;
  /** Present when the map came from a PDF: lets the page picker load another page. */
  readonly pdf: {
    /** Number of pages. */
    readonly pageCount: number;
    /** Render another page (1-based) of the same document as a new LoadedMap. */
    renderPage(page: number): Promise<LoadedMap>;
  } | null;
}

/** The open map plus the project traced over it. */
export interface Session {
  /** Project data (the undoable document). */
  readonly project: Project;
  /** The loaded map. */
  readonly map: LoadedMap;
}

/**
 * How src/io talks to the app state without importing the store's internals.
 * Lane B exports an instance as `sessionBridge` from src/state/bridge.ts.
 */
export interface SessionBridge {
  /** Current session, or null before a map is opened. */
  getSession(): Session | null;
  /** Called after every project or map change (including undo/redo). Returns an unsubscribe function. */
  subscribe(listener: (session: Session | null) => void): () => void;
  /** Replace the whole session (open file, restore autosave, open project). Clears undo history. */
  openSession(session: Session): void;
}

/**
 * Test hook for Playwright. Installed on window.__trailmaker when import.meta.env.DEV
 * or import.meta.env.MODE === 'test'; never in production builds.
 */
export interface TestHook {
  /** The session bridge. */
  readonly session: SessionBridge;
  /** Map a working-raster pixel to CSS client coordinates of the editor canvas (for clicking fixtures). */
  imageToClient(px: Px): { x: number; y: number };
  /** Resolves when no worker job is running. */
  idle(): Promise<void>;
}

declare global {
  interface Window {
    /** See TestHook. */
    __trailmaker?: TestHook;
  }
}
