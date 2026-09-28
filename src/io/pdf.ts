// Lane C. PDF loader (pdfjs-dist, page rendering, offline worker).
import type { PDFDocumentProxy } from 'pdfjs-dist';
// Vite ?url query emits the worker script as a separate asset and yields its URL string
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { LoadedMap } from '../ui/contract';
import type { MapImage, RasterImage } from '../core/types';
import { calculateWorkingDimensions, UNSUPPORTED_FILE_TYPE_MESSAGE } from './image';

export const PDF_PASSWORD_ERROR_MESSAGE =
  'This PDF is password-protected. Please remove the password and try again.';
export const PDF_INVALID_ERROR_MESSAGE =
  'That PDF couldn’t be read because the file is damaged or not a valid PDF.';
export const PDF_LOAD_FAILURE_MESSAGE =
  'The PDF reader couldn’t load. Check your connection, or export the PDF page as a PNG and open that.';

/** Check if a file or filename represents a PDF. */
export function isPdfFile(file: { name?: string; type?: string }): boolean {
  if (file.type === 'application/pdf') return true;
  if (file.name && file.name.toLowerCase().endsWith('.pdf')) return true;
  return false;
}

/**
 * Calculate the render scale for a PDF page in points to fit a sensible resolution.
 * Matches the prototype: min(8, 4200 / max(pageWidth, pageHeight)).
 */
export function calculatePdfRenderScale(pageWidth: number, pageHeight: number): number {
  const maxSide = Math.max(pageWidth, pageHeight);
  if (maxSide <= 0) return 1;
  return Math.min(8, 4200 / maxSide);
}

let pdfjsPromise: Promise<typeof import('pdfjs-dist')> | null = null;

/** Lazily load pdfjs-dist with its worker bundled by Vite offline. */
export async function getPdfJs(): Promise<typeof import('pdfjs-dist')> {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      try {
        const pdfjs = await import('pdfjs-dist');
        pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
        return pdfjs;
      } catch {
        throw new Error(PDF_LOAD_FAILURE_MESSAGE);
      }
    })();
  }
  return pdfjsPromise;
}

/** Render a single page from a parsed PDF document into a canvas and extract display/raster. */
async function renderPageCanvas(
  doc: PDFDocumentProxy,
  pageNumber: number
): Promise<{
  display: ImageBitmap;
  raster: RasterImage;
  width: number;
  height: number;
  scale: number;
}> {
  const page = await doc.getPage(pageNumber);
  const unscaledVp = page.getViewport({ scale: 1 });
  const scale = calculatePdfRenderScale(unscaledVp.width, unscaledVp.height);
  const viewport = page.getViewport({ scale });

  const rawWidth = Math.round(viewport.width);
  const rawHeight = Math.round(viewport.height);
  const dims = calculateWorkingDimensions(rawWidth, rawHeight);

  if (typeof document !== 'undefined') {
    const canvas = document.createElement('canvas');
    canvas.width = dims.width;
    canvas.height = dims.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error(PDF_LOAD_FAILURE_MESSAGE);

    // Flatten onto solid white background
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, dims.width, dims.height);

    // If dims was capped, scale context to match target resolution
    if (dims.scaled) {
      ctx.save();
      ctx.scale(dims.width / rawWidth, dims.height / rawHeight);
      await page.render({ canvas, canvasContext: ctx, viewport }).promise;
      ctx.restore();
    } else {
      await page.render({ canvas, canvasContext: ctx, viewport }).promise;
    }

    // Yield before large pixel buffer readback so page.render and readback are in separate tasks (T-313 acceptance 2)
    await new Promise((resolve) => setTimeout(resolve, 0));

    let rasterData: Uint8ClampedArray;
    if (dims.width * dims.height > 4_000_000 && dims.height >= 4) {
      const bands = 4;
      const bandH = Math.ceil(dims.height / bands);
      rasterData = new Uint8ClampedArray(dims.width * dims.height * 4);
      for (let b = 0; b < bands; b++) {
        const y = b * bandH;
        const h = Math.min(bandH, dims.height - y);
        if (h <= 0) break;
        if (b > 0) {
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
        const band = ctx.getImageData(0, y, dims.width, h);
        rasterData.set(band.data, y * dims.width * 4);
      }
    } else {
      const imageData = ctx.getImageData(0, 0, dims.width, dims.height);
      rasterData = imageData.data;
    }

    await new Promise((resolve) => setTimeout(resolve, 0));

    const display =
      typeof createImageBitmap === 'function'
        ? await createImageBitmap(canvas)
        : (canvas as unknown as ImageBitmap);

    return {
      display,
      raster: {
        width: dims.width,
        height: dims.height,
        data: rasterData,
      },
      width: dims.width,
      height: dims.height,
      scale,
    };
  }

  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(dims.width, dims.height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error(PDF_LOAD_FAILURE_MESSAGE);

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, dims.width, dims.height);

    if (dims.scaled) {
      ctx.save();
      ctx.scale(dims.width / rawWidth, dims.height / rawHeight);
      // @ts-expect-error OffscreenCanvas is accepted as canvas at runtime
      await page.render({ canvas, canvasContext: ctx, viewport }).promise;
      ctx.restore();
    } else {
      // @ts-expect-error OffscreenCanvas is accepted as canvas at runtime
      await page.render({ canvas, canvasContext: ctx, viewport }).promise;
    }

    await new Promise((resolve) => setTimeout(resolve, 0));

    let rasterData: Uint8ClampedArray;
    if (dims.width * dims.height > 4_000_000 && dims.height >= 4) {
      const bands = 4;
      const bandH = Math.ceil(dims.height / bands);
      rasterData = new Uint8ClampedArray(dims.width * dims.height * 4);
      for (let b = 0; b < bands; b++) {
        const y = b * bandH;
        const h = Math.min(bandH, dims.height - y);
        if (h <= 0) break;
        if (b > 0) {
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
        const band = ctx.getImageData(0, y, dims.width, h);
        rasterData.set(band.data, y * dims.width * 4);
      }
    } else {
      const imageData = ctx.getImageData(0, 0, dims.width, dims.height);
      rasterData = imageData.data;
    }

    await new Promise((resolve) => setTimeout(resolve, 0));

    const display = canvas.transferToImageBitmap
      ? canvas.transferToImageBitmap()
      : await createImageBitmap(canvas);

    return {
      display,
      raster: {
        width: dims.width,
        height: dims.height,
        data: rasterData,
      },
      width: dims.width,
      height: dims.height,
      scale,
    };
  }

  throw new Error('Canvas rendering is not supported in this environment');
}

