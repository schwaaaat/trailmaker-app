// Lane C. Open map button with replace confirmation arm (card T-304).
import React, { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { sessionBridge } from '../../state/bridge';
import type { SessionBridge } from '../contract';
import { hasWork, openFileBlob } from './open';

void React;

export interface OpenMapButtonProps {
  readonly bridge?: SessionBridge | undefined;
  readonly className?: string | undefined;
  readonly label?: string | undefined;
  readonly id?: string | undefined;
  readonly showToast?: ((msg: string) => void) | undefined;
  readonly setBusy?: ((busy: string | null) => void) | undefined;
}

export function OpenMapButton({
  bridge = sessionBridge,
  className = 'btn',
  label = 'Open image or PDF',
  id,
  showToast,
  setBusy,
}: OpenMapButtonProps) {
  const [armed, setArmed] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timeoutRef.current !== null) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  const handleClick = () => {
    const session = bridge.getSession();
    const work = hasWork(session);

    if (work && !armed) {
      setArmed(true);
      if (timeoutRef.current !== null) {
        clearTimeout(timeoutRef.current);
      }
      timeoutRef.current = setTimeout(() => {
        setArmed(false);
        timeoutRef.current = null;
      }, 4000);
      return;
    }

    if (armed) {
      setArmed(false);
      if (timeoutRef.current !== null) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
    }

    inputRef.current?.click();
  };

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file) {
      void openFileBlob(file, file.name, { bridge, showToast, setBusy });
    }
  };

  const currentLabel = armed ? 'Click again to replace this map' : label;
  const buttonClass = armed ? `${className} arm`.trim() : className;

  return (
    <>
      <button
        id={id}
        type="button"
        className={buttonClass}
        aria-label={currentLabel}
        onClick={handleClick}
      >
        {currentLabel}
      </button>
      {armed && (
        <span className="sr-only" role="status" aria-live="polite">
          Click again to replace this map
        </span>
      )}
      <input
        ref={inputRef}
        type="file"
        accept=".png,.jpg,.jpeg,.webp,.pdf,.trailmaker,.json"
        style={{ display: 'none' }}
        tabIndex={-1}
        aria-hidden="true"
        onChange={handleFileChange}
      />
    </>
  );
}
