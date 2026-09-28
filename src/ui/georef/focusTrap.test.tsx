// Lane C. Unit tests for focusTrap (card T-311, Acceptance 1).
import React, { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getFocusableElements, useFocusTrap } from './focusTrap';

void React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function TestDialog({
  isOpen,
  onClose,
  initialFocusInput = false,
}: {
  isOpen: boolean;
  onClose?: () => void;
  initialFocusInput?: boolean;
}) {
  const containerRef = createRef<HTMLDivElement>();
  const inputRef = createRef<HTMLInputElement>();

  useFocusTrap({
    active: isOpen,
    containerRef,
    onClose,
    initialFocusRef: initialFocusInput ? inputRef : undefined,
  });

  if (!isOpen) return null;

  return (
    <div ref={containerRef} role="dialog" aria-modal="true">
      <button type="button" id="btn1">
        First
      </button>
      <input ref={inputRef} type="text" id="input1" aria-label="Input field" />
      <button type="button" id="btn2">
        Last
      </button>
      <button type="button" id="btnDisabled" disabled>
        Disabled
      </button>
    </div>
  );
}

describe('focusTrap', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    document.body.innerHTML = '';
  });

  describe('getFocusableElements', () => {
    it('finds enabled focusable controls and ignores disabled or hidden controls', () => {
      const wrapper = document.createElement('div');
      wrapper.innerHTML = `
        <button id="b1">Button 1</button>
        <button id="bDisabled" disabled>Disabled</button>
        <input id="i1" type="text" />
        <select id="s1"><option>1</option></select>
        <textarea id="t1"></textarea>
        <a id="a1" href="#link">Link</a>
        <a id="aNoHref">No Href</a>
        <div id="d1" tabindex="0">Tabindex 0</div>
        <div id="d2" tabindex="-1">Tabindex -1</div>
        <div id="d3" aria-hidden="true"><button id="bHidden">Hidden</button></div>
      `;
      document.body.appendChild(wrapper);

      const focusables = getFocusableElements(wrapper);
      const ids = focusables.map((el) => el.id);

      expect(ids).toEqual(['b1', 'i1', 's1', 't1', 'a1', 'd1']);
      wrapper.remove();
    });

    it('returns empty array when container is null', () => {
      expect(getFocusableElements(null)).toEqual([]);
    });
  });

  describe('useFocusTrap', () => {
    it('auto-focuses first element on open and restores focus on close', () => {
      const triggerBtn = document.createElement('button');
      triggerBtn.id = 'trigger';
      document.body.appendChild(triggerBtn);
      triggerBtn.focus();
      expect(document.activeElement).toBe(triggerBtn);

      act(() => {
        root.render(<TestDialog isOpen={true} />);
      });

      const btn1 = container.querySelector('#btn1') as HTMLElement;
      expect(document.activeElement).toBe(btn1);

      act(() => {
        root.render(<TestDialog isOpen={false} />);
      });

      expect(document.activeElement).toBe(triggerBtn);
      triggerBtn.remove();
    });

    it('respects initialFocusRef if provided', () => {
      act(() => {
        root.render(<TestDialog isOpen={true} initialFocusInput={true} />);
      });

      const input1 = container.querySelector('#input1') as HTMLElement;
      expect(document.activeElement).toBe(input1);
    });

    it('traps Tab from last element to first element', () => {
      act(() => {
        root.render(<TestDialog isOpen={true} />);
      });

      const btn1 = container.querySelector('#btn1') as HTMLElement;
      const btn2 = container.querySelector('#btn2') as HTMLElement;

      btn2.focus();
      expect(document.activeElement).toBe(btn2);

      const tabEvent = new KeyboardEvent('keydown', {
        key: 'Tab',
        shiftKey: false,
        bubbles: true,
        cancelable: true,
      });
      document.dispatchEvent(tabEvent);

      expect(tabEvent.defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(btn1);
    });

    it('traps Shift+Tab from first element to last element', () => {
      act(() => {
        root.render(<TestDialog isOpen={true} />);
      });

      const btn1 = container.querySelector('#btn1') as HTMLElement;
      const btn2 = container.querySelector('#btn2') as HTMLElement;

      btn1.focus();
      expect(document.activeElement).toBe(btn1);

      const shiftTabEvent = new KeyboardEvent('keydown', {
        key: 'Tab',
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      });
      document.dispatchEvent(shiftTabEvent);

      expect(shiftTabEvent.defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(btn2);
    });

    it('calls onClose on Escape key', () => {
      const onClose = vi.fn();
      act(() => {
        root.render(<TestDialog isOpen={true} onClose={onClose} />);
      });

      const escEvent = new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      });
      document.dispatchEvent(escEvent);

      expect(escEvent.defaultPrevented).toBe(true);
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });
});
