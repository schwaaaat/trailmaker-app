import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AutoTraceCandidate,
  AutoTraceRequest,
  ColorChip,
  ColorScanResult,
  ImageId,
  JobControl,
  Project,
  Px,
  RasterImage,
  Rgb,
  ScannedColor,
  SmartTraceRequest,
  SmartTraceResult,
  WorkerApi,
} from '../../core/types';
import { sessionBridge } from '../../state/bridge';
import { deferred, fakeWorker } from '../../state/fake-worker.test.helper';
import { makeMap, makeProject, makeSession } from '../../state/fixtures.test.helper';
import { appStore, openSession, setTool, undo, undoCandidateSplit } from '../../state/store';
import {
  linkWorkerToSession,
  resetIsolationToastForTests,
  setWorkerForTests,
} from '../../state/worker-link';
import { Editor } from '../editor/Editor';
import { key, makeCanvas, ptr, tap } from '../editor/pointer.test.helper';
import { idle, installSmartFollow, pickRadius, snapRadius } from '../editor/smart';
import { Tools, chooseTool, settled } from '../editor/tools';
import { toScr } from '../editor/view';
import { splitReviewedCandidateAtMidpoint } from './candidate-split';
import type { TileLevel, TiledRegionRaster } from '../contract';
import {
  autoTraceRegion,
  autoTraceLevelForRegion,
  acceptReviewed,
  cancelRunningJob,
  clearScanCacheForTests,
  confidenceBand,
  findTrails,
  nameFor,
  pickColor,
  scanMapColors,
  setAllCandidates,
} from './trace-actions';

const st = () => appStore.getState();
const proj = () => st().session!.project;

const scanned = (
  rgb: [number, number, number],
  name: string,
  likely: boolean,
  share = 0.02,
): ScannedColor => ({
  rgb,
  name,
  share,
  thinness: 0.5,
  saturation: 0.6,
  lightness: 0.4,
  score: 1,
  likely,
});

let canvas: HTMLCanvasElement;
let ed: Editor;
let tools: Tools;
let unsmart: () => void;
let unlink: () => void;
let worker: ReturnType<typeof fakeWorker>;

function setup(over: Partial<WorkerApi> = {}, project: Project = makeProject({ seq: 20 })) {
  worker = fakeWorker(over);
  setWorkerForTests(worker.api);
  appStore.setState({ toast: null });
  openSession(makeSession(project));
  unlink = linkWorkerToSession();
  canvas = makeCanvas();
  ed = new Editor();
  ed.mount(canvas);
  tools = new Tools(ed);
  unsmart = installSmartFollow(ed);
}

const click = (p: Px) => tap(canvas, toScr(ed.view, p) as [number, number]);

const DETAIL_TRAIL_RGB: Rgb = [200, 40, 40];

function detailOnlyTrailRaster(
  rect: { x: number; y: number; width: number; height: number },
  level: number,
): TiledRegionRaster {
  const scale = 2 ** -level;
  const width = Math.ceil(rect.width * scale);
  const height = Math.ceil(rect.height * scale);
  const data = new Uint8ClampedArray(width * height * 4);
  if (level === -1) {
    const row = Math.floor(height / 2);
    for (let x = 0; x < width; x++) {
      const offset = (row * width + x) * 4;
      data.set([...DETAIL_TRAIL_RGB, 255], offset);
    }
  }
  return {
    width,
    height,
    data,
    ...(level === -1 ? { detailCoverage: new Uint8Array(width * height).fill(255) } : {}),
  };
}

function openDetailTiled(
  project: Project,
  readRegion: (
    rect: { x: number; y: number; width: number; height: number },
    level: number,
  ) => Promise<TiledRegionRaster>,
) {
  const session = makeSession(project);
  openSession({
    ...session,
    map: {
      ...session.map,
      tiles: {
        levels: [
          {
            level: -1,
            width: project.image.width * 2,
            height: project.image.height * 2,
            cols: 8,
            rows: 7,
          },
          { level: 0, width: project.image.width, height: project.image.height, cols: 4, rows: 4 },
        ],
        tileSize: 256,
        overviewScale: 0.5,
        getTileBitmap: async () => null,
        readRegion,
      },
    },
  });
}

