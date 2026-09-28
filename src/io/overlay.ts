// Lane C. KMZ overlay JPEG encoder.
import type { LoadedMap } from '../ui/contract';

/**
 * Encode the working map into a JPEG suitable for a KMZ GroundOverlay:
 * - scales so the longest side is <= maxSide;
 * - composites onto white;
 * - uses OffscreenCanvas where available.
 */
export async function encodeOverlayJpeg(
  map: LoadedMap,
  maxSide = 4096,
  quality = 0.86
): Promise<Uint8Array> {
  const maxDim = Math.max(map.meta.width, map.meta.height);
  const k = Math.min(1, maxSide / maxDim);
  const w = Math.max(1, Math.round(map.meta.width * k));
  const h = Math.max(1, Math.round(map.meta.height * k));

  // OffscreenCanvas (Worker or modern main thread)
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Could not create OffscreenCanvas 2D context for overlay');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(map.display, 0, 0, w, h);
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
    return new Uint8Array(await blob.arrayBuffer());
  }

  // DOM Canvas fallback
  if (typeof document !== 'undefined') {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Could not create Canvas 2D context for overlay');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(map.display, 0, 0, w, h);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', quality)
    );
    if (!blob) throw new Error('Failed to encode overlay JPEG blob');
    return new Uint8Array(await blob.arrayBuffer());
  }

  throw new Error('Canvas is not available in the current environment');
}
