import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Feature } from '../../core/types';
import { makeProject, makeSession } from '../../state/fixtures.test.helper';
import { appStore, openSession, openVertexMenu } from '../../state/store';
import { VertexMenu } from './VertexMenu';

void React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const trail: Feature = {
  kind: 'trail',
  id: 'f1',
  name: 'Ridge',
  color: '#D9480F',
  notes: '',
  pts: [
    [100, 100],
    [300, 100],
    [300, 300],
  ],
  ink: null,
};

let host: HTMLDivElement;
let root: Root;

function render(node: React.ReactNode) {
  act(() => root.render(node));
}
const byText = (text: string) =>
  [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
    b.textContent?.trim().startsWith(text),
  );
const click = (el: HTMLElement) => act(() => el.click());

beforeEach(() => {
  openSession(makeSession(makeProject({ features: [trail], seq: 5 })));
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('VertexMenu (T-209)', () => {
  it('renders nothing when closed', () => {
    render(<VertexMenu />);
    expect(host.innerHTML).toBe('');
  });

  it('shows "Split here" only when the vertex is interior, and "Delete point" always', () => {
    act(() =>
      openVertexMenu({ featureId: 'f1', index: 1, canSplit: true, client: { x: 10, y: 20 } }),
    );
    render(<VertexMenu />);
    expect(host.querySelector('[role="menu"]')).toHaveProperty('ariaLabel', 'Vertex actions');
    expect(byText('Split here')).toBeTruthy();
    expect(byText('Delete point')).toBeTruthy();

    act(() =>
      openVertexMenu({ featureId: 'f1', index: 0, canSplit: false, client: { x: 10, y: 20 } }),
    );
    expect(byText('Split here')).toBeFalsy();
    expect(byText('Delete point')).toBeTruthy();
  });

  it('shows the keyboard key for each menu action', () => {
    act(() =>
      openVertexMenu({ featureId: 'f1', index: 1, canSplit: true, client: { x: 10, y: 20 } }),
    );
    render(<VertexMenu />);
    expect(host.querySelector('[aria-keyshortcuts="S"]')?.textContent).toContain('S');
    expect(host.querySelector('[aria-keyshortcuts="Delete Backspace"]')?.textContent).toContain(
      'Delete / Backspace',
    );
  });

  it('"Split here" splits the trail and closes the menu', () => {
    act(() =>
      openVertexMenu({ featureId: 'f1', index: 1, canSplit: true, client: { x: 10, y: 20 } }),
    );
    render(<VertexMenu />);
    click(byText('Split here')!);
    const p = appStore.getState().session!.project;
    expect(p.features.map((f) => f.id)).toStrictEqual(['f1', 'f5']);
    expect(appStore.getState().selectedFeatureId).toBe('f5');
    expect(appStore.getState().vertexMenu).toBeNull();
  });

  it('the focused menu action responds to its displayed key', () => {
    act(() =>
      openVertexMenu({ featureId: 'f1', index: 1, canSplit: true, client: { x: 10, y: 20 } }),
    );
    render(<VertexMenu />);
    const split = byText('Split here')!;
    act(() => {
      split.focus();
      split.dispatchEvent(
        new KeyboardEvent('keydown', { key: 's', bubbles: true, cancelable: true }),
      );
    });
    expect(appStore.getState().session!.project.features.map((f) => f.id)).toStrictEqual([
      'f1',
      'f5',
    ]);
    expect(appStore.getState().vertexMenu).toBeNull();
  });

  it('"Delete point" removes the vertex and closes the menu', () => {
    act(() =>
      openVertexMenu({ featureId: 'f1', index: 1, canSplit: true, client: { x: 10, y: 20 } }),
    );
    render(<VertexMenu />);
    click(byText('Delete point')!);
    const f = appStore.getState().session!.project.features[0] as Extract<
      Feature,
      { kind: 'trail' }
    >;
    expect(f.pts).toHaveLength(2);
    expect(appStore.getState().vertexMenu).toBeNull();
  });

  it('closes on an outside pointerdown', () => {
    act(() =>
      openVertexMenu({ featureId: 'f1', index: 1, canSplit: true, client: { x: 10, y: 20 } }),
    );
    render(<VertexMenu />);
    act(() => {
      window.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    });
    expect(appStore.getState().vertexMenu).toBeNull();
  });

  it('shows "Set as loop start" for a loop vertex and rotates loop start', () => {
    const loopTrail: Feature = {
      ...trail,
      id: 'f1',
      pts: [
        [0, 0],
        [100, 0],
        [100, 100],
        [0, 0],
      ],
      route: { kind: 'loop', direction: 'clockwise' },
    };
    openSession(makeSession(makeProject({ features: [loopTrail], seq: 5 })));
    act(() =>
      openVertexMenu({ featureId: 'f1', index: 1, canSplit: true, client: { x: 10, y: 20 } }),
    );
    render(<VertexMenu />);
    const setStartBtn = byText('Set as loop start');
    expect(setStartBtn).toBeTruthy();
    expect(setStartBtn?.textContent).toContain('T');
    click(setStartBtn!);
    const p = appStore.getState().session!.project;
    const f = p.features[0] as Extract<Feature, { kind: 'trail' }>;
    expect(f.pts[0]).toStrictEqual([100, 0]);
    expect(f.pts.at(-1)).toStrictEqual([100, 0]);
    expect(appStore.getState().vertexMenu).toBeNull();
  });

  it('shows "Set as trailhead" for the end vertex of a one-way trail and swaps start/end', () => {
    const oneWayTrail: Feature = {
      ...trail,
      id: 'f1',
      pts: [
        [0, 0],
        [100, 0],
        [100, 100],
      ],
      route: { kind: 'one-way' },
    };
    openSession(makeSession(makeProject({ features: [oneWayTrail], seq: 5 })));
    act(() =>
      openVertexMenu({ featureId: 'f1', index: 2, canSplit: false, client: { x: 10, y: 20 } }),
    );
    render(<VertexMenu />);
    const setThBtn = byText('Set as trailhead');
    expect(setThBtn).toBeTruthy();
    expect(setThBtn?.textContent).toContain('T');
    click(setThBtn!);
    const p = appStore.getState().session!.project;
    const f = p.features[0] as Extract<Feature, { kind: 'trail' }>;
    expect(f.pts[0]).toStrictEqual([100, 100]);
    expect(f.pts.at(-1)).toStrictEqual([0, 0]);
    expect(appStore.getState().vertexMenu).toBeNull();
  });

  it('responds to keyboard shortcut T for setting loop start', () => {
    const loopTrail: Feature = {
      ...trail,
      id: 'f1',
      pts: [
        [0, 0],
        [100, 0],
        [100, 100],
        [0, 0],
      ],
      route: { kind: 'loop', direction: 'clockwise' },
    };
    openSession(makeSession(makeProject({ features: [loopTrail], seq: 5 })));
    act(() =>
      openVertexMenu({ featureId: 'f1', index: 2, canSplit: true, client: { x: 10, y: 20 } }),
    );
    render(<VertexMenu />);
    const setStartBtn = byText('Set as loop start')!;
    act(() => {
      setStartBtn.focus();
      setStartBtn.dispatchEvent(
        new KeyboardEvent('keydown', { key: 't', bubbles: true, cancelable: true }),
      );
    });
    const p = appStore.getState().session!.project;
    const f = p.features[0] as Extract<Feature, { kind: 'trail' }>;
    expect(f.pts[0]).toStrictEqual([100, 100]);
    expect(appStore.getState().vertexMenu).toBeNull();
  });
});
