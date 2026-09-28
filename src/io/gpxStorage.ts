// Lane C. Active imported GPX layer state and helpers (card T-312).
import { blobToText } from '../ui/files/open';
import { parseGpx, type GpxParseResult, type GpxPoint, type GpxTrackSegment } from './gpx';

export interface StoredGpxLayer {
  readonly fileName: string;
  readonly points: readonly GpxPoint[];
  readonly tracks: readonly GpxTrackSegment[];
  readonly totalPointsInFile: number;
  readonly wasDecimated: boolean;
  readonly notice?: string | undefined;
  readonly rawGpx?: string | undefined;
}

let activeGpxLayer: StoredGpxLayer | null = null;
const listeners = new Set<(layer: StoredGpxLayer | null) => void>();

export function getActiveGpx(): StoredGpxLayer | null {
  return activeGpxLayer;
}

export interface SetActiveGpxOptions {
  readonly silent?: boolean;
}

export function setActiveGpx(
  layer: StoredGpxLayer | null,
  options?: SetActiveGpxOptions,
): void {
  activeGpxLayer = layer;
  if (options?.silent) {
    return;
  }
  for (const listener of listeners) {
    try {
      listener(activeGpxLayer);
    } catch {
      // Ignore listener errors
    }
  }
}

export function subscribeActiveGpx(listener: (layer: StoredGpxLayer | null) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function clearActiveGpx(options?: SetActiveGpxOptions): void {
  setActiveGpx(null, options);
}

/**
 * Load and parse a GPX file Blob, setting it as active GPX if successful.
 */
export async function loadGpxBlob(
  blob: Blob,
  fileName = 'imported.gpx',
): Promise<GpxParseResult | { ok: false; error: string }> {
  try {
    const text = await blobToText(blob);
    const result = parseGpx(text, fileName, blob.size);
    if (result.ok) {
      setActiveGpx({
        fileName: result.fileName,
        points: result.points,
        tracks: result.tracks,
        totalPointsInFile: result.totalPointsInFile,
        wasDecimated: result.wasDecimated,
        notice: result.notice,
        rawGpx: result.rawGpx,
      });
    }
    return result;
  } catch (err) {
    return {
      ok: false,
      error: `Could not read GPX file: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
