import { describe, expect, it } from 'vitest';
import type { RenderModel } from './render';
import { renderFrame } from './render';

describe('editor render overlays', () => {
  it('draws selection halos for every box-selected trail and none for other trails', () => {
    const paths: unknown[][] = [];
    const raw = { canvas: { width: 500, height: 400 } };
    const ctx = new Proxy(raw as unknown as CanvasRenderingContext2D, {
      get(target, property) {
        if (property in target) return Reflect.get(target, property);
        return (...args: unknown[]) => {
          if (property === 'setLineDash') paths.push(args);
        };
      },
      set(target, property, value) {
        Reflect.set(target, property, value);
        return true;
      },
    });
    const model: RenderModel = {
      image: document.createElement('canvas'),
      features: ['a', 'b', 'other'].map((id) => ({
        kind: 'trail',
        id,
        name: id,
        color: '#123456',
        notes: '',
        ink: null,
        pts: [
          [0, 0],
          [10, 10],
        ],
      })),
      selectedFeatureId: null,
      secondSelectedFeatureId: null,
      selectedTrailIds: ['a', 'b'],
      draft: null,
      cursor: null,
      candidates: null,
      anchors: [],
      selectedAnchorId: null,
      isOutlier: () => false,
      focusedVertex: null,
      centerCrosshair: false,
    };
    renderFrame(ctx, model, { s: 2, x: 10, y: 20 }, 1, () => {});
    expect(paths.filter((call) => JSON.stringify(call) === '[[5,5]]')).toHaveLength(2);
  });
  it('draws the projected GPS accuracy boundary and center marker in screen space', () => {
    const calls = new Map<string, unknown[][]>();
    const raw = { canvas: { width: 500, height: 400 } };
    const ctx = new Proxy(raw as unknown as CanvasRenderingContext2D, {
      get(target, property) {
        if (property in target) return Reflect.get(target, property);
        return (...args: unknown[]) => {
          const name = String(property);
          const list = calls.get(name) ?? [];
          list.push(args);
          calls.set(name, list);
        };
      },
      set(target, property, value) {
        Reflect.set(target, property, value);
        return true;
      },
    });
    const model: RenderModel = {
      image: document.createElement('canvas'),
      features: [],
      selectedFeatureId: null,
      secondSelectedFeatureId: null,
      draft: null,
      cursor: null,
      candidates: null,
      anchors: [],
      selectedAnchorId: null,
      isOutlier: () => false,
      focusedVertex: null,
      centerCrosshair: false,
      locationOverlay: {
        center: [100, 50],
        accuracyBoundary: [
          [90, 50],
          [100, 40],
          [110, 50],
          [100, 60],
        ],
      },
    };

    renderFrame(ctx, model, { s: 2, x: 10, y: 20 }, 1);

    expect(calls.get('closePath')).toHaveLength(1);
    expect(calls.get('lineTo')).toHaveLength(3);
    expect(calls.get('arc')).toEqual([[210, 120, 6, 0, Math.PI * 2]]);
  });

  it('draws trailhead and end badges plus direction arrows for selected one-way routes', () => {
    const calls = new Map<string, unknown[][]>();
    const raw = { canvas: { width: 500, height: 400 } };
    const ctx = new Proxy(raw as unknown as CanvasRenderingContext2D, {
      get(target, property) {
        if (property === 'measureText') return () => ({ width: 40 });
        if (property in target) return Reflect.get(target, property);
        return (...args: unknown[]) => {
          const name = String(property);
          const list = calls.get(name) ?? [];
          list.push(args);
          calls.set(name, list);
        };
      },
      set(target, property, value) {
        Reflect.set(target, property, value);
        return true;
      },
    });

    const model: RenderModel = {
      image: document.createElement('canvas'),
      features: [
        {
          kind: 'trail',
          id: 't1',
          name: 'One-Way Trail',
          color: '#123456',
          notes: '',
          ink: null,
          pts: [
            [10, 10],
            [100, 100],
          ],
          route: { kind: 'one-way' },
        },
      ],
      selectedFeatureId: 't1',
      secondSelectedFeatureId: null,
      draft: null,
      cursor: null,
      candidates: null,
      anchors: [],
      selectedAnchorId: null,
      isOutlier: () => false,
      focusedVertex: null,
      centerCrosshair: false,
    };

    renderFrame(ctx, model, { s: 1, x: 0, y: 0 }, 1);

    const textCalls = calls.get('fillText')?.map((args) => args[0]);
    expect(textCalls).toContain('Trailhead');
    expect(textCalls).toContain('End');
    expect(calls.get('rotate')?.length).toBeGreaterThanOrEqual(1);
  });

  it('draws start/end direction badge for selected loop routes', () => {
    const calls = new Map<string, unknown[][]>();
    const raw = { canvas: { width: 500, height: 400 } };
    const ctx = new Proxy(raw as unknown as CanvasRenderingContext2D, {
      get(target, property) {
        if (property === 'measureText') return () => ({ width: 40 });
        if (property in target) return Reflect.get(target, property);
        return (...args: unknown[]) => {
          const name = String(property);
          const list = calls.get(name) ?? [];
          list.push(args);
          calls.set(name, list);
        };
      },
      set(target, property, value) {
        Reflect.set(target, property, value);
        return true;
      },
    });

    const model: RenderModel = {
      image: document.createElement('canvas'),
      features: [
        {
          kind: 'trail',
          id: 't2',
          name: 'Loop Trail',
          color: '#123456',
          notes: '',
          ink: null,
          pts: [
            [0, 0],
            [100, 0],
            [100, 100],
            [0, 0],
          ],
          route: { kind: 'loop', direction: 'clockwise' },
        },
      ],
      selectedFeatureId: 't2',
      secondSelectedFeatureId: null,
      draft: null,
      cursor: null,
      candidates: null,
      anchors: [],
      selectedAnchorId: null,
      isOutlier: () => false,
      focusedVertex: null,
      centerCrosshair: false,
    };

    renderFrame(ctx, model, { s: 1, x: 0, y: 0 }, 1);

    const textCalls = calls.get('fillText')?.map((args) => args[0]);
    expect(textCalls).toContain('Start/End · Clockwise');
    expect(calls.get('rotate')?.length).toBeGreaterThanOrEqual(2);
  });
});
