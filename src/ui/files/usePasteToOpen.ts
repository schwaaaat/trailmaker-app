// Lane C. Global paste-to-open hook (card T-304).
import { useEffect } from 'react';
import { sessionBridge } from '../../state/bridge';
import type { SessionBridge } from '../contract';
import { hasWork, openFileBlob } from './open';

export interface UsePasteToOpenOptions {
  readonly bridge?: SessionBridge | undefined;
  readonly enabled?: boolean | undefined;
  readonly showToast?: ((msg: string) => void) | undefined;
  readonly setBusy?: ((busy: string | null) => void) | undefined;
}

export function usePasteToOpen(options: UsePasteToOpenOptions = {}): void {
  const { bridge = sessionBridge, enabled = true, showToast, setBusy } = options;

  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return;

    const handlePaste = (e: ClipboardEvent) => {
      const active = document.activeElement;
      if (active && /^(input|textarea)$/i.test(active.tagName)) {
        return;
      }

      const items = e.clipboardData?.items;
      if (!items) return;

      const item = Array.from(items).find((i) => i.type.startsWith('image/'));
      if (!item) return;

      const session = bridge.getSession();
      if (hasWork(session)) {
        // Paste only opens when there is no work
        return;
      }

      const file = item.getAsFile();
      if (file) {
        void openFileBlob(file, 'Pasted map.png', { bridge, showToast, setBusy });
      }
    };

    window.addEventListener('paste', handlePaste);
    return () => window.removeEventListener('paste', handlePaste);
  }, [bridge, enabled, showToast, setBusy]);
}
