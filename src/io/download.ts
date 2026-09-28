// Lane C. Browser file download helper (card T-304).

declare global {
  interface Window {
    claude?: {
      use?: (feature: string) => Promise<{
        save: (args: { filename: string; data: Blob }) => Promise<{ status: string }>;
      }>;
    };
  }
}

/**
 * Triggers a download of a Blob as a file named `filename`.
 * Uses window.claude.use('downloads') when available, otherwise creates a temporary <a> tag with an object URL.
 */
export async function downloadBlob(filename: string, blob: Blob): Promise<boolean> {
  if (typeof window !== 'undefined' && window.claude && typeof window.claude.use === 'function') {
    try {
      const dl = await window.claude.use('downloads');
      if (dl && typeof dl.save === 'function') {
        const res = await dl.save({ filename, data: blob });
        return res?.status === 'saved';
      }
    } catch {
      // Fall back to standard browser download
    }
  }

  if (typeof document === 'undefined') {
    return false;
  }

  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    return true;
  } finally {
    setTimeout(() => {
      URL.revokeObjectURL(url);
    }, 5000);
  }
}
