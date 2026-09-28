// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GpxPointsList } from './GpxPointsList';
import type { StoredGpxLayer } from '../../io/gpxStorage';

void React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('GpxPointsList Component (card T-312)', () => {
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

  function type(input: HTMLInputElement, value: string): void {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    act(() => {
      setter.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }

  const mockGpx: StoredGpxLayer = {
    fileName: 'shenandoah.gpx',
    points: [
      { id: 'pt-1', name: 'Marys Rock Summit', ll: [38.65, -78.31], kind: 'wpt', desc: 'Rocky outlook' },
      { id: 'pt-2', name: 'Appalachian Trail pt 1', ll: [38.64, -78.32], kind: 'trkpt' },
      { id: 'pt-3', name: 'Panorama Parking', ll: [38.66, -78.30], kind: 'wpt' },
    ],
    tracks: [{ name: 'AT Section', points: [[38.64, -78.32], [38.65, -78.31]] }],
    totalPointsInFile: 3,
    wasDecimated: false,
  };

  it('renders list of points by name when open', () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    const onClear = vi.fn();

    render(
      <GpxPointsList
        gpx={mockGpx}
        isOpen={true}
        onClose={onClose}
        onSelectPoint={onSelect}
        onClearGpx={onClear}
      />,
    );

    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    expect(container.textContent).toContain('GPX Points (3)');
    expect(container.textContent).toContain('Marys Rock Summit');
    expect(container.textContent).toContain('Appalachian Trail pt 1');
    expect(container.textContent).toContain('Panorama Parking');
  });

  it('returns null when isOpen is false', () => {
    render(
      <GpxPointsList
        gpx={mockGpx}
        isOpen={false}
        onClose={vi.fn()}
        onSelectPoint={vi.fn()}
        onClearGpx={vi.fn()}
      />,
    );
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it('filters points dynamically by name query', () => {
    render(
      <GpxPointsList
        gpx={mockGpx}
        isOpen={true}
        onClose={vi.fn()}
        onSelectPoint={vi.fn()}
        onClearGpx={vi.fn()}
      />,
    );

    const input = container.querySelector('input[type="search"]') as HTMLInputElement;
    expect(input).not.toBeNull();
    type(input, 'Rock');

    expect(container.textContent).toContain('Marys Rock Summit');
    expect(container.textContent).not.toContain('Appalachian Trail pt 1');
    expect(container.textContent).not.toContain('Panorama Parking');
  });

  it('calls onSelectPoint when a point button is clicked', () => {
    const onSelect = vi.fn();
    render(
      <GpxPointsList
        gpx={mockGpx}
        isOpen={true}
        onClose={vi.fn()}
        onSelectPoint={onSelect}
        onClearGpx={vi.fn()}
      />,
    );

    const buttons = Array.from(container.querySelectorAll('.trailmaker-gpx-point-btn')) as HTMLButtonElement[];
    expect(buttons.length).toBe(3);
    act(() => buttons[0]!.click());

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(mockGpx.points[0]);
  });

  it('calls onClearGpx when Remove GPX is clicked', () => {
    const onClear = vi.fn();
    render(
      <GpxPointsList
        gpx={mockGpx}
        isOpen={true}
        onClose={vi.fn()}
        onSelectPoint={onSelectPointStub}
        onClearGpx={onClear}
      />,
    );

    function onSelectPointStub() {}

    const clearBtn = container.querySelector('.trailmaker-gpx-list-footer button') as HTMLButtonElement;
    expect(clearBtn).not.toBeNull();
    act(() => clearBtn.click());

    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it('displays notice when file was decimated', () => {
    const decimatedGpx: StoredGpxLayer = {
      ...mockGpx,
      totalPointsInFile: 60000,
      wasDecimated: true,
      notice: 'Large GPX (60,000 points) decimated to 10,000 points for smooth display.',
    };

    render(
      <GpxPointsList
        gpx={decimatedGpx}
        isOpen={true}
        onClose={vi.fn()}
        onSelectPoint={vi.fn()}
        onClearGpx={vi.fn()}
      />,
    );

    expect(container.textContent).toContain('decimated to 10,000 points');
    expect(container.textContent).toContain('(decimated from 60000)');
  });
});
