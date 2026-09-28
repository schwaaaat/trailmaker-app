// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { downloadBlob } from './download';

describe('downloadBlob', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    delete (window as unknown as { claude?: unknown }).claude;
  });

  it('creates an anchor element and clicks it in browser environment', async () => {
    const createObjectURLMock = vi.fn().mockReturnValue('blob:http://localhost/test-uuid');
    const revokeObjectURLMock = vi.fn();
    window.URL.createObjectURL = createObjectURLMock;
    window.URL.revokeObjectURL = revokeObjectURLMock;

    let clicked = false;
    let appendedHref = '';
    let appendedDownload = '';

    const originalAppend = document.body.appendChild.bind(document.body);
    vi.spyOn(document.body, 'appendChild').mockImplementation((node) => {
      if (node instanceof HTMLAnchorElement) {
        appendedHref = node.href;
        appendedDownload = node.download;
        node.click = () => {
          clicked = true;
        };
      }
      return originalAppend(node);
    });

    const blob = new Blob(['test content'], { type: 'text/plain' });
    const success = await downloadBlob('sample.txt', blob);

    expect(success).toBe(true);
    expect(createObjectURLMock).toHaveBeenCalledWith(blob);
    expect(appendedHref).toBe('blob:http://localhost/test-uuid');
    expect(appendedDownload).toBe('sample.txt');
    expect(clicked).toBe(true);
  });

  it('uses window.claude.use("downloads") if available', async () => {
    const saveMock = vi.fn().mockResolvedValue({ status: 'saved' });
    const useMock = vi.fn().mockResolvedValue({ save: saveMock });
    (window as unknown as { claude?: unknown }).claude = { use: useMock };

    const blob = new Blob(['claude content'], { type: 'text/plain' });
    const success = await downloadBlob('claude.txt', blob);

    expect(success).toBe(true);
    expect(useMock).toHaveBeenCalledWith('downloads');
    expect(saveMock).toHaveBeenCalledWith({ filename: 'claude.txt', data: blob });
  });
});
