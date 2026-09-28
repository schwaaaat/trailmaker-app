import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createUpdateManager } from './update';
import { registerPwa } from './register';
import { UpdatePrompt } from './UpdatePrompt';

void React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('UpdatePrompt', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render(node: React.ReactNode): void {
    act(() => root.render(node));
  }

  it('renders nothing when no update is available', () => {
    const manager = createUpdateManager();
    render(<UpdatePrompt updateManager={manager} />);
    expect(container.querySelector('.pwa-update-banner')).toBeNull();
  });

  it('renders update banner with accessible controls when update is available', () => {
    const manager = createUpdateManager();
    manager.setUpdateAvailable(true);

    render(<UpdatePrompt updateManager={manager} />);

    const banner = container.querySelector('.pwa-update-banner');
    expect(banner).not.toBeNull();
    expect(banner?.getAttribute('role')).toBe('status');
    expect(banner?.getAttribute('aria-live')).toBe('polite');
    expect(banner?.textContent).toContain('Update available');

    const reloadBtn = container.querySelector('.pwa-update-reload') as HTMLButtonElement;
    const dismissBtn = container.querySelector('.pwa-update-dismiss') as HTMLButtonElement;
    expect(reloadBtn).not.toBeNull();
    expect(dismissBtn).not.toBeNull();
    expect(reloadBtn.getAttribute('aria-label')).toBe('Reload to update application');
    expect(dismissBtn.getAttribute('aria-label')).toBe('Dismiss update notification');
  });

  it('dismisses the notification when Dismiss button is clicked', () => {
    const manager = createUpdateManager();
    manager.setUpdateAvailable(true);

    render(<UpdatePrompt updateManager={manager} />);
    const dismissBtn = container.querySelector('.pwa-update-dismiss') as HTMLButtonElement;

    act(() => {
      dismissBtn.click();
    });

    expect(manager.getState().dismissed).toBe(true);
    expect(container.querySelector('.pwa-update-banner')).toBeNull();
  });

  it('calls applyUpdate and disables buttons when Reload button is clicked', () => {
    const reload = vi.fn();
    const manager = createUpdateManager({ reloadWindow: reload });
    manager.setUpdateAvailable(true);

    render(<UpdatePrompt updateManager={manager} />);
    const reloadBtn = container.querySelector('.pwa-update-reload') as HTMLButtonElement;

    act(() => {
      reloadBtn.click();
    });

    expect(manager.getState().isUpdating).toBe(true);
    expect(reloadBtn.textContent).toBe('Reloading…');
    expect(reloadBtn.disabled).toBe(true);
  });

  it('wires full update lifecycle from registration through UI banner and worker activation', async () => {
    sessionStorage.setItem('trailmaker:coi_reloaded', '1');
    const reload = vi.fn();
    let controllerChangeHandler: (() => void) | null = null;
    const mockServiceWorker = {
      controller: {},
      register: vi.fn(),
      addEventListener: vi.fn((event: string, cb: () => void) => {
        if (event === 'controllerchange') controllerChangeHandler = cb;
      }),
      removeEventListener: vi.fn(),
    };
    Object.defineProperty(globalThis.navigator, 'serviceWorker', {
      value: mockServiceWorker,
      configurable: true,
      writable: true,
    });

    const waitingWorker = {
      postMessage: vi.fn(),
    };
    const mockRegistration = {
      waiting: waitingWorker,
      installing: null,
      active: {},
      unregister: vi.fn().mockResolvedValue(true),
      addEventListener: vi.fn(),
    };
    mockServiceWorker.register.mockResolvedValue(mockRegistration);

    const manager = createUpdateManager({ reloadWindow: reload });
    render(<UpdatePrompt updateManager={manager} />);
    expect(container.querySelector('.pwa-update-banner')).toBeNull();

    // Register PWA with waiting worker
    await act(async () => {
      await registerPwa({ enabled: true, updateManager: manager, reload });
    });

    // Banner should now be visible in DOM
    const banner = container.querySelector('.pwa-update-banner');
    expect(banner).not.toBeNull();
    const reloadBtn = container.querySelector('.pwa-update-reload') as HTMLButtonElement;
    expect(reloadBtn).not.toBeNull();

    // User clicks reload
    act(() => {
      reloadBtn.click();
    });

    expect(waitingWorker.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
    expect(reload).not.toHaveBeenCalled();

    // Service worker activates and fires controllerchange
    act(() => {
      if (controllerChangeHandler) {
        controllerChangeHandler();
      }
    });

    expect(reload).toHaveBeenCalledTimes(1);
  });
});
