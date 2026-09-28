/** @jsxRuntime automatic */
// Lane B. Feature list, feature editor and draft bar (card T-205): the prototype's renderDraft,
// renderFeatures and renderEditor. Every edit is a command; typing coalesces into one undo step
// and is sealed on blur.
import { memo, useEffect, useRef, useState } from 'react';
import { formatLength, normalizeColor } from '../../core/export/format';
import {
  DEFAULT_COLORS,
  POI_TYPES,
  type Feature,
  type GeoFit,
  type PoiType,
  type Units,
} from '../../core/types';
import { deleteFeature, reverseTrail, updateFeature } from '../../state/commands';
import { useApp, useFit } from '../../state/hooks';
import {
  appStore,
  edit,
  sealHistory,
  selectFeature,
  selectSecondFeature,
  showToast,
} from '../../state/store';
import { cleanupJunctions, cleanupTolerancePx, joinSelected } from '../../state/topology-actions';
import { currentEditor } from '../editor/EditorStage';
import { cancelDraft, continueTrail, draftUndo, finishDraft } from '../editor/tools';
import { toScr } from '../editor/view';
import { cachedFeatureLengthM, fillFeatureLengths } from './lengths';

const project = () => appStore.getState().session?.project ?? null;
const ORDER = { trail: 0, area: 1, poi: 2 } as const;

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
  return (
    <li className={selected ? 'sel' : undefined}>
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
      <div className="row">
        {f.kind === 'trail' ? (
          <>
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
  if (!open) return null;
  return (
    <div className="features-panel">
      <DraftBar />
      <FeatureList />
      <CleanupButton />
      <FeatureEditor />
    </div>
  );
}
