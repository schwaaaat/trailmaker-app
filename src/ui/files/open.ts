import { deserializeProjectAsync, importPrototypeJson, newProject } from '../../core/project';
import { parseGpx } from '../../io/gpx';
import { clearActiveGpx, loadGpxBlob, setActiveGpx } from '../../io/gpxStorage';
import { loadImageFile, isSupportedImage } from '../../io/image';
import { loadPdfFile } from '../../io/pdf';
import { restoreTiledProjectMap } from '../../io/tile-raster';
import { sessionBridge } from '../../state/bridge';
import { setBusy as storeSetBusy, showToast as storeShowToast } from '../../state/store';
import type { LoadedMap, Session, SessionBridge } from '../contract';

export const UNSUPPORTED_FILE_MESSAGE =
  'That file type isn’t supported. Use PNG, JPG, WebP or PDF.';
export const REPLACE_MAP_HINT_MESSAGE = 'Use “Open image or PDF” to replace the current map.';

/** Formats a project name as a URL- and filename-safe slug. Matches prototype slug(). */
export function slug(name: string): string {
  return (
    (name || 'park-map')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'park-map'
  );
}

/** Returns true if the open session contains anchors or traced features. Matches prototype hasWork(). */
export function hasWork(session: Session | null): boolean {
  if (!session) return false;
  return session.project.anchors.length > 0 || session.project.features.length > 0;
}

export interface OpenFileOptions {
  readonly bridge?: SessionBridge | undefined;
  readonly showToast?: ((msg: string) => void) | undefined;
  readonly setBusy?: ((text: string | null) => void) | undefined;
  readonly deserializeProject?: typeof deserializeProjectAsync | undefined;
}

/** Reads a Blob as an ArrayBuffer, using blob.arrayBuffer() with FileReader fallback for environments like jsdom. */
export async function blobToArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === 'function') {
    try {
      return await blob.arrayBuffer();
    } catch {
      // Fallback to FileReader
    }
  }
  return new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error || new Error('Failed to read blob'));
    reader.readAsArrayBuffer(blob);
  });
}

/** Reads a Blob as text, using blob.text() with FileReader fallback for environments like jsdom. */
export async function blobToText(blob: Blob): Promise<string> {
  if (typeof blob.text === 'function') {
    try {
      return await blob.text();
    } catch {
      // Fallback to FileReader
    }
  }
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error || new Error('Failed to read text'));
    reader.readAsText(blob);
  });
}

/**
 * Routes an incoming Blob/File to the appropriate loader:
 * - .trailmaker -> deserializeProjectAsync
 * - .json -> importPrototypeJson
 * - PDF -> loadPdfFile
 * - Image -> loadImageFile
 * - Other -> prototype error toast
 */
export async function openFileBlob(
  file: Blob,
  fileName: string,
  options: OpenFileOptions = {},
): Promise<boolean> {
  const bridge = options.bridge ?? sessionBridge;
  const showToast = options.showToast ?? storeShowToast;
  const setBusy = options.setBusy ?? storeSetBusy;

  const name = (fileName || '').toLowerCase();

  try {
    setBusy('Opening file...');

    if (name.endsWith('.trailmaker')) {
      const buffer = await blobToArrayBuffer(file);
      const deserialize = options.deserializeProject ?? deserializeProjectAsync;
      const { project, image, gpxBytes, tiles } = await deserialize(new Uint8Array(buffer));
      const imageBlob = new Blob([image.bytes as unknown as BlobPart], { type: image.mimeType });
      let map: LoadedMap;
      if (project.image.source.kind === 'tiles') {
        map = await restoreTiledProjectMap(project.image, imageBlob, tiles);
      } else if (project.image.source.kind === 'pdf') {
        map = await loadPdfFile(imageBlob, project.image.fileName, project.image.source.page);
      } else {
        map = await loadImageFile(imageBlob, project.image.fileName);
      }
      if (gpxBytes && gpxBytes.length > 0) {
        try {
          const gpxText = new TextDecoder().decode(gpxBytes);
          const parsed = parseGpx(gpxText, 'imported.gpx', gpxBytes.byteLength);
          if (parsed.ok) {
            setActiveGpx({
              fileName: parsed.fileName,
              points: parsed.points,
              tracks: parsed.tracks,
              totalPointsInFile: parsed.totalPointsInFile,
              wasDecimated: parsed.wasDecimated,
              notice: parsed.notice,
              rawGpx: parsed.rawGpx,
            });
          } else {
            clearActiveGpx();
          }
        } catch {
          clearActiveGpx();
        }
      } else {
        clearActiveGpx();
      }
      bridge.openSession({ project, map });
      showToast(
        map.meta.source.kind === 'tiles' && !map.tiles
          ? 'Project opened with its overview. To work offline at full detail, download the tiles again from Capture satellite.'
          : 'Project opened',
      );
      return true;
    }

    if (name.endsWith('.json') || file.type === 'application/json') {
      const text = await blobToText(file);
      const { project, image } = await importPrototypeJson(text);
      const imageBlob = new Blob([image.bytes as unknown as BlobPart], { type: image.mimeType });
      let map: LoadedMap;
      if (project.image.source.kind === 'pdf') {
        map = await loadPdfFile(imageBlob, project.image.fileName, project.image.source.page);
      } else {
        map = await loadImageFile(imageBlob, project.image.fileName);
      }
      clearActiveGpx();
      bridge.openSession({ project, map });
      showToast('Project opened');
      return true;
    }

    if (name.endsWith('.pdf') || file.type === 'application/pdf') {
      const map = await loadPdfFile(file, fileName, 1);
      const baseName = fileName.replace(/\.[^.]+$/, '') || 'Park map';
      const project = newProject(map.meta, baseName, new Date().toISOString());
      clearActiveGpx();
      bridge.openSession({ project, map });
      return true;
    }

    if (
      file.type.startsWith('image/') ||
      isSupportedImage(file) ||
      /\.(png|jpe?g|webp|gif|bmp|avif)$/i.test(name)
    ) {
      const map = await loadImageFile(file, fileName);
      const baseName = fileName.replace(/\.[^.]+$/, '') || 'Park map';
      const project = newProject(map.meta, baseName, new Date().toISOString());
      clearActiveGpx();
      bridge.openSession({ project, map });
      return true;
    }

    if (name.endsWith('.gpx') || file.type === 'application/gpx+xml') {
      const current = bridge.getSession();
      if (!current) {
        showToast('Open a map image or PDF first, then import your GPX.');
        return false;
      }
      const res = await loadGpxBlob(file, fileName);
      if (res.ok) {
        showToast(res.notice || `Imported ${res.points.length} GPX points from "${fileName}".`);
        return true;
      } else {
        showToast(res.error);
        return false;
      }
    }

    showToast(UNSUPPORTED_FILE_MESSAGE);
    return false;
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Couldn’t open that file.';
    showToast(message);
    return false;
  } finally {
    setBusy(null);
  }
}