/** Translate error from pdfjs into a readable user error. */
function handlePdfError(err: unknown): never {
  if (err instanceof Error) {
    const name = err.name;
    const msg = err.message.toLowerCase();
    if (name === 'PasswordException' || msg.includes('password')) {
      throw new Error(PDF_PASSWORD_ERROR_MESSAGE);
    }
    if (name === 'InvalidPDFException' || msg.includes('invalid pdf') || msg.includes('corrupted')) {
      throw new Error(PDF_INVALID_ERROR_MESSAGE);
    }
  }
  throw new Error(PDF_INVALID_ERROR_MESSAGE);
}

/**
 * Open a PDF file, fingerprint it, and render the chosen page (1-based) to a LoadedMap.
 * Renders at prototype scale onto white, keeping original bytes untouched.
 * The returned LoadedMap.pdf.renderPage allows switching pages without re-parsing the document.
 */
export async function loadPdfFile(file: Blob, fileName: string, page = 1): Promise<LoadedMap> {
  if (!isPdfFile(file) && !isPdfFile({ name: fileName, type: file.type })) {
    throw new Error(UNSUPPORTED_FILE_TYPE_MESSAGE);
  }

  const arrayBuffer = await file.arrayBuffer();
  const fileBytes = new Uint8Array(arrayBuffer);

  // Compute SHA-256 of the original PDF bytes
  const hashBuf = await crypto.subtle.digest('SHA-256', fileBytes);
  const sha256 = Array.from(new Uint8Array(hashBuf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  const pdfjs = await getPdfJs();

  let doc: PDFDocumentProxy;
  try {
    const loadingTask = pdfjs.getDocument({
      data: fileBytes,
      useSystemFonts: true,
    });
    doc = await loadingTask.promise;
  } catch (err) {
    handlePdfError(err);
  }

  const cleanFileName = fileName.replace(/\.[^.]+$/, '') || 'map';

  async function renderDocPage(pageNum: number): Promise<LoadedMap> {
    if (pageNum < 1 || pageNum > doc.numPages) {
      throw new Error(
        `Requested page ${pageNum} does not exist in this PDF (document has ${doc.numPages} pages).`
      );
    }

    const { display, raster, width, height, scale } = await renderPageCanvas(doc, pageNum);

    const meta: MapImage = {
      fileName: cleanFileName,
      width,
      height,
      originalWidth: width,
      originalHeight: height,
      source: {
        kind: 'pdf',
        page: pageNum,
        pageCount: doc.numPages,
        renderScale: scale,
      },
      sha256,
    };

    return {
      meta,
      display,
      raster,
      original: file,
      pdf: {
        pageCount: doc.numPages,
        renderPage: (nextPage: number) => renderDocPage(nextPage),
      },
    };
  }

  return renderDocPage(page);
}
