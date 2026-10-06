import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  Anchor,
  Feature,
  FitResult,
  GeoFit,
  ImageId,
  KmzRequest,
  Project,
  RasterImage,
  Trail,
} from '../../core/types';
import * as formatModule from '../../core/export/format';
import { sessionBridge } from '../../state/bridge';
import { makeProject, makeSession } from '../../state/fixtures.test.helper';
import { updateFeature } from '../../state/commands';
import {
  appStore,
  edit,
  openSession,
  redo,
  requestFocus,
  selectFeature,
  selectFit,
  selectSecondFeature,
  setCandidateOn,
  setCandidates,
  setDraft,
  setRefinePreview,
  setTool,
  setConnectSession,
  undo,
  type ReviewCandidate,
} from '../../state/store';
import { settled } from '../editor/tools';
import { Busy } from '../../app/Overlays';
import { fakeWorker } from '../../state/fake-worker.test.helper';
import { jobsIdle, setWorkerForTests } from '../../state/worker-link';
import { AnchorsPanel, BAD_COORDS_MESSAGE } from './AnchorsPanel';
import { BUSY_AFTER_MS, ExportPanel, HINT_IDLE_MS, exportSummary } from './ExportPanel';
import { FeaturesPanel, LIST_BATCH, LIST_FIRST } from './FeaturesPanel';
import { fitMessage, fmtRes } from './fit-message';
import { TracePanel } from './TracePanel';
import * as editorStageModule from '../editor/EditorStage';
import * as traceActionsModule from './trace-actions';
import { ConnectPanel } from './ConnectPanel';
import { Toolbar } from '../editor/Toolbar';

const downloads = vi.hoisted(() => [] as { name: string; type: string }[]);
vi.mock('../../io/download', () => ({
  downloadBlob: vi.fn(async (name: string, blob: Blob) => {
    downloads.push({ name, type: blob.type });
    return true;
  }),
}));
vi.mock('../../io/overlay', () => ({
  encodeOverlayJpeg: vi.fn(async () => new Uint8Array([0xff, 0xd8, 0xff, 0xd9])),
}));

// Test JSX compiles with the classic runtime (no React plugin in vitest.config.ts).
void React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const st = () => appStore.getState();
const proj = () => st().session!.project;

let host: HTMLDivElement;
let root: Root;

function render(node: React.ReactNode) {
  act(() => root.render(node));
}
const q = <T extends Element = HTMLElement>(sel: string) => host.querySelector<T>(sel)!;
const byLabel = <T extends HTMLElement = HTMLInputElement>(label: string) =>
  host.querySelector<T>(`[aria-label="${label}"]`)!;
const byText = (text: string) =>
  [...host.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.textContent?.trim() === text,
  )!;

