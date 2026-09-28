/** @jsxRuntime automatic */
// Lane B. Toast and busy overlay (prototype #toast / #busy), driven by the store.
import { useEffect } from 'react';
import { useApp } from '../state/hooks';
import { appStore, clearToast } from '../state/store';

export function Toast() {
  const toast = useApp((s) => s.toast);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => {
      // Only clear the toast this timer was for; a newer one keeps its own timer.
      if (appStore.getState().toast?.id === toast.id) clearToast();
    }, toast.ms);
    return () => clearTimeout(timer);
  }, [toast]);
  return (
    <div className={toast ? 'toast show' : 'toast'} role="status" aria-live="polite">
      {toast?.message ?? ''}
    </div>
  );
}

export function Busy() {
  const busy = useApp((s) => s.busy);
  const cancel = useApp((s) => s.busyCancel ?? null);
  return (
    <div className="busy" hidden={busy === null}>
      <div className="busy-box">
        <span role="status" aria-live="polite">
          {busy}
        </span>
        {cancel ? (
          <button type="button" className="btn small" onClick={cancel}>
            Cancel
          </button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * App-wide polite live region (T-215): undo/redo and vertex-focus changes. Always mounted, not
 * `hidden` like Busy's box above -- an aria-live region has to already be in the accessibility
 * tree before its text changes for most screen readers to announce it.
 */
export function LiveRegion() {
  const text = useApp((s) => s.announcement?.text ?? '');
  return (
    <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
      {text}
    </div>
  );
}
