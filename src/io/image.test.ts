import { describe, expect, test } from 'vitest';
import { MAX_WORKING_SIDE } from '../core/types';
import {
  calculateWorkingDimensions,
  inferImageMimeType,
  isSupportedImage,
  parseExifOrientation,
  parseImageHeaderDimensions,
  UNSUPPORTED_FILE_TYPE_MESSAGE,
} from './image';

describe('isSupportedImage', () => {
  test('accepts supported MIME types', () => {
    expect(isSupportedImage({ type: 'image/png' })).toBe(true);
    expect(isSupportedImage({ type: 'image/jpeg' })).toBe(true);
    expect(isSupportedImage({ type: 'image/jpg' })).toBe(true);
    expect(isSupportedImage({ type: 'image/webp' })).toBe(true);
    expect(isSupportedImage({ type: 'image/gif' })).toBe(true);
    expect(isSupportedImage({ type: 'image/bmp' })).toBe(true);
    expect(isSupportedImage({ type: 'image/x-ms-bmp' })).toBe(true);
    expect(isSupportedImage({ type: 'image/avif' })).toBe(true);
  });

  test('accepts supported extensions case-insensitively', () => {
    expect(isSupportedImage({ name: 'map.PNG' })).toBe(true);
    expect(isSupportedImage({ name: 'trail.jpg' })).toBe(true);
    expect(isSupportedImage({ name: 'photo.JPEG' })).toBe(true);
    expect(isSupportedImage({ name: 'scan.webp' })).toBe(true);
    expect(isSupportedImage({ name: 'animation.gif' })).toBe(true);
    expect(isSupportedImage({ name: 'bitmap.bmp' })).toBe(true);
    expect(isSupportedImage({ name: 'modern.avif' })).toBe(true);
  });

  test('rejects unsupported types', () => {
    expect(isSupportedImage({ name: 'doc.pdf', type: 'application/pdf' })).toBe(false);
    expect(isSupportedImage({ name: 'proj.json', type: 'application/json' })).toBe(false);
    expect(isSupportedImage({ name: 'vector.svg', type: 'image/svg+xml' })).toBe(false);
    expect(isSupportedImage({ name: 'archive.zip', type: 'application/zip' })).toBe(false);
    expect(isSupportedImage({ name: 'text.txt', type: 'text/plain' })).toBe(false);
  });

  test('UNSUPPORTED_FILE_TYPE_MESSAGE matches the prototype message', () => {
    expect(UNSUPPORTED_FILE_TYPE_MESSAGE).toBe(
      "That file type isn't supported. Use PNG, JPG, WebP or PDF."
    );
  });
});

describe('calculateWorkingDimensions', () => {
  test('preserves dimensions when longest side <= MAX_WORKING_SIDE', () => {
    const res = calculateWorkingDimensions(2400, 1800, MAX_WORKING_SIDE);
    expect(res).toEqual({
      width: 2400,
      height: 1800,
      originalWidth: 2400,
      originalHeight: 1800,
      scaled: false,
    });
  });

  test('scales down wide image so width <= MAX_WORKING_SIDE', () => {
    // 12000 x 9000 -> long side is 12000. 12000 * (7000/12000) = 7000, 9000 * (7000/12000) = 5250
    const res = calculateWorkingDimensions(12000, 9000, 7000);
    expect(res.width).toBe(7000);
    expect(res.height).toBe(5250);
    expect(res.originalWidth).toBe(12000);
    expect(res.originalHeight).toBe(9000);
    expect(res.scaled).toBe(true);
  });

  test('scales down tall image so height <= MAX_WORKING_SIDE', () => {
    // 5000 x 15000 -> height 7000, width = round(5000 * 7000 / 15000) = 2333
    const res = calculateWorkingDimensions(5000, 15000, 7000);
    expect(res.height).toBe(7000);
    expect(res.width).toBe(2333);
    expect(res.scaled).toBe(true);
  });

  test('handles tiny 1x1 image', () => {
    const res = calculateWorkingDimensions(1, 1, 7000);
    expect(res.width).toBe(1);
    expect(res.height).toBe(1);
    expect(res.scaled).toBe(false);
  });
});

