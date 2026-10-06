import React, { useEffect, useState } from 'react';
import { migrateProject } from '../../core/project';
import { readAutosave, type RestoredAutosave } from '../../io/autosave';
import { clearActiveGpx, setActiveGpx } from '../../io/gpxStorage';
import { loadImageFile } from '../../io/image';
import { loadPdfFile } from '../../io/pdf';
import { restoreTiledProjectMap } from '../../io/tile-raster';
import { sessionBridge } from '../../state/bridge';
import { setBusy as storeSetBusy, showToast as storeShowToast } from '../../state/store';
import type { LoadedMap, Session, SessionBridge } from '../contract';

void React;

export const RESUME_FAILED_MESSAGE = 'The saved session couldn’t be restored.';

export interface ResumePromptProps {
  readonly bridge?: SessionBridge | undefined;
  readonly showToast?: ((msg: string) => void) | undefined;
  readonly setBusy?: ((busy: string | null) => void) | undefined;
}

/** Formats an ISO date string to match prototype: e.g. "Sep 25, 3:30 PM". */
export function formatResumeDate(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** Formats resume button text: Resume “<name>” (n items, <date time>). */
export function formatResumeButtonText(name: string, itemCount: number, dateStr: string): string {
  const countStr = `${itemCount} ${itemCount === 1 ? 'item' : 'items'}`;
  const when = formatResumeDate(dateStr);
  return `Resume “${name}” (${countStr}, ${when})`;
}

export function ResumePrompt({
  bridge = sessionBridge,
  showToast = storeShowToast,
  setBusy = storeSetBusy,
}: ResumePromptProps) {
  const [session, setSession] = useState<Session | null>(() => bridge.getSession());
  const [saved, setSaved] = useState<RestoredAutosave | null>(null);
  const [resuming, setResuming] = useState(false);

  useEffect(() => {
    setSession(bridge.getSession());
    return bridge.subscribe((next) => {
      setSession(next);
    });
  }, [bridge]);

  useEffect(() => {
    let cancelled = false;
    async function loadSaved() {
      const data = await readAutosave({ showToast });
      if (!cancelled) {
        setSaved(data);
      }
    }
    void loadSaved();
    return () => {
      cancelled = true;
    };
  }, [session, showToast]);

  if (session !== null || !saved) {
    return null;
  }

  const { project, image } = saved;
  const n = project.features.length;
  const buttonText = formatResumeButtonText(project.name, n, project.updatedAt);

  async function handleResume() {
    if (!saved || resuming) return;
    setResuming(true);
    setBusy('Resuming session...');

    try {
      let map: LoadedMap;
      if (project.image.source.kind === 'tiles') {
        map = await restoreTiledProjectMap(project.image, image);
      } else if (project.image.source.kind === 'pdf') {
        map = await loadPdfFile(image, project.image.fileName, project.image.source.page);
      } else {
        map = await loadImageFile(image, project.image.fileName);
      }
      const migrated = migrateProject(project);
      if (saved.gpx) {
        setActiveGpx(saved.gpx);
      } else {
        clearActiveGpx();
      }
      bridge.openSession({ project: migrated, map });
      if (map.meta.source.kind === 'tiles' && !map.tiles) {
        showToast(
          'Session resumed with its overview. Download the tiles again from Capture satellite for full offline detail.',
        );
      }
    } catch {
      showToast(RESUME_FAILED_MESSAGE);
    } finally {
      setResuming(false);
      setBusy(null);
    }
  }

  return (
    <div id="resume" className="resume-slot">
      <button
        type="button"
        className="btn blaze"
        id="resumeBtn"
        aria-label={buttonText}
        onClick={handleResume}
        disabled={resuming}
      >
        {buttonText}
      </button>
    </div>
  );
}
