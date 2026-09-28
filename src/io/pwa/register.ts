// Lane C. Service Worker registration and Cross-Origin Isolation coordinator (card T-310).
import { defaultUpdateManager, type UpdateManager } from './update';

export const COI_RELOAD_KEY = 'trailmaker:coi_reloaded';

export interface RegisterPwaOptions {
  /** Service worker script URL (defaults to '/sw.js'). */
  readonly swUrl?: string;
  /** Service worker scope (defaults to '/'). */
  readonly scope?: string;
  /** Custom UpdateManager instance. */
  readonly updateManager?: UpdateManager;
  /** Custom window location reload implementation. */
  readonly reload?: () => void;
  /** Whether service worker registration is enabled (defaults to true in production or when serviceWorker is present). */
  readonly enabled?: boolean;
}

export interface RegisterPwaResult {
  readonly registration: ServiceWorkerRegistration | null;
  readonly isIsolated: boolean;
  readonly unregister: () => Promise<boolean>;
}

/**
 * Registers the PWA service worker and handles the Cross-Origin Isolation (coi) reload loop guard.
 * If the current page is not crossOriginIsolated, waits for the service worker to take control
 * and reloads the page once so the service worker can serve responses with COOP/COEP headers.
 */
export function isProductionEnvironment(): boolean {
  try {
    if (typeof import.meta !== 'undefined' && import.meta.env) {
      return Boolean(import.meta.env.PROD);
    }
  } catch {
    // Ignore
  }
  return false;
}

export async function registerPwa(options: RegisterPwaOptions = {}): Promise<RegisterPwaResult> {
  const isIsolated = typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated;
  const updateManager = options.updateManager ?? defaultUpdateManager;
  const swUrl = options.swUrl ?? '/sw.js';
  const scope = options.scope ?? '/';
  const reload = options.reload ?? (() => window.location.reload());

  if (isIsolated && typeof sessionStorage !== 'undefined') {
    try {
      sessionStorage.removeItem(COI_RELOAD_KEY);
    } catch {
      // Ignore sessionStorage errors
    }
  }

  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
    return {
      registration: null,
      isIsolated,
      unregister: async () => false,
    };
  }

  const enabled = options.enabled ?? isProductionEnvironment();
  if (!enabled) {
    return {
      registration: null,
      isIsolated,
      unregister: async () => false,
    };
  }

  // Handle COI reload when not yet isolated
  if (!isIsolated) {
    const handleCoiReload = () => {
      let alreadyReloaded = false;
      try {
        alreadyReloaded = sessionStorage.getItem(COI_RELOAD_KEY) === '1';
      } catch {
        alreadyReloaded = false;
      }

      if (!alreadyReloaded) {
        try {
          sessionStorage.setItem(COI_RELOAD_KEY, '1');
        } catch {
          // Ignore
        }
        reload();
      }
    };

    if (navigator.serviceWorker.controller) {
      handleCoiReload();
    } else {
      navigator.serviceWorker.addEventListener('controllerchange', handleCoiReload, {
        once: true,
      });
    }
  }

  let registration: ServiceWorkerRegistration | null = null;
  try {
    registration = await navigator.serviceWorker.register(swUrl, { scope });
  } catch {
    // Service worker registration failed (e.g. unsupported protocol, private mode)
    return {
      registration: null,
      isIsolated,
      unregister: async () => false,
    };
  }

  // Supply registration and postMessage callback to the update manager
  updateManager.setRegistration?.(registration);
  updateManager.setPostMessageToWaitingWorker?.((msg: unknown) => {
    const worker =
      registration?.waiting ||
      (registration?.installing?.state === 'installed' ? registration.installing : null);
    if (worker) {
      worker.postMessage(msg);
    }
  });

  const notifyWaitingWorker = (
    worker: ServiceWorker | { postMessage: (msg: unknown) => void } | null
  ) => {
    if (worker) {
      updateManager.setWaitingWorker?.(worker);
      updateManager.setUpdateAvailable(true);
    }
  };

  // 1. If a worker is already waiting in this registration, notify immediately
  if (registration.waiting) {
    notifyWaitingWorker(registration.waiting);
  }

  // 2. Watch installing worker if one is currently in flight
  const watchInstallingWorker = (worker: ServiceWorker | null) => {
    if (!worker) return;
    worker.addEventListener('statechange', () => {
      // Only notify when installing transitions to installed and the page already has an active controller (an update, not initial install)
      if (worker.state === 'installed' && navigator.serviceWorker.controller) {
        notifyWaitingWorker(worker);
      }
    });
  };

  if (registration.installing) {
    watchInstallingWorker(registration.installing);
  }

  // 3. Listen for future update installations
  registration.addEventListener('updatefound', () => {
    watchInstallingWorker(registration?.installing ?? null);
  });

  // Expose PWA debug handle on window for testing/inspection
  if (typeof window !== 'undefined') {
    (
      window as unknown as {
        __trailmakerPwa?: {
          registration: ServiceWorkerRegistration;
          updateManager: UpdateManager;
          isIsolated: boolean;
        };
      }
    ).__trailmakerPwa = {
      registration,
      updateManager,
      isIsolated,
    };
  }

  return {
    registration,
    isIsolated,
    unregister: async () => {
      if (!registration) return false;
      return registration.unregister();
    },
  };
}
