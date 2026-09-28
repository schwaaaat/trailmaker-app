import { describe, expect, test } from 'vitest';
import { UNSUPPORTED_FILE_TYPE_MESSAGE } from './image';
import {
  calculatePdfRenderScale,
  isPdfFile,
  loadPdfFile,
  PDF_INVALID_ERROR_MESSAGE,
  PDF_LOAD_FAILURE_MESSAGE,
  PDF_PASSWORD_ERROR_MESSAGE,
} from './pdf';

describe('isPdfFile', () => {
  test('accepts application/pdf MIME type', () => {
    expect(isPdfFile({ type: 'application/pdf' })).toBe(true);
  });

  test('accepts .pdf extensions case-insensitively', () => {
    expect(isPdfFile({ name: 'map.pdf' })).toBe(true);
    expect(isPdfFile({ name: 'MAP.PDF' })).toBe(true);
    expect(isPdfFile({ name: 'trail-guide.Pdf' })).toBe(true);
  });

  test('rejects non-PDF files', () => {
    expect(isPdfFile({ name: 'map.png', type: 'image/png' })).toBe(false);
    expect(isPdfFile({ name: 'photo.jpg', type: 'image/jpeg' })).toBe(false);
    expect(isPdfFile({ name: 'archive.zip', type: 'application/zip' })).toBe(false);
    expect(isPdfFile({ name: 'project.json', type: 'application/json' })).toBe(false);
    expect(isPdfFile({ name: '', type: '' })).toBe(false);
  });
});

describe('calculatePdfRenderScale', () => {
  test('scales standard US Letter page (612x792 pt) to long side 4200 px', () => {
    const scale = calculatePdfRenderScale(612, 792);
    expect(scale).toBeCloseTo(4200 / 792, 4);
    expect(Math.round(792 * scale)).toBe(4200);
  });

  test('scales 800x600 pt page to scale 5.25 (4200 px long side)', () => {
    const scale = calculatePdfRenderScale(800, 600);
    expect(scale).toBe(5.25);
    expect(800 * scale).toBe(4200);
    expect(600 * scale).toBe(3150);
  });

  test('caps maximum scale at 8 for tiny pages', () => {
    const scale = calculatePdfRenderScale(200, 150);
    expect(scale).toBe(8);
  });

  test('scales down very large pages (e.g. 8400 pt)', () => {
    const scale = calculatePdfRenderScale(8400, 4200);
    expect(scale).toBe(0.5);
    expect(8400 * scale).toBe(4200);
  });

  test('handles zero or negative dimensions safely', () => {
    expect(calculatePdfRenderScale(0, 0)).toBe(1);
    expect(calculatePdfRenderScale(-100, 0)).toBe(1);
  });
});

describe('error messages', () => {
  test('defines readable error messages for password and invalid PDFs', () => {
    expect(PDF_PASSWORD_ERROR_MESSAGE).toBe(
      'This PDF is password-protected. Please remove the password and try again.'
    );
    expect(PDF_INVALID_ERROR_MESSAGE).toBe(
      'That PDF couldn’t be read because the file is damaged or not a valid PDF.'
    );
    expect(PDF_LOAD_FAILURE_MESSAGE).toContain('The PDF reader couldn’t load');
  });

  test('loadPdfFile rejects unsupported non-pdf file type before parsing', async () => {
    const textBlob = new Blob(['not a pdf'], { type: 'text/plain' });
    await expect(loadPdfFile(textBlob, 'notes.txt')).rejects.toThrow(
      UNSUPPORTED_FILE_TYPE_MESSAGE
    );
  });
});
