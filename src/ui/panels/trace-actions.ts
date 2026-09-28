// Lane B. Auto-trace actions behind the step-3 panel (card T-206): the prototype's scan,
// runAuto, nameFor, acceptCands and the pick-color buttons, running on the worker. No React.
import { featureColorForInk } from '../../core/trace/color';
import {
  DEFAULT_COLORS,
  type AutoTraceCandidate,
  type ColorChip,
  type ColorScanResult,
  type ImageId,
  type JobProgress,
} from '../../core/types';
import type { LoadedMap } from '../contract';
import { acceptCandidates, addChips } from '../../state/commands';
import {
  appStore,
  edit,
  sealHistory,
  selectFeature,
  setCandidates,
  showToast,
  type JobStatus,
  type ReviewCandidate,
} from '../../state/store';
import {
  call,
  cancelJob,
  imageFor,
  isCancelled,
  isReported,
  jobDone,
  startJob,
  stillOn,
  track,
} from '../../state/worker-link';
import { chooseTool, finishDraft } from '../editor/tools';

const state = () => appStore.getState();
const project = () => state().session?.project ?? null;

/** Candidate trail name (prototype nameFor): "Red trail 2", or "Loop (part 2)" for named chips. */
export function nameFor(chip: Pick<ColorChip, 'name' | 'named'>, k: number, n: number): string {
  const base = chip.named ? chip.name : `${chip.name} trail`;
  if (n === 1) return base;
  return chip.named ? `${base} (part ${k + 1})` : `${base} ${k + 1}`;
}

/** Confidence band shown next to a candidate (T-210); 0.5 matches T-109's calibrated threshold. */
export type ConfidenceBand = 'High' | 'Medium' | 'Low';

/** Null (score unavailable) has no band: it sorts last but is never pre-unticked as weak. */
export function confidenceBand(confidence: number | null): ConfidenceBand | null {
  if (confidence === null) return null;
  if (confidence >= 0.75) return 'High';
  if (confidence >= 0.5) return 'Medium';
  return 'Low';
}

/** Store progress at most every PROGRESS_MS so a chatty worker can't flood React. */
const PROGRESS_MS = 100;

function progressReporter(
  jobId: string,
  kind: JobStatus['kind'],
  label: (p: JobProgress) => string,
): (p: JobProgress) => void {
  let last = 0;
  return (p) => {
    const now = performance.now();
    if (now - last < PROGRESS_MS && p.fraction < 1) return;
    last = now;
    if (state().job?.jobId === jobId) {
      appStore.setState({ job: { kind, jobId, fraction: p.fraction, stage: label(p) } });
    }
  };
}

function failed(err: unknown, what: string): void {
  if (isCancelled(err) || isReported(err)) return;
  showToast(`${what}: ${err instanceof Error ? err.message : String(err)}`);
}

// One scan per worker image (prototype `scanned` cache).
const scans = new Map<ImageId, Promise<ColorScanResult>>();

/** Run (or reuse) the color scan for the current map, as a cancellable inline job. */
async function scanFor(map: LoadedMap): Promise<ColorScanResult | null> {
  const id = await imageFor(map);
  const cached = scans.get(id);
  if (cached) return cached;
  const jobId = startJob(map);
  appStore.setState({ job: { kind: 'scan', jobId, fraction: 0, stage: 'Scanning colors…' } });
  const scan = call((api) =>
    api.scanColors(id, {
      jobId,
      onProgress: progressReporter(jobId, 'scan', () => 'Scanning colors…'),
    }),
  );
  scans.set(id, scan);
  try {
    return await scan;
  } catch (err) {
    scans.delete(id);
    throw err;
  } finally {
    jobDone(jobId);
    if (state().job?.jobId === jobId) appStore.setState({ job: null });
  }
}

/** Add scanned colors as chips (merging within RGB 40), ticking the likely ones. */
function addScanned(colors: ColorScanResult['colors'], onlyLikely: boolean): void {
  const p = project();
  if (!p) return;
  const picked = onlyLikely ? colors.filter((c) => c.likely) : colors;
  const { command } = addChips(
    p,
    picked.map((c) => ({
      rgb: c.rgb,
      name: c.name,
      enabled: onlyLikely || c.likely,
      share: c.share,
      named: false,
    })),
  );
  if (command) edit(command);
  sealHistory();
}

/** "Scan map colors" (prototype #scanBtn). */
export function scanMapColors(): Promise<void> {
  return track(scanMapColorsNow());
}

async function scanMapColorsNow(): Promise<void> {
  const map = state().session?.map;
  if (!map || state().job) return;
  try {
    const res = await scanFor(map);
    if (!res || !stillOn(map)) return;
    if (!res.colors.length) {
      showToast('No line-like colors stood out. Use Pick color from map instead.');
      return;
    }
    addScanned(res.colors, false);
    const on = project()?.autoTrace.chips.filter((c) => c.enabled).length ?? 0;
    showToast(
      `Found ${res.colors.length} colors drawn as lines. ${on ? `${on} look like trails and are ticked.` : 'Tick the ones used for trails.'}`,
      5000,
    );
  } catch (err) {
    failed(err, 'Scanning colors didn’t work');
  }
}

/** "Find trails" (prototype runAuto). */
export function findTrails(): Promise<void> {
  return track(findTrailsNow());
}

