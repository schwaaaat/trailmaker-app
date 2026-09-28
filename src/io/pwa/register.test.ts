import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { COI_RELOAD_KEY, registerPwa } from './register';
import { createUpdateManager } from './update';

interface MockRegistration {
  waiting: { postMessage: (msg: unknown) => void } | null;
  installing: { addEventListener: (event: string, cb: () => void) => void; state?: string } | null;
  active: unknown;
  unregister: Mock;
  addEventListener: Mock;
}

interface MockServiceWorkerContainer {
  controller: unknown;
  register: Mock;
  addEventListener: Mock;
  removeEventListener: Mock;
}

describe('registerPwa', () => {
  let mockServiceWorker: MockServiceWorkerContainer;
  let mockRegistration: MockRegistration;

  beforeEach(() => {
    mockRegistration = {
      waiting: null,
      installing: null,
      active: null,
      unregister: vi.fn().mockResolvedValue(true),
      addEventListener: vi.fn(),
    };

    mockServiceWorker = {
      controller: null,
      register: vi.fn().mockResolvedValue(mockRegistration),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };

    Object.defineProperty(globalThis.navigator, 'serviceWorker', {
      value: mockServiceWorker,
      configurable: true,
      writable: true,
    });

    sessionStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('bypasses registration when enabled is false', async () => {
    const res = await registerPwa({ enabled: false });
    expect(res.registration).toBeNull();
    expect(mockServiceWorker.register).not.toHaveBeenCalled();
  });

  it('registers sw.js with scope by default', async () => {
    const res = await registerPwa({ enabled: true });
    expect(mockServiceWorker.register).toHaveBeenCalledWith('/sw.js', { scope: '/' });
    expect(res.registration).toBe(mockRegistration);
  });

  it('detects already-waiting worker, notifies updateManager, and sends SKIP_WAITING on applyUpdate', async () => {
    const updateManager = createUpdateManager();
    const waitingPostMessage = vi.fn();
    mockRegistration.waiting = { postMessage: waitingPostMessage };

    await registerPwa({ enabled: true, updateManager });
    expect(updateManager.getState().updateAvailable).toBe(true);

    await updateManager.applyUpdate();
    expect(waitingPostMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
  });

  it('wires installing worker to updateManager when new version is installed over existing controller', async () => {
    sessionStorage.setItem(COI_RELOAD_KEY, '1');
    mockServiceWorker.controller = {};
    const reload = vi.fn();
    const updateManager = createUpdateManager({ reloadWindow: reload });

    let stateChangeHandler: (() => void) | null = null;
    const installingWorker = {
      state: 'installing',
      postMessage: vi.fn(),
      addEventListener: vi.fn((event: string, cb: () => void) => {
        if (event === 'statechange') {
          stateChangeHandler = cb;
        }
      }),
    };
    mockRegistration.installing = installingWorker;

    await registerPwa({ enabled: true, updateManager, reload });
    expect(updateManager.getState().updateAvailable).toBe(false);

    // Transition installing worker to 'installed'
    installingWorker.state = 'installed';
    expect(stateChangeHandler).not.toBeNull();
    stateChangeHandler!();

    expect(updateManager.getState().updateAvailable).toBe(true);

    // User triggers reload update
    let controllerChangeHandler: (() => void) | null = null;
    mockServiceWorker.addEventListener.mockImplementation((event: string, cb: () => void) => {
      if (event === 'controllerchange') controllerChangeHandler = cb;
    });

    const updatePromise = updateManager.applyUpdate();
    expect(installingWorker.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' });

    // Worker activates and claims clients -> fires controllerchange
    if (controllerChangeHandler) {
      (controllerChangeHandler as () => void)();
    }
    await updatePromise;
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('does not flag updateAvailable during initial install without existing controller', async () => {
    mockServiceWorker.controller = null;
    const updateManager = createUpdateManager();

    let stateChangeHandler: (() => void) | null = null;
    const installingWorker = {
      state: 'installing',
      postMessage: vi.fn(),
      addEventListener: vi.fn((event: string, cb: () => void) => {
        if (event === 'statechange') stateChangeHandler = cb;
      }),
    };
    mockRegistration.installing = installingWorker;

    await registerPwa({ enabled: true, updateManager });
    installingWorker.state = 'installed';
    if (stateChangeHandler) {
      (stateChangeHandler as () => void)();
    }

    expect(updateManager.getState().updateAvailable).toBe(false);
  });

  it('exposes __trailmakerPwa on window for testing and diagnostics', async () => {
    const updateManager = createUpdateManager();
    await registerPwa({ enabled: true, updateManager });

    const pwaHook = (
      window as unknown as {
        __trailmakerPwa?: { registration: MockRegistration; updateManager: unknown };
      }
    ).__trailmakerPwa;
    expect(pwaHook).toBeDefined();
    expect(pwaHook?.registration).toBe(mockRegistration);
    expect(pwaHook?.updateManager).toBe(updateManager);
  });

  it('handles registration failure gracefully without unhandled error', async () => {
    mockServiceWorker.register.mockRejectedValue(new Error('Failed to register'));
    const res = await registerPwa({ enabled: true });
    expect(res.registration).toBeNull();
  });
});