function hasDetailTrail(raster: RasterImage | undefined): boolean {
  if (!raster) return false;
  for (let i = 0; i < raster.data.length; i += 4) {
    if (
      raster.data[i] === DETAIL_TRAIL_RGB[0] &&
      raster.data[i + 1] === DETAIL_TRAIL_RGB[1] &&
      raster.data[i + 2] === DETAIL_TRAIL_RGB[2]
    ) {
      return true;
    }
  }
  return false;
}

describe('regional auto-trace level selection', () => {
  beforeEach(() => setup());

  const levels: TileLevel[] = [
    { level: 0, width: 40000, height: 30000, cols: 157, rows: 118 },
    { level: 1, width: 20000, height: 15000, cols: 79, rows: 59 },
    { level: 2, width: 10000, height: 7500, cols: 40, rows: 30 },
    { level: 3, width: 5000, height: 3750, cols: 20, rows: 15 },
  ];

  it('chooses the finest level that fits the selected region, not the whole map', () => {
    expect(autoTraceLevelForRegion(levels, { width: 8000, height: 8000 })).toBe(1);
  });

  it('keeps level 0 when the selected region is already within budget', () => {
    expect(autoTraceLevelForRegion(levels, { width: 7000, height: 7000 })).toBe(0);
  });

  it('uses V to auto-trace the bounded current view on a tiled map', async () => {
    const project = makeProject({
      autoTrace: {
        chips: [
          {
            id: 'c1',
            name: 'Red',
            rgb: [200, 40, 40],
            enabled: true,
            share: null,
            named: false,
          },
        ],
        gapPx: 12,
        minLengthPct: 4,
      },
    });
    setup({}, project);
    const session = makeSession(project);
    const readRegion = vi.fn(async ({ width, height }: { width: number; height: number }) => ({
      width,
      height,
      data: new Uint8ClampedArray(width * height * 4),
    }));
    openSession({
      ...session,
      map: {
        ...session.map,
        tiles: {
          levels: [{ level: 0, width: 1000, height: 800, cols: 4, rows: 4 }],
          tileSize: 256,
          overviewScale: 0.5,
          getTileBitmap: async () => null,
          readRegion,
        },
      },
    });
    await idle();
    const visibleRegion = ed.visibleMapRegion!;
    appStore.setState({ regionTraceMode: true });

    const event = key('v');
    expect(event.defaultPrevented).toBe(true);
    expect(st().regionTraceMode).toBe(false);
    await idle();

    expect(readRegion).toHaveBeenCalledWith(visibleRegion, 0);
    expect(worker.of('autoTrace')).toHaveLength(1);
    const request = worker.of('autoTrace')[0]!.args[0] as AutoTraceRequest;
    expect(request.imageId).not.toBe(st().imageId);
  });

  it('does not run whole-image tracing for a regional request on a non-tiled map', async () => {
    setup();
    await autoTraceRegion({ x: 100, y: 100, width: 200, height: 150 });
    expect(worker.of('autoTrace')).toHaveLength(0);
    expect(worker.of('scanColors')).toHaveLength(0);
  });
});

beforeEach(async () => {
  await settled();
  setTool('select');
  resetIsolationToastForTests();
  clearScanCacheForTests();
});

afterEach(async () => {
  await idle();
  unsmart();
  tools.destroy();
  ed.destroy();
  unlink();
  canvas.remove();
  setWorkerForTests(null);
  document.body.innerHTML = '';
});

describe('worker image lifecycle', () => {
  it('transfers each map once, keeps the ImageId, and releases it for the next map', async () => {
    setup();
    await idle();
    expect(worker.of('loadImage')).toHaveLength(1);
    expect(st().imageId).toBe('image-1');
    // Same map, new project (e.g. restore): no second transfer.
    openSession({ ...st().session!, project: makeProject({ seq: 99 }) });
    await idle();
    expect(worker.of('loadImage')).toHaveLength(1);
    // Another map: release the old image, load the new one.
    openSession(makeSession(makeProject()));
    await idle();
    expect(worker.of('releaseImage').map((c) => c.args[0])).toStrictEqual(['image-1']);
    expect(worker.of('loadImage')).toHaveLength(2);
    expect(st().imageId).toBe('image-2');
  });

  it('keeps gapPx from the project (T-301 newProject sets the default)', () => {
    setup({}, makeProject({ autoTrace: { chips: [], gapPx: 37, minLengthPct: 4 } }));
    expect(proj().autoTrace.gapPx).toBe(37);
  });
});

