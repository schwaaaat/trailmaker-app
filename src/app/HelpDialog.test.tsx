import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appStore, setHelpOpen } from '../state/store';
import { HelpDialog } from './HelpDialog';

void React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

function render() {
  act(() => root.render(<HelpDialog />));
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  setHelpOpen(false);
});

const fire = (target: EventTarget, key: string, shiftKey = false) => {
  act(() => {
    target.dispatchEvent(
      new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true }),
    );
  });
};

describe('help dialog (T-215)', () => {
  it('renders nothing while closed', () => {
    render();
    expect(host.querySelector('[role="dialog"]')).toBeNull();
  });

  it('opens with the tool shortcuts and a Close button, focused first', () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    setHelpOpen(true);
    render();
    const dialog = host.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.textContent).toContain('Select and move');
    expect(dialog?.textContent).toContain(', / .');
    expect(dialog?.textContent).toContain('Backslash');
    expect(dialog?.textContent).toContain('Collapse or expand the steps panel on desktop');
    expect(dialog?.textContent).toContain('Points and splitting');
    expect(document.activeElement?.textContent).toBe('Close');
    opener.remove();
  });

  it('Escape closes it and returns focus to the opener', () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    setHelpOpen(true);
    render();
    fire(document, 'Escape');
    expect(appStore.getState().helpOpen).toBe(false);
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it('Tab does not move focus out of the dialog while it is open', () => {
    setHelpOpen(true);
    render();
    const close = document.activeElement as HTMLElement;
    expect(close.textContent).toBe('Close');
    fire(document, 'Tab');
    expect(host.contains(document.activeElement)).toBe(true);
    // Tabbing from the last element (Reset interface…) wraps back to Close
    const lastBtn = host.querySelector('.btn-reset-interface') as HTMLElement;
    lastBtn.focus();
    fire(document, 'Tab');
    expect(document.activeElement).toBe(close);
  });

  it('renders Reset interface action and handles confirmation step (Acceptance 1)', () => {
    const onResetInterface = vi.fn();
    setHelpOpen(true);
    act(() => root.render(<HelpDialog onResetInterface={onResetInterface} />));

    const resetBtn = host.querySelector('.btn-reset-interface') as HTMLButtonElement | null;
    expect(resetBtn).not.toBeNull();
    expect(resetBtn?.textContent).toContain('Reset interface');

    // Click Reset interface to show confirmation step
    act(() => {
      resetBtn?.click();
    });

    const confirmBox = host.querySelector('.reset-interface-confirm') as HTMLElement | null;
    expect(confirmBox).not.toBeNull();
    expect(confirmBox?.textContent).toContain('Reset interface to defaults?');
    expect(confirmBox?.textContent).toContain('Live basemap and geocoder permissions');
    expect(confirmBox?.textContent).toContain('Basemap style, imagery (Map/Satellite), provider');
    expect(confirmBox?.textContent).toContain('Split layout, pane widths, and mode');
    expect(confirmBox?.textContent).toContain('Stage view tabs and collapsed hints');
    expect(confirmBox?.textContent).toContain(
      'Your project, map images, traced trails, and saved files are not touched.',
    );

    // Cancel returns to shortcuts list
    const cancelBtn = host.querySelector('.btn-cancel-reset') as HTMLButtonElement | null;
    expect(cancelBtn).not.toBeNull();
    act(() => {
      cancelBtn?.click();
    });

    expect(host.querySelector('.reset-interface-confirm')).toBeNull();
    expect(host.querySelector('.btn-reset-interface')).not.toBeNull();
    expect(onResetInterface).not.toHaveBeenCalled();

    // Re-open confirmation and confirm reset
    const resetBtnAgain = host.querySelector('.btn-reset-interface') as HTMLButtonElement | null;
    act(() => {
      resetBtnAgain?.click();
    });

    const confirmResetBtn = host.querySelector('.btn-confirm-reset') as HTMLButtonElement | null;
    expect(confirmResetBtn).not.toBeNull();
    act(() => {
      confirmResetBtn?.click();
    });

    expect(onResetInterface).toHaveBeenCalledTimes(1);
    expect(appStore.getState().helpOpen).toBe(false);
  });
});
