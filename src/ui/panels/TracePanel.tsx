/** @jsxRuntime automatic */
// Lane B. Step 3 "Trace" panel (card T-206): color match, auto-trace (chips, scan, pick, gap and
// minimum length, Find trails with progress + Cancel, candidate review) and trace-by-hand
// settings (smart follow, ink). Port of the prototype's #s3 section; every edit is a command.
import { useEffect, useState } from 'react';
import { formatLength } from '../../core/export/format';
import { rgbToHex } from '../../core/trace/color';
import type { ColorChip } from '../../core/types';
import {
  removeChip,
  setAutoTraceSettings,
  setTraceSettings,
  updateChip,
} from '../../state/commands';
import { useApp, useFit } from '../../state/hooks';
import {
  appStore,
  edit,
  sealHistory,
  setCandidateOn,
  setCandidateSplitFocus,
  setMergeAcrossColors,
  undoCandidateSplit,
  type ReviewCandidate,
} from '../../state/store';
import {
  splitReviewedCandidateAtMidpoint,
  splitReviewedCandidateAtVertex,
} from './candidate-split';
import {
  initialCandidateSplitPoint,
  stepCandidateSplitPoint,
} from '../../state/candidate-split-focus';
import { useBatchedCount } from './FeaturesPanel';
import { cachedCandidateLengthM, fillCandidateLengths } from './lengths';
import {
  acceptReviewed,
  cancelRunningJob,
  confidenceBand,
  discardReviewed,
  findTrails,
  pickColor,
  scanMapColors,
  setAllCandidates,
} from './trace-actions';

const project = () => appStore.getState().session?.project ?? null;

/** Apply a slider/field edit now; its coalesced run is sealed when the control is released. */
const sealOnRelease = {
  onPointerUp: sealHistory,
  onKeyUp: sealHistory,
  onBlur: sealHistory,
};

function Range({
  label,
  min,
  max,
  value,
  onValue,
}: {
  label: string;
  min: number;
  max: number;
  value: number;
  onValue: (v: number) => void;
}) {
  return (
    <input
      type="range"
      min={min}
      max={max}
      value={value}
      aria-label={label}
      onChange={(e) => onValue(Number(e.target.value))}
      {...sealOnRelease}
    />
  );
}

function ChipRow({ chip }: { chip: ColorChip }) {
  const share = chip.share
    ? chip.share * 100 < 0.1
      ? '<0.1%'
      : `${(chip.share * 100).toFixed(1)}%`
    : '';
  const change = (fields: Parameters<typeof updateChip>[2], seal: boolean) => {
    const p = project();
    if (!p) return;
    edit(updateChip(p, chip.id, fields));
    if (seal) sealHistory();
  };
  return (
    <li className={chip.enabled ? 'chip' : 'chip off'}>
      <input
        type="checkbox"
        aria-label="Use this color"
        checked={chip.enabled}
        onChange={(e) => change({ enabled: e.target.checked }, true)}
      />
      <span className="sw" style={{ background: rgbToHex(chip.rgb) }} aria-hidden="true" />
      <input
        type="text"
        aria-label="Trail name for this color"
        spellCheck={false}
        value={chip.name}
        onChange={(e) => change({ name: e.target.value, named: true }, false)}
        onBlur={sealHistory}
      />
      <span className="meta">{share}</span>
      <button
        type="button"
        className="x"
        title="Remove color"
        aria-label="Remove color"
        onClick={() => {
          const p = project();
          if (!p) return;
          edit(removeChip(p, chip.id));
          sealHistory();
        }}
      >
        ×
      </button>
    </li>
  );
}

function JobBar() {
  const job = useApp((s) => s.job);
  if (!job) return null;
  return (
    <div className="job" role="status">
      <div className="job-stage">{job.stage}</div>
      <div
        className="job-bar"
        role="progressbar"
        aria-label={job.kind === 'scan' ? 'Scanning colors' : 'Finding trails'}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(job.fraction * 100)}
      >
        <span style={{ width: `${Math.round(job.fraction * 100)}%` }} />
      </div>
      <button type="button" className="btn small" onClick={cancelRunningJob}>
        Cancel
      </button>
    </div>
  );
}

/** "Join colors that continue each other" (T-110/T-210): a UI preference, not persisted. */
function MergeCheckbox() {
  const on = useApp((s) => s.mergeAcrossColors);
  return (
    <label className="toggle">
      <input
        type="checkbox"
        checked={on}
        onChange={(e) => setMergeAcrossColors(e.target.checked)}
      />{' '}
      Join colors that continue each other
    </label>
  );
}