describe('smart follow', () => {
  it('first click picks ink (5/zoom) and snaps (8/zoom); later clicks trace through the worker', async () => {
    setup();
    chooseTool('trail');
    click([100, 500]);
    await idle();
    const [pick] = worker.of('pickInk');
    expect(pick!.args[2]).toBeCloseTo(pickRadius(ed.view), 9);
    const [snap] = worker.of('snapToInk');
    expect(snap!.args[4]).toBeCloseTo(snapRadius(ed.view), 9);
    const d = st().draft!;
    expect(d.ink).toStrictEqual([200, 40, 40]);
    expect(d.color).toBe('#c82828');
    expect(d.pts[0]![0]).toBeCloseTo(101, 6); // snapped
    expect(st().lastInk).toStrictEqual([200, 40, 40]);

    click([300, 500]);
    await idle();
    const [trace] = worker.of('smartTrace');
    const req = trace!.args[0] as SmartTraceRequest;
    expect(req).toMatchObject({ imageId: 'image-1', ink: [200, 40, 40], tolerance: 60 });
    expect(req.snapRadiusPx).toBeCloseTo(snapRadius(ed.view), 9);
    // The path's first point (= the draft's last) is not repeated.
    expect(st().draft!.pts).toHaveLength(3);
    expect(st().draft!.cps).toStrictEqual([1, 3]);
  });

  it('uses a trail present only in sparse detail for follow and ink pick', async () => {
    const loaded = new Map<ImageId, RasterImage>();
    let imageCount = 0;
    setup({
      loadImage: async (raster) => {
        const id = `tool-image-${++imageCount}` as ImageId;
        loaded.set(id, raster);
        return id;
      },
      pickInk: async (id) => (hasDetailTrail(loaded.get(id)) ? DETAIL_TRAIL_RGB : [0, 180, 0]),
      snapToInk: async (_id, at) => at,
      smartTrace: async (request) =>
        hasDetailTrail(loaded.get(request.imageId))
          ? {
              path: [
                request.from,
                [(request.from[0] + request.to[0]) / 2, request.from[1] + 2],
                request.to,
              ],
              snappedTo: request.to,
              ms: 5,
            }
          : { path: null, snappedTo: request.to, ms: 5 },
    });
    const readRegion = vi.fn(
      async (rect: { x: number; y: number; width: number; height: number }, level: number) =>
        detailOnlyTrailRaster(rect, level),
    );
    openDetailTiled(proj(), readRegion);

    chooseTool('trail');
    click([100, 500]);
    await idle();
    expect(st().draft?.ink).toStrictEqual(DETAIL_TRAIL_RGB);
    expect(worker.of('pickInk')[0]!.args[2]).toBeCloseTo(pickRadius(ed.view) * 2, 9);
    expect(worker.of('snapToInk')[0]!.args[4]).toBeCloseTo(snapRadius(ed.view) * 2, 9);

    click([300, 500]);
    await idle();
    expect(st().draft?.pts).toContainEqual([200, 501]);
    const traceRequest = worker.of('smartTrace')[0]!.args[0] as SmartTraceRequest;
    expect(traceRequest.snapRadiusPx).toBeCloseTo(snapRadius(ed.view) * 2, 9);

    pickColor('trace');
    click([400, 400]);
    await idle();
    expect(proj().trace.ink).toStrictEqual(DETAIL_TRAIL_RGB);
    expect(worker.of('pickInk')).toHaveLength(2);
    expect(worker.of('pickInk')[1]!.args[2]).toBeCloseTo(pickRadius(ed.view) * 2, 9);
    expect(readRegion.mock.calls.map(([, level]) => level)).toStrictEqual([-1, -1, -1]);
  });

  it('uses the picked ink instead of picking from the first click', async () => {
    setup({}, makeProject({ trace: { smartFollow: true, tolerance: 70, ink: [10, 20, 200] } }));
    chooseTool('trail');
    click([100, 500]);
    await idle();
    expect(worker.of('pickInk')).toHaveLength(0);
    expect(st().draft!.ink).toStrictEqual([10, 20, 200]);
  });

  it('adds a straight segment to the snapped point, with the prototype toast, when a hop fails', async () => {
    setup({
      smartTrace: async (req): Promise<SmartTraceResult> => ({
        path: null,
        snappedTo: [req.to[0], 777],
        ms: 3,
      }),
    });
    chooseTool('trail');
    click([100, 500]);
    click([300, 500]);
    await idle();
    expect(st().toast?.message).toMatch(/^Too far to follow in one step/);
    expect(st().draft!.pts.at(-1)![1]).toBe(777);
  });

  it('with smart follow off, draws straight lines and never calls the worker', async () => {
    setup({}, makeProject({ trace: { smartFollow: false, tolerance: 60, ink: null } }));
    chooseTool('trail');
    click([100, 500]);
    click([300, 500]);
    await idle();
    expect(worker.of('pickInk')).toHaveLength(0);
    expect(worker.of('smartTrace')).toHaveLength(0);
    expect(st().draft!.pts).toHaveLength(2);
  });

  it('a new click cancels the hop still tracing; that click adds nothing', async () => {
    const slow = deferred<SmartTraceResult>();
    let first = true;
    setup({
      smartTrace: (req) => {
        if (first) {
          first = false;
          return slow.promise;
        }
        return Promise.resolve({ path: [req.from, req.to], snappedTo: req.to, ms: 1 });
      },
    });
    chooseTool('trail');
    click([100, 500]);
    await idle();
    click([300, 500]); // slow hop
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    click([500, 500]); // supersedes it
    await idle();
    const cancels = worker.of('cancel');
    expect(cancels).toHaveLength(1);
    const firstJob = (worker.of('smartTrace')[0]!.args[1] as JobControl).jobId;
    expect(cancels[0]!.args[0]).toBe(firstJob);
    // The start point and the second hop only; no toast for the cancelled hop.
    expect(st().draft!.pts.map((p) => Math.round(p[0]))).toStrictEqual([101, 500]);
    expect(st().toast).toBeNull();
  });

  it('Esc cancels the running hop and the draft', async () => {
    const slow = deferred<SmartTraceResult>();
    setup({ smartTrace: () => slow.promise });
    chooseTool('trail');
    click([100, 500]);
    await idle();
    click([300, 500]);
    await new Promise((r) => setTimeout(r, 0));
    key('Escape');
    await idle();
    expect(worker.of('cancel')).toHaveLength(1);
    expect(st().draft).toBeNull();
  });

  it('shows the cross-origin-isolation error once, and not again from the drafting queue', async () => {
    const isolation = new Error(
      'Worker cancellation requires COOP/COEP cross-origin isolation headers',
    );
    setup({
      pickInk: () => {
        throw isolation;
      },
    });
    chooseTool('trail');
    click([100, 500]);
    await idle();
    const first = st().toast;
    expect(first?.message).toMatch(/cross-origin isolated/);
    click([120, 500]);
    await idle();
    expect(st().toast).toBe(first);
  });
});

