// Lane C. Image loading, resolution capping, EXIF orientation and raster extraction.
import type { MapImage, RasterImage } from '../core/types';
import { MAX_WORKING_SIDE } from '../core/types';
import type { LoadedMap } from '../ui/contract';

export const SUPPORTED_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.avif'] as const;

export const SUPPORTED_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
  'image/gif',
  'image/bmp',
  'image/x-ms-bmp',
  'image/avif',
]);

export const UNSUPPORTED_FILE_TYPE_MESSAGE = "That file type isn't supported. Use PNG, JPG, WebP or PDF.";
export const DECODE_FAILURE_MESSAGE = "That image couldn't be read. Try exporting it as PNG or JPG.";

export interface WorkingDimensions {
  readonly width: number;
  readonly height: number;
  readonly originalWidth: number;
  readonly originalHeight: number;
  readonly scaled: boolean;
}

/** Check if a Blob or File is an accepted bitmap image. */
export function isSupportedImage(file: Blob | { readonly name?: string; readonly type?: string }): boolean {
  if (file.type && SUPPORTED_MIME_TYPES.has(file.type.toLowerCase())) {
    return true;
  }
  const name = 'name' in file && typeof file.name === 'string' ? file.name.toLowerCase() : '';
  return /\.(png|jpe?g|webp|gif|bmp|avif)$/i.test(name);
}

/** Calculate working raster dimensions capped at maxSide, preserving aspect ratio. */
export function calculateWorkingDimensions(
  originalWidth: number,
  originalHeight: number,
  maxSide = MAX_WORKING_SIDE
): WorkingDimensions {
  const maxDim = Math.max(originalWidth, originalHeight);
  const k = Math.min(1, maxSide / maxDim);
  const width = Math.max(1, Math.round(originalWidth * k));
  const height = Math.max(1, Math.round(originalHeight * k));
  return {
    width,
    height,
    originalWidth,
    originalHeight,
    scaled: k < 1,
  };
}

/** Parse EXIF orientation tag from an APP1 marker payload. */
export function parseExifOrientation(bytes: Uint8Array, offset: number, length: number): number | undefined {
  if (length < 14) return undefined;
  // Must start with 'Exif\0\0'
  if (
    bytes[offset] !== 0x45 ||
    bytes[offset + 1] !== 0x78 ||
    bytes[offset + 2] !== 0x69 ||
    bytes[offset + 3] !== 0x66 ||
    bytes[offset + 4] !== 0x00 ||
    bytes[offset + 5] !== 0x00
  ) {
    return undefined;
  }

  const tiff = offset + 6;
  const tiffEnd = offset + length;
  if (tiff + 8 > tiffEnd) return undefined;

  const isLE = bytes[tiff] === 0x49 && bytes[tiff + 1] === 0x49;
  const isBE = bytes[tiff] === 0x4d && bytes[tiff + 1] === 0x4d;
  if (!isLE && !isBE) return undefined;

  const readU16 = (pos: number): number => {
    if (pos + 2 > tiffEnd) return 0;
    const b0 = bytes[pos]!;
    const b1 = bytes[pos + 1]!;
    return isLE ? b0 | (b1 << 8) : (b0 << 8) | b1;
  };

  const readU32 = (pos: number): number => {
    if (pos + 4 > tiffEnd) return 0;
    const b0 = bytes[pos]!;
    const b1 = bytes[pos + 1]!;
    const b2 = bytes[pos + 2]!;
    const b3 = bytes[pos + 3]!;
    return isLE
      ? (b0 | (b1 << 8) | (b2 << 16) | (b3 << 24)) >>> 0
      : ((b0 << 24) | (b1 << 16) | (b2 << 8) | b3) >>> 0;
  };

  if (readU16(tiff + 2) !== 42) return undefined;

  const ifdOffset = readU32(tiff + 4);
  const ifd0 = tiff + ifdOffset;
  if (ifd0 + 2 > tiffEnd) return undefined;

  const numEntries = readU16(ifd0);
  for (let i = 0; i < numEntries; i++) {
    const entry = ifd0 + 2 + i * 12;
    if (entry + 12 > tiffEnd) break;
    const tag = readU16(entry);
    if (tag === 0x0112) {
      const orientation = readU16(entry + 8);
      if (orientation >= 1 && orientation <= 8) {
        return orientation;
      }
    }
  }

  return undefined;
}

