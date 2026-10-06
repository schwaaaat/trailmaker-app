import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as C from '../../state/commands';
import { makeProject, makeSession } from '../../state/fixtures.test.helper';
import {
  appStore,
  edit,
  openSession,
  selectTrails,
  setDraft,
  setTool,
  splitCandidateInReview,
  setCandidates,
  type ReviewCandidate,
} from '../../state/store';
import { settled } from './tools';
import { Toolbar, TipLine } from './Toolbar';

void React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

function render(node: React.ReactNode) {
  act(() => root.render(node));
}
const undoButton = () => host.querySelector<HTMLButtonElement>('button[aria-label="Undo"]')!;
const project = () => appStore.getState().session!.project;

describe('Box selection toolbar (T-333)', () => {
  it('keeps selection-only actions out of the toolbar while placing anchors or tracing', () => {
    openSession(makeSession(makeProject()));
    render(<Toolbar />);
    expect(host.querySelector('button[aria-label="Box select trails"]')).not.toBeNull();
    expect(
      host.querySelector('[aria-label="Map tools"] button[aria-label="Box select trails"]'),
    ).toBeNull();
    expect(
      host.querySelector(
        '[aria-label="Trail selection actions"] button[aria-label="Box select trails"]',
      ),
    ).not.toBeNull();
    for (const tool of ['anchor', 'trail', 'point', 'area', 'connect'] as const) {
      act(() => setTool(tool));
      expect(host.querySelector('button[aria-label="Box select trails"]')).toBeNull();
    }
    act(() => setTool('select'));
    expect(host.querySelector('button[aria-label="Box select trails"]')).not.toBeNull();
  });

  it('exposes touch actions, reports the proposed counts, and applies only after confirmation', () => {
    const trail = (id: string, start: number, end: number) => ({
      kind: 'trail' as const,
      id,
      name: id,
      color: '#123456',
      notes: '',
      ink: null,
      pts: [
        [start, 100],
        [end, 100],
      ] as const,
    });
    const initial = makeProject({
      features: [
        trail('a', 0, 100),
        trail('b', 100, 200),
        {
          ...trail('branch', 100, 100),
          pts: [
            [100, 100],
            [100, 200],
          ],
        },
      ],
    });
    openSession(makeSession(initial));
    render(
      <>
        <Toolbar />
        <TipLine />
      </>,
    );
    const button = (label: string) =>
      host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
    act(() => button('Box select trails').click());
    expect(appStore.getState().boxSelectMode).toBe(true);
    expect(host.textContent).toContain('tap two corners');
    act(() => {
      button('Box select trails').click();
      selectTrails(['a', 'b']);
    });
    act(() => button('Preview auto-join').click());
    expect(project()).toBe(initial);
    expect(host.querySelector('[aria-label="Auto-join preview"]')?.textContent).toContain(
      '1 ambiguous junctions left separate',
    );
    expect(
      host.querySelector('[aria-label="Trails at ambiguous junctions"]')?.textContent,
    ).toContain('a, b');
    const cancel = [...host.querySelectorAll('button')].find(
      (b) => b.textContent === 'Cancel auto-join',
    )!;
    act(() => cancel.click());
    expect(project()).toBe(initial);
    const clean = makeProject({ features: initial.features.slice(0, 2) });
    act(() => {
      openSession(makeSession(clean));
      selectTrails(['a', 'b']);
    });
    act(() => button('Preview auto-join').click());
    expect(host.querySelector('[aria-label="Auto-join preview"]')?.textContent).toContain(
      '1 chains to join; 0 ambiguous',
    );
    const apply = [...host.querySelectorAll('button')].find(
      (b) => b.textContent === 'Apply auto-join',
    )!;
    act(() => apply.click());
    expect(project().features).toHaveLength(1);
    act(() => undoButton().click());
    expect(project()).toStrictEqual(clean);
  });
});

const cand: ReviewCandidate = {
  id: 'k1',
  chipId: 'c1',
  pts: [
    [0, 0],
    [9, 9],
  ],
  lengthPx: 12.7,
  ink: [0, 0, 0],
  confidence: null,
  on: true,
  name: 'Black',
  color: '#000000',
};