/** Reads the cache only (T-216): `Review`'s effect fills it in time slices. */
function CandidateLength({ c }: { c: ReviewCandidate }) {
  const fit = useFit();
  const units = useApp((s) => s.session?.project.units ?? 'mi');
  if (!fit?.ok) return <span className="flen" />;
  const m = cachedCandidateLengthM(fit, c);
  return <span className="flen">{m === undefined ? '…' : formatLength(m, units)}</span>;
}

/** Swatches for a merged candidate's other chips (T-110 alsoChips), plus its own color. */
function CandidateSwatches({ c }: { c: ReviewCandidate }) {
  const chips = useApp((s) => s.session?.project.autoTrace.chips ?? []);
  const also = (c.alsoChips ?? [])
    .map((id) => chips.find((chip) => chip.id === id))
    .filter((chip): chip is ColorChip => !!chip);
  return (
    <span className="swatches" aria-hidden="true">
      <i className="ln" style={{ background: c.color }} />
      {also.map((chip) => (
        <i key={chip.id} className="ln" style={{ background: rgbToHex(chip.rgb) }} />
      ))}
    </span>
  );
}

/** Confidence indicator (T-109/T-210): inside the row's label, so it's part of the checkbox's accessible name. */
function Confidence({ c }: { c: ReviewCandidate }) {
  const band = confidenceBand(c.confidence);
  if (!band) return null;
  return <span className={`conf conf-${band.toLowerCase()}`}>{band} confidence</span>;
}

function CandidateSplitButton({ c }: { c: ReviewCandidate }) {
  const focus = useApp((s) => s.candidateSplitFocus ?? null);
  const focused = focus?.candidateId === c.id;
  const title = focused
    ? `Split at point ${focus.index + 1} of ${c.pts.length}; use arrow keys, Shift for 10 points`
    : 'Focus to choose a split point with the arrow keys';
  const startFocus = () => {
    const index = initialCandidateSplitPoint(c.pts.length);
    if (index !== null) setCandidateSplitFocus({ candidateId: c.id, index, moved: false });
  };
  return (
    <button
      type="button"
      className="btn tiny"
      title={title}
      aria-keyshortcuts="ArrowLeft ArrowRight ArrowUp ArrowDown Shift+ArrowLeft Shift+ArrowRight Shift+ArrowUp Shift+ArrowDown Enter"
      onFocus={() => {
        if (!focused) startFocus();
      }}
      onBlur={() => {
        if (appStore.getState().candidateSplitFocus?.candidateId === c.id)
          setCandidateSplitFocus(null);
      }}
      onKeyDown={(e) => {
        if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
        e.preventDefault();
        e.stopPropagation();
        const current = appStore.getState().candidateSplitFocus;
        const index =
          current?.candidateId === c.id ? current.index : initialCandidateSplitPoint(c.pts.length);
        if (index === null || index === undefined) return;
        const direction = e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 1;
        const next = stepCandidateSplitPoint(index, c.pts.length, direction, e.shiftKey ? 10 : 1);
        if (next !== null) setCandidateSplitFocus({ candidateId: c.id, index: next, moved: true });
      }}
      onClick={(e) => {
        const current = appStore.getState().candidateSplitFocus;
        if (current?.candidateId === c.id && (current.moved || e.detail === 0)) {
          splitReviewedCandidateAtVertex(c.id, current.index);
        } else {
          splitReviewedCandidateAtMidpoint(c.id);
        }
      }}
    >
      Split
    </button>
  );
}

function Review() {
  const cands = useApp((s) => s.candidates);
  const canUndoSplit = useApp((s) => s.reviewUndoStack.length > 0);
  const reviewEpoch = useApp((s) => s.reviewEpoch);
  const fit = useFit();
  const [, forceRerender] = useState(0);
  useEffect(() => {
    if (!fit?.ok || !cands) return;
    return fillCandidateLengths(fit, cands, () => forceRerender((n) => n + 1));
  }, [fit, cands]);
  // A large find-trails result (T-216) mounts progressively, like FeaturesPanel's list, keyed on
  // reviewEpoch so ticking a checkbox or splitting a row (both replace `cands` but not the epoch)
  // doesn't reset already-mounted rows back down.
  const count = useBatchedCount(reviewEpoch, cands?.length ?? 0);
  if (!cands) return null;
  const on = cands.filter((c) => c.on).length;
  const all = on === cands.length;
  return (
    <div className="cands" role="group" aria-label="Found lines">
      <p>
        <b>
          Found {cands.length} line{cands.length > 1 ? 's' : ''}.
        </b>{' '}
        Highlighted lines will be added. Click a line on the map, or untick it here, to leave it
        out. Alt-click a line (or its Split button) to split it in two.
      </p>
      <ul>
        {cands.slice(0, count).map((c) => (
          <li key={c.id}>
            <label>
              <input
                type="checkbox"
                checked={c.on}
                onChange={(e) => setCandidateOn(c.id, e.target.checked)}
              />
              <CandidateSwatches c={c} />
              <span className="fname">{c.name}</span>
              <CandidateLength c={c} />
              <Confidence c={c} />
            </label>
            <CandidateSplitButton c={c} />
          </li>
        ))}
      </ul>
      <div className="row">
        <button type="button" className="btn small primary" disabled={!on} onClick={acceptReviewed}>
          Add {on} as trail{on === 1 ? '' : 's'}
        </button>
        <button type="button" className="btn small" onClick={discardReviewed}>
          Discard
        </button>
        <button type="button" className="linkish" onClick={() => setAllCandidates(!all)}>
          {all ? 'Untick all' : 'Tick all'}
        </button>
        {canUndoSplit ? (
          <button type="button" className="linkish" onClick={undoCandidateSplit}>
            Undo split
          </button>
        ) : null}
      </div>
    </div>
  );
}

