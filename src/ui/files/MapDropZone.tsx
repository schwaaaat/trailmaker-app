import React, { useEffect, useState, type DragEvent, type ReactNode } from 'react';
import { defaultUpdateManager, registerPwa } from '../../io/pwa';
import { UpdatePrompt } from '../../io/pwa/UpdatePrompt';
import { sessionBridge } from '../../state/bridge';
import { showToast as storeShowToast } from '../../state/store';
import type { SessionBridge } from '../contract';
import { hasWork, openFileBlob, REPLACE_MAP_HINT_MESSAGE } from './open';
import { useAutosave } from './useAutosave';

void React;

export interface MapDropZoneProps {
  readonly bridge?: SessionBridge | undefined;
  readonly className?: string | undefined;
  readonly children?: ReactNode | undefined;
  readonly showToast?: ((msg: string) => void) | undefined;
  readonly setBusy?: ((busy: string | null) => void) | undefined;
}

export function MapDropZone({
  bridge = sessionBridge,
  className = '',
  children,
  showToast = storeShowToast,
  setBusy,
}: MapDropZoneProps) {
  useAutosave(bridge, { showToast });

  useEffect(() => {
    defaultUpdateManager.setHasUnsavedWork?.(() => hasWork(bridge.getSession()));
    void registerPwa();
  }, [bridge]);

  const [isDragOver, setIsDragOver] = useState(false);

  const handleDragEnter = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(true);
  };

  const handleDragOver = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    if (!isDragOver) {
      setIsDragOver(true);
    }
  };

  const handleDragLeave = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    // Only clear if leaving the drop zone container itself
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) {
      return;
    }
    setIsDragOver(false);
  };

  const handleDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);

    const file = e.dataTransfer.files?.[0];
    if (!file) return;

    const session = bridge.getSession();
    const work = hasWork(session);
    const name = (file.name || '').toLowerCase();
    const isProject = name.endsWith('.trailmaker') || name.endsWith('.json');
    const isGpx = name.endsWith('.gpx');

    if (work && !isProject && !isGpx) {
      showToast(REPLACE_MAP_HINT_MESSAGE);
      return;
    }

    void openFileBlob(file, file.name, { bridge, showToast, setBusy });
  };

  const containerClasses = [
    'map-drop-zone',
    className,
    isDragOver ? 'drag-over' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      className={containerClasses}
      role="region"
      aria-label="Map drop zone"
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {children}
      <UpdatePrompt />
    </div>
  );
}
