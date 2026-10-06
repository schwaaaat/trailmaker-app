import { describe, expect, it } from 'vitest';
import { isTiledDownloadDisabled, resetTiledDownloadUiState } from './tiled-download-ui-state';

describe('tiled download UI session transitions', () => {
  it('clears the previous estimate and completed progress before preparing another session', () => {
    const previous = {
      estimate: { estimatedBytes: 2_000_000, estimatedSeconds: 90, enoughSpace: true },
      progress: { complete: 9, total: 9, missing: 0 },
    };

    expect({ ...previous, ...resetTiledDownloadUiState() }).toEqual({
      estimate: null,
      progress: null,
    });
  });

  it('keeps download disabled while a replacement session is loading despite any estimate', () => {
    expect(isTiledDownloadDisabled(true, false, true, false)).toBe(true);
    expect(isTiledDownloadDisabled(false, false, true, false)).toBe(false);
  });
});
