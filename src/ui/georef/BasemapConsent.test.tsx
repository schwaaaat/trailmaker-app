import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BasemapConsent, getStyleHost } from './BasemapConsent';

void React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('BasemapConsent', () => {
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

  it('correctly parses style host from various URLs', () => {
    expect(getStyleHost('https://tiles.openfreemap.org/styles/liberty')).toBe(
      'tiles.openfreemap.org',
    );
    expect(getStyleHost('https://tile.openstreetmap.org/{z}/{x}/{y}.png')).toBe(
      'tile.openstreetmap.org',
    );
    expect(getStyleHost('/__test_basemap/style.json')).toBe(window.location.host);
  });

  it('renders consent panel with required privacy explanation and buttons', () => {
    const onEnable = vi.fn();
    const onDismiss = vi.fn();

    render(
      <BasemapConsent
        styleUrl="https://tiles.openfreemap.org/styles/liberty"
        onEnable={onEnable}
        onDismiss={onDismiss}
      />,
    );

    const dialog = container.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.textContent).toContain(
      'Shows a live map from tiles.openfreemap.org. Your map image and trails stay on this device; the tile server sees which area you view.',
    );

    const enableBtn = container.querySelector(
      'button[aria-label="Enable basemap"]',
    ) as HTMLButtonElement | null;
    const notNowBtn = container.querySelector(
      'button[aria-label="Not now"]',
    ) as HTMLButtonElement | null;

    expect(enableBtn).not.toBeNull();
    expect(notNowBtn).not.toBeNull();

    act(() => enableBtn?.click());
    expect(onEnable).toHaveBeenCalledTimes(1);

    act(() => notNowBtn?.click());
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('renders compact disabled state when dismissed', () => {
    const onEnable = vi.fn();
    const onDismiss = vi.fn();
    const onOpenSettings = vi.fn();

    render(
      <BasemapConsent
        styleUrl="https://tiles.openfreemap.org/styles/liberty"
        onEnable={onEnable}
        onDismiss={onDismiss}
        isDismissed={true}
        onOpenSettings={onOpenSettings}
      />,
    );

    expect(container.textContent).toContain('Basemap is disabled.');
    const enableBtn = container.querySelector(
      'button[aria-label="Enable basemap"]',
    ) as HTMLButtonElement | null;
    const settingsBtn = container.querySelector(
      'button[aria-label="Basemap settings"]',
    ) as HTMLButtonElement | null;

    expect(enableBtn).not.toBeNull();
    expect(settingsBtn).not.toBeNull();

    act(() => enableBtn?.click());
    expect(onEnable).toHaveBeenCalledTimes(1);

    act(() => settingsBtn?.click());
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it('discloses geocoder host and independently controls search consent', () => {
    const onToggleGeocoder = vi.fn();
    render(
      <BasemapConsent
        styleUrl="https://tiles.openfreemap.org/styles/liberty"
        geocoderUrl="https://nominatim.openstreetmap.org/search?format=jsonv2"
        geocoderEnabled={false}
        onToggleGeocoder={onToggleGeocoder}
        onEnable={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(container.textContent).toContain(
      'Sends your search text to nominatim.openstreetmap.org.',
    );
    expect(container.textContent).toContain('No map image, coordinates, or project data is sent.');
    const consent = container.querySelector(
      '.trailmaker-geocoder-consent input',
    ) as HTMLInputElement | null;
    expect(consent?.checked).toBe(false);
    act(() => consent?.click());
    expect(onToggleGeocoder).toHaveBeenCalledWith(true);
  });

  it('traps focus, handles Escape, and has aria-modal="true"', () => {
    const trigger = document.createElement('button');
    trigger.id = 'consent-trigger';
    document.body.appendChild(trigger);
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    const onDismiss = vi.fn();
    render(
      <BasemapConsent
        styleUrl="https://tiles.openfreemap.org/styles/liberty"
        onEnable={vi.fn()}
        onDismiss={onDismiss}
      />,
    );

    const dialog = container.querySelector('[role="dialog"]');
    expect(dialog?.getAttribute('aria-modal')).toBe('true');
    expect(dialog?.getAttribute('aria-labelledby')).toBe('basemap-consent-title');

    const enableBtn = container.querySelector('button[aria-label="Enable basemap"]') as HTMLElement;
    const notNowBtn = container.querySelector('button[aria-label="Not now"]') as HTMLElement;

    // Auto-focuses first element
    expect(document.activeElement).toBe(enableBtn);

    // Tab wraps from last to first
    notNowBtn.focus();
    const tabEvent = new KeyboardEvent('keydown', {
      key: 'Tab',
      shiftKey: false,
      bubbles: true,
      cancelable: true,
    });
    document.dispatchEvent(tabEvent);
    expect(tabEvent.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(enableBtn);

    // Escape dismisses
    const escEvent = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    });
    document.dispatchEvent(escEvent);
    expect(onDismiss).toHaveBeenCalledTimes(1);

    // On unmount/close, focus returns to trigger
    render(<div />);
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });

  it('names satellite host in privacy disclosure when provided (card T-316)', () => {
    render(
      <BasemapConsent
        styleUrl="https://tiles.openfreemap.org/styles/liberty"
        satelliteHost="basemap.nationalmap.gov"
        onEnable={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );

    const dialog = container.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain(
      'Shows a live map from tiles.openfreemap.org (and satellite imagery from basemap.nationalmap.gov). Your map image and trails stay on this device; the tile server sees which area you view.',
    );
  });
});