/** Parse image dimensions from file header without allocating full decoded pixel buffer. */
export function parseImageHeaderDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 10) return null;

  // PNG: bytes 16..23 contain 32-bit big-endian width and height
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    if (bytes.length >= 24) {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const width = view.getUint32(16, false);
      const height = view.getUint32(20, false);
      if (width > 0 && height > 0) return { width, height };
    }
  }

  // GIF: bytes 6..9 contain 16-bit little-endian width and height
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const width = view.getUint16(6, true);
    const height = view.getUint16(8, true);
    if (width > 0 && height > 0) return { width, height };
  }

  // BMP: bytes 18..25 contain 32-bit little-endian width and height
  if (bytes[0] === 0x42 && bytes[1] === 0x4d && bytes.length >= 26) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const width = Math.abs(view.getInt32(18, true));
    const height = Math.abs(view.getInt32(22, true));
    if (width > 0 && height > 0) return { width, height };
  }

  // JPEG: scan markers for APP1 (EXIF) and SOF0..SOF15
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    let rawWidth: number | undefined;
    let rawHeight: number | undefined;
    let orientation = 1;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    while (offset < bytes.length - 8) {
      if (bytes[offset] !== 0xff) {
        offset++;
        continue;
      }
      const marker = bytes[offset + 1];
      if (marker === undefined) break;

      // Standalone markers without length
      if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
        offset += 2;
        continue;
      }

      // SOS (Start of Scan): image entropy stream begins, all headers are parsed
      if (marker === 0xda) {
        break;
      }

      if (offset + 4 > bytes.length) break;
      const length = view.getUint16(offset + 2, false);

      // APP1 marker (EXIF)
      if (marker === 0xe1 && offset + 4 <= bytes.length) {
        const orient = parseExifOrientation(bytes, offset + 4, length - 2);
        if (orient !== undefined) {
          orientation = orient;
        }
      }

      // SOF markers
      if (
        marker === 0xc0 ||
        marker === 0xc1 ||
        marker === 0xc2 ||
        marker === 0xc3 ||
        marker === 0xc5 ||
        marker === 0xc6 ||
        marker === 0xc7 ||
        marker === 0xc9 ||
        marker === 0xca ||
        marker === 0xcb ||
        marker === 0xcd ||
        marker === 0xce ||
        marker === 0xcf
      ) {
        if (offset + 9 <= bytes.length) {
          rawHeight = view.getUint16(offset + 5, false);
          rawWidth = view.getUint16(offset + 7, false);
        }
      }

      offset += 2 + length;
    }

    if (rawWidth !== undefined && rawHeight !== undefined && rawWidth > 0 && rawHeight > 0) {
      const swaps = orientation >= 5 && orientation <= 8;
      return {
        width: swaps ? rawHeight : rawWidth,
        height: swaps ? rawWidth : rawHeight,
      };
    }
  }

  // WebP: RIFF ... WEBP
  if (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes.length >= 30 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    const chunkHeader = String.fromCharCode(bytes[12] ?? 0, bytes[13] ?? 0, bytes[14] ?? 0, bytes[15] ?? 0);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (chunkHeader === 'VP8 ' && bytes.length >= 30) {
      // 14 bits width, 14 bits height
      const width = (view.getUint16(26, true) & 0x3fff);
      const height = (view.getUint16(28, true) & 0x3fff);
      if (width > 0 && height > 0) return { width, height };
    } else if (chunkHeader === 'VP8L' && bytes.length >= 25) {
      const b1 = bytes[21] ?? 0;
      const b2 = bytes[22] ?? 0;
      const b3 = bytes[23] ?? 0;
      const b4 = bytes[24] ?? 0;
      const width = 1 + (((b2 & 0x3f) << 8) | b1);
      const height = 1 + (((b4 & 0x0f) << 10) | (b3 << 2) | ((b2 & 0xc0) >> 6));
      if (width > 0 && height > 0) return { width, height };
    } else if (chunkHeader === 'VP8X' && bytes.length >= 30) {
      const width = 1 + (bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16));
      const height = 1 + (bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16));
      if (width > 0 && height > 0) return { width, height };
    }
  }

  return null;
}

