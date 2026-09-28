import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BasemapSettingsPopover } from './BasemapSettingsPopover';

void React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('BasemapSettingsPopover', () => {
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

  it('renders nothing when closed', () => {
    render(
      <BasemapSettingsPopover
        isOpen={false}
        onClose={vi.fn()}
        styleUrl="https://tiles.openfreemap.org/styles/liberty"
        enabled={false}
        onToggleEnabled={vi.fn()}
        onChangeStyleUrl={vi.fn()}
        onResetStyleUrl={vi.fn()}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders popover controls and responds to user interactions when open', () => {
    const onClose = vi.fn();
    const onToggleEnabled = vi.fn();
    const onChangeStyleUrl = vi.fn();
    const onResetStyleUrl = vi.fn();
    const onToggleGeocoder = vi.fn();
    const onChangeGeocoderUrl = vi.fn();
    const onResetGeocoderUrl = vi.fn();

    render(
      <BasemapSettingsPopover
        isOpen={true}
        onClose={onClose}
        styleUrl="https://tiles.openfreemap.org/styles/liberty"
        enabled={false}
        onToggleEnabled={onToggleEnabled}
        onChangeStyleUrl={onChangeStyleUrl}
        onResetStyleUrl={onResetStyleUrl}
        geocoderUrl="https://nominatim.openstreetmap.org/search?format=jsonv2"
        geocoderEnabled={false}
        onToggleGeocoder={onToggleGeocoder}
        onChangeGeocoderUrl={onChangeGeocoderUrl}
        onResetGeocoderUrl={onResetGeocoderUrl}
      />,
    );

    const dialog = container.querySelector('[role="dialog"]') as HTMLElement | null;
    expect(dialog).not.toBeNull();
    expect(dialog?.textContent).toContain(
      'Sends your search text to nominatim.openstreetmap.org. No map image, coordinates, or project data is sent.',
    );

    const checkbox = container.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
    expect(checkbox).not.toBeNull();
    expect(checkbox?.checked).toBe(false);

    act(() => {
      checkbox?.click();
    });
    expect(onToggleEnabled).toHaveBeenCalledWith(true);

    const input = container.querySelector('input[type="text"]') as HTMLInputElement | null;
    expect(input).not.toBeNull();
    expect(input?.value).toBe('https://tiles.openfreemap.org/styles/liberty');

    act(() => {
      if (input) {
        input.value = 'https://custom-tiles.org/style.json';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });

    const resetBtn = container.querySelector(
      'button[aria-label="Reset to default"]',
    ) as HTMLButtonElement | null;
    act(() => resetBtn?.click());
    expect(onResetStyleUrl).toHaveBeenCalledTimes(1);

    const geocoderCheckbox = container.querySelector(
      'input[aria-label="Enable place search"]',
    ) as HTMLInputElement | null;
    expect(geocoderCheckbox).not.toBeNull();
    act(() => geocoderCheckbox?.click());
    expect(onToggleGeocoder).toHaveBeenCalledWith(true);

    const geocoderInput = container.querySelector(
      '#geocoder-service-url-input',
    ) as HTMLInputElement | null;
    expect(geocoderInput?.value).toBe('https://nominatim.openstreetmap.org/search?format=jsonv2');
    act(() => {
      if (geocoderInput) {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
          geocoderInput,
          'https://geo.example/search',
        );
        geocoderInput.dispatchEvent(new Event('input', { bubbles: true }));
      }
    });
    expect(onChangeGeocoderUrl).toHaveBeenCalledWith('https://geo.example/search');
    const resetGeocoder = container.querySelector(
      'button[aria-label="Reset geocoder to default"]',
    ) as HTMLButtonElement | null;
    act(() => resetGeocoder?.click());
    expect(onResetGeocoderUrl).toHaveBeenCalledTimes(1);

    const closeBtn = container.querySelector(
      'button[aria-label="Close settings"]',
    ) as HTMLButtonElement | null;
    act(() => closeBtn?.click());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on Escape key', () => {
    const onClose = vi.fn();
    render(
      <BasemapSettingsPopover
        isOpen={true}
        onClose={onClose}
        styleUrl="https://tiles.openfreemap.org/styles/liberty"
        enabled={true}
        onToggleEnabled={vi.fn()}
        onChangeStyleUrl={vi.fn()}
        onResetStyleUrl={vi.fn()}
      />,
    );

    const dialog = container.querySelector('[role="dialog"]') as HTMLElement | null;
    expect(dialog).not.toBeNull();
    expect(dialog?.getAttribute('aria-modal')).toBe('true');
    expect(dialog?.getAttribute('aria-labelledby')).toBe('basemap-settings-title');

    act(() => {
      dialog?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('traps focus while open and restores focus when closed', () => {
    const trigger = document.createElement('button');
    trigger.id = 'settings-trigger';
    document.body.appendChild(trigger);
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    render(
      <BasemapSettingsPopover
        isOpen={true}
        onClose={vi.fn()}
        styleUrl="https://tiles.openfreemap.org/styles/liberty"
        enabled={true}
        onToggleEnabled={vi.fn()}
        onChangeStyleUrl={vi.fn()}
        onResetStyleUrl={vi.fn()}
      />,
    );

    const closeBtn = container.querySelector('button[aria-label="Close settings"]') as HTMLElement;
    const resetBtn = container.querySelector('button[aria-label="Reset to default"]') as HTMLElement;

    expect(document.activeElement).toBe(closeBtn);

    // Focus last element
    resetBtn.focus();
    expect(document.activeElement).toBe(resetBtn);

    // Tab wraps around to first element (closeBtn)
    const tabEvent = new KeyboardEvent('keydown', {
      key: 'Tab',
      shiftKey: false,
      bubbles: true,
      cancelable: true,
    });
    document.dispatchEvent(tabEvent);
    expect(tabEvent.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(closeBtn);

    // Unmount/close returns focus to trigger
    render(
      <BasemapSettingsPopover
        isOpen={false}
        onClose={vi.fn()}
        styleUrl="https://tiles.openfreemap.org/styles/liberty"
        enabled={true}
        onToggleEnabled={vi.fn()}
        onChangeStyleUrl={vi.fn()}
        onResetStyleUrl={vi.fn()}
      />,
    );
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });
});