async function findTrailsNow(): Promise<void> {
  const map = state().session?.map;
  if (!map || state().job) return;
  if (state().draft) await finishDraft();
  try {
    let chips = project()?.autoTrace.chips.filter((c) => c.enabled) ?? [];
    if (!chips.length) {
      // Prototype: with nothing ticked, use the scan's likely trail colors.
      const res = await scanFor(map);
      if (!res || !stillOn(map)) return;
      if (!res.colors.some((c) => c.likely)) {
        showToast(
          'Add at least one trail color first: Scan map colors or Pick color from map.',
          5000,
        );
        return;
      }
      addScanned(res.colors, true);
      chips = project()?.autoTrace.chips.filter((c) => c.enabled) ?? [];
    }
    const p = project();
    if (!p) return;
    const id = await imageFor(map);
    const { width, height } = p.image;
    const jobId = startJob(map);
    const names = new Map(chips.map((c, i) => [c.id, { name: c.name, i }] as const));
    const label = (prog: JobProgress) => {
      const [chipId] = prog.stage.split(': ');
      const chip = chipId ? names.get(chipId) : undefined;
      return chip
        ? `Finding ${chip.name} lines (${chip.i + 1} of ${chips.length})…`
        : 'Finding trails…';
    };
    appStore.setState({ job: { kind: 'auto', jobId, fraction: 0, stage: 'Finding trails…' } });
    let found: readonly AutoTraceCandidate[];
    try {
      found = await call((api) =>
        api.autoTrace(
          {
            imageId: id,
            colors: chips.map((c) => ({ chipId: c.id, rgb: c.rgb })),
            tolerance: p.trace.tolerance,
            gapPx: p.autoTrace.gapPx,
            minLengthPx: (p.autoTrace.minLengthPct / 100) * Math.max(width, height),
            mergeAcrossColors: state().mergeAcrossColors,
          },
          { jobId, onProgress: progressReporter(jobId, 'auto', label) },
        ),
      );
    } finally {
      jobDone(jobId);
      if (state().job?.jobId === jobId) appStore.setState({ job: null });
    }
    if (!stillOn(map)) return;
    if (!found.length) {
      setCandidates(null);
      showToast(
        'No lines found in those colors. Try a looser color match, a larger gap bridge, or a shorter minimum length.',
        6000,
      );
      return;
    }
    const byChip = new Map<string, AutoTraceCandidate[]>();
    for (const c of found) byChip.set(c.chipId, [...(byChip.get(c.chipId) ?? []), c]);
    const chipById = new Map(chips.map((c) => [c.id, c]));
    const named: ReviewCandidate[] = found.map((c) => {
      // Naming groups candidates by their own (possibly merged) chipId, so "part n" numbering
      // is unaffected by the confidence sort below.
      const group = byChip.get(c.chipId)!;
      const chip = chipById.get(c.chipId);
      return {
        ...c,
        // T-109: candidates below 0.5 start unticked; an unscored (null) candidate is unaffected.
        on: c.confidence === null || c.confidence >= 0.5,
        name: chip ? nameFor(chip, group.indexOf(c), group.length) : 'Trail',
        color: featureColorForInk(c.ink, DEFAULT_COLORS.trail),
      };
    });
    // Sorted by confidence, highest first; unscored (null) candidates sort last (Array.sort is
    // stable, so equal-confidence and all-null candidates keep their found order).
    const review = [...named].sort((a, b) => (b.confidence ?? -1) - (a.confidence ?? -1));
    setCandidates(review);
    selectFeature(null);
    chooseTool('select');
    showToast(
      `Found ${review.length} line${review.length > 1 ? 's' : ''}. Click any on the map to leave it out.`,
    );
  } catch (err) {
    failed(err, 'Something went wrong while finding lines');
  }
}

/** Cancel the running scan / Find trails job. */
export function cancelRunningJob(): void {
  const job = state().job;
  if (job) void cancelJob(job.jobId);
}

/** Other colors a merged candidate (T-110 alsoChips) absorbed, for the accepted trail's notes. */
function mergedNotes(c: ReviewCandidate, chips: readonly ColorChip[]): string {
  if (!c.alsoChips?.length) return '';
  const names = c.alsoChips
    .map((id) => chips.find((chip) => chip.id === id)?.name)
    .filter((n): n is string => !!n);
  return names.length ? `Also follows: ${names.join(', ')}.` : '';
}

/** "Add N as trails" (prototype acceptCands): one undo step. */
export function acceptReviewed(): void {
  const cands = state().candidates;
  const p = project();
  if (!cands || !p) return;
  const take = cands.filter((c) => c.on);
  if (!take.length) return;
  const { command } = acceptCandidates(
    p,
    take.map((c) => ({
      name: c.name,
      color: c.color,
      pts: c.pts,
      ink: c.ink,
      notes: mergedNotes(c, p.autoTrace.chips),
    })),
  );
  edit(command);
  setCandidates(null);
  selectFeature(null);
  showToast(
    `Added ${take.length} trail${take.length > 1 ? 's' : ''}. Click one to rename it, recolor it, or keep tracing from its end.`,
    5000,
  );
}

/** "Discard" the candidates under review. */
export function discardReviewed(): void {
  setCandidates(null);
}

/** Tick or untick every candidate. Ticking doesn't touch the split undo stack. */
export function setAllCandidates(on: boolean): void {
  const cands = state().candidates;
  if (cands) appStore.setState({ candidates: cands.map((c) => (c.on === on ? c : { ...c, on })) });
}

/** "Pick color from map" (a new chip) or the smart-follow "Pick color". */
export function pickColor(forWhat: 'trace' | 'chip'): void {
  if (!state().session) return;
  appStore.setState({ inkFor: forWhat });
  chooseTool('ink');
  if (forWhat === 'chip') showToast('Click right on a trail line');
}

/** Tests: forget cached scans. */
export function clearScanCacheForTests(): void {
  scans.clear();
}
