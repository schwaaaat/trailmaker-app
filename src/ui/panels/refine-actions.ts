// Lane B. Worker-backed refinement actions and their transient, rejectable review state.
import type { FeatureId, Px, RefineResult, Trail } from '../../core/types';
import { findJunctionCoordinates } from '../../core/trace/simplify';
import { appStore, selectFit, setRefinePreview, showToast } from '../../state/store';
import type { RefinePreviewEntry, RefinePreviewPart } from '../../state/store';
import {
  call,
  cancelJob,
  imageFor,
  isCancelled,
  jobDone,
  startJob,
  stillOn,
  track,
} from '../../state/worker-link';

let activeJob: ReturnType<typeof startJob> | null = null;

export function cancelRefinement(): void {
  if (activeJob) void cancelJob(activeJob);
}

function cumulative(pts: readonly Px[]): number[] {
  const values = [0];
  for (let i = 1; i < pts.length; i++) {
    values.push(
      values[i - 1]! + Math.hypot(pts[i]![0] - pts[i - 1]![0], pts[i]![1] - pts[i - 1]![1]),
    );
  }
  return values;
}

function firstAtOrAfter(lengths: readonly number[], target: number): number {
  let low = 0;
  let high = lengths.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (lengths[middle]! < target) low = middle + 1;
    else high = middle;
  }
  return low;
}

function projectionDistance(
  pts: readonly Px[],
  lengths: readonly number[],
  target: Px,
  minimum: number,
  maximum: number,
): number {
  let bestDistance = minimum;
  let bestError = Infinity;
  for (
    let i = Math.max(1, firstAtOrAfter(lengths, minimum));
    i < pts.length && lengths[i - 1]! <= maximum;
    i++
  ) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    const length = lengths[i]! - lengths[i - 1]!;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const tMin = length > 0 ? Math.max(0, (minimum - lengths[i - 1]!) / length) : 0;
    const tMax = length > 0 ? Math.min(1, (maximum - lengths[i - 1]!) / length) : 1;
    const t = Math.max(
      tMin,
      Math.min(
        tMax,
        ((target[0] - a[0]) * dx + (target[1] - a[1]) * dy) / (dx * dx + dy * dy || 1),
      ),
    );
    const error = Math.hypot(target[0] - a[0] - t * dx, target[1] - a[1] - t * dy);
    if (error < bestError) {
      bestError = error;
      bestDistance = lengths[i - 1]! + t * length;
    }
  }
  return bestDistance;
}

function pointAt(pts: readonly Px[], lengths: readonly number[], distance: number): Px {
  const i = Math.max(1, Math.min(pts.length - 1, firstAtOrAfter(lengths, distance)));
  const length = lengths[i]! - lengths[i - 1]!;
  const t = length ? Math.max(0, Math.min(1, (distance - lengths[i - 1]!) / length)) : 0;
  return [
    pts[i - 1]![0] + (pts[i]![0] - pts[i - 1]![0]) * t,
    pts[i - 1]![1] + (pts[i]![1] - pts[i - 1]![1]) * t,
  ];
}

function sliceOriginal(
  pts: readonly Px[],
  lengths: readonly number[],
  from: number,
  to: number,
): Px[] {
  const result = [pointAt(pts, lengths, from)];
  for (
    let i = Math.max(1, firstAtOrAfter(lengths, from + 0.001));
    i < pts.length - 1 && lengths[i]! < to;
    i++
  )
    result.push(pts[i]!);
  const end = pointAt(pts, lengths, to);
  if (Math.hypot(result.at(-1)![0] - end[0], result.at(-1)![1] - end[1]) > 0.001) result.push(end);
  return result;
}

function makePreview(trail: Trail, result: RefineResult): RefinePreviewEntry {
  const lengths = cumulative(trail.pts);
  const total = lengths.at(-1)!;
  let fromDistance = 0;
  const parts: RefinePreviewPart[] = result.segments.map((segment, index) => {
    const refinedPts = result.pts.slice(segment.from, segment.to + 1);
    const toDistance =
      index === result.segments.length - 1
        ? total
        : projectionDistance(
            trail.pts,
            lengths,
            result.pts[segment.to]!,
            fromDistance,
            Math.min(total, fromDistance + 120),
          );
    const part: RefinePreviewPart = {
      confidence: segment.confidence,
      originalPts: sliceOriginal(
        trail.pts,
        lengths,
        fromDistance,
        Math.max(fromDistance, toDistance),
      ),
      refinedPts,
      useRefined: segment.refined,
    };
    fromDistance = Math.max(fromDistance, toDistance);
    return part;
  });
  return { featureId: trail.id, name: trail.name, originalPts: trail.pts, parts };
}

