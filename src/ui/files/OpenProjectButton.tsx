// Lane C. Open project button (card T-304).
import React, { useRef, type ChangeEvent } from 'react';
import { sessionBridge } from '../../state/bridge';
import type { SessionBridge } from '../contract';
import { openFileBlob } from './open';

void React;

export interface OpenProjectButtonProps {
  readonly bridge?: SessionBridge | undefined;
  readonly className?: string | undefined;
  readonly label?: string | undefined;
  readonly id?: string | undefined;
  readonly showToast?: ((msg: string) => void) | undefined;
  readonly setBusy?: ((busy: string | null) => void) | undefined;
}

export function OpenProjectButton({
  bridge = sessionBridge,
  className = 'btn',
  label = 'Open project',
  id,
  showToast,
  setBusy,
}: OpenProjectButtonProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  const handleClick = () => {
    inputRef.current?.click();
  };

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file) {
      void openFileBlob(file, file.name, { bridge, showToast, setBusy });
    }
  };

  return (
    <>
      <button
        id={id}
        type="button"
        className={className}
        aria-label={label}
        onClick={handleClick}
      >
        {label}
      </button>
      <input
        ref={inputRef}
        type="file"
        accept=".trailmaker,.json"
        style={{ display: 'none' }}
        tabIndex={-1}
        aria-hidden="true"
        onChange={handleFileChange}
      />
    </>
  );
}
