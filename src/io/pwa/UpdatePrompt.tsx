// Lane C. PWA Update Prompt notification component (card T-310, Acceptance 5).
import React, { useEffect, useState } from 'react';
import { defaultUpdateManager, type UpdateManager, type UpdateState } from './update';
import './pwa.css';

void React;

export interface UpdatePromptProps {
  readonly updateManager?: UpdateManager;
  readonly className?: string;
}

export function useUpdateState(manager: UpdateManager = defaultUpdateManager): UpdateState {
  const [state, setState] = useState<UpdateState>(() => manager.getState());

  useEffect(() => {
    return manager.subscribe((next) => setState(next));
  }, [manager]);

  return state;
}

export function UpdatePrompt({
  updateManager = defaultUpdateManager,
  className = '',
}: UpdatePromptProps) {
  const state = useUpdateState(updateManager);

  // If no update is available or the user dismissed it, render nothing
  if (!state.updateAvailable || state.dismissed) {
    return null;
  }

  const handleReload = () => {
    void updateManager.applyUpdate();
  };

  const handleDismiss = () => {
    updateManager.dismiss();
  };

  return (
    <aside
      className={`pwa-update-banner ${className}`.trim()}
      role="status"
      aria-live="polite"
      aria-label="Application update available"
    >
      <div className="pwa-update-content">
        <span className="pwa-update-msg">Update available</span>
        <div className="pwa-update-actions">
          <button
            type="button"
            className="btn small primary pwa-update-reload"
            onClick={handleReload}
            disabled={state.isUpdating}
            aria-label="Reload to update application"
          >
            {state.isUpdating ? 'Reloading…' : 'Reload'}
          </button>
          <button
            type="button"
            className="btn small pwa-update-dismiss"
            onClick={handleDismiss}
            disabled={state.isUpdating}
            aria-label="Dismiss update notification"
          >
            Dismiss
          </button>
        </div>
      </div>
    </aside>
  );
}
