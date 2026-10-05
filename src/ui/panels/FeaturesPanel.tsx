/** @jsxRuntime automatic */
// Lane B. Feature list, feature editor and draft bar (card T-205): the prototype's renderDraft,
// renderFeatures and renderEditor. Every edit is a command; typing coalesces into one undo step
// and is sealed on blur.
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { formatLength, normalizeColor } from '../../core/export/format';
import {
  DEFAULT_COLORS,
  POI_TYPES,
  type Feature,
  type GeoFit,
  type PoiType,
  type Px,
  type Trail,
  type Units,
} from '../../core/types';
import {
  deleteFeature,
  reverseTrail,
  setFeaturePoints,
  simplifyFeatures,
  updateFeature,
} from '../../state/commands';
import { useApp, useFit } from '../../state/hooks';
import {
  appStore,
  edit,
  sealHistory,
  selectFeature,
  selectSecondFeature,
  setJoinArmed,
  setSimplifyPreview,
  setRefinePreview,
  type RefinePreviewEntry,
  showToast,
} from '../../state/store';
import { cleanupJunctions, cleanupTolerancePx, joinSelected } from '../../state/topology-actions';
import {
  findJunctionCoordinates,
  simplifyFeature,
  simplifyFeaturesSteps,
} from '../../core/trace/simplify';
import { currentEditor } from '../editor/EditorStage';
import { runSliced } from '../editor/slice';
import { cancelDraft, continueTrail, draftUndo, finishDraft } from '../editor/tools';
import { toScr } from '../editor/view';
import { cachedFeatureLengthM, fillFeatureLengths } from './lengths';
import { cancelRefinement, startRefineAll, startRefinement } from './refine-actions';

const project = () => appStore.getState().session?.project ?? null;
const ORDER = { trail: 0, area: 1, poi: 2 } as const;
const EMPTY_FEATURES: readonly Feature[] = [];

function DraftBar() {
  const draft = useApp((s) => s.draft);
  if (!draft) return null;
  const noun = draft.kind === 'area' ? 'area' : 'trail';
  const clicks = draft.cps.length;
  return (
    <div className="draftbar" role="group" aria-label="Drawing">
      <div>
        <b>
          {draft.editId ? 'Extending' : 'Tracing'} {draft.name}
        </b>{' '}
        · {clicks} click{clicks === 1 ? '' : 's'}
      </div>
      <div className="row">
        <button type="button" className="btn small primary" onClick={() => void finishDraft()}>
          Finish {noun} (Enter)
        </button>
        <button type="button" className="btn small" onClick={() => void draftUndo()}>
          Undo click
        </button>
        <button type="button" className="btn small" onClick={() => void cancelDraft()}>
          Cancel (Esc)
        </button>
      </div>
    </div>
  );
}

function Glyph({ f }: { f: Feature }) {
  const color = normalizeColor(f.color, DEFAULT_COLORS[f.kind]);
  if (f.kind === 'trail') return <i className="ln" style={{ background: color }} />;
  if (f.kind === 'area')
    return <i className="ar" style={{ borderColor: color, background: `${color}33` }} />;
  return <i className="pt" style={{ background: color }} />;
}

/**
 * Length (trails, areas) in the chosen units when the map is placed; POI type otherwise. `m` is
 * read from the cache by the parent (T-216), not here: a fit change invalidates every length at
 * once, and `FeatureList`'s effect fills the cache in time slices, so a row shows a placeholder
 * until its slice runs rather than computing synchronously in render. Taking the already-looked-
 * up value as a prop (instead of calling `cachedFeatureLengthM` in here) is what lets
 * `FeatureRow`'s memo tell an unrelated row's re-render from this one's -- see its comment.
 */
function Measure({
  f,
  fit,
  m,
  units,
}: {
  f: Feature;
  fit: GeoFit | null;
  m: number | undefined;
  units: Units;
}) {
  if (f.kind === 'poi') return <span className="flen">{f.poiType}</span>;
  if (!fit) return <span className="flen" />;
  return <span className="flen">{m === undefined ? '…' : formatLength(m, units)}</span>;
}

