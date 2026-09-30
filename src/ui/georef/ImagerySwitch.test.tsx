import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ImagerySwitch } from './ImagerySwitch';

void React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('ImagerySwitch (card T-316)', () => {
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

  it('renders Map and Satellite buttons with proper active states', () => {
    const onChange = vi.fn();
    render(<ImagerySwitch imagery="vector" onChange={onChange} isOnline={true} />);

    const buttons = container.querySelectorAll('button');
    expect(buttons).toHaveLength(2);

    const mapBtn = buttons[0]!;
    const satBtn = buttons[1]!;

    expect(mapBtn.textContent?.trim()).toBe('Map');
    expect(mapBtn.classList.contains('active')).toBe(true);
    expect(mapBtn.getAttribute('aria-pressed')).toBe('true');

    expect(satBtn.textContent?.trim()).toBe('Satellite');
    expect(satBtn.classList.contains('active')).toBe(false);
    expect(satBtn.getAttribute('aria-pressed')).toBe('false');
    expect(satBtn.disabled).toBe(false);
  });

  it('calls onChange with "satellite" when Satellite button is clicked', () => {
    const onChange = vi.fn();
    render(<ImagerySwitch imagery="vector" onChange={onChange} isOnline={true} />);

    const satBtn = container.querySelectorAll('button')[1]!;
    act(() => satBtn.click());

    expect(onChange).toHaveBeenCalledWith('satellite');
  });

  it('calls onChange with "vector" when Map button is clicked', () => {
    const onChange = vi.fn();
    render(<ImagerySwitch imagery="satellite" onChange={onChange} isOnline={true} />);

    const mapBtn = container.querySelectorAll('button')[0]!;
    act(() => mapBtn.click());

    expect(onChange).toHaveBeenCalledWith('vector');
  });

  it('shows clear "Satellite needs a connection" state when offline (Acceptance 5)', () => {
    const onChange = vi.fn();
    render(<ImagerySwitch imagery="vector" onChange={onChange} isOnline={false} />);

    const satBtn = container.querySelectorAll('button')[1]!;
    expect(satBtn.disabled).toBe(true);
    expect(satBtn.title).toBe('Satellite needs a connection');

    const notice = container.querySelector('.trailmaker-imagery-offline-notice');
    expect(notice).not.toBeNull();
    expect(notice?.textContent).toBe('Satellite needs a connection');

    // Attempting to click disabled satellite button must not trigger onChange
    act(() => satBtn.click());
    expect(onChange).not.toHaveBeenCalled();

    // Map button should still be clickable
    const mapBtn = container.querySelectorAll('button')[0]!;
    expect(mapBtn.disabled).toBe(false);
    act(() => mapBtn.click());
    expect(onChange).toHaveBeenCalledWith('vector');
  });
});
