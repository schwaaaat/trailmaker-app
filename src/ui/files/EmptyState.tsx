// Lane C. Empty state drop area (card T-304).
import React, { useEffect, useState, type ReactNode } from 'react';
import { sessionBridge } from '../../state/bridge';
import type { Session, SessionBridge } from '../contract';
import { OpenMapButton } from './OpenMapButton';
import { ResumePrompt } from './ResumePrompt';

void React;

export interface EmptyStateProps {
  readonly bridge?: SessionBridge | undefined;
  readonly className?: string | undefined;
  readonly resumeSlot?: ReactNode | undefined;
  readonly showToast?: ((msg: string) => void) | undefined;
  readonly setBusy?: ((busy: string | null) => void) | undefined;
}

export function EmptyState({
  bridge = sessionBridge,
  className = 'empty-state',
  resumeSlot,
  showToast,
  setBusy,
}: EmptyStateProps) {
  const [session, setSession] = useState<Session | null>(() => bridge.getSession());

  useEffect(() => {
    setSession(bridge.getSession());
    return bridge.subscribe((next) => {
      setSession(next);
    });
  }, [bridge]);

  if (session !== null) {
    return null;
  }

  return (
    <div id="empty" className={className} aria-label="Empty map stage">
      <div className="drop">
        <svg
          width="64"
          height="64"
          viewBox="0 0 64 64"
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M8 14l14-6 20 8 14-6v40l-14 6-20-8-14 6z" />
          <path d="M22 8v40M42 16v40" />
          <path d="M14 38c6-2 8-10 14-10s6 8 12 8 8-6 12-8" strokeDasharray="1 6" />
        </svg>
        <h3>Drop a park map here</h3>
        <p>PNG, JPG, WebP or PDF. Everything stays in your browser.</p>
        <OpenMapButton
          bridge={bridge}
          className="btn primary"
          id="openBtn2"
          label="Open image or PDF"
          showToast={showToast}
          setBusy={setBusy}
        />
        {resumeSlot !== undefined ? (
          resumeSlot ? (
            <div id="resume" className="resume-slot">
              {resumeSlot}
            </div>
          ) : null
        ) : (
          <ResumePrompt bridge={bridge} showToast={showToast} setBusy={setBusy} />
        )}
      </div>
    </div>
  );
}