function InkRow() {
  const picked = useApp((s) => s.session?.project.trace.ink ?? null);
  const auto = useApp((s) => s.lastInk);
  const ink = picked ?? auto;
  return (
    <div className="inkrow">
      <span
        className="swatch"
        aria-hidden="true"
        style={ink ? { background: rgbToHex(ink) } : undefined}
      />
      <span>
        {picked
          ? 'Following this color'
          : auto
            ? 'Picked from your first click'
            : 'Color is picked from your first click'}
      </span>
      <button type="button" className="btn small" onClick={() => pickColor('trace')}>
        Pick color
      </button>
    </div>
  );
}

/** Step 3 contents; renders nothing until a map is open. */
export function TracePanel() {
  const open = useApp((s) => s.session !== null);
  const trace = useApp((s) => s.session?.project.trace ?? null);
  const auto = useApp((s) => s.session?.project.autoTrace ?? null);
  const busy = useApp((s) => s.job !== null);
  if (!open || !trace || !auto) return null;
  const setTrace = (patch: Parameters<typeof setTraceSettings>[1]) => {
    const p = project();
    if (p) edit(setTraceSettings(p, patch));
  };
  const setAuto = (patch: Parameters<typeof setAutoTraceSettings>[1]) => {
    const p = project();
    if (p) edit(setAutoTraceSettings(p, patch));
  };
  return (
    <div className="trace-panel">
      <div className="range">
        <span>Color match</span>
        <span className="mini">strict</span>
        <Range
          label="Color match tolerance"
          min={15}
          max={140}
          value={trace.tolerance}
          onValue={(tolerance) => setTrace({ tolerance })}
        />
        <span className="mini">loose</span>
      </div>

      <div className="sub">
        <h3>Find trails automatically</h3>
        <p className="hint">
          Choose the colors this map draws trails in, then let Trailmaker find the lines.
        </p>
        <div className="row">
          <button
            type="button"
            className="btn small"
            disabled={busy}
            onClick={() => void scanMapColors()}
          >
            Scan map colors
          </button>
          <button type="button" className="btn small" onClick={() => pickColor('chip')}>
            Pick color from map
          </button>
        </div>
        {auto.chips.length ? (
          <ul className="chips" aria-label="Trail colors">
            {auto.chips.map((c) => (
              <ChipRow key={c.id} chip={c} />
            ))}
          </ul>
        ) : null}
        <div className="range">
          <span>Bridge gaps</span>
          <Range
            label="Bridge gaps up to"
            min={0}
            max={120}
            value={auto.gapPx}
            onValue={(gapPx) => setAuto({ gapPx })}
          />
          <span className="val">{auto.gapPx ? `${auto.gapPx} px` : 'off'}</span>
        </div>
        <div className="range">
          <span>Skip lines under</span>
          <Range
            label="Skip lines shorter than"
            min={1}
            max={20}
            value={auto.minLengthPct}
            onValue={(minLengthPct) => setAuto({ minLengthPct })}
          />
          <span className="val">{auto.minLengthPct}%</span>
        </div>
        <MergeCheckbox />
        <button
          type="button"
          className="btn primary wide"
          disabled={busy}
          onClick={() => void findTrails()}
        >
          Find trails
        </button>
        <JobBar />
        <Review />
      </div>

      <div className="sub">
        <h3>Trace by hand</h3>
        <p className="hint">Pick Trail, Point or Area in the toolbar over the map.</p>
        <label className="toggle">
          <input
            type="checkbox"
            checked={trace.smartFollow}
            onChange={(e) => {
              setTrace({ smartFollow: e.target.checked });
              sealHistory();
            }}
          />{' '}
          Follow the line&apos;s color while tracing
        </label>
        {trace.smartFollow ? <InkRow /> : null}
      </div>
    </div>
  );
}