/** Decode an image Blob into an ImageBitmap or HTMLImageElement. */
async function decodeImageSource(
  file: Blob,
  targetWidth?: number,
  targetHeight?: number
): Promise<ImageBitmap | HTMLImageElement> {
  // Primary path: createImageBitmap with EXIF orientation
  if (typeof createImageBitmap === 'function') {
    try {
      const options: ImageBitmapOptions = {
        imageOrientation: 'from-image',
      };
      if (targetWidth !== undefined && targetHeight !== undefined) {
        options.resizeWidth = targetWidth;
        options.resizeHeight = targetHeight;
        options.resizeQuality = 'high';
      }
      return await createImageBitmap(file, options);
    } catch {
      // Fall through to HTMLImageElement
    }
  }

  // Fallback: HTMLImageElement
  if (typeof Image !== 'undefined' && typeof URL !== 'undefined') {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        resolve(img);
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error(DECODE_FAILURE_MESSAGE));
      };
      img.src = url;
    });
  }

  throw new Error(DECODE_FAILURE_MESSAGE);
}

/** Helper to draw an image source onto a white background canvas and get ImageBitmap + ImageData. */
async function renderToWhiteCanvas(
  source: ImageBitmap | HTMLImageElement,
  width: number,
  height: number
): Promise<{ display: ImageBitmap; raster: RasterImage }> {
  // Yield to event loop so decode and render don't combine into one long task > 50ms
  await new Promise((resolve) => setTimeout(resolve, 0));

  // Use OffscreenCanvas if available
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error(DECODE_FAILURE_MESSAGE);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(source, 0, 0, width, height);

    // Yield before large pixel buffer readback if image is large (> 2M pixels)
    if (width * height > 2_000_000) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    let rasterData: Uint8ClampedArray;
    if (width * height > 4_000_000 && height >= 4) {
      // Chunked readback into 4 bands to stay under 50ms per task (T-313 acceptance 2)
      const bands = 4;
      const bandH = Math.ceil(height / bands);
      rasterData = new Uint8ClampedArray(width * height * 4);
      for (let b = 0; b < bands; b++) {
        const y = b * bandH;
        const h = Math.min(bandH, height - y);
        if (h <= 0) break;
        if (b > 0) {
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
        const band = ctx.getImageData(0, y, width, h);
        rasterData.set(band.data, y * width * 4);
      }
    } else {
      const imageData = ctx.getImageData(0, 0, width, height);
      rasterData = imageData.data;
    }

    await new Promise((resolve) => setTimeout(resolve, 0));

    const display = canvas.transferToImageBitmap
      ? canvas.transferToImageBitmap()
      : await createImageBitmap(canvas);

    return {
      display,
      raster: {
        width,
        height,
        data: rasterData,
      },
    };
  }

  // Fallback to DOM canvas
  if (typeof document !== 'undefined') {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error(DECODE_FAILURE_MESSAGE);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(source, 0, 0, width, height);

    if (width * height > 2_000_000) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    let rasterData: Uint8ClampedArray;
    if (width * height > 4_000_000 && height >= 4) {
      const bands = 4;
      const bandH = Math.ceil(height / bands);
      rasterData = new Uint8ClampedArray(width * height * 4);
      for (let b = 0; b < bands; b++) {
        const y = b * bandH;
        const h = Math.min(bandH, height - y);
        if (h <= 0) break;
        if (b > 0) {
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
        const band = ctx.getImageData(0, y, width, h);
        rasterData.set(band.data, y * width * 4);
      }
    } else {
      const imageData = ctx.getImageData(0, 0, width, height);
      rasterData = imageData.data;
    }

    await new Promise((resolve) => setTimeout(resolve, 0));

    const display = typeof createImageBitmap === 'function'
      ? await createImageBitmap(canvas)
      : (canvas as unknown as ImageBitmap);

    return {
      display,
      raster: {
        width,
        height,
        data: rasterData,
      },
    };
  }

  throw new Error('Canvas rendering is not supported in this environment');
}

/** Infer MIME type from file or filename. */
export function inferImageMimeType(file: Blob, fileName: string): string {
  if (file.type && file.type.startsWith('image/')) {
    return file.type;
  }
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.bmp')) return 'image/bmp';
  if (lower.endsWith('.avif')) return 'image/avif';
  return 'image/png';
}

/**
 * Load and process a user's image file safely:
 * - verifies supported type;
 * - caps working resolution at MAX_WORKING_SIDE;
 * - composites transparent pixels onto a white background;
 * - hashes original bytes via SHA-256;
 * - returns LoadedMap.
 */
export async function loadImageFile(file: Blob, fileName: string): Promise<LoadedMap> {
  if (!isSupportedImage(file) && !isSupportedImage({ name: fileName, type: file.type })) {
    throw new Error(UNSUPPORTED_FILE_TYPE_MESSAGE);
  }

  const mimeType = inferImageMimeType(file, fileName);
  const arrayBuffer = await file.arrayBuffer();
  const fileBytes = new Uint8Array(arrayBuffer);

  // Yield before SHA-256 computation to ensure large arrayBuffer allocation doesn't combine with crypto task
  await new Promise((resolve) => setTimeout(resolve, 0));

  // Compute SHA-256
  const hashBuf = await crypto.subtle.digest('SHA-256', fileBytes);
  const sha256 = Array.from(new Uint8Array(hashBuf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  // Yield before image decode
  await new Promise((resolve) => setTimeout(resolve, 0));

  // Determine original dimensions (header parsing prevents high memory allocation for huge images)
  const headerDims = parseImageHeaderDimensions(fileBytes);
  let originalWidth = headerDims?.width;
  let originalHeight = headerDims?.height;

  let decoded: ImageBitmap | HTMLImageElement;

  if (originalWidth !== undefined && originalHeight !== undefined) {
    const dims = calculateWorkingDimensions(originalWidth, originalHeight);
    if (dims.scaled) {
      // Decode directly at scaled working resolution to prevent full-size RGBA buffer allocation
      try {
        decoded = await decodeImageSource(file, dims.width, dims.height);
      } catch {
        decoded = await decodeImageSource(file);
      }
    } else {
      decoded = await decodeImageSource(file);
    }
  } else {
    // Header parsing did not yield dimensions; decode to read natural dimensions
    try {
      decoded = await decodeImageSource(file);
    } catch (err) {
      throw new Error(err instanceof Error && err.message === DECODE_FAILURE_MESSAGE ? err.message : DECODE_FAILURE_MESSAGE);
    }
    originalWidth = 'naturalWidth' in decoded ? decoded.naturalWidth : decoded.width;
    originalHeight = 'naturalHeight' in decoded ? decoded.naturalHeight : decoded.height;
  }

  // When not scaled during decode, decoded source provides browser-authoritative oriented dimensions
  const decodedWidth = 'naturalWidth' in decoded ? decoded.naturalWidth : decoded.width;
  const decodedHeight = 'naturalHeight' in decoded ? decoded.naturalHeight : decoded.height;
  if (
    originalWidth === undefined ||
    originalHeight === undefined ||
    !calculateWorkingDimensions(originalWidth, originalHeight).scaled
  ) {
    originalWidth = decodedWidth;
    originalHeight = decodedHeight;
  }

  const dims = calculateWorkingDimensions(originalWidth, originalHeight);

  // Composite onto white background and extract working raster and display ImageBitmap
  const { display, raster } = await renderToWhiteCanvas(decoded, dims.width, dims.height);

  const cleanFileName = fileName.replace(/\.[^.]+$/, '') || 'map';

  const meta: MapImage = {
    fileName: cleanFileName,
    width: dims.width,
    height: dims.height,
    originalWidth: dims.originalWidth,
    originalHeight: dims.originalHeight,
    source: { kind: 'image', mimeType },
    sha256,
  };

  return {
    meta,
    display,
    raster,
    original: file,
    pdf: null,
  };
}
