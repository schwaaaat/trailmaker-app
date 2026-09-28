// Lane C. PWA update prompt state management (card T-310, Acceptance 5).

export interface UpdateState {
  /** True when a new service worker is installed and waiting to activate. */
  readonly updateAvailable: boolean;
  /** True when the update action has been initiated by the user. */
  readonly isUpdating: boolean;
  /** True if the user dismissed the notification prompt for the current session. */
  readonly dismissed: boolean;
}

export interface UpdateManagerOptions {
  readonly postMessageToWaitingWorker?: (msg: unknown) => void;
  readonly reloadWindow?: () => void;
  readonly onControllerChange?: (cb: () => void) => () => void;
  readonly hasUnsavedWork?: () => boolean;
}

export interface UpdateManager {
  getState(): UpdateState;
  subscribe(listener: (state: UpdateState) => void): () => void;
  setUpdateAvailable(available: boolean): void;
  setWaitingWorker(worker: { postMessage: (msg: unknown) => void } | null): void;
  setRegistration(registration: ServiceWorkerRegistration | null): void;
  setPostMessageToWaitingWorker(fn: ((msg: unknown) => void) | null): void;
  setOnControllerChange(fn: ((cb: () => void) => () => void) | null): void;
  setHasUnsavedWork(fn: (() => boolean) | null): void;
  applyUpdate(): Promise<void>;
  dismiss(): void;
  reset(): void;
}

export function createUpdateManager(options: UpdateManagerOptions = {}): UpdateManager {
  let state: UpdateState = {
    updateAvailable: false,
    isUpdating: false,
    dismissed: false,
  };

  let postMessage = options.postMessageToWaitingWorker ?? null;
  let onControllerChange = options.onControllerChange ?? null;
  let hasUnsavedWorkCallback = options.hasUnsavedWork ?? null;
  let waitingWorker: { postMessage: (msg: unknown) => void } | null = null;
  let registration: ServiceWorkerRegistration | null = null;

  const reload = options.reloadWindow ?? (() => {
    if (typeof window !== 'undefined') {
      window.location.reload();
    }
  });

  const listeners = new Set<(s: UpdateState) => void>();

  function notify(): void {
    for (const listener of listeners) {
      try {
        listener(state);
      } catch {
        // Suppress listener errors
      }
    }
  }

  function setState(patch: Partial<UpdateState>): void {
    state = { ...state, ...patch };
    notify();
  }

  return {
    getState(): UpdateState {
      return state;
    },

    subscribe(listener: (s: UpdateState) => void): () => void {
      listeners.add(listener);
      listener(state);
      return () => {
        listeners.delete(listener);
      };
    },

    setUpdateAvailable(available: boolean): void {
      if (state.updateAvailable === available) return;
      setState({
        updateAvailable: available,
        // Reset dismissed flag if a fresh update is discovered
        dismissed: available ? false : state.dismissed,
      });
    },

    setWaitingWorker(worker: { postMessage: (msg: unknown) => void } | null): void {
      waitingWorker = worker;
    },

    setRegistration(reg: ServiceWorkerRegistration | null): void {
      registration = reg;
      if (reg?.waiting) {
        waitingWorker = reg.waiting;
      }
    },

    setPostMessageToWaitingWorker(fn: ((msg: unknown) => void) | null): void {
      postMessage = fn;
    },

    setOnControllerChange(fn: ((cb: () => void) => () => void) | null): void {
      onControllerChange = fn;
    },

    setHasUnsavedWork(fn: (() => boolean) | null): void {
      hasUnsavedWorkCallback = fn;
    },

    async applyUpdate(): Promise<void> {
      if (state.isUpdating) return;

      if (hasUnsavedWorkCallback?.()) {
        const confirmed =
          typeof window !== 'undefined' && typeof window.confirm === 'function'
            ? window.confirm('You have unsaved changes. Discard and update to the new version?')
            : true;
        if (!confirmed) {
          return;
        }
      }

      setState({ isUpdating: true });

      // Target the waiting worker
      const targetWorker = waitingWorker ?? registration?.waiting ?? null;

      // Post SKIP_WAITING to waiting service worker
      if (postMessage) {
        postMessage({ type: 'SKIP_WAITING' });
      } else if (targetWorker && typeof targetWorker.postMessage === 'function') {
        targetWorker.postMessage({ type: 'SKIP_WAITING' });
      }

      let reloaded = false;
      const doReload = () => {
        if (!reloaded) {
          reloaded = true;
          reload();
        }
      };

      // If a controllerchange listener was provided, wait for controller to swap, else reload
      if (onControllerChange) {
        let unsubscribe: (() => void) | null = null;
        unsubscribe = onControllerChange(doReload);

        // Fallback safety timeout in case controllerchange event is suppressed
        setTimeout(() => {
          if (!reloaded) {
            if (unsubscribe) {
              unsubscribe();
              unsubscribe = null;
            }
            doReload();
          }
        }, 1200);
      } else if (
        typeof navigator !== 'undefined' &&
        'serviceWorker' in navigator &&
        navigator.serviceWorker
      ) {
        navigator.serviceWorker.addEventListener('controllerchange', doReload, { once: true });
        setTimeout(doReload, 1200);
      } else {
        doReload();
      }
    },

    dismiss(): void {
      if (state.dismissed) return;
      setState({ dismissed: true });
    },

    reset(): void {
      state = {
        updateAvailable: false,
        isUpdating: false,
        dismissed: false,
      };
      notify();
    },
  };
}

/** Global default update manager instance for the app. */
export const defaultUpdateManager = createUpdateManager();