/** Select a feature and scroll it into view when its middle is near or past the canvas edge. */
function selectAndReveal(f: Feature): void {
  selectFeature(f.id);
  const ed = currentEditor();
  if (!ed) return;
  const mid = f.kind === 'poi' ? f.at : f.pts[Math.floor(f.pts.length / 2)]!;
  const [sx, sy] = toScr(ed.view, mid);
  const { width, height } = ed.size;
  if (sx < 40 || sy < 40 || sx > width - 40 || sy > height - 40) ed.centerOn(mid);
}

/**
 * A row click or Shift+Enter/Space on its button arms "Join trails" against a different trail
 * row, same as a shift-click on the canvas (T-209). The key handler prevents native activation
 * so the second selection cannot be lost to a follow-up unmodified click (T-217). Plain rows fall
 * through to selectAndReveal.
 */
function selectOrArmJoin(f: Feature, shiftKey: boolean): void {
  const s = appStore.getState();
  if (shiftKey && f.kind === 'trail' && s.selectedFeatureId && s.selectedFeatureId !== f.id) {
    const primary = s.session?.project.features.find((x) => x.id === s.selectedFeatureId);
    if (primary?.kind === 'trail') {
      selectSecondFeature(f.id);
      return;
    }
  }
  selectAndReveal(f);
}

/**
 * One list row. Memoized on its props (T-211), so an edit re-renders only the row of the feature
 * it replaced, not all of them. `m` (T-216) is the already-looked-up cached length, computed by
 * `FeatureList` per row and passed down instead of read from the cache in here: a length-cache
 * fill completing is otherwise invisible to memo (the cache write isn't a prop), and a naive
 * "bump a tick prop on every row when any fill completes" fix (this component's first version)
 * defeated the whole point of memoizing -- every edit re-rendered every row again. Passing the
 * looked-up value itself means memo only sees a changed prop for the row whose length actually
 * changed.
 */
const FeatureRow = memo(function FeatureRow({
  f,
  selected,
  fit,
  m,
  units,
}: {
  f: Feature;
  selected: boolean;
  fit: GeoFit | null;
  m: number | undefined;
  units: Units;
}) {
  const [contextOpen, setContextOpen] = useState(false);
  return (
    <li
      className={selected ? 'sel' : undefined}
      onContextMenu={(event) => {
        if (f.kind !== 'trail') return;
        event.preventDefault();
        selectFeature(f.id);
        setContextOpen(true);
      }}
    >
      <button
        type="button"
        aria-pressed={selected}
        aria-keyshortcuts="Shift+Enter Shift+Space"
        onKeyDown={(e) => {
          if (e.shiftKey && (e.key === 'Enter' || e.key === ' ')) {
            e.preventDefault();
            selectOrArmJoin(f, true);
          }
        }}
        onClick={(e) => selectOrArmJoin(f, e.shiftKey)}
      >
        <span className="glyph" aria-hidden="true">
          <Glyph f={f} />
        </span>
        <span className="fname">{f.name}</span>
        <Measure f={f} fit={fit} m={m} units={units} />
      </button>
      {contextOpen && f.kind === 'trail' ? (
        <div className="feature-context-menu" role="menu" aria-label={`${f.name} actions`}>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setContextOpen(false);
              void startRefinement([f.id]);
            }}
          >
            Refine to map image
          </button>
        </div>
      ) : null}
    </li>
  );
});

/** Rows mounted with the panel when a map opens with a long feature list (T-211, D-020 item 3). */
export const LIST_FIRST = 50;
/** Rows added per animation frame after that. */
export const LIST_BATCH = 200;

/**
 * How many of `total` rows to render, keyed to reset by `epoch` (T-216): starts at LIST_FIRST
 * rows and adds LIST_BATCH per animation frame, so mounting a large list never blocks the main
 * thread in one piece (each frame renders, styles and lays out one batch; per task, back-to-back
 * batches followed by one frame that lays out all of them at once cost ~105 ms at 2,000 rows).
 * When `total` grows without `epoch` changing (an edit that adds features, not a new map or
 * review), the added rows still ramp in over the following frames rather than mounting at once,
 * since `n` only ever climbs by LIST_BATCH per frame regardless of how far `total` jumped.
 * Exported so TracePanel's candidate-review list (T-216) shares the same mechanism, keyed on
 * `reviewEpoch` instead of the session's map.
 */