describe('ink picker', () => {
  it('"Pick color" follows the picked ink, updates the open draft and returns to drawing', async () => {
    setup({ pickInk: async () => [30, 90, 200] });
    chooseTool('trail');
    click([100, 500]);
    await idle();
    pickColor('trace');
    expect(st().tool).toBe('ink');
    click([400, 400]);
    await idle();
    expect(proj().trace.ink).toStrictEqual([30, 90, 200]);
    expect(st().draft?.ink).toStrictEqual([30, 90, 200]);
    expect(st().tool).toBe('trail');
    expect(st().toast?.message).toBe('Following #1e5ac8');
  });

  it('"Pick color from map" adds a chip named for the color and returns to select', async () => {
    setup({ pickInk: async () => [36, 130, 60] });
    pickColor('chip');
    click([400, 400]);
    await idle();
    expect(proj().autoTrace.chips).toMatchObject([
      { rgb: [36, 130, 60], enabled: true, named: false },
    ]);
    expect(st().tool).toBe('select');
  });
});

describe('scan and chips', () => {
  it('adds scanned colors, merging near duplicates (RGB < 40) and ticking the likely ones', async () => {
    const colors = [
      scanned([200, 40, 40], 'Red', true, 0.03),
      scanned([205, 45, 38], 'Red', false, 0.01), // merges into the first
      scanned([40, 60, 200], 'Blue', false, 0.02),
    ];
    setup({ scanColors: async (): Promise<ColorScanResult> => ({ colors }) });
    await scanMapColors();
    const chips = proj().autoTrace.chips;
    expect(chips.map((c) => [c.name, c.enabled])).toStrictEqual([
      ['Red', true],
      ['Blue', false],
    ]);
    expect(st().toast?.message).toBe(
      'Found 3 colors drawn as lines. 1 look like trails and are ticked.',
    );
    // Scanning is one undo step.
    undo();
    expect(proj().autoTrace.chips).toHaveLength(0);
  });

  it('reuses the scan for the same image, and drops a scan that lands on another map', async () => {
    const pending = deferred<ColorScanResult>();
    setup({ scanColors: () => pending.promise });
    const run = scanMapColors();
    await new Promise((r) => setTimeout(r, 0));
    expect(st().job?.kind).toBe('scan');
    // A new map opens while scanning: the old job is cancelled and its result ignored.
    openSession(makeSession(makeProject({ seq: 5 })));
    await run;
    await idle();
    expect(worker.of('cancel')).toHaveLength(1);
    expect(proj().autoTrace.chips).toHaveLength(0);
    expect(st().job).toBeNull();
  });
});