/** Set a React-controlled input's value the way typing does. */
function type(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto =
    el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  act(() => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const enter = (el: HTMLElement) =>
  act(() => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
const click = (el: HTMLElement) => act(() => el.click());
function select(el: HTMLSelectElement, value: string) {
  act(() => {
    el.value = value;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

// Anchors on an exactly linear map near Yosemite: image (x, y) -> (37.7 - y*1e-5, -119.6 + x*1e-5).
const ll = ([x, y]: readonly [number, number]) => [37.7 - y * 1e-5, -119.6 + x * 1e-5] as const;
const anchor = (id: string, px: [number, number], withLl = true): Anchor => ({
  id,
  px,
  ll: withLl ? ll(px) : null,
  source: 'paste',
});
const trail: Feature = {
  kind: 'trail',
  id: 'f1',
  name: 'Ridge',
  color: '#D9480F',
  notes: '',
  pts: [
    [100, 100],
    [900, 100],
  ],
  ink: null,
};
const area: Feature = {
  kind: 'area',
  id: 'f2',
  name: 'Meadow',
  color: '#3A7D44',
  notes: '',
  pts: [
    [0, 0],
    [50, 0],
    [50, 50],
  ],
};
const poi: Feature = {
  kind: 'poi',
  id: 'f3',
  name: 'Point 1',
  color: '#1F6FB2',
  notes: '',
  at: [10, 10],
  poiType: 'Waypoint',
};

function open(p: Project) {
  openSession(makeSession(p));
}

function openTiled(p: Project) {
  const session = makeSession(p);
  openSession({
    ...session,
    map: {
      ...session.map,
      tiles: {
        levels: [{ level: 0, width: p.image.width, height: p.image.height, cols: 4, rows: 4 }],
        tileSize: 256,
        overviewScale: 0.5,
        getTileBitmap: async () => null,
        readRegion: async ({ width, height }) => ({
          width,
          height,
          data: new Uint8ClampedArray(width * height * 4),
        }),
      },
    },
  });
}

beforeEach(async () => {
  await settled();
  setTool('select');
  appStore.setState({ toast: null });
  downloads.length = 0;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

/* ------------------------------------------------------------------ fit message */

describe('fitMessage (prototype renderFit)', () => {
  const ok = (over: Partial<GeoFit>): GeoFit => ({
    ok: true,
    requested: 'auto',
    method: 'affine',
    frame: { lat0: 0, lon0: 0, kx: 1, ky: 1, cx: 0, cy: 0, scale: 1 },
    model: { kind: 'affine', affine: [1, 0, 0, 0, 1, 0] },
    anchorCount: 4,
    residuals: { a: 3, b: 4, c: 5, d: 2 },
    rms: 3.7,
    checked: true,
    looResiduals: null,
    metersPerPixel: 1.23,
    mirrored: false,
    implausibleScale: false,
    ...over,
  });
  const cases: [string, FitResult | null, number, string, 'good' | 'warn' | null][] = [
    ['no fit yet', null, 0, '', null],
    ['no anchors', { ok: false, reason: 'too-few', anchorCount: 0, need: 2 }, 0, '', null],
    [
      'one more',
      { ok: false, reason: 'too-few', anchorCount: 1, need: 1 },
      1,
      'Add 1 more anchor with coordinates to place the map.',
      null,
    ],
    [
      'two more',
      { ok: false, reason: 'too-few', anchorCount: 0, need: 2 },
      2,
      'Add 2 more anchors with coordinates to place the map.',
      null,
    ],
    [
      'degenerate',
      { ok: false, reason: 'degenerate', anchorCount: 2, need: 0 },
      2,
      'These anchors sit on top of each other. Spread them across the map.',
      null,
    ],
    [
      'mirrored',
      ok({ mirrored: true }),
      4,
      'The anchors describe a mirror image. Latitude and longitude may be swapped on one of them.',
      'warn',
    ],
    [
      'implausible',
      ok({ implausibleScale: true, metersPerPixel: 0.002 }),
      4,
      'Placed using stretch to fit. About 0 cm per map pixel. That scale looks wrong for a park map; check each anchor’s coordinates.',
      'warn',
    ],
    [
      'unchecked',
      ok({ checked: false, method: 'similarity' }),
      2,
      'Placed using scale and rotate. About 1.2 m per map pixel. Add another anchor so the fit can be checked.',
      'good',
    ],
    [
      'good',
      ok({ metersPerPixel: 0.456 }),
      4,
      'Placed using stretch to fit. About 46 cm per map pixel. Anchors agree within 4 m on average.',
      'good',
    ],
    [
      'odd one out',
      ok({ residuals: { a: 3, b: 4, c: 80, d: 2 }, rms: 20 }),
      4,
      'Placed using stretch to fit. About 1.2 m per map pixel. Anchors agree within 20 m on average. The red anchor is the odd one out: re-check its spot or coordinates.',
      'warn',
    ],
    [
      'loose',
      ok({ method: 'tps', residuals: { a: 70, b: 70, c: 70, d: 70 }, rms: 70 }),
      4,
      'Placed using rubber sheet. About 1.2 m per map pixel. Anchors agree within 70 m on average. That’s loose. If the map is hand-drawn, try the rubber sheet method with more anchors.',
      'warn',
    ],
  ];
  it.each(cases)('%s', (_name, fit, count, text, tone) => {
    expect(fitMessage(fit, count, true)).toStrictEqual({ text, tone });
  });
  it('shows nothing before a map is open, and formats residuals as the prototype', () => {
    expect(fitMessage(ok({}), 4, false)).toStrictEqual({ text: '', tone: null });
    expect([fmtRes(0.4), fmtRes(12.4), fmtRes(1450)]).toStrictEqual(['±<1 m', '±12 m', '±1.4 km']);
  });
  it('explains when the anchors cannot check a stretch in every direction', () => {
    expect(
      fitMessage(ok({ checked: false, method: 'similarity', requested: 'auto' }), 4, true).text,
    ).toContain('Add an anchor farther from their line');
  });
});

/* ------------------------------------------------------------------ anchors */

describe('AnchorsPanel', () => {
  it('leaves the uniquely cross-line Seabranch pin unscored and unflagged', () => {
    const px: [number, number][] = [
      [1127, 720],
      [1025, 562],
      [655, 162],
      [475, 395],
    ];
    const coords: [number, number][] = [
      [27.131201, -80.162278],
      [27.134947, -80.164812],
      [27.143866, -80.172832],
      [27.136827, -80.17394],
    ];
    const anchors = px.map((p, i) => ({
      id: `s${i + 1}`,
      px: p,
      ll: coords[i]!,
      source: 'paste' as const,
    }));
    anchors[3] = { ...anchors[3]!, ll: [27.138227, -80.176769] };
    open(makeProject({ image: { width: 1920, height: 945 } as never, anchors }));
    render(<AnchorsPanel />);
    const fit = selectFit(st());
    expect(fit?.ok && fit.checked).toBe(false);
    expect(q('.fit').textContent).toContain('Add an anchor farther from their line');
    const badges = [...host.querySelectorAll<HTMLElement>('.res')];
    expect(badges.map((b) => b.textContent)).toContain('—');
    expect(badges.every((b) => !b.classList.contains('hi'))).toBe(true);
  });
  it('applies pasted/entered coordinates, flags unreadable ones, and clears on empty', () => {
    open(makeProject({ anchors: [anchor('g1', [100, 100], false)] }));
    render(<AnchorsPanel />);
    const input = byLabel('Coordinates for anchor 1');
    type(input, '37.5, -119.25');
    enter(input);
    expect(proj().anchors[0]!.ll).toStrictEqual([37.5, -119.25]);
    expect(input.value).toBe('37.500000, -119.250000');

    type(input, 'somewhere nice');
    enter(input);
    expect(st().toast?.message).toBe(BAD_COORDS_MESSAGE);
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(proj().anchors[0]!.ll).toStrictEqual([37.5, -119.25]);
    // Blur after Enter does not toast the same text again.
    const toast = st().toast;
    act(() => input.dispatchEvent(new FocusEvent('focusout', { bubbles: true })));
    expect(st().toast).toBe(toast);

    type(input, '');
    enter(input);
    expect(proj().anchors[0]!.ll).toBeNull();
  });

  it('shows residual badges once the fit is checked, removes anchors, and arms the anchor tool', () => {
    open(
      makeProject({
        anchors: [
          anchor('g1', [0, 0]),
          anchor('g2', [1000, 0]),
          anchor('g3', [1000, 800]),
          anchor('g4', [0, 800]),
        ],
      }),
    );
    render(<AnchorsPanel />);
    const fit = selectFit(st());
    expect(fit?.ok && fit.checked).toBe(true);
    const badges = [...host.querySelectorAll('.res')].map((b) => b.textContent);
    expect(badges).toStrictEqual(['±<1 m', '±<1 m', '±<1 m', '±<1 m']);
    expect(q('.fit').className).toBe('fit good');
    expect(q('.fit').textContent).toMatch(/^Placed using stretch to fit\./);

    click(byLabel<HTMLButtonElement>('Remove anchor 4'));
    expect(proj().anchors.map((a) => a.id)).toStrictEqual(['g1', 'g2', 'g3']);

    click(byText('Add anchor'));
    expect(st().tool).toBe('anchor');
    expect(st().toast?.message).toBe('Click the spot on the map');
  });

  it('shows leave-one-out badges with their tooltip, and flags only the anchor the others disagree with (T-208)', () => {
    // A 3x3 grid of anchors on the linear map; the centre one's latitude is ~110 m off. (With
    // only five anchors the bad one contaminates every other anchor's refit too much to stand
    // out; nine is a realistic spread.)
    const grid: [number, number][] = [];
    for (const y of [0, 400, 800]) for (const x of [0, 500, 1000]) grid.push([x, y]);
    const anchors = grid.map((p, i) => anchor(`g${i + 1}`, p));
    const mid = anchors[4]!;
    anchors[4] = { ...mid, ll: [mid.ll![0] + 0.001, mid.ll![1]] };
    open(makeProject({ anchors }));
    render(<AnchorsPanel />);
    const f = selectFit(st());
    expect(f?.ok && f.looResiduals).toBeTruthy();
    if (!f?.ok || !f.looResiduals) return;
    const badges = [...host.querySelectorAll<HTMLElement>('.res')];
    expect(badges.map((b) => b.textContent)).toStrictEqual(
      anchors.map((a) => fmtRes(f.looResiduals![a.id]!)),
    );
    expect(
      badges.every(
        (b) => b.title === 'How far this anchor is from where the other anchors place it',
      ),
    ).toBe(true);
    expect(badges.map((b) => b.classList.contains('hi'))).toStrictEqual(
      anchors.map((a) => a.id === 'g5'),
    );
    expect(q('.fit').textContent).toMatch(/The red anchor is the odd one out/);
    expect(q('.fit').className).toBe('fit warn');
  });

  it('focuses the requested anchor input, highlights the selected row, and sets the fit method', () => {
    open(makeProject({ anchors: [anchor('g1', [0, 0], false), anchor('g2', [9, 9], false)] }));
    render(<AnchorsPanel />);
    act(() => requestFocus('anchor', 'g2'));
    expect(document.activeElement).toBe(byLabel('Coordinates for anchor 2'));
    expect(st().selectedAnchorId).toBe('g2');
    expect(host.querySelectorAll('.anc.sel')).toHaveLength(1);
    select(host.querySelector<HTMLSelectElement>('select')!, 'tps');
    expect(proj().fitMethod).toBe('tps');
  });
});

/* ------------------------------------------------------------------ features */

describe('FeaturesPanel', () => {
  it('lists trails, areas, then points, with POI type, and says so when empty', () => {
    open(makeProject({ features: [] }));
    render(<FeaturesPanel />);
    expect(q('.empty-note').textContent).toBe('Nothing traced yet.');
    act(() => open(makeProject({ features: [poi, area, trail] })));
    const names = [...host.querySelectorAll('.feats .fname')].map((n) => n.textContent);
    expect(names).toStrictEqual(['Ridge', 'Meadow', 'Point 1']);
    expect(host.querySelectorAll('.feats .flen')[2]!.textContent).toBe('Waypoint');
    click(host.querySelectorAll<HTMLButtonElement>('.feats button')[1]!);
    expect(st().selectedFeatureId).toBe('f2');
  });

  it('shows lengths in the chosen units when the map is placed', async () => {
    open(
      makeProject({
        features: [trail],
        anchors: [anchor('g1', [0, 0]), anchor('g2', [1000, 0]), anchor('g3', [1000, 800])],
        units: 'km',
      }),
    );
    render(<FeaturesPanel />);
    // The length cache fills in a time slice (T-216), not synchronously in render.
    expect(host.querySelector('.feats .flen')!.textContent).toBe('…');
    await act(async () => new Promise((r) => setTimeout(r, 300)));
    // 800 px east at 1e-5 deg/px near 37.7 N: ~70 m.
    expect(host.querySelector('.feats .flen')!.textContent).toMatch(/^\d+ m$/);
  });

  it('an edit re-renders only the row of the feature it replaced, not the whole list (T-211/T-216)', async () => {
    open(
      makeProject({
        features: [trail, area],
        anchors: [anchor('g1', [0, 0]), anchor('g2', [1000, 0]), anchor('g3', [1000, 800])],
      }),
    );
    render(<FeaturesPanel />);
    await act(async () => new Promise((r) => setTimeout(r, 300)));
    // formatLength runs only inside a row that actually re-rendered (a memo bail-out skips the
    // row's render function entirely, so it never calls it) -- a DOM-node-identity check doesn't
    // work here, because React reuses the <li> either way and just patches its text in place.
    const fmt = vi.spyOn(formatModule, 'formatLength');
    fmt.mockClear();
    act(() => edit(updateFeature(proj(), 'f1', { name: 'Renamed ridge' })));
    await act(async () => new Promise((r) => setTimeout(r, 300)));
    expect(host.querySelector('.feats li')!.textContent).toContain('Renamed ridge');
    // Exactly one row's Measure ran: the edited trail's. Before the fix, a fill completing bumped
    // a tick prop shared by every row, so the untouched area's row re-rendered too (2 calls).
    expect(fmt).toHaveBeenCalledTimes(1);
    fmt.mockRestore();
  });

  it('edits name (one undo step), POI type (renaming "Point n"), notes, and deletes', () => {
    open(makeProject({ features: [trail, poi] }));
    render(<FeaturesPanel />);
    act(() => selectFeature('f3'));
    const before = proj();
    const name = q<HTMLInputElement>('.editor input:not([type=color])');
    type(name, 'Point 1x');
    type(name, 'Point 1xy');
    act(() => name.dispatchEvent(new FocusEvent('focusout', { bubbles: true })));
    expect(proj().features[1]!.name).toBe('Point 1xy');
    act(() => {
      undo();
    });
    expect(proj()).toStrictEqual(before);

    select(q<HTMLSelectElement>('.editor select'), 'Water');
    expect(proj().features[1]).toMatchObject({ poiType: 'Water', name: 'Water' });
    type(q<HTMLTextAreaElement>('.editor textarea'), 'Near the bridge');
    expect(proj().features[1]!.notes).toBe('Near the bridge');

    click(byText('Delete'));
    expect(proj().features.map((f) => f.id)).toStrictEqual(['f1']);
    expect(st().selectedFeatureId).toBeNull();
  });

  it('reverses and continues trails, and shows the draft bar', async () => {
    open(makeProject({ features: [trail] }));
    render(<FeaturesPanel />);
    act(() => selectFeature('f1'));
    click(byText('Reverse direction'));
    expect((proj().features[0] as Extract<Feature, { kind: 'trail' }>).pts[0]).toStrictEqual([
      900, 100,
    ]);
    expect(st().toast?.message).toBe('Direction reversed');
    click(byText('Continue tracing'));
    await act(async () => settled());
    expect(st().draft).toMatchObject({ editId: 'f1', name: 'Ridge' });
    expect(q('.draftbar').textContent).toMatch(/Extending Ridge · 1 click/);
    click(byText('Cancel (Esc)'));
    await act(async () => settled());
    expect(st().draft).toBeNull();
  });

  it('focuses and selects the name of a newly added point', () => {
    open(makeProject({ features: [poi] }));
    render(<FeaturesPanel />);
    act(() => {
      selectFeature('f3');
      requestFocus('feature-name', 'f3');
    });
    expect(document.activeElement).toBe(q('.editor input:not([type=color])'));
  });

  it('shows "Clean up junctions" only with 2+ trails, and snaps ends when clicked (T-209)', () => {
    open(makeProject({ features: [trail] }));
    render(<FeaturesPanel />);
    expect(byText('Clean up junctions')).toBeUndefined();
    const second: Feature = {
      ...trail,
      id: 'f9',
      pts: [
        [900.4, 100],
        [900.4, 300],
      ],
    };
    act(() => open(makeProject({ features: [trail, second] })));
    click(byText('Clean up junctions'));
    expect(st().toast?.message).toMatch(/^Joined \d+ trail ends?$/);
  });

  it('joins the shift-selected trail via the "Join trails" button, keeping the first name (T-209)', () => {
    const second: Feature = {
      ...trail,
      id: 'f9',
      name: 'Spur',
      pts: [
        [900, 100],
        [900, 300],
      ],
    };
    open(makeProject({ features: [trail, second] }));
    render(<FeaturesPanel />);
    act(() => selectFeature('f1'));
    expect(byText('Join trails')).toBeUndefined();
    act(() => selectSecondFeature('f9'));
    expect(q('.editor').textContent).toContain('Shift-selected “Spur” to join with this trail.');
    click(byText('Join trails'));
    expect(proj().features.map((f) => f.id)).toStrictEqual(['f1']);
    expect(proj().features[0]!.name).toBe('Ridge');
    expect(st().selectedFeatureId).toBe('f1');
  });

  it('arms a second trail with Shift+Enter from its feature row and joins by keyboard', () => {
    const second: Feature = {
      ...trail,
      id: 'f9',
      name: 'Spur',
      pts: [
        [900, 100],
        [900, 300],
      ],
    };
    open(makeProject({ features: [trail, second] }));
    render(<FeaturesPanel />);
    act(() => selectFeature('f1'));
    const spurRow = [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      b.textContent?.includes('Spur'),
    )!;
    act(() =>
      spurRow.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }),
      ),
    );
    expect(st().secondSelectedFeatureId).toBe('f9');
    const join = byText('Join trails');
    act(() => join.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    act(() => join.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 })));
    expect(proj().features.map((f) => f.id)).toStrictEqual(['f1']);
    expect(proj().features[0]!.name).toBe('Ridge');
  });

  it('classifies a trail as one-way and swaps start/end (T-334)', () => {
    open(makeProject({ features: [trail] }));
    render(<FeaturesPanel />);
    act(() => selectFeature('f1'));

    const routeSelect = host.querySelector<HTMLSelectElement>('select[aria-label="Route type"]')!;
    expect(routeSelect).toBeTruthy();
    expect(routeSelect.value).toBe('');

    act(() => {
      routeSelect.value = 'one-way';
      routeSelect.dispatchEvent(new Event('change', { bubbles: true }));
    });

    const p = proj();
    const f = p.features[0] as Extract<Feature, { kind: 'trail' }>;
    expect(f.route).toStrictEqual({ kind: 'one-way' });

    const swapBtn = byText('Swap start and end')!;
    expect(swapBtn).toBeTruthy();
    click(swapBtn);

    const p2 = proj();
    const f2 = p2.features[0] as Extract<Feature, { kind: 'trail' }>;
    expect(f2.pts[0]).toStrictEqual([900, 100]);
    expect(f2.pts.at(-1)).toStrictEqual([100, 100]);
  });

  it('classifies a trail as a loop, toggles direction, and rotates start point (T-334)', () => {
    const closedTrail: Feature = {
      ...trail,
      id: 'loop1',
      pts: [
        [0, 0],
        [100, 0],
        [100, 100],
        [0, 0],
      ],
    };
    open(makeProject({ features: [closedTrail] }));
    render(<FeaturesPanel />);
    act(() => selectFeature('loop1'));

    const routeSelect = host.querySelector<HTMLSelectElement>('select[aria-label="Route type"]')!;
    act(() => {
      routeSelect.value = 'loop';
      routeSelect.dispatchEvent(new Event('change', { bubbles: true }));
    });

    const p = proj();
    const f = p.features[0] as Extract<Feature, { kind: 'trail' }>;
    expect(f.route?.kind).toBe('loop');
    expect(f.route && 'direction' in f.route ? f.route.direction : null).toBe('clockwise');

    const dirSelect = host.querySelector<HTMLSelectElement>('select[aria-label="Loop direction"]')!;
    expect(dirSelect).toBeTruthy();
    act(() => {
      dirSelect.value = 'counterclockwise';
      dirSelect.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const pDir = proj();
    const fDir = pDir.features[0] as Extract<Feature, { kind: 'trail' }>;
    expect(fDir.route).toStrictEqual({ kind: 'loop', direction: 'counterclockwise' });

    const startSelect = host.querySelector<HTMLSelectElement>(
      'select[aria-label="Loop start point"]',
    )!;
    expect(startSelect).toBeTruthy();
    act(() => {
      startSelect.value = '1';
      startSelect.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const pRot = proj();
    const fRot = pRot.features[0] as Extract<Feature, { kind: 'trail' }>;
    expect(fRot.pts[0]).toStrictEqual([100, 100]);
    expect(fRot.pts.at(-1)).toStrictEqual([100, 100]);
  });

  it('refuses to mark open trail as loop when ends are too far apart (T-334)', () => {
    const openTrail: Feature = {
      ...trail,
      id: 'open1',
      pts: [
        [0, 0],
        [100, 50],
        [200, 200],
      ],
    };
    open(makeProject({ features: [openTrail] }));
    render(<FeaturesPanel />);
    act(() => selectFeature('open1'));

    const routeSelect = host.querySelector<HTMLSelectElement>('select[aria-label="Route type"]')!;
    act(() => {
      routeSelect.value = 'loop';
      routeSelect.dispatchEvent(new Event('change', { bubbles: true }));
    });

    expect(st().toast?.message).toContain('Trail ends are too far apart');
    const f = proj().features[0] as Extract<Feature, { kind: 'trail' }>;
    expect(f.route).toBeUndefined();
  });

  it('classifies a counterclockwise loop naturally as counterclockwise (T-334)', () => {
    const ccwTrail: Feature = {
      ...trail,
      id: 'loop-ccw',
      pts: [
        [0, 0],
        [0, 100],
        [100, 100],
        [0, 0],
      ],
    };
    open(makeProject({ features: [ccwTrail] }));
    render(<FeaturesPanel />);
    act(() => selectFeature('loop-ccw'));

    const routeSelect = host.querySelector<HTMLSelectElement>('select[aria-label="Route type"]')!;
    act(() => {
      routeSelect.value = 'loop';
      routeSelect.dispatchEvent(new Event('change', { bubbles: true }));
    });

    const p = proj();
    const f = p.features[0] as Extract<Feature, { kind: 'trail' }>;
    expect(f.route).toStrictEqual({ kind: 'loop', direction: 'counterclockwise' });
  });

  it('uses zoom-aware snap tolerance to close or refuse loops depending on editor view scale (T-334)', () => {
    // Endpoints are [0,0] and [0, 14], exactly 14 px apart
    const nearTrail: Feature = {
      ...trail,
      id: 'near1',
      pts: [
        [0, 0],
        [100, 50],
        [100, 100],
        [0, 14],
      ],
    };

    open(makeProject({ features: [nearTrail] }));
    render(<FeaturesPanel />);
    act(() => selectFeature('near1'));

    const routeSelect = host.querySelector<HTMLSelectElement>('select[aria-label="Route type"]')!;
    act(() => {
      routeSelect.value = 'loop';
      routeSelect.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(st().toast?.message).toContain(
      'Trail ends are too far apart (14.0 px) to close into a loop (must be within snap tolerance of 8.0 px).',
    );
    expect(
      proj().features[0]!.kind === 'trail' &&
        (proj().features[0] as Extract<Feature, { kind: 'trail' }>).route,
    ).toBeUndefined();

    const editorStub = {
      view: { s: 0.2 },
    } as unknown as NonNullable<ReturnType<typeof editorStageModule.currentEditor>>;
    const editorSpy = vi.spyOn(editorStageModule, 'currentEditor').mockReturnValue(editorStub);

    try {
      act(() => {
        routeSelect.value = 'loop';
        routeSelect.dispatchEvent(new Event('change', { bubbles: true }));
      });
      const f = proj().features[0] as Extract<Feature, { kind: 'trail' }>;
      expect(f.route?.kind).toBe('loop');
      expect(f.pts[0]).toStrictEqual([0, 0]);
      expect(f.pts.at(-1)).toStrictEqual([0, 0]);
    } finally {
      editorSpy.mockRestore();
    }
  });

  it('shows simplify control for selected trail with preview, smooth, and single-step undo (T-222)', async () => {
    const noisyTrail: Feature = {
      kind: 'trail',
      id: 't1',
      name: 'Noisy Ridge',
      color: '#D9480F',
      notes: '',
      ink: null,
      pts: [
        [0, 0],
        [10, 10.1],
        [25, 25.05],
        [50, 50],
        [75, 25.05],
        [90, 9.95],
        [100, 0],
      ],
    };
    open(makeProject({ features: [noisyTrail] }));
    render(<FeaturesPanel />);
    act(() => selectFeature('t1'));

    const simplifyCtrl = host.querySelector('.simplify-control');
    expect(simplifyCtrl).not.toBeNull();
    const countEl = simplifyCtrl?.querySelector('.point-count');
    expect(countEl?.textContent).toBe('7 → 3 points');

    // Canvas preview is populated
    expect(st().simplifyPreview?.featureId).toBe('t1');
    expect(st().simplifyPreview?.pts.length).toBe(3);

    // Toggle smooth
    const smoothBox = byLabel<HTMLInputElement>('Smooth');
    expect(smoothBox.checked).toBe(false);
    click(smoothBox);
    expect(smoothBox.checked).toBe(true);
    // Smooth cuts the corner at [50, 50], adding intermediate points
    expect(st().simplifyPreview?.pts.length).toBeGreaterThan(3);

    // Turn smooth back off for apply
    click(smoothBox);

    // Click Apply
    const applyBtn = byText('Apply');
    click(applyBtn);

    const current = proj().features.find((f) => f.id === 't1') as Trail;
    expect(current.pts).toStrictEqual([
      [0, 0],
      [50, 50],
      [100, 0],
    ]);

    // Undo restores original 7 points in one step
    act(() => undo());
    const reverted = proj().features.find((f) => f.id === 't1') as Trail;
    expect(reverted.pts).toHaveLength(7);
  });

  it('refines a selected trail with pinned junctions as one undoable edit (T-327)', async () => {
    const branch: Trail = {
      ...trail,
      id: 'branch',
      name: 'Branch',
      pts: [
        [900, 100],
        [950, 150],
      ],
    };
    const fake = fakeWorker({
      refineTrail: async () => ({
        pts: [
          [100, 98],
          [900, 100],
        ],
        segments: [{ from: 0, to: 1, refined: true, confidence: 0.96 }],
        ink: [205, 48, 48],
        ms: 4,
      }),
    });
    setWorkerForTests(fake.api);
    try {
      open(makeProject({ features: [trail, branch] }));
      render(
        <>
          <FeaturesPanel />
          <Toolbar />
        </>,
      );
      act(() => selectFeature('f1'));
      click(byText('Refine to map image'));
      await act(async () => jobsIdle());

      const [request] = fake.of('refineTrail')[0]!.args as [
        { pinned: readonly number[]; corridorPx: number },
      ];
      expect(request.pinned).toStrictEqual([1]);
      expect(request.corridorPx).toBe(12);
      const sourceTrail = proj().features[0]!;
      expect(sourceTrail.kind === 'trail' ? sourceTrail.pts : null).toStrictEqual(trail.pts);
      expect(host.querySelector('[aria-label="Refinement preview"]')).not.toBeNull();
      click(byText('Apply refinement'));
      expect((proj().features[0] as Trail).pts).toStrictEqual([
        [100, 98],
        [900, 100],
      ]);
      act(() => undo());
      expect((proj().features[0] as Trail).pts).toStrictEqual(trail.pts);
      act(() => redo());
      expect((proj().features[0] as Trail).pts).toStrictEqual([
        [100, 98],
        [900, 100],
      ]);
    } finally {
      setWorkerForTests(null);
    }
  });

  it('refines against sparse level -1 detail and maps its output back to map pixels (T-332)', async () => {
    const loaded = new Map<ImageId, RasterImage>();
    let imageCount = 0;
    const fake = fakeWorker({
      loadImage: async (raster) => {
        const id = `refine-image-${++imageCount}` as ImageId;
        loaded.set(id, raster);
        return id;
      },
      refineTrail: async (request) => {
        const hasDetail = loaded
          .get(request.imageId)
          ?.data.some((value, index) => index % 4 === 0 && value === 200);
        return {
          pts: hasDetail ? request.pts.map(([x, y]) => [x, y + 2] as const) : request.pts,
          segments: [
            {
              from: 0,
              to: request.pts.length - 1,
              refined: Boolean(hasDetail),
              confidence: hasDetail ? 0.95 : 0,
            },
          ],
          ink: [200, 40, 40],
          ms: 2,
        };
      },
    });
    setWorkerForTests(fake.api);
    const readRegion = vi.fn(
      async (rect: { x: number; y: number; width: number; height: number }, level: number) => {
        const scale = 2 ** -level;
        const width = Math.ceil(rect.width * scale);
        const height = Math.ceil(rect.height * scale);
        const data = new Uint8ClampedArray(width * height * 4);
        if (level === -1) {
          for (let i = 0; i < data.length; i += 4) data.set([200, 40, 40, 255], i);
        }
        return {
          width,
          height,
          data,
          ...(level === -1 ? { detailCoverage: new Uint8Array(width * height).fill(255) } : {}),
        };
      },
    );
    try {
      const session = makeSession(makeProject({ features: [trail] }));
      openSession({
        ...session,
        map: {
          ...session.map,
          tiles: {
            levels: [
              {
                level: -1,
                width: session.map.meta.width * 2,
                height: session.map.meta.height * 2,
                cols: 8,
                rows: 7,
              },
              {
                level: 0,
                width: session.map.meta.width,
                height: session.map.meta.height,
                cols: 4,
                rows: 4,
              },
            ],
            tileSize: 256,
            overviewScale: 0.5,
            getTileBitmap: async () => null,
            readRegion,
          },
        },
      });
      render(<FeaturesPanel />);
      act(() => selectFeature('f1'));
      click(byText('Refine to map image'));
      await act(async () => jobsIdle());

      expect(readRegion).toHaveBeenCalled();
      expect(readRegion.mock.calls.map(([, level]) => level)).toStrictEqual(
        readRegion.mock.calls.map(() => -1),
      );
      const request = fake.of('refineTrail')[0]!.args[0] as { corridorPx: number };
      expect(request.corridorPx).toBe(24);
      expect(st().refinePreview?.entries[0]?.parts[0]?.useRefined).toBe(true);
      expect(st().refinePreview?.entries[0]?.parts[0]?.refinedPts[0]).toStrictEqual([100, 101]);
    } finally {
      setWorkerForTests(null);
    }
  });

  it('rejects a refinement preview without changing the project and exposes Esri isolation copy (T-327)', async () => {
    const fake = fakeWorker();
    setWorkerForTests(fake.api);
    try {
      open(makeProject({ features: [trail] }));
      appStore.setState({ editorBackdrop: 'esri' });
      render(
        <>
          <FeaturesPanel />
          <Toolbar />
        </>,
      );
      act(() => selectFeature('f1'));
      const before = JSON.stringify(proj());
      click(byText('Refine to map image'));
      await act(async () => jobsIdle());
      expect(host.querySelector('[role="note"]')?.textContent).toBe(
        'Refining against the map image, not Esri.',
      );
      click(byText('Reject'));
      expect(JSON.stringify(proj())).toBe(before);
      expect(st().refinePreview).toBeNull();
    } finally {
      setWorkerForTests(null);
    }
  });

  it('starts refinement from the trail context menu and Alt+Shift+R shortcut (T-327)', async () => {
    const fake = fakeWorker();
    setWorkerForTests(fake.api);
    try {
      open(makeProject({ features: [trail] }));
      act(() => selectFeature('f1'));
      render(
        <>
          <FeaturesPanel />
          <Toolbar />
        </>,
      );
      act(() => q('.feats li').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true })));
      click(host.querySelector('[role="menuitem"]')!);
      await act(async () => jobsIdle());
      expect(fake.of('refineTrail')).toHaveLength(1);
      act(() => setRefinePreview(null));
      act(() => {
        document.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'R', altKey: true, shiftKey: true, bubbles: true }),
        );
      });
      await act(async () => jobsIdle());
      expect(fake.of('refineTrail')).toHaveLength(2);
    } finally {
      setWorkerForTests(null);
    }
  });

  it('refines all trails sequentially and applies the batch as one history command (T-327)', async () => {
    const second: Trail = {
      ...trail,
      id: 'second',
      name: 'Second trail',
      pts: [
        [200, 200],
        [500, 200],
      ],
    };
    const fake = fakeWorker({
      refineTrail: async (request) => ({
        pts: request.pts.map(([x, y]) => [x, y - 1] as const),
        segments: [{ from: 0, to: request.pts.length - 1, refined: true, confidence: 0.9 }],
        ink: [205, 48, 48],
        ms: 3,
      }),
    });
    setWorkerForTests(fake.api);
    try {
      open(makeProject({ features: [trail, second] }));
      render(<FeaturesPanel />);
      click(byText('Refine all trails'));
      await act(async () => jobsIdle());
      expect(fake.of('refineTrail')).toHaveLength(2);
      expect(st().refinePreview?.batch).toBe(true);
      click(byText('Apply refinement'));
      expect((proj().features[0] as Trail).pts).toStrictEqual([
        [100, 99],
        [900, 99],
      ]);
      expect((proj().features[1] as Trail).pts).toStrictEqual([
        [200, 199],
        [500, 199],
      ]);
      act(() => undo());
      expect(
        proj().features.map((feature) => (feature.kind === 'trail' ? feature.pts : [])),
      ).toStrictEqual([trail.pts, second.pts]);
    } finally {
      setWorkerForTests(null);
    }
  });

  it('supports simplify and smooth on areas, keeping closed rings with min 3 points (T-222)', () => {
    const testArea: Feature = {
      kind: 'area',
      id: 'a1',
      name: 'Pond',
      color: '#3A7D44',
      notes: '',
      pts: [
        [0, 0],
        [50, 0.1],
        [100, 0],
        [100, 100],
        [50, 99.9],
        [0, 100],
      ],
    };
    open(makeProject({ features: [testArea] }));
    render(<FeaturesPanel />);
    act(() => selectFeature('a1'));

    const countEl = host.querySelector('.simplify-control .point-count');
    expect(countEl?.textContent).toBe('6 → 4 points');

    // Apply
    click(byText('Apply'));
    const simplifiedArea = proj().features.find(
      (f) => f.id === 'a1',
    ) as import('../../core/types').Area;
    expect(simplifiedArea.pts.length).toBeGreaterThanOrEqual(3);
    expect(simplifiedArea.pts).toHaveLength(4);

    // Undo restores original points
    act(() => undo());
    const reverted = proj().features.find((f) => f.id === 'a1') as import('../../core/types').Area;
    expect(reverted.pts).toHaveLength(6);
  });

  it('preserves shared junction coordinates during simplify (T-222)', () => {
    const t1: Feature = {
      kind: 'trail',
      id: 't1',
      name: 'Main',
      color: '#D9480F',
      notes: '',
      ink: null,
      pts: [
        [0, 0],
        [25, 0.1],
        [50, 50],
        [75, 0.1],
        [100, 0],
      ],
    };
    const t2: Feature = {
      kind: 'trail',
      id: 't2',
      name: 'Branch',
      color: '#1F6FB2',
      notes: '',
      ink: null,
      pts: [
        [50, 50],
        [60, 80],
        [70, 100],
      ],
    };
    open(makeProject({ features: [t1, t2] }));
    render(<FeaturesPanel />);
    act(() => selectFeature('t1'));

    // Even if tolerance is high, junction [50, 50] must not be simplified away
    const tolInput = byLabel<HTMLInputElement>('Tolerance');
    act(() => {
      tolInput.value = '100';
      tolInput.dispatchEvent(new Event('change', { bubbles: true }));
      tolInput.dispatchEvent(new Event('input', { bubbles: true }));
    });

    click(byText('Apply'));
    const simplified = proj().features.find((f) => f.id === 't1') as Trail;
    // Must contain start, junction [50, 50], and end
    expect(simplified.pts).toStrictEqual([
      [0, 0],
      [50, 50],
      [100, 0],
    ]);
  });

  it('displays tolerance in real units (m or ft) depending on fit and project units (T-222)', () => {
    const t1: Feature = {
      kind: 'trail',
      id: 't1',
      name: 'Ridge',
      color: '#D9480F',
      notes: '',
      ink: null,
      pts: [
        [0, 0],
        [10, 0.1],
        [20, 0],
      ],
    };
    // No fit -> px
    open(makeProject({ features: [t1] }));
    render(<FeaturesPanel />);
    act(() => selectFeature('t1'));
    expect(host.querySelector('.simplify-control')?.textContent).toContain('px');

    // Fit with km -> m
    act(() =>
      open(
        makeProject({
          features: [t1],
          anchors: [anchor('g1', [0, 0]), anchor('g2', [1000, 0]), anchor('g3', [1000, 800])],
          units: 'km',
        }),
      ),
    );
    act(() => selectFeature('t1'));
    expect(host.querySelector('.simplify-control')?.textContent).toContain('m');

    // Fit with mi -> ft
    act(() =>
      open(
        makeProject({
          features: [t1],
          anchors: [anchor('g1', [0, 0]), anchor('g2', [1000, 0]), anchor('g3', [1000, 800])],
          units: 'mi',
        }),
      ),
    );
    act(() => selectFeature('t1'));
    expect(host.querySelector('.simplify-control')?.textContent).toContain('ft');
  });

  it('simplifies all trails with total count and single undo step (T-222)', async () => {
    const t1: Feature = {
      kind: 'trail',
      id: 't1',
      name: 'Trail 1',
      color: '#D9480F',
      notes: '',
      ink: null,
      pts: [
        [0, 0],
        [10, 0.1],
        [20, 0],
        [30, 0.2],
        [40, 0],
      ],
    };
    const t2: Feature = {
      kind: 'trail',
      id: 't2',
      name: 'Trail 2',
      color: '#1F6FB2',
      notes: '',
      ink: null,
      pts: [
        [100, 100],
        [110, 100.1],
        [120, 100],
        [130, 100.2],
        [140, 100],
      ],
    };
    open(makeProject({ features: [t1, t2] }));
    render(<FeaturesPanel />);

    const openAllBtn = byText('Simplify all trails');
    expect(openAllBtn).not.toBeUndefined();
    click(openAllBtn);

    const allPanel = host.querySelector('.simplify-all-panel');
    expect(allPanel).not.toBeNull();
    const countEl = allPanel?.querySelector('.point-count');
    expect(countEl?.textContent).toBe('10 → 4 points');

    click(byText('Apply to all trails'));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    const p = proj();
    const updated1 = p.features.find((f) => f.id === 't1') as Trail;
    const updated2 = p.features.find((f) => f.id === 't2') as Trail;
    expect(updated1.pts).toHaveLength(2);
    expect(updated2.pts).toHaveLength(2);

    // Single undo restores both trails
    act(() => undo());
    const restored1 = proj().features.find((f) => f.id === 't1') as Trail;
    const restored2 = proj().features.find((f) => f.id === 't2') as Trail;
    expect(restored1.pts).toHaveLength(5);
    expect(restored2.pts).toHaveLength(5);
  });
});

describe('ConnectPanel (T-221)', () => {
  it('offers a connector style after two points and previews before commit', () => {
    open(makeProject());
    setTool('connect');
    setConnectSession({
      points: [
        { trailId: 'a', segmentIndex: 0, point: [10, 10] },
        { trailId: 'b', segmentIndex: 0, point: [30, 10] },
      ],
      mode: null,
      connector: null,
      drawing: false,
    });
    render(<ConnectPanel />);
    expect(host.textContent).toContain('Choose how the connector should run.');
    click(byText('Straight'));
    expect(byText('Connect trails')).toBeTruthy();
    expect(host.textContent).toContain('Preview the line');
  });
});

/* ------------------------------------------------------------------ trace / review (T-210) */

describe('TracePanel review (T-210)', () => {
  const chip = (id: string, name: string): import('../../core/types').ColorChip => ({
    id,
    rgb: [200, 40, 40],
    name,
    enabled: true,
    share: null,
    named: false,
  });

  it('keeps regional auto-trace tiled-only and exposes a keyboard-accessible current-view action', () => {
    const region = { x: 25, y: 30, width: 200, height: 150 };
    const editorStub = {
      visibleMapRegion: region,
      setRegionSelection: vi.fn(),
    } as unknown as NonNullable<ReturnType<typeof editorStageModule.currentEditor>>;
    const editorSpy = vi.spyOn(editorStageModule, 'currentEditor').mockReturnValue(editorStub);
    const traceSpy = vi.spyOn(traceActionsModule, 'autoTraceRegion').mockResolvedValue();
    try {
      open(makeProject());
      render(<TracePanel />);
      expect(byText('Auto-trace a region')).toBeUndefined();

      act(() => {
        openTiled(makeProject());
        appStore.setState({ regionTraceMode: true });
      });
      render(<TracePanel />);
      const button = byText('Trace current view');
      expect(button).toBeTruthy();
      expect(button.getAttribute('aria-keyshortcuts')).toBe('V');
      expect(host.textContent).toContain('Drag a rectangle on the map. Press Escape to cancel.');
      expect(host.textContent).toContain(
        'Press V or choose Trace current view to trace the visible map bounds.',
      );
      click(button);
      expect(traceSpy).toHaveBeenCalledWith(region);
      expect(editorStub.setRegionSelection).toHaveBeenCalledWith(null);
      expect(st().regionTraceMode).toBe(false);
    } finally {
      traceSpy.mockRestore();
      editorSpy.mockRestore();
    }
  });

  it('"Join colors that continue each other" reflects and toggles the store default (on)', () => {
    open(makeProject({}));
    render(<TracePanel />);
    const box = [...host.querySelectorAll<HTMLInputElement>('input[type=checkbox]')].find((el) =>
      el.parentElement?.textContent?.includes('Join colors that continue each other'),
    )!;
    expect(box.checked).toBe(true);
    click(box);
    expect(st().mergeAcrossColors).toBe(false);
  });

  it('shows confidence bands, alsoChips swatches, and splits a candidate via its row button', () => {
    open(
      makeProject({
        autoTrace: { chips: [chip('c1', 'Red'), chip('c2', 'Loop')], gapPx: 12, minLengthPct: 4 },
      }),
    );
    appStore.setState({
      candidates: [
        {
          id: 'k1',
          chipId: 'c1',
          pts: [
            [0, 0],
            [10, 0],
            [20, 0],
          ],
          lengthPx: 20,
          ink: [200, 40, 40],
          confidence: 0.9,
          alsoChips: ['c2'],
          on: true,
          name: 'Red trail',
          color: '#c82828',
        },
      ],
    });
    render(<TracePanel />);
    expect(q('.cands').textContent).toContain('High confidence');
    expect(host.querySelectorAll('.swatches .ln')).toHaveLength(2);
    expect(byText('Undo split')).toBeUndefined();
    click(byText('Split'));
    expect(st().candidates).toHaveLength(2);
    expect(st().reviewUndoStack).toHaveLength(1);
    expect(byText('Undo split')).toBeTruthy();
    click(byText('Undo split'));
    expect(st().candidates).toHaveLength(1);
    expect(byText('Undo split')).toBeUndefined();
  });

  it('shows a candidate length placeholder until the sliced fill completes (T-216, D-025)', async () => {
    open(
      makeProject({
        anchors: [anchor('g1', [0, 0]), anchor('g2', [1000, 0]), anchor('g3', [1000, 800])],
        units: 'km',
      }),
    );
    appStore.setState({
      candidates: [
        {
          id: 'k1',
          chipId: 'c1',
          pts: [
            [0, 0],
            [10, 0],
            [800, 0],
          ],
          lengthPx: 800,
          ink: [200, 40, 40],
          confidence: 0.9,
          on: true,
          name: 'Red trail',
          color: '#c82828',
        },
      ],
    });
    render(<TracePanel />);
    expect(q('.cands .flen').textContent).toBe('…');
    await act(async () => new Promise((r) => setTimeout(r, 300)));
    expect(q('.cands .flen').textContent).toMatch(/^\d+ m$/);
  });

  it('mounts a large find-trails result progressively, but a tick/split does not reset it (T-216)', () => {
    vi.useFakeTimers();
    try {
      const many = (n: number, offset = 0): ReviewCandidate[] =>
        Array.from({ length: n }, (_, i) => ({
          id: `k${offset + i}`,
          chipId: 'c1',
          pts: [
            [0, 0],
            [10, 0],
          ],
          lengthPx: 10,
          ink: [200, 40, 40],
          confidence: null,
          on: true,
          name: `Line ${offset + i}`,
          color: '#c82828',
        }));
      open(makeProject({ autoTrace: { chips: [chip('c1', 'Red')], gapPx: 12, minLengthPct: 4 } }));
      const cands = many(LIST_FIRST + LIST_BATCH + 10);
      act(() => setCandidates(cands));
      render(<TracePanel />);
      const rows = () => host.querySelectorAll('.cands ul li').length;
      expect(rows()).toBe(LIST_FIRST);
      act(() => vi.advanceTimersToNextFrame());
      expect(rows()).toBe(LIST_FIRST + LIST_BATCH);
      act(() => vi.advanceTimersToNextFrame());
      expect(rows()).toBe(cands.length);
      // Ticking a candidate replaces `candidates` (a new array) but not reviewEpoch: no reset.
      act(() => setCandidateOn(cands[0]!.id, false));
      expect(rows()).toBe(cands.length);
      // A fresh find-trails result (a new epoch) resets and ramps again.
      const fresh = many(LIST_FIRST + LIST_BATCH + 10, 10_000);
      act(() => setCandidates(fresh));
      expect(rows()).toBe(LIST_FIRST);
      act(() => vi.advanceTimersToNextFrame());
      act(() => vi.advanceTimersToNextFrame());
      expect(rows()).toBe(fresh.length);
    } finally {
      vi.useRealTimers();
    }
  }, 15_000);

  it('chooses and splits a candidate vertex with the keyboard, then restores it with one undo', () => {
    open(makeProject({ autoTrace: { chips: [chip('c1', 'Red')], gapPx: 12, minLengthPct: 4 } }));
    const original = {
      id: 'k1',
      chipId: 'c1',
      pts: [
        [0, 0],
        [10, 0],
        [20, 0],
        [30, 0],
        [40, 0],
      ] as [number, number][],
      lengthPx: 40,
      ink: [200, 40, 40] as [number, number, number],
      confidence: 0.9,
      on: true,
      name: 'Red trail',
      color: '#c82828',
    };
    appStore.setState({ candidates: [original] });
    render(<TracePanel />);
    const split = byText('Split');
    act(() => split.focus());
    expect(st().candidateSplitFocus).toMatchObject({ candidateId: 'k1', index: 2, moved: false });
    act(() =>
      split.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })),
    );
    expect(st().candidateSplitFocus).toMatchObject({ candidateId: 'k1', index: 3, moved: true });
    expect(st().announcement?.text).toBe('Split point 4 of 5');
    act(() => split.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 })));
    expect(st().candidates?.map((c) => c.pts)).toStrictEqual([
      [
        [0, 0],
        [10, 0],
        [20, 0],
        [30, 0],
      ],
      [
        [30, 0],
        [40, 0],
      ],
    ]);
    expect(st().reviewUndoStack).toHaveLength(1);
    click(byText('Undo split'));
    expect(st().candidates).toStrictEqual([original]);
    expect(st().reviewUndoStack).toHaveLength(0);
  });

  it('moves candidate split focus with arrow-free aliases and ten-point steps', () => {
    open(makeProject({ autoTrace: { chips: [chip('c1', 'Red')], gapPx: 12, minLengthPct: 4 } }));
    const c = {
      id: 'alias-candidate',
      chipId: 'c1',
      pts: Array.from({ length: 52 }, (_, i) => [i, 0] as [number, number]),
      lengthPx: 51,
      ink: [200, 40, 40] as [number, number, number],
      confidence: 0.9,
      on: true,
      name: 'Long trail',
      color: '#c82828',
    };
    act(() => setCandidates([c]));
    render(<TracePanel />);
    const split = byText('Split');
    act(() => split.focus());
    const press = (key: string, shiftKey = false) =>
      act(() =>
        split.dispatchEvent(
          new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true }),
        ),
      );
    expect(st().candidateSplitFocus?.index).toBe(25);
    press('.');
    expect(st().candidateSplitFocus?.index).toBe(26);
    press(',');
    expect(st().candidateSplitFocus?.index).toBe(25);
    press('>');
    expect(st().candidateSplitFocus?.index).toBe(35);
    press('<');
    expect(st().candidateSplitFocus?.index).toBe(25);
    press('[');
    expect(st().candidateSplitFocus?.index).toBe(15);
    press(']');
    expect(st().candidateSplitFocus?.index).toBe(25);
    press(',', true);
    expect(st().candidateSplitFocus?.index).toBe(15);
    press('.', true);
    expect(st().candidateSplitFocus?.index).toBe(25);
    expect(split.getAttribute('aria-keyshortcuts')).toContain('Period');
  });
});

