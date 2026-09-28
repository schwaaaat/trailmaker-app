import { describe, expect, it, vi } from 'vitest';
import { createUpdateManager, type UpdateState } from './update';

describe('createUpdateManager', () => {
  it('initializes with default clean state', () => {
    const manager = createUpdateManager();
    expect(manager.getState()).toEqual({
      updateAvailable: false,
      isUpdating: false,
      dismissed: false,
    });
  });

  it('notifies subscribers of state changes', () => {
    const manager = createUpdateManager();
    const states: UpdateState[] = [];
    const unsubscribe = manager.subscribe((s) => states.push(s));

    manager.setUpdateAvailable(true);
    expect(manager.getState().updateAvailable).toBe(true);
    expect(states.length).toBe(2); // initial + change

    unsubscribe();
    manager.setUpdateAvailable(false);
    expect(states.length).toBe(2); // no more notifications after unsubscribe
  });

  it('allows dismissing an update notice', () => {
    const manager = createUpdateManager();
    manager.setUpdateAvailable(true);
    expect(manager.getState().dismissed).toBe(false);

    manager.dismiss();
    expect(manager.getState().dismissed).toBe(true);

    // If new update arrives later, dismissed is reset
    manager.setUpdateAvailable(false);
    manager.setUpdateAvailable(true);
    expect(manager.getState().dismissed).toBe(false);
  });

  it('applyUpdate posts SKIP_WAITING to waiting worker and reloads on controller change', async () => {
    const postMessage = vi.fn();
    const reload = vi.fn();
    let triggerControllerChange = () => {};
    const onControllerChange = vi.fn((cb: () => void) => {
      triggerControllerChange = cb;
      return () => {
        triggerControllerChange = () => {};
      };
    });

    const manager = createUpdateManager({
      postMessageToWaitingWorker: postMessage,
      reloadWindow: reload,
      onControllerChange,
    });

    manager.setUpdateAvailable(true);
    const promise = manager.applyUpdate();

    expect(manager.getState().isUpdating).toBe(true);
    expect(postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
    expect(onControllerChange).toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();

    // Trigger controller change
    triggerControllerChange();
    await promise;

    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('applyUpdate uses fallback timeout if controller change does not fire', async () => {
    vi.useFakeTimers();
    try {
      const postMessage = vi.fn();
      const reload = vi.fn();
      const onControllerChange = vi.fn(() => () => {});

      const manager = createUpdateManager({
        postMessageToWaitingWorker: postMessage,
        reloadWindow: reload,
        onControllerChange,
      });

      void manager.applyUpdate();
      expect(reload).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1300);
      expect(reload).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not re-invoke applyUpdate while isUpdating is already true', async () => {
    const reload = vi.fn();
    const manager = createUpdateManager({ reloadWindow: reload });

    void manager.applyUpdate();
    void manager.applyUpdate();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('posts SKIP_WAITING to waiting worker provided via setWaitingWorker', async () => {
    const reload = vi.fn();
    const mockWorker = { postMessage: vi.fn() };
    const manager = createUpdateManager({ reloadWindow: reload });

    manager.setWaitingWorker(mockWorker);
    manager.setUpdateAvailable(true);
    await manager.applyUpdate();

    expect(mockWorker.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('posts SKIP_WAITING to registration.waiting provided via setRegistration', async () => {
    const reload = vi.fn();
    const mockWaiting = { postMessage: vi.fn() };
    const mockRegistration = {
      waiting: mockWaiting,
    } as unknown as ServiceWorkerRegistration;
    const manager = createUpdateManager({ reloadWindow: reload });

    manager.setRegistration(mockRegistration);
    manager.setUpdateAvailable(true);
    await manager.applyUpdate();

    expect(mockWaiting.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('posts SKIP_WAITING to custom callback set via setPostMessageToWaitingWorker', async () => {
    const reload = vi.fn();
    const customPostMessage = vi.fn();
    const manager = createUpdateManager({ reloadWindow: reload });

    manager.setPostMessageToWaitingWorker(customPostMessage);
    manager.setUpdateAvailable(true);
    await manager.applyUpdate();

    expect(customPostMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('aborts applyUpdate if user cancels confirmation when unsaved work exists', async () => {
    const reload = vi.fn();
    const hasUnsaved = vi.fn(() => true);
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const manager = createUpdateManager({ reloadWindow: reload, hasUnsavedWork: hasUnsaved });

    await manager.applyUpdate();

    expect(hasUnsaved).toHaveBeenCalled();
    expect(confirmSpy).toHaveBeenCalled();
    expect(manager.getState().isUpdating).toBe(false);
    expect(reload).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it('proceeds with applyUpdate when user confirms unsaved work prompt', async () => {
    const reload = vi.fn();
    const hasUnsaved = vi.fn(() => true);
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const manager = createUpdateManager({ reloadWindow: reload, hasUnsavedWork: hasUnsaved });

    await manager.applyUpdate();

    expect(hasUnsaved).toHaveBeenCalled();
    expect(confirmSpy).toHaveBeenCalled();
    expect(manager.getState().isUpdating).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
    confirmSpy.mockRestore();
  });
});
