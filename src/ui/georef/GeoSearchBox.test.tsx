import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GeocoderError, type GeocodeResult } from '../../io/geocoder';
import { GeoSearchBox } from './GeoSearchBox';

void React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const place: GeocodeResult = {
  name: 'Dickey Ridge Visitor Center, Virginia',
  ll: [38.5482, -78.3897],
  bbox: [
    [-78.4, 38.54],
    [-78.38, 38.56],
  ],
};

describe('GeoSearchBox', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  function render(node: React.ReactNode): void {
    act(() => root.render(node));
  }

  function type(input: HTMLInputElement, value: string): void {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    act(() => {
      setter.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  it('keeps the search box absent until the independent geocoder opt-in is enabled', () => {
    const searchPlaces = vi.fn();
    render(<GeoSearchBox enabled={false} onSelect={vi.fn()} searchPlaces={searchPlaces} />);
    expect(container.querySelector('[role="combobox"]')).toBeNull();
    expect(searchPlaces).not.toHaveBeenCalled();
  });

  it('debounces typing, exposes an accessible listbox and supports arrow/enter selection', async () => {
    const searchPlaces = vi.fn().mockResolvedValue([place]);
    const onSelect = vi.fn();
    render(<GeoSearchBox enabled onSelect={onSelect} searchPlaces={searchPlaces} />);
    const input = container.querySelector('[role="combobox"]') as HTMLInputElement;
    expect(input.getAttribute('aria-autocomplete')).toBe('list');
    type(input, 'Dickey Ridge');

    await act(async () => vi.advanceTimersByTimeAsync(499));
    expect(searchPlaces).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(searchPlaces).toHaveBeenCalledWith('Dickey Ridge', expect.any(AbortSignal));
    expect(container.querySelector('[role="listbox"]')).not.toBeNull();
    expect(container.querySelector('[role="option"]')?.textContent).toBe(place.name);
    expect(container.textContent).toContain('© OpenStreetMap contributors');

    act(() =>
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })),
    );
    expect(input.getAttribute('aria-activedescendant')).toContain('option-0');
    act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    expect(onSelect).toHaveBeenCalledWith(place);
    expect(container.querySelector('[role="listbox"]')).toBeNull();

    await act(async () => vi.advanceTimersByTimeAsync(500));
    expect(searchPlaces).toHaveBeenCalledTimes(1);
  });

  it('aborts the prior in-flight query as soon as a newer query is typed', async () => {
    const signals: AbortSignal[] = [];
    const searchPlaces = vi.fn((query: string, signal?: AbortSignal) => {
      if (signal) signals.push(signal);
      if (query === 'new place') return Promise.resolve([place]);
      return new Promise<GeocodeResult[]>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), {
          once: true,
        });
      });
    });
    render(<GeoSearchBox enabled onSelect={vi.fn()} searchPlaces={searchPlaces} />);
    const input = container.querySelector('[role="combobox"]') as HTMLInputElement;
    type(input, 'old place');
    await act(async () => vi.advanceTimersByTimeAsync(500));
    expect(signals).toHaveLength(1);
    expect(signals[0]!.aborted).toBe(false);

    type(input, 'new place');
    expect(signals[0]!.aborted).toBe(true);
    await act(async () => vi.advanceTimersByTimeAsync(500));
    expect(container.querySelector('[role="option"]')?.textContent).toBe(place.name);
  });

  it('shows a short message for rate limits and service errors', async () => {
    const searchPlaces = vi
      .fn()
      .mockRejectedValue(new GeocoderError('rate-limited', 'internal message'));
    render(<GeoSearchBox enabled onSelect={vi.fn()} searchPlaces={searchPlaces} />);
    type(container.querySelector('[role="combobox"]') as HTMLInputElement, 'place');
    await act(async () => vi.advanceTimersByTimeAsync(500));
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      'Try again in a minute',
    );
    expect(container.textContent).not.toContain('internal message');
  });
});