/* ------------------------------------------------------------------ export */

describe('ExportPanel', () => {
  const placed = (features: Feature[], name = 'Red Reef Park') =>
    makeProject({
      name,
      features,
      anchors: [anchor('g1', [0, 0]), anchor('g2', [1000, 0]), anchor('g3', [1000, 800])],
    });

  it('stays disabled until the map is placed and something is traced', () => {
    open(makeProject({ features: [trail] }));
    render(<ExportPanel />);
    expect(q('.sum').textContent).toBe('Pin the map to at least 2 real-world coordinates first.');
    expect(byText('Download all (.zip)').disabled).toBe(true);
    expect(byLabel<HTMLButtonElement>('Download GPX').disabled).toBe(true);

    act(() => open(placed([])));
    expect(q('.sum').textContent).toBe('Trace at least one trail or point.');
    expect(byText('Copy GPX').disabled).toBe(true);

    act(() => open(placed([trail, area, poi])));
    expect(q('.sum').textContent).toMatch(/^Ready: 1 trail \(0\.\d\d mi\), 1 area, 1 point\.$/);
    for (const label of [
      'Download GPX',
      'Download KML',
      'Download KMZ with map overlay',
      'Download GeoJSON',
    ]) {
      expect(byLabel<HTMLButtonElement>(label).disabled).toBe(false);
    }
    expect(byText('Download all (.zip)').disabled).toBe(false);
  });

  it('downloads GPX / KML / GeoJSON named from slugify', async () => {
    open(placed([trail, poi]));
    render(<ExportPanel />);
    click(byLabel<HTMLButtonElement>('Download GPX'));
    click(byLabel<HTMLButtonElement>('Download KML'));
    click(byLabel<HTMLButtonElement>('Download GeoJSON'));
    // The exports are built in time slices (T-211); idle() covers them. The three run
    // concurrently, so under CPU load they may finish in any order.
    await act(async () => {
      await jobsIdle();
    });
    expect([...downloads].sort((a, b) => a.name.localeCompare(b.name))).toStrictEqual([
      { name: 'red-reef-park.geojson', type: 'application/geo+json' },
      { name: 'red-reef-park.gpx', type: 'application/gpx+xml' },
      { name: 'red-reef-park.kml', type: 'application/vnd.google-earth.kml+xml' },
    ]);
  });

  it('summarizes plural counts and switches units', () => {
    const p = placed([trail, { ...trail, id: 'f9' }, poi, { ...poi, id: 'f8' }]);
    const fit = (() => {
      open(p);
      const f = selectFit(st());
      return f?.ok ? f : null;
    })();
    expect(exportSummary(p, fit)).toMatch(/^Ready: 2 trails \(.+ mi\), 2 points\.$/);
    render(<ExportPanel />);
    click(host.querySelector<HTMLButtonElement>('[aria-label="Export units"] button:last-child')!);
    expect(proj().units).toBe('km');
  });

  it('warns about unsnapped nearby trail ends once edits are idle, and its own button clears the warning (T-209, D-020)', () => {
    vi.useFakeTimers();
    try {
      const near: Feature = {
        ...trail,
        id: 'f9',
        pts: [
          [905, 100],
          [905, 300],
        ],
      };
      open(placed([trail, near]));
      render(<ExportPanel />);
      // Not evaluated until edits have been idle HINT_IDLE_MS.
      act(() => vi.advanceTimersByTime(HINT_IDLE_MS - 1));
      expect(host.querySelector('.hint.warn')).toBeNull();
      act(() => vi.advanceTimersByTime(1));
      expect(q('.hint.warn').textContent).toContain('Some trail ends are close but not joined.');
      click(host.querySelector<HTMLButtonElement>('.hint.warn button')!);
      expect(st().toast?.message).toMatch(/^Joined \d+ trail ends?$/);
      // Hidden at once: it was computed for the features before the edit.
      expect(host.querySelector('.hint.warn')).toBeNull();
      act(() => vi.advanceTimersByTime(HINT_IDLE_MS));
      expect(host.querySelector('.hint.warn')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('restarts the hint wait on every edit and never evaluates it with a draft open (D-020)', () => {
    vi.useFakeTimers();
    try {
      const near: Feature = {
        ...trail,
        id: 'f9',
        pts: [
          [905, 100],
          [905, 300],
        ],
      };
      open(placed([trail, near]));
      render(<ExportPanel />);
      act(() => vi.advanceTimersByTime(HINT_IDLE_MS - 100));
      act(() => edit(updateFeature(proj(), 'f9', { name: 'Near' })));
      act(() => vi.advanceTimersByTime(HINT_IDLE_MS - 100));
      expect(host.querySelector('.hint.warn')).toBeNull();
      act(() =>
        setDraft({
          kind: 'trail',
          name: 'Trail 3',
          pts: [[1, 1]],
          cps: [1],
          editId: null,
          color: '#D9480F',
          ink: null,
        }),
      );
      act(() => vi.advanceTimersByTime(5 * HINT_IDLE_MS));
      expect(host.querySelector('.hint.warn')).toBeNull();
      act(() => setDraft(null));
      act(() => vi.advanceTimersByTime(HINT_IDLE_MS));
      expect(host.querySelector('.hint.warn')).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows no warning when trail ends are far apart', () => {
    vi.useFakeTimers();
    try {
      open(
        placed([
          trail,
          {
            ...trail,
            id: 'f9',
            pts: [
              [0, 500],
              [0, 700],
            ],
          },
        ]),
      );
      render(<ExportPanel />);
      act(() => vi.advanceTimersByTime(HINT_IDLE_MS));
      expect(host.querySelector('.hint.warn')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows the busy overlay with Cancel for a long export, and Cancel stops it (T-211)', async () => {
    let kmzCalls = 0;
    const fake = fakeWorker({
      buildKmz: () => {
        kmzCalls++;
        return new Promise<Uint8Array>(() => {});
      },
    });
    setWorkerForTests(fake.api);
    try {
      open(placed([trail, poi]));
      render(
        <>
          <ExportPanel />
          <Busy />
        </>,
      );
      click(byLabel<HTMLButtonElement>('Download KMZ with map overlay'));
      await act(async () => {
        await new Promise((r) => setTimeout(r, BUSY_AFTER_MS + 50));
      });
      expect(kmzCalls).toBe(1);
      expect(st().busy).toBe('Building KMZ…');
      const busy = q('.busy');
      expect(busy.hidden).toBe(false);
      const cancel = [...busy.querySelectorAll('button')].find((b) => b.textContent === 'Cancel')!;
      click(cancel);
      await act(async () => {
        await jobsIdle();
      });
      expect(fake.of('cancel')).toHaveLength(1);
      expect(st().busy).toBeNull();
      expect(st().busyCancel).toBeNull();
      expect(q('.busy').hidden).toBe(true);
      expect(downloads).toStrictEqual([]);
      expect(st().toast).toBeNull();
    } finally {
      setWorkerForTests(null);
    }
  });

  it('sends the KMZ worker job lat/lon only, without the pixel paths (T-211)', async () => {
    const fake = fakeWorker({ buildKmz: async () => new Uint8Array([80, 75, 5, 6]) });
    setWorkerForTests(fake.api);
    try {
      open(placed([trail, poi]));
      render(<ExportPanel />);
      click(byLabel<HTMLButtonElement>('Download KMZ with map overlay'));
      await act(async () => {
        await jobsIdle();
      });
      expect(downloads).toStrictEqual([
        { name: 'red-reef-park.kmz', type: 'application/vnd.google-earth.kmz' },
      ]);
      const [req] = fake.of('buildKmz')[0]!.args as [KmzRequest];
      const sent = req.doc.features.find((f) => f.kind === 'trail')!;
      expect(sent.kind === 'trail' && sent.pts).toStrictEqual([]);
      expect(sent.kind === 'trail' && sent.ll.length).toBe(
        trail.kind === 'trail' ? trail.pts.length : 0,
      );
    } finally {
      setWorkerForTests(null);
    }
  });

  it('uses tiledOverlayQuad tile math for KMZ export when map is tiled (T-331)', async () => {
    const fake = fakeWorker({ buildKmz: async () => new Uint8Array([80, 75, 5, 6]) });
    setWorkerForTests(fake.api);
    try {
      const baseProject = placed([trail, poi]);
      const tiledProject: Project = {
        ...baseProject,
        image: {
          ...baseProject.image,
          source: {
            kind: 'tiles',
            sourceId: 'martin-county',
            z: 20,
            tileSize: 256,
            origin: { x: 74400000, y: 112800000 },
            boundary: [
              [27.15, -80.16],
              [27.15, -80.14],
              [27.13, -80.14],
              [27.13, -80.16],
            ],
            tileCount: 96 * 64,
          },
        },
      };
      open(tiledProject);
      render(<ExportPanel />);
      click(byLabel<HTMLButtonElement>('Download KMZ with map overlay'));
      await act(async () => {
        await jobsIdle();
      });
      const [req] = fake.of('buildKmz')[0]!.args as [KmzRequest];
      expect(req.quad).toBeDefined();
      expect(req.quad).toHaveLength(4);
      const [sw] = req.quad!;
      expect(sw[0]).toBeCloseTo(27.59, 1);
      expect(sw[1]).toBeCloseTo(-80.22, 1);
    } finally {
      setWorkerForTests(null);
    }
  });

  it('shows no busy overlay for an export that finishes quickly (T-211)', async () => {
    open(placed([trail, poi]));
    render(<ExportPanel />);
    const seen: (string | null)[] = [];
    const off = appStore.subscribe((s) => seen.push(s.busy));
    click(byLabel<HTMLButtonElement>('Download GPX'));
    await act(async () => {
      await jobsIdle();
    });
    off();
    expect(downloads).toHaveLength(1);
    expect(seen.filter((b) => b !== null)).toStrictEqual([]);
  });
});

describe('FeaturesPanel long lists (T-211)', () => {
  it('mounts LIST_FIRST rows with the panel, then LIST_BATCH more per animation frame', () => {
    vi.useFakeTimers();
    try {
      const many = Array.from({ length: LIST_FIRST + LIST_BATCH + 10 }, (_, i): Feature => ({
        ...trail,
        id: `f${100 + i}`,
        name: `Trail ${i}`,
      }));
      open(makeProject({ features: many, seq: 1000 }));
      render(<FeaturesPanel />);
      const rows = () => host.querySelectorAll('ul[aria-label="Traced features"] li').length;
      expect(rows()).toBe(LIST_FIRST);
      act(() => vi.advanceTimersToNextFrame());
      expect(rows()).toBe(LIST_FIRST + LIST_BATCH);
      act(() => vi.advanceTimersToNextFrame());
      expect(rows()).toBe(many.length);
      // A same-count edit doesn't reset the ramp (n already covers the unchanged total).
      act(() => edit(updateFeature(proj(), 'f100', { name: 'Renamed' })));
      expect(rows()).toBe(many.length);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a count-growing edit (not a new map) still ramps in LIST_BATCH per frame, not all at once (T-216)', () => {
    vi.useFakeTimers();
    try {
      const start = Array.from({ length: 5 }, (_, i): Feature => ({
        ...trail,
        id: `s${i}`,
        name: `Trail ${i}`,
      }));
      open(makeProject({ features: start, seq: 2000 }));
      render(<FeaturesPanel />);
      const rows = () => host.querySelectorAll('ul[aria-label="Traced features"] li').length;
      expect(rows()).toBe(5); // under LIST_FIRST, nothing to ramp yet
      const grown = [
        ...start,
        ...Array.from({ length: LIST_FIRST + LIST_BATCH + 10 }, (_, i): Feature => ({
          ...trail,
          id: `g${i}`,
          name: `Grown ${i}`,
        })),
      ];
      act(() =>
        edit({
          label: 'bulk add',
          apply: (p) => ({ ...p, features: grown }),
          revert: (p) => ({ ...p, features: start }),
          coalesceKey: null,
        }),
      );
      // The same-frame render still shows only what was already ramped (LIST_FIRST, since the
      // small starting list never needed more), not all of `grown` at once.
      expect(rows()).toBe(LIST_FIRST);
      act(() => vi.advanceTimersToNextFrame());
      expect(rows()).toBe(LIST_FIRST + LIST_BATCH);
      act(() => vi.advanceTimersToNextFrame());
      expect(rows()).toBe(grown.length);
    } finally {
      vi.useRealTimers();
    }
  });
});

/* ------------------------------------------------------------------ bridge sanity */

it('panels render nothing before a map is open', () => {
  appStore.setState({ session: null });
  render(
    <>
      <AnchorsPanel />
      <FeaturesPanel />
      <ExportPanel />
    </>,
  );
  expect(host.innerHTML).toBe('');
  expect(sessionBridge.getSession()).toBeNull();
});
