// Lane C. Save project button (card T-304).
import React, { useEffect, useState } from 'react';
import { serializeProjectAsync, type StoredImage } from '../../core/project';
import { downloadBlob } from '../../io/download';
import { getActiveGpx } from '../../io/gpxStorage';
import { sessionBridge } from '../../state/bridge';
import { setBusy as storeSetBusy, showToast as storeShowToast } from '../../state/store';
import type { Session, SessionBridge } from '../contract';
import { slug, blobToArrayBuffer } from './open';

void React;

export interface SaveProjectButtonProps {
  readonly bridge?: SessionBridge | undefined;
  readonly className?: string | undefined;
  readonly label?: string | undefined;
  readonly id?: string | undefined;
  readonly showToast?: ((msg: string) => void) | undefined;
  readonly setBusy?: ((busy: string | null) => void) | undefined;
  readonly serializeProject?: typeof serializeProjectAsync | undefined;
}

export function SaveProjectButton({
  bridge = sessionBridge,
  className = 'btn',
  label = 'Save project',
  id,
  showToast = storeShowToast,
  setBusy = storeSetBusy,
  serializeProject = serializeProjectAsync,
}: SaveProjectButtonProps) {
  const [session, setSession] = useState<Session | null>(() => bridge.getSession());

  useEffect(() => {
    setSession(bridge.getSession());
    return bridge.subscribe((next) => {
      setSession(next);
    });
  }, [bridge]);

  const handleSave = async () => {
    const current = bridge.getSession();
    if (!current) return;

    try {
      setBusy('Saving project...');
      const buffer = await blobToArrayBuffer(current.map.original);
      const bytes = new Uint8Array(buffer);
      const mimeType =
        current.map.meta.source.kind === 'pdf'
          ? 'application/pdf'
          : current.map.meta.source.mimeType;

      const storedImage: StoredImage = { bytes, mimeType };
      const activeGpx = getActiveGpx();
      const gpxBytes = activeGpx?.rawGpx
        ? new TextEncoder().encode(activeGpx.rawGpx)
        : undefined;
      const zipBytes = await serializeProject(current.project, storedImage, gpxBytes);

      const filename = `${slug(current.project.name)}.trailmaker`;
      const blob = new Blob([zipBytes as unknown as BlobPart], { type: 'application/octet-stream' });
      await downloadBlob(filename, blob);
      showToast(`Saved ${filename}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Could not save project.';
      showToast(msg);
    } finally {
      setBusy(null);
    }
  };

  return (
    <button
      id={id}
      type="button"
      className={className}
      aria-label={label}
      disabled={session === null}
      onClick={handleSave}
    >
      {label}
    </button>
  );
}