beforeEach(() => {
  openSession(makeSession(makeProject({ seq: 5 })));
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('Toolbar Undo button (T-213)', () => {
  it('is disabled with nothing to undo, and enabled by a pending review split', () => {
    render(<Toolbar />);
    expect(undoButton().disabled).toBe(true);

    act(() => setCandidates([cand]));
    const a: ReviewCandidate = {
      ...cand,
      id: 'k1a',
      pts: [
        [0, 0],
        [4, 4],
      ],
    };
    const b: ReviewCandidate = {
      ...cand,
      id: 'k1b',
      pts: [
        [4, 4],
        [9, 9],
      ],
    };
    act(() => splitCandidateInReview([a, b]));
    render(<Toolbar />);
    expect(undoButton().disabled).toBe(false);

    act(() => undoButton().click());
    expect(appStore.getState().candidates).toStrictEqual([cand]);
    expect(appStore.getState().history.canUndo).toBe(false);
    render(<Toolbar />);
    expect(undoButton().disabled).toBe(true);
  });

  it('undoes only the split, leaving project history untouched, then undoes the project edit', () => {
    act(() =>
      edit(
        C.addFeature(project(), {
          kind: 'poi',
          name: 'P',
          color: '#1F6FB2',
          notes: '',
          at: [1, 1],
          poiType: 'Water',
        }).command,
      ),
    );
    expect(project().features).toHaveLength(1);
    expect(appStore.getState().history.canUndo).toBe(true);

    act(() => setCandidates([cand]));
    const a: ReviewCandidate = {
      ...cand,
      id: 'k1a',
      pts: [
        [0, 0],
        [4, 4],
      ],
    };
    const b: ReviewCandidate = {
      ...cand,
      id: 'k1b',
      pts: [
        [4, 4],
        [9, 9],
      ],
    };
    act(() => splitCandidateInReview([a, b]));
    render(<Toolbar />);

    // First Undo restores the split only: the feature and history stay exactly as before.
    act(() => undoButton().click());
    expect(appStore.getState().candidates).toStrictEqual([cand]);
    expect(project().features).toHaveLength(1);
    expect(appStore.getState().history.canUndo).toBe(true);

    // With no split left, the same button now reaches the project.
    render(<Toolbar />);
    act(() => undoButton().click());
    expect(project().features).toHaveLength(0);
    expect(appStore.getState().history.canUndo).toBe(false);
  });

  it('a pending split waits behind an open draft (acceptance 2 and 3)', async () => {
    act(() =>
      setDraft({
        kind: 'trail',
        pts: [
          [0, 0],
          [1, 1],
        ],
        cps: [2],
        ink: null,
        color: '#D9480F',
        name: 'Trail 1',
        editId: null,
      }),
    );
    act(() => setCandidates([cand]));
    const a: ReviewCandidate = {
      ...cand,
      id: 'k1a',
      pts: [
        [0, 0],
        [4, 4],
      ],
    };
    const b: ReviewCandidate = {
      ...cand,
      id: 'k1b',
      pts: [
        [4, 4],
        [9, 9],
      ],
    };
    act(() => splitCandidateInReview([a, b]));
    render(<Toolbar />);

    act(() => undoButton().click());
    await act(() => settled());
    expect(appStore.getState().draft).toBeNull();
    expect(appStore.getState().candidates).toStrictEqual([a, b]);

    render(<Toolbar />);
    act(() => undoButton().click());
    expect(appStore.getState().candidates).toStrictEqual([cand]);
  });
});

describe('Toolbar "Keyboard shortcuts" button (T-215 review)', () => {
  it('is present, and the map-tool buttons are not, before any map is open', () => {
    act(() => appStore.setState({ session: null }));
    render(<Toolbar />);
    const help = host.querySelector<HTMLButtonElement>('button[aria-label="Keyboard shortcuts"]');
    expect(help).not.toBeNull();
    expect(host.querySelector('button[aria-label="Undo"]')).toBeNull();
    expect(host.querySelector('button[aria-label="Select"]')).toBeNull();
  });

  it('opens the help dialog once a map is open too', () => {
    render(<Toolbar />);
    const help = host.querySelector<HTMLButtonElement>('button[aria-label="Keyboard shortcuts"]')!;
    act(() => help.click());
    expect(appStore.getState().helpOpen).toBe(true);
  });
});