describe('parseImageHeaderDimensions', () => {
  test('parses PNG dimensions from header', () => {
    const pngHeader = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
      0x00, 0x00, 0x07, 0xd0, // width: 2000 (0x7D0)
      0x00, 0x00, 0x05, 0xdc, // height: 1500 (0x5DC)
      0x08, 0x06, 0x00, 0x00, 0x00,
    ]);
    const dims = parseImageHeaderDimensions(pngHeader);
    expect(dims).toEqual({ width: 2000, height: 1500 });
  });

  test('parses GIF dimensions from header', () => {
    const gifHeader = new Uint8Array([
      0x47, 0x49, 0x46, 0x38, 0x39, 0x61,
      0x20, 0x03, // width: 800 (0x0320 little-endian)
      0x58, 0x02, // height: 600 (0x0258 little-endian)
    ]);
    const dims = parseImageHeaderDimensions(gifHeader);
    expect(dims).toEqual({ width: 800, height: 600 });
  });

  test('parses BMP dimensions from header', () => {
    const bmpHeader = new Uint8Array(30);
    bmpHeader[0] = 0x42;
    bmpHeader[1] = 0x4d;
    const view = new DataView(bmpHeader.buffer);
    view.setInt32(18, 1024, true); // width
    view.setInt32(22, 768, true);  // height
    const dims = parseImageHeaderDimensions(bmpHeader);
    expect(dims).toEqual({ width: 1024, height: 768 });
  });

  test('parses JPEG dimensions from SOF marker', () => {
    const jpegData = new Uint8Array([
      0xff, 0xd8, // SOI
      0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, // APP0
      0xff, 0xc0, 0x00, 0x0b, 0x08,
      0x04, 0xb0, // height: 1200 (0x04B0 big-endian)
      0x06, 0x40, // width: 1600 (0x0640 big-endian)
      0x03, 0x01, 0x22, 0x00,
      0xff, 0xd9, // EOI
    ]);
    const dims = parseImageHeaderDimensions(jpegData);
    expect(dims).toEqual({ width: 1600, height: 1200 });
  });

  test('swaps JPEG dimensions when EXIF orientation is 6 or 8', () => {
    function makeJpegWithExif(rawWidth: number, rawHeight: number, orientation: number): Uint8Array {
      // APP1 payload: Exif\0\0 + TIFF header + IFD0
      const exifPayload = new Uint8Array(6 + 8 + 2 + 12 + 4);
      const pView = new DataView(exifPayload.buffer);
      exifPayload.set([0x45, 0x78, 0x69, 0x66, 0x00, 0x00], 0); // Exif\0\0
      const tiff = 6;
      exifPayload[tiff] = 0x49; // II (Little Endian)
      exifPayload[tiff + 1] = 0x49;
      pView.setUint16(tiff + 2, 42, true);
      pView.setUint32(tiff + 4, 8, true); // IFD0 offset from tiff start
      const ifd0 = tiff + 8;
      pView.setUint16(ifd0, 1, true); // 1 entry
      const entry = ifd0 + 2;
      pView.setUint16(entry, 0x0112, true); // Orientation
      pView.setUint16(entry + 2, 3, true); // SHORT
      pView.setUint32(entry + 4, 1, true); // count 1
      pView.setUint16(entry + 8, orientation, true); // value

      const app1Len = 2 + exifPayload.length;
      const sofLen = 11;
      const totalLen = 2 + (2 + app1Len) + (2 + sofLen) + 2;
      const jpeg = new Uint8Array(totalLen);
      const jView = new DataView(jpeg.buffer);
      let pos = 0;
      // SOI
      jpeg[pos++] = 0xff;
      jpeg[pos++] = 0xd8;
      // APP1
      jpeg[pos++] = 0xff;
      jpeg[pos++] = 0xe1;
      jView.setUint16(pos, app1Len, false);
      pos += 2;
      jpeg.set(exifPayload, pos);
      pos += exifPayload.length;
      // SOF0
      jpeg[pos++] = 0xff;
      jpeg[pos++] = 0xc0;
      jView.setUint16(pos, sofLen, false);
      pos += 2;
      jpeg[pos++] = 0x08; // precision
      jView.setUint16(pos, rawHeight, false);
      pos += 2;
      jView.setUint16(pos, rawWidth, false);
      pos += 2;
      jpeg[pos++] = 0x03; // components
      jpeg[pos++] = 0x01;
      jpeg[pos++] = 0x22;
      jpeg[pos++] = 0x00;
      // EOI
      jpeg[pos++] = 0xff;
      jpeg[pos++] = 0xd9;

      return jpeg;
    }

    // Orientation 6: 40x20 raw -> 20x40 oriented
    const jpeg6 = makeJpegWithExif(40, 20, 6);
    expect(parseImageHeaderDimensions(jpeg6)).toEqual({ width: 20, height: 40 });

    // Orientation 8: 40x20 raw -> 20x40 oriented
    const jpeg8 = makeJpegWithExif(40, 20, 8);
    expect(parseImageHeaderDimensions(jpeg8)).toEqual({ width: 20, height: 40 });

    // Orientation 1: 40x20 raw -> 40x20 oriented (no swap)
    const jpeg1 = makeJpegWithExif(40, 20, 1);
    expect(parseImageHeaderDimensions(jpeg1)).toEqual({ width: 40, height: 20 });

    // Orientation 3: 40x20 raw -> 40x20 oriented (180 deg, no swap)
    const jpeg3 = makeJpegWithExif(40, 20, 3);
    expect(parseImageHeaderDimensions(jpeg3)).toEqual({ width: 40, height: 20 });
  });

  test('parseExifOrientation returns undefined for malformed or non-exif APP1', () => {
    expect(parseExifOrientation(new Uint8Array([1, 2, 3]), 0, 3)).toBeUndefined();
    // Non-Exif string (e.g. XMP: http://...)
    const xmpBytes = new Uint8Array([0x68, 0x74, 0x74, 0x70, 0x00, 0x00, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(parseExifOrientation(xmpBytes, 0, xmpBytes.length)).toBeUndefined();
  });

  test('parses WebP VP8X dimensions from header', () => {
    const webpData = new Uint8Array(32);
    // RIFF .... WEBP VP8X
    webpData.set([0x52, 0x49, 0x46, 0x46], 0);
    webpData.set([0x57, 0x45, 0x42, 0x50], 8);
    webpData.set([0x56, 0x50, 0x38, 0x58], 12);
    // Width-1 (24 bit LE) at 24: 1919 -> 1920 (0x00077F)
    webpData[24] = 0x7f;
    webpData[25] = 0x07;
    webpData[26] = 0x00;
    // Height-1 (24 bit LE) at 27: 1079 -> 1080 (0x000437)
    webpData[27] = 0x37;
    webpData[28] = 0x04;
    webpData[29] = 0x00;

    const dims = parseImageHeaderDimensions(webpData);
    expect(dims).toEqual({ width: 1920, height: 1080 });
  });

  test('returns null on invalid or short byte arrays', () => {
    expect(parseImageHeaderDimensions(new Uint8Array([]))).toBeNull();
    expect(parseImageHeaderDimensions(new Uint8Array([1, 2, 3]))).toBeNull();
    expect(parseImageHeaderDimensions(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBeNull();
  });
});

describe('inferImageMimeType', () => {
  test('prefers blob type when set', () => {
    const blob = new Blob([], { type: 'image/webp' });
    expect(inferImageMimeType(blob, 'map.png')).toBe('image/webp');
  });

  test('falls back to filename extension when blob type is empty', () => {
    const blob = new Blob([]);
    expect(inferImageMimeType(blob, 'map.png')).toBe('image/png');
    expect(inferImageMimeType(blob, 'map.jpg')).toBe('image/jpeg');
    expect(inferImageMimeType(blob, 'map.jpeg')).toBe('image/jpeg');
    expect(inferImageMimeType(blob, 'map.webp')).toBe('image/webp');
    expect(inferImageMimeType(blob, 'map.gif')).toBe('image/gif');
    expect(inferImageMimeType(blob, 'map.bmp')).toBe('image/bmp');
    expect(inferImageMimeType(blob, 'map.avif')).toBe('image/avif');
    expect(inferImageMimeType(blob, 'map.unknown')).toBe('image/png');
  });
});
