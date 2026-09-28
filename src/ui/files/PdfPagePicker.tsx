// Lane C. PDF multi-page picker (card T-304).
import React, { useEffect, useId, useState, type ChangeEvent } from 'react';
import type { Project } from '../../core/types';
import { sessionBridge } from '../../state/bridge';
import { setBusy as storeSetBusy, showToast as storeShowToast } from '../../state/store';
import type { Session, SessionBridge } from '../contract';
import { hasWork } from './open';

void React;

export const PAGE_CHANGE_CONFIRM_MESSAGE =
  'Changing pages clears current anchors and traced features. Continue?';

export interface PdfPagePickerProps {
  readonly bridge?: SessionBridge | undefined;
  readonly className?: string | undefined;
  readonly confirmFn?: ((message: string) => boolean) | undefined;
  readonly showToast?: ((msg: string) => void) | undefined;
  readonly setBusy?: ((busy: string | null) => void) | undefined;
}

export function PdfPagePicker({
  bridge = sessionBridge,
  className = 'page-picker',
  confirmFn,
  showToast = storeShowToast,
  setBusy = storeSetBusy,
}: PdfPagePickerProps) {
  const selectId = useId();
  const [session, setSession] = useState<Session | null>(() => bridge.getSession());

  useEffect(() => {
    setSession(bridge.getSession());
    return bridge.subscribe((next) => {
      setSession(next);
    });
  }, [bridge]);

  if (!session || !session.map.pdf || session.map.pdf.pageCount <= 1) {
    return null;
  }

  const { pdf } = session.map;
  const currentPage =
    session.project.image.source.kind === 'pdf' ? session.project.image.source.page : 1;

  const handleChange = async (e: ChangeEvent<HTMLSelectElement>) => {
    const targetPage = Number(e.target.value);
    if (!Number.isFinite(targetPage) || targetPage === currentPage) return;

    if (hasWork(session)) {
      const askConfirm = confirmFn ?? (typeof window !== 'undefined' ? window.confirm.bind(window) : () => true);
      const confirmed = askConfirm(PAGE_CHANGE_CONFIRM_MESSAGE);
      if (!confirmed) {
        e.target.value = String(currentPage);
        return;
      }
    }

    try {
      setBusy(`Rendering page ${targetPage}...`);
      const nextMap = await pdf.renderPage(targetPage);
      const nextProject: Project = {
        ...session.project,
        image: nextMap.meta,
        anchors: [],
        features: [],
        updatedAt: new Date().toISOString(),
      };
      bridge.openSession({ project: nextProject, map: nextMap });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to switch page.';
      showToast(msg);
      e.target.value = String(currentPage);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className={className}>
      <label htmlFor={selectId}>Page</label>
      <select
        id={selectId}
        aria-label="Page"
        value={currentPage}
        onChange={handleChange}
      >
        {Array.from({ length: pdf.pageCount }, (_, i) => (
          <option key={i + 1} value={i + 1}>
            Page {i + 1}
          </option>
        ))}
      </select>
    </div>
  );
}