describe('find trails and review', () => {
  const chip = (
    id: string,
    name: string,
    rgb: [number, number, number],
    named = false,
  ): ColorChip => ({
    id,
    rgb,
    name,
    enabled: true,
    share: null,
    named,
  });
  const cand = (
    id: string,
    chipId: string,
    x: number,
    ink: [number, number, number],
    confidence: number | null = null,
  ): AutoTraceCandidate => ({
    id,
    chipId,
    pts: [
      [x, 100],
      [x, 600],
    ],
    lengthPx: 500,
    ink,
    confidence,
  });

  it('nameFor matches the prototype', () => {
    expect(nameFor({ name: 'Red', named: false }, 0, 1)).toBe('Red trail');
    expect(nameFor({ name: 'Red', named: false }, 1, 3)).toBe('Red trail 2');
    expect(nameFor({ name: 'Loop', named: true }, 0, 1)).toBe('Loop');
    expect(nameFor({ name: 'Loop', named: true }, 2, 3)).toBe('Loop (part 3)');
  });

  it('traces the ticked chips, names and colors candidates, and accepts them as one undo step', async () => {
    const project = makeProject({
      seq: 20,
      autoTrace: {
        chips: [
          chip('c1', 'Red', [200, 40, 40]),
          chip('c2', 'Loop', [40, 60, 200], true),
          { ...chip('c3', 'Off', [9, 9, 9]), enabled: false },
        ],
        gapPx: 12,
        minLengthPct: 5,
      },
    });
    let request: AutoTraceRequest | null = null;
    const progress: string[] = [];
    setup(
      {
        autoTrace: async (req, ctl): Promise<readonly AutoTraceCandidate[]> => {
          request = req;
          ctl.onProgress?.({ jobId: ctl.jobId, fraction: 0.5, stage: 'c2: Thinning' });
          progress.push(st().job?.stage ?? '');
          return [
            cand('k1', 'c1', 100, [200, 40, 40]),
            cand('k2', 'c1', 200, [200, 40, 40]),
            cand('k3', 'c2', 300, [40, 60, 200]),
          ];
        },
      },
      project,
    );
    const before = sessionBridge.getSession()!.project;
    await findTrails();
    expect(request).toMatchObject({
      imageId: 'image-1',
      colors: [
        { chipId: 'c1', rgb: [200, 40, 40] },
        { chipId: 'c2', rgb: [40, 60, 200] },
      ],
      tolerance: 60,
      gapPx: 12,
      minLengthPx: 50, // 5% of max(1000, 800)
      mergeAcrossColors: true, // T-210 default
    });
    expect(progress).toStrictEqual(['Finding Loop lines (2 of 2)…']);
    const cands = st().candidates!;
    expect(cands.map((c) => [c.name, c.color, c.on])).toStrictEqual([
      ['Red trail 1', '#c82828', true],
      ['Red trail 2', '#c82828', true],
      ['Loop', '#283cc8', true],
    ]);
    expect(st().tool).toBe('select');
    expect(st().job).toBeNull();

    // Review: click a line on the map to leave it out; tick all puts it back.
    click([200, 350]);
    expect(st().candidates![1]!.on).toBe(false);
    setAllCandidates(true);
    click([200, 350]);
    acceptReviewed();
    expect(st().candidates).toBeNull();
    expect(proj().features.map((f) => f.name)).toStrictEqual(['Red trail 1', 'Loop']);
    expect(st().history.undoLabel).toBe('Add 2 trails');
    undo();
    expect(sessionBridge.getSession()!.project).toStrictEqual(before);
  });

  it('sorts candidates by confidence (nulls last) and pre-unticks those below 0.5 (T-210)', async () => {
    const project = makeProject({
      seq: 20,
      autoTrace: { chips: [chip('c1', 'Red', [200, 40, 40])], gapPx: 12, minLengthPct: 5 },
    });
    setup(
      {
        autoTrace: async (): Promise<readonly AutoTraceCandidate[]> => [
          cand('weak', 'c1', 100, [200, 40, 40], 0.3),
          cand('strong', 'c1', 200, [200, 40, 40], 0.9),
          cand('unscored', 'c1', 300, [200, 40, 40], null),
          cand('medium', 'c1', 400, [200, 40, 40], 0.6),
        ],
      },
      project,
    );
    await findTrails();
    const cands = st().candidates!;
    expect(cands.map((c) => c.id)).toStrictEqual(['strong', 'medium', 'weak', 'unscored']);
    expect(cands.map((c) => c.on)).toStrictEqual([true, true, false, true]);
  });

  it('confidenceBand: bands match the pre-untick threshold; null has no band', () => {
    expect(confidenceBand(0.9)).toBe('High');
    expect(confidenceBand(0.75)).toBe('High');
    expect(confidenceBand(0.74)).toBe('Medium');
    expect(confidenceBand(0.5)).toBe('Medium');
    expect(confidenceBand(0.49)).toBe('Low');
    expect(confidenceBand(0)).toBe('Low');
    expect(confidenceBand(null)).toBeNull();
  });

  it('a merged candidate (T-110 alsoChips) accepts with notes listing the other colors', async () => {
    const project = makeProject({
      seq: 20,
      autoTrace: {
        chips: [chip('c1', 'Red', [200, 40, 40]), chip('c2', 'Loop', [40, 60, 200], true)],
        gapPx: 12,
        minLengthPct: 5,
      },
    });
    setup(
      {
        autoTrace: async (): Promise<readonly AutoTraceCandidate[]> => [
          { ...cand('m1', 'c1', 100, [200, 40, 40], 0.8), alsoChips: ['c2'] },
        ],
      },
      project,
    );
    await findTrails();
    acceptReviewed();
    const f = proj().features[0]!;
    expect(f.notes).toBe('Also follows: Loop.');
  });

  it('Alt-click splits a candidate under review; Ctrl+Z and "Undo split" both restore it (T-213)', async () => {
    const project = makeProject({
      seq: 20,
      autoTrace: { chips: [chip('c1', 'Red', [200, 40, 40])], gapPx: 12, minLengthPct: 5 },
    });
    setup(
      {
        autoTrace: async (): Promise<readonly AutoTraceCandidate[]> => [
          {
            id: 'k1',
            chipId: 'c1',
            pts: [
              [100, 100],
              [100, 400],
              [100, 700],
            ],
            lengthPx: 600,
            ink: [200, 40, 40],
            confidence: 0.8,
          },
        ],
      },
      project,
    );
    await findTrails();
    expect(st().candidates).toHaveLength(1);
    const [sx, sy] = toScr(ed.view, [100, 400]);
    ptr(canvas, 'pointerdown', sx, sy, { altKey: true });
    ptr(canvas, 'pointerup', sx, sy, { altKey: true });
    expect(st().candidates).toHaveLength(2);
    expect(st().reviewUndoStack).toHaveLength(1);
    // Ctrl+Z prefers a pending review split over project undo (T-213); it doesn't touch history.
    expect(st().history.canUndo).toBe(false);
    key('z', { ctrlKey: true });
    expect(st().candidates).toHaveLength(1);
    expect(st().reviewUndoStack).toHaveLength(0);
    expect(st().history.canUndo).toBe(false);
    expect(undoCandidateSplit()).toBe(false);

    // Split again and undo through "Undo split" directly; the outcome is the same either way.
    ptr(canvas, 'pointerdown', sx, sy, { altKey: true });
    ptr(canvas, 'pointerup', sx, sy, { altKey: true });
    expect(st().candidates).toHaveLength(2);
    expect(undoCandidateSplit()).toBe(true);
    expect(st().candidates).toHaveLength(1);
    expect(st().reviewUndoStack).toHaveLength(0);
    expect(undoCandidateSplit()).toBe(false);
  });

  it('the review row\'s "Split" button splits at the midpoint (no click point)', async () => {
    const project = makeProject({
      seq: 20,
      autoTrace: { chips: [chip('c1', 'Red', [200, 40, 40])], gapPx: 12, minLengthPct: 5 },
    });
    setup(
      {
        autoTrace: async (): Promise<readonly AutoTraceCandidate[]> => [
          cand('k1', 'c1', 100, [200, 40, 40], 0.8),
        ],
      },
      project,
    );
    await findTrails();
    const id = st().candidates![0]!.id;
    splitReviewedCandidateAtMidpoint(id);
    expect(st().candidates).toHaveLength(2);
    const [a, b] = st().candidates!;
    expect(a!.pts[a!.pts.length - 1]).toStrictEqual([100, 350]);
    expect(b!.pts[0]).toStrictEqual([100, 350]);
  });

  it('with nothing ticked, scans and uses the likely colors; says so when there are none', async () => {
    setup({
      scanColors: async () => ({ colors: [scanned([10, 10, 10], 'Black', false)] }),
    });
    await findTrails();
    expect(worker.of('autoTrace')).toHaveLength(0);
    expect(st().toast?.message).toBe(
      'Add at least one trail color first: Scan map colors or Pick color from map.',
    );
  });

  it('shows the prototype toast when nothing is found, and Cancel stops a running job', async () => {
    const project = makeProject({
      autoTrace: { chips: [chip('c1', 'Red', [200, 40, 40])], gapPx: 12, minLengthPct: 4 },
    });
    setup({}, project);
    await findTrails();
    expect(st().toast?.message).toMatch(/^No lines found in those colors/);
    expect(st().candidates).toBeNull();

    const slow = deferred<readonly AutoTraceCandidate[]>();
    setWorkerForTests(fakeWorker({ autoTrace: () => slow.promise }).api);
    worker = fakeWorker({ autoTrace: () => slow.promise });
    setWorkerForTests(worker.api);
    // A fresh map so the ImageId comes from this worker.
    openSession({ project, map: makeMap(project) });
    const run = findTrails();
    await new Promise((r) => setTimeout(r, 0));
    expect(st().job?.kind).toBe('auto');
    cancelRunningJob();
    await run;
    expect(worker.of('cancel')).toHaveLength(1);
    expect(st().job).toBeNull();
    expect(st().candidates).toBeNull();
    // Cancelling is not an error.
    expect(st().toast?.message ?? '').not.toMatch(/went wrong/);
  });
});
