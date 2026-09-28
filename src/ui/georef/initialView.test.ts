import { describe, expect, it } from 'vitest';
import { fitAnchors } from '../../core/geo/fit';
import type { Anchor, FitResult } from '../../core/types';
import { getDefaultSettings } from '../../io/settings';
import { computeInitialView } from './initialView';

describe('computeInitialView', () => {
  const defaultSettings = getDefaultSettings().basemap;

  it('frames overlayQuad bounds when project has a valid fit and image dimensions', () => {
    const anchors: Anchor[] = [
      { id: 'a1', px: [0, 0], ll: [38.5, -78.4], source: 'paste' },
      { id: 'a2', px: [1000, 0], ll: [38.5, -78.3], source: 'paste' },
      { id: 'a3', px: [1000, 800], ll: [38.4, -78.3], source: 'paste' },
      { id: 'a4', px: [0, 800], ll: [38.4, -78.4], source: 'paste' },
    ];

    const fit: FitResult = fitAnchors(anchors, 1000, 800, 'similarity');
    expect(fit.ok).toBe(true);

    const view = computeInitialView(fit, { width: 1000, height: 800 }, anchors, defaultSettings);
    expect(view.bounds).toBeDefined();
    if (view.bounds) {
      const [[minLng, minLat], [maxLng, maxLat]] = view.bounds;
      expect(minLng).toBeCloseTo(-78.4, 1);
      expect(maxLng).toBeCloseTo(-78.3, 1);
      expect(minLat).toBeCloseTo(38.4, 1);
      expect(maxLat).toBeCloseTo(38.5, 1);
    }
    expect(view.center).toBeUndefined();
  });

  it('frames anchor bounds when fit is absent or not ok and multiple anchors have coordinates', () => {
    const anchors: Anchor[] = [
      { id: 'a1', px: [10, 10], ll: [38.5, -78.4], source: 'paste' },
      { id: 'a2', px: [20, 20], ll: [38.7, -78.2], source: 'paste' },
      { id: 'a3', px: [30, 30], ll: null, source: 'paste' },
    ];

    const view = computeInitialView(null, undefined, anchors, defaultSettings);
    expect(view.bounds).toEqual([
      [-78.4, 38.5],
      [-78.2, 38.7],
    ]);
  });

  it('centers on the single anchor coordinate when only one anchor has coordinates', () => {
    const anchors: Anchor[] = [
      { id: 'a1', px: [10, 10], ll: [38.55, -78.35], source: 'paste' },
      { id: 'a2', px: [20, 20], ll: null, source: 'paste' },
    ];

    const view = computeInitialView(null, undefined, anchors, defaultSettings);
    expect(view.center).toEqual([-78.35, 38.55]);
    expect(view.zoom).toBe(14);
    expect(view.bounds).toBeUndefined();
  });

  it('uses last viewed basemap position from settings when no fit and no anchor coordinates', () => {
    const settings = {
      ...defaultSettings,
      lastCenter: [-73.98, 40.75] as [number, number],
      lastZoom: 12,
    };

    const view = computeInitialView(null, undefined, [], settings);
    expect(view.center).toEqual([-73.98, 40.75]);
    expect(view.zoom).toBe(12);
    expect(view.bounds).toBeUndefined();
  });

  it('falls back to world view when no fit, no anchors, and no saved settings position', () => {
    const view = computeInitialView(null, undefined, undefined, defaultSettings);
    expect(view.center).toEqual([0, 20]);
    expect(view.zoom).toBe(1);
    expect(view.bounds).toBeUndefined();
  });
});