export function useBatchedCount(epoch: unknown, total: number): number {
  const [shown, setShown] = useState({ epoch, n: LIST_FIRST });
  const n = shown.epoch === epoch ? shown.n : LIST_FIRST;
  useEffect(() => {
    if (n >= total) return;
    const id = requestAnimationFrame(() => setShown({ epoch, n: n + LIST_BATCH }));
    return () => cancelAnimationFrame(id);
  }, [epoch, n, total]);
  return Math.min(n, total);
}

function FeatureList() {
  const features = useApp((s) => s.session?.project.features ?? null);
  const selected = useApp((s) => s.selectedFeatureId);
  const units = useApp((s) => s.session?.project.units ?? 'mi');
  const result = useFit();
  const fit = result?.ok ? result : null;
  const map = useApp((s) => s.session?.map ?? null);
  const count = useBatchedCount(map, features?.length ?? 0);
  // Triggers only FeatureList's own re-render when a fill completes; NOT passed to FeatureRow
  // (see its comment) -- each row reads its own value straight from the cache below.
  const [, setFillVersion] = useState(0);
  useEffect(() => {
    if (!fit || !features) return;
    const lines = features.filter(
      (f): f is Extract<Feature, { kind: 'trail' | 'area' }> =>
        f.kind === 'trail' || f.kind === 'area',
    );
    return fillFeatureLengths(fit, lines, () => setFillVersion((n) => n + 1));
  }, [fit, features]);
  if (!features) return null;
  if (!features.length) return <p className="empty-note">Nothing traced yet.</p>;
  const sorted = [...features].sort((a, b) => ORDER[a.kind] - ORDER[b.kind]);
  return (
    <ul className="feats" aria-label="Traced features">
      {sorted.slice(0, count).map((f) => (
        <FeatureRow
          key={f.id}
          f={f}
          selected={f.id === selected}
          fit={fit}
          m={fit && f.kind !== 'poi' ? cachedFeatureLengthM(fit, f) : undefined}
          units={units}
        />
      ))}
    </ul>
  );
}

function FeatureEditor() {
  const f = useApp(
    (s) => s.session?.project.features.find((x) => x.id === s.selectedFeatureId) ?? null,
  );
  const secondName = useApp(
    (s) =>
      s.session?.project.features.find((x) => x.id === s.secondSelectedFeatureId)?.name ?? null,
  );
  const joinArmed = useApp((s) => s.joinArmed);
  const refinementBlocked = useApp(
    (s) => s.job !== null || s.refinePreview !== null || s.draft !== null,
  );
  const focus = useApp((s) => s.focusRequest);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (focus?.target === 'feature-name' && f && focus.id === f.id) {
      nameRef.current?.focus();
      nameRef.current?.select();
    }
  }, [focus, f]);

  if (!f) return null;
  const change = (fields: Parameters<typeof updateFeature>[2]) => {
    const p = project();
    if (p) edit(updateFeature(p, f.id, fields));
  };
  return (
    <div className="editor" role="group" aria-label={`Edit ${f.name}`}>
      <div className="two">
        <label className="field">
          Name
          <input
            ref={nameRef}
            value={f.name}
            onChange={(e) => change({ name: e.target.value })}
            onBlur={sealHistory}
          />
        </label>
        <label className="field">
          Color
          <input
            type="color"
            value={normalizeColor(f.color, DEFAULT_COLORS[f.kind]).toLowerCase()}
            onChange={(e) => change({ color: e.target.value })}
            onBlur={sealHistory}
          />
        </label>
      </div>
      {f.kind === 'poi' ? (
        <label className="field">
          Type
          <select
            value={f.poiType}
            onChange={(e) => {
              const poiType = e.target.value as PoiType;
              // Prototype: a default "Point n" name follows the chosen type.
              change(/^Point \d+$/.test(f.name) ? { poiType, name: poiType } : { poiType });
              sealHistory();
            }}
          >
            {POI_TYPES.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
        </label>
      ) : null}
      <label className="field">
        Notes
        <textarea
          placeholder="Difficulty, surface, hours…"
          value={f.notes}
          onChange={(e) => change({ notes: e.target.value })}
          onBlur={sealHistory}
        />
      </label>
      {secondName ? (
        <p className="hint">Shift-selected “{secondName}” to join with this trail.</p>
      ) : null}
      {joinArmed ? (
        <p className="hint touch-join-status">Tap another trail on the map to join it.</p>
      ) : null}
      {f.kind === 'trail' || f.kind === 'area' ? <SimplifyControl f={f} /> : null}
      <div className="row">
        {f.kind === 'trail' ? (
          <>
            <button
              type="button"
              className="btn small"
              disabled={refinementBlocked}
              onClick={() => void startRefinement([f.id])}
            >
              Refine to map image
            </button>
            <button
              type="button"
              className="btn small touch-only"
              aria-pressed={joinArmed}
              onClick={() => setJoinArmed(!joinArmed)}
            >
              Join with…
            </button>
            <button type="button" className="btn small" onClick={() => void continueTrail(f.id)}>
              Continue tracing
            </button>
            <button
              type="button"
              className="btn small"
              onClick={() => {
                const p = project();
                if (!p) return;
                edit(reverseTrail(p, f.id));
                showToast('Direction reversed');
              }}
            >
              Reverse direction
            </button>
            {secondName ? (
              <button
                type="button"
                className="btn small"
                aria-keyshortcuts="J"
                title="Join with the shift-selected trail (J)"
                onClick={joinSelected}
              >
                Join trails
              </button>
            ) : null}
          </>
        ) : null}
        <button
          type="button"
          className="btn small danger"
          onClick={() => {
            const p = project();
            if (p) edit(deleteFeature(p, f.id));
          }}
        >
          Delete
        </button>
      </div>
    </div>
  );
}

