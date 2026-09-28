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
  [...host.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.textContent?.trim() === text,
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
});