function progressReporter(jobId: string, index: number, count: number) {
  let last = 0;
  return (progress: { readonly fraction: number; readonly stage: string }) => {
    const now = performance.now();
    if (now - last < 100 && progress.fraction < 1) return;
    last = now;
    if (appStore.getState().job?.jobId === jobId) {
      appStore.setState({
        job: {
          kind: 'refine',
          jobId,
          fraction: (index + progress.fraction) / count,
          stage: count > 1 ? `Refining trail ${index + 1} of ${count}…` : progress.stage,
        },
      });
    }
  };
}

export function startRefinement(featureIds?: readonly FeatureId[], batch = false): Promise<void> {
  return track(runRefinement(featureIds, batch));
}

async function runRefinement(featureIds?: readonly FeatureId[], batch = false): Promise<void> {
  const state = appStore.getState();
  const session = state.session;
  if (!session || state.job || state.draft || state.refinePreview) return;
  const project = session.project;
  const selected = featureIds ?? (state.selectedFeatureId ? [state.selectedFeatureId] : []);
  const trails = project.features.filter(
    (feature): feature is Trail => feature.kind === 'trail' && selected.includes(feature.id),
  );
  if (!trails.length) return;
  setRefinePreview(null);
  let imageId = state.imageId;
  if (!imageId) {
    try {
      imageId = await imageFor(session.map);
    } catch (error) {
      if (!isCancelled(error))
        showToast(error instanceof Error ? error.message : 'Could not load map pixels');
      return;
    }
  }
  if (!stillOn(session.map) || appStore.getState().session?.project !== project) return;
  const fit = selectFit(appStore.getState());
  const mpp = fit?.ok ? fit.metersPerPixel : null;
  const corridorPx = mpp ? Math.max(6, Math.min(40, 4 / mpp)) : 12;
  const junctions = findJunctionCoordinates(project.features);
  const entries: RefinePreviewEntry[] = [];
  try {
    for (let index = 0; index < trails.length; index++) {
      const trail = trails[index]!;
      const jobId = startJob(session.map);
      activeJob = jobId;
      appStore.setState({
        job: { kind: 'refine', jobId, fraction: index / trails.length, stage: 'Refining trail…' },
      });
      try {
        const result = await call((api) =>
          api.refineTrail(
            {
              imageId,
              pts: trail.pts,
              corridorPx,
              ink: trail.ink,
              tolerance: project.trace.tolerance,
              pinned: trail.pts.flatMap((point, pointIndex) =>
                junctions.has(`${point[0]},${point[1]}`) ? [pointIndex] : [],
              ),
            },
            { jobId, onProgress: progressReporter(jobId, index, trails.length) },
          ),
        );
        if (!stillOn(session.map) || appStore.getState().session?.project !== project) {
          if (appStore.getState().job?.jobId === jobId) appStore.setState({ job: null });
          return;
        }
        entries.push(makePreview(trail, result));
      } finally {
        jobDone(jobId);
        const currentJob = appStore.getState().job;
        if (currentJob?.jobId === jobId) {
          if (index === trails.length - 1) appStore.setState({ job: null });
          else {
            appStore.setState({
              job: {
                ...currentJob,
                fraction: (index + 1) / trails.length,
                stage: `Refining trail ${index + 1} of ${trails.length}…`,
              },
            });
          }
        }
        activeJob = null;
      }
    }
    setRefinePreview({ entries, batch });
  } catch (error) {
    if (appStore.getState().job?.kind === 'refine') appStore.setState({ job: null });
    if (!isCancelled(error))
      showToast(error instanceof Error ? error.message : 'Could not refine trail');
  }
}

export async function startRefineAll(): Promise<void> {
  const ids = appStore
    .getState()
    .session?.project.features.filter((feature) => feature.kind === 'trail')
    .map((trail) => trail.id);
  if (ids?.length) await startRefinement(ids, true);
}
