import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
    fire(document, 'Tab');
    expect(host.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(close);
  });
});
