// Lane C. Accessible focus trap hook and helpers for dialogs (card T-311, Acceptance 1).
import { useEffect, type RefObject } from 'react';

const FOCUSABLE_SELECTOR = [
  'button:not([disabled])',
  '[href]',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

/**
 * Returns all reachable, focusable HTML elements inside a container.
 */
export function getFocusableElements(container: HTMLElement | null): HTMLElement[] {
  if (!container) return [];
  const elements = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
  return elements.filter((el) => {
    if (el.hasAttribute('disabled')) return false;
    if (el.closest('[aria-hidden="true"]')) return false;
    if (el.closest('[hidden]')) return false;
    return true;
  });
}

export interface UseFocusTrapOptions {
  readonly active: boolean;
  readonly containerRef: RefObject<HTMLElement | null>;
  readonly onClose?: (() => void) | undefined;
  readonly initialFocusRef?: RefObject<HTMLElement | null> | undefined;
}

/**
 * Traps keyboard focus within container while active, closes on Escape,
 * and restores focus to the previously active element on close.
 */
export function useFocusTrap({
  active,
  containerRef,
  onClose,
  initialFocusRef,
}: UseFocusTrapOptions): void {
  useEffect(() => {
    if (!active) return;

    const previousActive =
      typeof document !== 'undefined' ? (document.activeElement as HTMLElement | null) : null;

    // Focus the initial element or first focusable element inside the container
    const container = containerRef.current;
    if (container) {
      const focusables = getFocusableElements(container);
      const target = initialFocusRef?.current ?? focusables[0] ?? container;
      if (typeof target.focus === 'function') {
        target.focus();
      }
    }

    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        if (onClose) {
          e.preventDefault();
          e.stopPropagation();
          onClose();
        }
        return;
      }

      if (e.key === 'Tab') {
        const currentContainer = containerRef.current;
        if (!currentContainer) return;

        const focusables = getFocusableElements(currentContainer);
        if (focusables.length === 0) {
          e.preventDefault();
          currentContainer.focus();
          return;
        }

        const first = focusables[0]!;
        const last = focusables[focusables.length - 1]!;

        if (e.shiftKey) {
          if (
            document.activeElement === first ||
            !currentContainer.contains(document.activeElement)
          ) {
            e.preventDefault();
            last.focus();
          }
        } else {
          if (
            document.activeElement === last ||
            !currentContainer.contains(document.activeElement)
          ) {
            e.preventDefault();
            first.focus();
          }
        }
      }
    };

    document.addEventListener('keydown', handleKeyDown, true);

    return () => {
      document.removeEventListener('keydown', handleKeyDown, true);
      if (
        previousActive &&
        typeof previousActive.focus === 'function' &&
        document.contains(previousActive)
      ) {
        previousActive.focus();
      }
    };
  }, [active, containerRef, onClose, initialFocusRef]);
}
