/** @jsxRuntime automatic */
// Lane B. Step 2 "Pin to real world" (card T-205): the prototype's renderAnchors, selectAnchor
// and renderFit, with the fit method select. Every edit is a command.
import { useEffect, useRef, useState } from 'react';
import { formatLatLon, parseLatLon } from '../../core/geo/parse';
import type { Anchor, FitMethod } from '../../core/types';
import { removeAnchor, setAnchorCoords, setFitMethod } from '../../state/commands';
import { useApp, useFit } from '../../state/hooks';
import { appStore, edit, selectAnchor, showToast } from '../../state/store';
import { anchorOutlier } from '../../state/outliers';
import { chooseTool } from '../editor/tools';
import { fitMessage, fmtRes } from './fit-message';

const project = () => appStore.getState().session?.project ?? null;

/** Prototype toast for coordinates that don't parse. */
export const BAD_COORDS_MESSAGE = 'Couldn’t read those coordinates. Try “26.3683, -80.1289”.';

const shown = (a: Anchor) => (a.ll ? formatLatLon(a.ll) : '');

function AnchorRow({ anchor, n }: { anchor: Anchor; n: number }) {
  const fit = useFit();
  const selected = useApp((s) => s.selectedAnchorId === anchor.id);
  const focus = useApp((s) => s.focusRequest);
  const [text, setText] = useState(shown(anchor));
  const [bad, setBad] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  // The last text rejected, so Enter followed by blur doesn't toast twice.
  const rejected = useRef<string | null>(null);

  // Keep the field in step with undo/redo and drags of the pin.
  useEffect(() => {
    setText(shown(anchor));
    setBad(false);
  }, [anchor]);

  useEffect(() => {
    if (focus?.target === 'anchor' && focus.id === anchor.id) {
      input.current?.scrollIntoView?.({ block: 'nearest' });
      input.current?.focus();
    }
  }, [focus, anchor.id]);

  const apply = (raw: string) => {
    const v = raw.trim();
    if (v === shown(anchor) || v === rejected.current) return;
    const p = project();
    if (!p) return;
    if (!v) {
      edit(setAnchorCoords(p, anchor.id, null));
      return;
    }
    const ll = parseLatLon(v);
    if (!ll) {
      rejected.current = v;
      setBad(true);
      showToast(BAD_COORDS_MESSAGE);
      return;
    }
    edit(setAnchorCoords(p, anchor.id, ll));
  };

  // Leave-one-out when available (T-208); otherwise the plain residual of a checked fit.
  const loo = fit?.ok ? fit.looResiduals?.[anchor.id] : undefined;
  const plain = fit?.ok && fit.checked ? fit.residuals[anchor.id] : undefined;
  const residual = loo ?? plain;
  const odd = fit?.ok ? anchorOutlier(fit, anchor.id) : false;
  return (
    <li className={`anc${anchor.ll ? '' : ' empty'}${selected ? ' sel' : ''}`}>
      <span className="pin" aria-hidden="true">
        <b>{n}</b>
      </span>
      <input
        ref={input}
        aria-label={`Coordinates for anchor ${n}`}
        aria-invalid={bad || undefined}
        className={bad ? 'bad' : undefined}
        placeholder="Paste lat, long"
        spellCheck={false}
        autoComplete="off"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setBad(false);
          rejected.current = null;
        }}
        onPaste={(e) => {
          // Apply what the field will contain once the paste lands.
          const el = e.currentTarget;
          setTimeout(() => apply(el.value), 0);
        }}
        onBlur={(e) => apply(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            apply(e.currentTarget.value);
          }
        }}
        onFocus={() => {
          if (!selected) selectAnchor(anchor.id);
        }}
      />
      <span
        className={odd ? 'res hi' : 'res'}
        title={
          loo !== undefined
            ? 'How far this anchor is from where the other anchors place it'
            : 'Distance between where this anchor is and where the fit puts it'
        }
      >
        {residual !== undefined ? fmtRes(residual) : ''}
      </span>
      <button
        type="button"
        className="x"
        title="Remove anchor"
        aria-label={`Remove anchor ${n}`}
        onClick={() => {
          const p = project();
          if (p) edit(removeAnchor(p, anchor.id));
        }}
      >
        ×
      </button>
    </li>
  );
}

const METHODS: readonly { value: FitMethod; label: string }[] = [
  { value: 'auto', label: 'Automatic' },
  { value: 'similarity', label: 'Scale and rotate (2+ anchors)' },
  { value: 'affine', label: 'Stretch to fit (3+ anchors)' },
  { value: 'tps', label: 'Rubber sheet, for hand-drawn maps (4+ anchors)' },
];

export function AnchorsPanel() {
  const anchors = useApp((s) => s.session?.project.anchors ?? null);
  const method = useApp((s) => s.session?.project.fitMethod ?? 'auto');
  const fit = useFit();
  if (!anchors) return null;
  const msg = fitMessage(fit, anchors.length, true);
  return (
    <div className="anchors-panel">
      <p className="hint">
        Click a spot you can recognize, like a trailhead, junction or parking lot. Then find the
        same spot in{' '}
        <a href="https://www.google.com/maps" target="_blank" rel="noopener noreferrer">
          Google Maps
        </a>
        , right-click it, click the coordinates to copy them, and paste below. Three to six anchors
        spread around the edges work best.
      </p>
      <button
        type="button"
        className="btn"
        onClick={() => {
          chooseTool('anchor');
          showToast('Click the spot on the map');
        }}
      >
        Add anchor
      </button>
      {anchors.length ? (
        <ol className="anchors" aria-label="Anchors">
          {anchors.map((a, i) => (
            <AnchorRow key={a.id} anchor={a} n={i + 1} />
          ))}
        </ol>
      ) : null}
      {msg.text ? (
        <div className={`fit${msg.tone ? ` ${msg.tone}` : ''}`} role="status">
          {msg.text}
        </div>
      ) : null}
      <label className="field">
        Fit method
        <select
          value={method}
          onChange={(e) => {
            const p = project();
            if (p) edit(setFitMethod(p, e.target.value as FitMethod));
          }}
        >
          {METHODS.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
