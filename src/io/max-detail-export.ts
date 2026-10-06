import type { DetailExportFetchResponse } from './max-detail-downloader';
import { detailExportTiles, DETAIL_TILE_SIZE, type DetailExportCell } from './max-detail-planner';
import { MARTIN_TILE_MAPSERVER_URL } from './tile-service';
import { putTileRecord } from './tile-store';

export interface LocalDetailTile {
  readonly x: number;
  readonly y: number;
  readonly col: number;
  readonly row: number;
  readonly exportCol: number;
  readonly exportRow: number;
}

export interface DetailMapExtent {
  /** Level-0 world pixel origin at source.z (normally z20). */
  readonly origin: { readonly x: number; readonly y: number };
  readonly sourceZoom: number;
  readonly width: number;
  readonly height: number;
  readonly tileSize: number;
}

export function buildDetailExportUrl(
  cell: DetailExportCell,
  serviceUrl = MARTIN_TILE_MAPSERVER_URL,
): URL {
  const url = new URL(`${serviceUrl.replace(/\/+$/, '')}/export`);
  url.search = new URLSearchParams({
    bbox: cell.bbox3857.join(','),
    bboxSR: '3857',
    imageSR: '3857',
    size: `${cell.width},${cell.height}`,
    format: 'jpg',
    f: 'image',
  }).toString();
  return url;
}

export async function fetchDetailExportBlob(
  cell: DetailExportCell,
  signal: AbortSignal,
  serviceUrl = MARTIN_TILE_MAPSERVER_URL,
  fetchImage: typeof fetch = fetch,
): Promise<DetailExportFetchResponse<Blob>> {
  const response = await fetchImage(buildDetailExportUrl(cell, serviceUrl), {
    mode: 'cors',
    cache: 'no-store',
    signal,
  });
  const retryAfter = response.headers.get('Retry-After');
  if (!response.ok) return { ok: false, status: response.status, retryAfter };

  const blob = await response.blob();
  if (!blob.type.startsWith('image/')) {
    const body = await blob.text();
    let message = 'The county export service did not return an image.';
    try {
      const parsed = JSON.parse(body) as {
        error?: { message?: string; details?: readonly string[] };
      };
      message =
        [parsed.error?.message, ...(parsed.error?.details ?? [])].filter(Boolean).join(' ') ||
        message;
    } catch {
      if (body.trim()) message = body.trim().slice(0, 300);
    }
    return { ok: false, status: 400, retryAfter, error: message };
  }
  return { ok: true, status: response.status, value: blob };
}

export function detailExportLocalTiles(
  cell: DetailExportCell,
  extent: DetailMapExtent,
): readonly LocalDetailTile[] {
  if (
    !Number.isInteger(extent.tileSize) ||
    extent.tileSize !== DETAIL_TILE_SIZE ||
    extent.sourceZoom !== 20 ||
    extent.width <= 0 ||
    extent.height <= 0
  ) {
    throw new Error('Maximum-detail export requires a z20 map with a valid 256px tile extent.');
  }
  const originCol = (extent.origin.x * 2) / extent.tileSize;
  const originRow = (extent.origin.y * 2) / extent.tileSize;
  if (!Number.isInteger(originCol) || !Number.isInteger(originRow)) {
    throw new Error('Tiled-map origin must align to the cached imagery tile grid.');
  }
  const cols = Math.ceil((extent.width * 2) / extent.tileSize);
  const rows = Math.ceil((extent.height * 2) / extent.tileSize);
  return detailExportTiles(cell)
    .map((tile) => ({
      x: tile.x,
      y: tile.y,
      exportCol: tile.col,
      exportRow: tile.row,
      col: tile.x - originCol,
      row: tile.y - originRow,
    }))
    .filter((tile) => tile.col >= 0 && tile.row >= 0 && tile.col < cols && tile.row < rows);
}

function createTileCanvas(): {
  readonly canvas: HTMLCanvasElement | OffscreenCanvas;
  readonly context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
} {
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(DETAIL_TILE_SIZE, DETAIL_TILE_SIZE);
    const context = canvas.getContext('2d');
    if (context) return { canvas, context };
  }
  if (typeof document !== 'undefined') {
    const canvas = document.createElement('canvas');
    canvas.width = DETAIL_TILE_SIZE;
    canvas.height = DETAIL_TILE_SIZE;
    const context = canvas.getContext('2d');
    if (context) return { canvas, context };
  }
  throw new Error('Canvas rendering is not supported in this environment.');
}

async function encodeJpeg(canvas: HTMLCanvasElement | OffscreenCanvas): Promise<Blob> {
  if ('convertToBlob' in canvas && typeof canvas.convertToBlob === 'function') {
    return canvas.convertToBlob({ type: 'image/jpeg', quality: 0.92 });
  }
  return new Promise<Blob>((resolve, reject) => {
    (canvas as HTMLCanvasElement).toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('Could not encode maximum-detail tile.'))),
      'image/jpeg',
      0.92,
    );
  });
}

export async function storeDetailExportBlob(
  mapId: string,
  cell: DetailExportCell,
  extent: DetailMapExtent,
  blob: Blob,
): Promise<void> {
  if (!mapId) throw new Error('A tiled map id is required to store maximum-detail imagery.');
  if (typeof createImageBitmap !== 'function') {
    throw new Error('This browser cannot decode maximum-detail exports.');
  }
  const bitmap = await createImageBitmap(blob);
  try {
    if (bitmap.width !== cell.width || bitmap.height !== cell.height) {
      throw new Error(
        `The county export returned ${bitmap.width}×${bitmap.height}; expected ${cell.width}×${cell.height}.`,
      );
    }
    const { canvas, context } = createTileCanvas();
    const tiles = detailExportLocalTiles(cell, extent);
    if (!tiles.length) {
      throw new Error('The maximum-detail export does not overlap the tiled map boundary.');
    }
    for (const tile of tiles) {
      context.clearRect(0, 0, DETAIL_TILE_SIZE, DETAIL_TILE_SIZE);
      context.drawImage(
        bitmap,
        tile.exportCol * DETAIL_TILE_SIZE,
        tile.exportRow * DETAIL_TILE_SIZE,
        DETAIL_TILE_SIZE,
        DETAIL_TILE_SIZE,
        0,
        0,
        DETAIL_TILE_SIZE,
        DETAIL_TILE_SIZE,
      );
      await putTileRecord(mapId, -1, tile.col, tile.row, await encodeJpeg(canvas));
    }
  } finally {
    bitmap.close();
  }
}
