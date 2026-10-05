import { afterEach, describe, expect, it } from 'vitest';
import { appStore } from '../../state/store';
import { SmartFollow } from './smart';

describe('T-324 Esri pixel-analysis terms fallback', () => {
  afterEach(() => appStore.setState({ editorBackdrop: 'map' }));

  it('does not pick map pixels to start smart follow over Esri', async () => {
    appStore.setState({ editorBackdrop: 'esri' });
    await expect(new SmartFollow().start([12, 34], { s: 1, x: 0, y: 0 })).resolves.toEqual({
      at: [12, 34],
      ink: null,
    });
  });

  it('adds a straight hop instead of deriving a trail from Esri pixels', async () => {
    appStore.setState({ editorBackdrop: 'esri' });
    const draft = {
      kind: 'trail',
      pts: [[0, 0]],
      cps: [1],
      ink: [1, 2, 3],
      color: '#000000',
      name: '',
      editId: null,
    } as const;
    await expect(
      new SmartFollow().hop([0, 0], [30, 40], draft, { s: 1, x: 0, y: 0 }),
    ).resolves.toEqual([[30, 40]]);
  });
});