function SimplifyControl({ f }: { f: Extract<Feature, { kind: 'trail' | 'area' }> }) {
  const units = useApp((s) => s.session?.project.units ?? 'mi');
  const features = useApp((s) => s.session?.project.features ?? EMPTY_FEATURES);
  const result = useFit();
  const fit = result?.ok ? result : null;
  const junctions = useMemo(() => findJunctionCoordinates(features), [features]);

  const mpp = fit?.metersPerPixel;
  const unitLabel = fit ? (units === 'km' ? 'm' : 'ft') : 'px';

  const { min, max, step, defaultVal, toPx } = useMemo(() => {
    if (fit && mpp) {
      if (units === 'km') {
        const d = Math.max(0.5, Math.round(mpp * 1.5 * 10) / 10);
        return {
          min: 0,
          max: Math.max(20, Math.round(mpp * 30)),
          step: Math.max(0.1, Math.round(mpp * 0.1 * 10) / 10),
          defaultVal: d,
          toPx: (val: number) => val / mpp,
        };
      } else {
        const ftPerPx = mpp / 0.3048;
        const d = Math.max(1, Math.round(ftPerPx * 1.5));
        return {
          min: 0,
          max: Math.max(60, Math.round(ftPerPx * 30)),
          step: Math.max(0.5, Math.round(ftPerPx * 0.2 * 2) / 2),
          defaultVal: d,
          toPx: (val: number) => (val * 0.3048) / mpp,
        };
      }
    }
    return {
      min: 0,
      max: 30,
      step: 0.5,
      defaultVal: 1,
      toPx: (val: number) => val,
    };
  }, [fit, mpp, units]);

  const [tolerance, setTolerance] = useState(defaultVal);
  const [smooth, setSmooth] = useState(false);

  const prevUnitLabelRef = useRef(unitLabel);
  useEffect(() => {
    if (prevUnitLabelRef.current !== unitLabel) {
      prevUnitLabelRef.current = unitLabel;
      setTolerance(defaultVal);
    }
  }, [unitLabel, defaultVal]);

  const tolerancePx = toPx(tolerance);
  const simplified = useMemo(
    () => simplifyFeature(f, tolerancePx, smooth, junctions),
    [f, tolerancePx, smooth, junctions],
  );

  useEffect(() => {
    setSimplifyPreview({ featureId: f.id, pts: simplified.pts });
    return () => {
      setSimplifyPreview(null);
    };
  }, [f.id, simplified.pts]);

  const beforeCount = f.pts.length;
  const afterCount = simplified.pts.length;

  const trails = useMemo(
    () => features.filter((feat): feat is Trail => feat.kind === 'trail'),
    [features],
  );
  const isTrail = f.kind === 'trail';
  const hasMultipleTrails = trails.length > 1;

  const allTrailsBefore = useMemo(() => trails.reduce((sum, t) => sum + t.pts.length, 0), [trails]);
  const allTrailsAfter = useMemo(() => {
    if (!hasMultipleTrails) return afterCount;
    return trails.reduce((sum, t) => {
      const s = t.id === f.id ? simplified : simplifyFeature(t, tolerancePx, smooth, junctions);
      return sum + s.pts.length;
    }, 0);
  }, [hasMultipleTrails, trails, f.id, simplified, tolerancePx, smooth, junctions, afterCount]);

  const [busy, setBusy] = useState(false);

  const applySingle = () => {
    const proj = project();
    if (!proj) return;
    setSimplifyPreview(null);
    edit(
      setFeaturePoints(
        proj,
        f.id,
        simplified.pts,
        smooth ? `Smooth ${f.kind}` : `Simplify ${f.kind}`,
      ),
    );
    sealHistory();
    showToast(`Applied to ${f.name}`);
  };

  const applyAll = async () => {
    const proj = project();
    if (!proj) return;
    setBusy(true);
    setSimplifyPreview(null);
    try {
      const updated = await runSliced(simplifyFeaturesSteps(trails, tolerancePx, smooth));
      edit(simplifyFeatures(proj, updated));
      sealHistory();
      showToast(`Simplified ${updated.length} trails`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="simplify-control" role="group" aria-label="Simplify">
      <div className="simplify-header">
        <b>Simplify</b>
      </div>
      <label className="field">
        <span>
          Tolerance: {tolerance} {unitLabel}
        </span>
        <input
          type="range"
          aria-label="Tolerance"
          min={min}
          max={max}
          step={step}
          value={tolerance}
          onChange={(e) => setTolerance(parseFloat(e.target.value))}
        />
      </label>
      <label className="chk">
        <input
          type="checkbox"
          aria-label="Smooth"
          checked={smooth}
          onChange={(e) => setSmooth(e.target.checked)}
        />
        <span>Smooth</span>
      </label>
      <div className="point-count" aria-live="polite">
        {beforeCount.toLocaleString()} → {afterCount.toLocaleString()} points
      </div>
      <div className="row">
        <button type="button" className="btn small primary" onClick={applySingle} disabled={busy}>
          Apply
        </button>
        {isTrail && hasMultipleTrails && (
          <button
            type="button"
            className="btn small"
            onClick={applyAll}
            disabled={busy}
            title={`Simplify all trails (${allTrailsBefore.toLocaleString()} → ${allTrailsAfter.toLocaleString()} points)`}
          >
            Simplify all trails ({allTrailsBefore.toLocaleString()} →{' '}
            {allTrailsAfter.toLocaleString()} points)
          </button>
        )}
      </div>
    </div>
  );
}

function SimplifyAllPanel({ onClose }: { onClose: () => void }) {
  const units = useApp((s) => s.session?.project.units ?? 'mi');
  const features = useApp((s) => s.session?.project.features ?? EMPTY_FEATURES);
  const result = useFit();
  const fit = result?.ok ? result : null;
  const trails = useMemo(
    () => features.filter((feat): feat is Trail => feat.kind === 'trail'),
    [features],
  );
  const junctions = useMemo(() => findJunctionCoordinates(features), [features]);

  const mpp = fit?.metersPerPixel;
  const unitLabel = fit ? (units === 'km' ? 'm' : 'ft') : 'px';

  const { min, max, step, defaultVal, toPx } = useMemo(() => {
    if (fit && mpp) {
      if (units === 'km') {
        const d = Math.max(0.5, Math.round(mpp * 1.5 * 10) / 10);
        return {
          min: 0,
          max: Math.max(20, Math.round(mpp * 30)),
          step: Math.max(0.1, Math.round(mpp * 0.1 * 10) / 10),
          defaultVal: d,
          toPx: (val: number) => val / mpp,
        };
      } else {
        const ftPerPx = mpp / 0.3048;
        const d = Math.max(1, Math.round(ftPerPx * 1.5));
        return {
          min: 0,
          max: Math.max(60, Math.round(ftPerPx * 30)),
          step: Math.max(0.5, Math.round(ftPerPx * 0.2 * 2) / 2),
          defaultVal: d,
          toPx: (val: number) => (val * 0.3048) / mpp,
        };
      }
    }
    return {
      min: 0,
      max: 30,
      step: 0.5,
      defaultVal: 1,
      toPx: (val: number) => val,
    };
  }, [fit, mpp, units]);

  const [tolerance, setTolerance] = useState(defaultVal);
  const [smooth, setSmooth] = useState(false);
  const [busy, setBusy] = useState(false);

  const tolerancePx = toPx(tolerance);
  const totalBefore = useMemo(() => trails.reduce((sum, t) => sum + t.pts.length, 0), [trails]);
  const totalAfter = useMemo(
    () =>
      trails.reduce(
        (sum, t) => sum + simplifyFeature(t, tolerancePx, smooth, junctions).pts.length,
        0,
      ),
    [trails, tolerancePx, smooth, junctions],
  );

  const applyAll = async () => {
    const proj = project();
    if (!proj) return;
    setBusy(true);
    try {
      const updated = await runSliced(simplifyFeaturesSteps(trails, tolerancePx, smooth));
      edit(simplifyFeatures(proj, updated));
      sealHistory();
      showToast(`Simplified ${updated.length} trails`);
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="simplify-all-panel" role="group" aria-label="Simplify all trails">
      <div className="simplify-header">
        <b>Simplify all trails</b>
      </div>
      <label className="field">
        <span>
          Tolerance: {tolerance} {unitLabel}
        </span>
        <input
          type="range"
          aria-label="Tolerance"
          min={min}
          max={max}
          step={step}
          value={tolerance}
          onChange={(e) => setTolerance(parseFloat(e.target.value))}
        />
      </label>
      <label className="chk">
        <input
          type="checkbox"
          aria-label="Smooth"
          checked={smooth}
          onChange={(e) => setSmooth(e.target.checked)}
        />
        <span>Smooth</span>
      </label>
      <div className="point-count" aria-live="polite">
        {totalBefore.toLocaleString()} → {totalAfter.toLocaleString()} points
      </div>
      <div className="row">
        <button type="button" className="btn small primary" onClick={applyAll} disabled={busy}>
          Apply to all trails
        </button>
        <button type="button" className="btn small" onClick={onClose} disabled={busy}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/** "Clean up junctions" (T-209): snap nearby trail ends at the current zoom's tolerance. */
function CleanupButton() {
  const trailCount = useApp(
    (s) => s.session?.project.features.filter((f) => f.kind === 'trail').length ?? 0,
  );
  if (trailCount < 2) return null;
  return (
    <button
      type="button"
      className="btn small"
      onClick={() => cleanupJunctions(cleanupTolerancePx(currentEditor()?.view.s ?? 1))}
    >
      Clean up junctions
    </button>
  );
}

/** Step 3's traced-feature section: draft bar, list and editor. */
export function FeaturesPanel() {
  const open = useApp((s) => s.session !== null);
  const refinementBlocked = useApp(
    (s) => s.job !== null || s.refinePreview !== null || s.draft !== null,
  );
  const trailCount = useApp(
    (s) => s.session?.project.features.filter((f) => f.kind === 'trail').length ?? 0,
  );
  const [simplifyAllOpen, setSimplifyAllOpen] = useState(false);

  if (!open) return null;
  return (
    <div className="features-panel">
      <DraftBar />
      <FeatureList />
      <div className="panel-actions row">
        <CleanupButton />
        {trailCount > 0 && (
          <button
            type="button"
            className="btn small"
            disabled={refinementBlocked}
            onClick={() => void startRefineAll()}
          >
            Refine all trails
          </button>
        )}
        {trailCount > 0 && (
          <button
            type="button"
            className="btn small"
            aria-expanded={simplifyAllOpen}
            onClick={() => setSimplifyAllOpen(!simplifyAllOpen)}
          >
            Simplify all trails
          </button>
        )}
      </div>
      {simplifyAllOpen && <SimplifyAllPanel onClose={() => setSimplifyAllOpen(false)} />}
      <RefineReview />
      <FeatureEditor />
    </div>
  );
}

function pointsFromParts(parts: RefinePreviewEntry['parts']): Px[] {
  const pts: Px[] = [];
  for (const part of parts) {
    const section = part.useRefined ? part.refinedPts : part.originalPts;
    if (!section.length) continue;
    if (!pts.length) pts.push(...section);
    else {
      const startsAtLast = pts.at(-1)![0] === section[0]![0] && pts.at(-1)![1] === section[0]![1];
      pts.push(...(startsAtLast ? section.slice(1) : section));
    }
  }
  return pts;
}

function RefineReview() {
  const preview = useApp((s) => s.refinePreview);
  const job = useApp((s) => (s.job?.kind === 'refine' ? s.job : null));
  const editorBackdrop = useApp((s) => s.editorBackdrop ?? 'map');
  if (job) {
    return (
      <div className="refine-job" role="status" aria-label="Refining trails">
        <span>{job.stage}</span>
        <progress max={1} value={job.fraction} />
        <button type="button" className="btn small" onClick={cancelRefinement}>
          Cancel refinement
        </button>
      </div>
    );
  }
  if (!preview) return null;
  const acceptAll = () => {
    const current = appStore.getState().refinePreview;
    if (!current) return;
    setRefinePreview({
      ...current,
      entries: current.entries.map((entry) => ({
        ...entry,
        parts: entry.parts.map((part) => ({ ...part, useRefined: part.confidence >= 0.6 })),
      })),
    });
  };
  const togglePart = (entryIndex: number, partIndex: number, useRefined: boolean) => {
    const current = appStore.getState().refinePreview;
    if (!current) return;
    setRefinePreview({
      ...current,
      entries: current.entries.map((entry, i) =>
        i !== entryIndex
          ? entry
          : {
              ...entry,
              parts: entry.parts.map((part, j) =>
                j === partIndex ? { ...part, useRefined } : part,
              ),
            },
      ),
    });
  };
  const apply = () => {
    const project = appStore.getState().session?.project;
    if (!project) return;
    const updated = preview.entries.flatMap((entry) => {
      const current = project.features.find((feature) => feature.id === entry.featureId);
      if (!current || current.kind !== 'trail') return [];
      const sameSource =
        current.pts.length === entry.originalPts.length &&
        current.pts.every(
          (point, i) =>
            point[0] === entry.originalPts[i]![0] && point[1] === entry.originalPts[i]![1],
        );
      if (!sameSource) return [];
      const pts = pointsFromParts(entry.parts);
      if (pts.length < 2) return [];
      return [{ ...current, pts }];
    });
    if (updated.length !== preview.entries.length) {
      setRefinePreview(null);
      showToast('The trail changed during refinement. Please refine it again.');
      return;
    }
    if (!updated.length) {
      setRefinePreview(null);
      return;
    }
    const changed = updated.filter((trail) => {
      const before = preview.entries.find((entry) => entry.featureId === trail.id)!.originalPts;
      return (
        trail.pts.length !== before.length ||
        trail.pts.some((point, i) => point[0] !== before[i]?.[0] || point[1] !== before[i]?.[1])
      );
    });
    setRefinePreview(null);
    if (!changed.length) return;
    if (preview.batch) edit(simplifyFeatures(project, changed, 'Refine all trails'));
    else
      edit(setFeaturePoints(project, changed[0]!.id, changed[0]!.pts, 'Refine trail to map image'));
  };
  return (
    <section className="refine-review" aria-label="Refinement preview">
      <h3>Refinement preview</h3>
      {editorBackdrop === 'esri' ? (
        <p className="hint" role="note">
          Refining against the map image, not Esri.
        </p>
      ) : null}
      {preview.entries.map((entry, entryIndex) => (
        <fieldset key={entry.featureId}>
          <legend>{entry.name}</legend>
          {entry.parts.map((part, partIndex) => (
            <label key={partIndex} className="field refine-section-toggle">
              <input
                type="checkbox"
                checked={part.useRefined}
                disabled={part.confidence < 0.6}
                onChange={(event) => togglePart(entryIndex, partIndex, event.target.checked)}
              />
              Use image path for section {partIndex + 1} ({Math.round(part.confidence * 100)}%
              confidence)
            </label>
          ))}
        </fieldset>
      ))}
      <div className="row">
        <button type="button" className="btn small" onClick={acceptAll}>
          Accept all supported sections
        </button>
        <button type="button" className="btn small primary" onClick={apply}>
          Apply refinement
        </button>
        <button type="button" className="btn small" onClick={() => setRefinePreview(null)}>
          Reject
        </button>
      </div>
    </section>
  );
}
