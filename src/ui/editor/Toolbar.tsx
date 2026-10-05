/** @jsxRuntime automatic */
// Lane B. Map toolbar and tip line over the editor stage (prototype #toolbar / #tip).
import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { TOUCH_HINT_STORAGE_KEY } from '../../io/settings';
import { useApp } from '../../state/hooks';
import { setHelpOpen, type Tool } from '../../state/store';
import { currentEditor } from './EditorStage';
import { chooseTool, redoAction, tipFor, undoAction } from './tools';
import { startRefinement } from '../panels/refine-actions';

export { TOUCH_HINT_STORAGE_KEY };

const ICONS: Readonly<Record<string, ReactNode>> = {
  select: <path d="M5 3l14 8-6 2-3 6z" strokeLinejoin="round" />,
  anchor: (
    <>
      <path d="M12 22s7-7 7-12a7 7 0 10-14 0c0 5 7 12 7 12z" />
      <circle cx="12" cy="10" r="2.5" />
    </>
  ),
  trail: (
    <>
      <path d="M4 20c3-1 3-6 7-7s5-5 9-9" strokeLinecap="round" />
      <circle cx="4" cy="20" r="1.5" fill="currentColor" />
      <circle cx="20" cy="4" r="1.5" fill="currentColor" />
    </>
  ),
  point: <path d="M6 21V4h11l-2 4 2 4H6" strokeLinejoin="round" />,
  area: <path d="M4 7l7-4 9 5-2 11-11 2z" strokeLinejoin="round" />,
  connect: (
    <>
      <path d="M6 7l12 10" />
      <circle cx="5" cy="6" r="2" />
      <circle cx="19" cy="18" r="2" />
    </>
  ),
  fit: <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" strokeLinecap="round" />,
  undo: (
    <>
      <path d="M9 14L4 9l5-5" />
      <path d="M4 9h10a6 6 0 010 12h-3" />
    </>
  ),
  redo: (
    <>
      <path d="M15 14l5-5-5-5" />
      <path d="M20 9H10a6 6 0 000 12h3" />
    </>
  ),
};

function Icon({ name }: { name: string }) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {ICONS[name]}
    </svg>
  );
}

/** Exported for the keyboard shortcuts help dialog (T-215), so its tool list can't drift from
 * the toolbar's. */
export const TOOLS: readonly { tool: Tool; label: string; title: string; key: string }[] = [
  { tool: 'select', label: 'Select', title: 'Select and move', key: 'V' },
  { tool: 'anchor', label: 'Anchor', title: 'Add anchor', key: 'A' },
  { tool: 'trail', label: 'Trail', title: 'Trace a trail', key: 'T' },
  { tool: 'point', label: 'Point', title: 'Add a point of interest', key: 'P' },
  { tool: 'area', label: 'Area', title: 'Outline an area', key: 'R' },
  { tool: 'connect', label: 'Connect', title: 'Connect two points on trails', key: 'C' },
];

export function Toolbar() {
  const open = useApp((s) => s.session !== null);
  const tool = useApp((s) => s.tool);
  const drafting = useApp((s) => s.draft !== null);
  const canUndo = useApp((s) => s.history.canUndo);
  const canRedo = useApp((s) => s.history.canRedo);
  const reviewCanUndo = useApp((s) => s.reviewUndoStack.length > 0);
  const selectedTrail = useApp(
    (s) =>
      s.session?.project.features.find(
        (feature) => feature.id === s.selectedFeatureId && feature.kind === 'trail',
      ) ?? null,
  );
  const refinementBlocked = useApp(
    (s) => s.job !== null || s.refinePreview !== null || s.draft !== null,
  );
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      if (
        event.shiftKey &&
        event.altKey &&
        event.key.toLowerCase() === 'r' &&
        !event.ctrlKey &&
        !event.metaKey &&
        !(
          target instanceof HTMLElement &&
          (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))
        )
      ) {
        if (selectedTrail && !refinementBlocked) {
          event.preventDefault();
          void startRefinement([selectedTrail.id]);
        }
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [selectedTrail, refinementBlocked]);
  // The map-tool buttons need an open session; the "Keyboard shortcuts" help below (T-215) does
  // not, so the toolbar landmark and that one button stay mounted either way -- a user can check
  // the shortcuts before opening a map.
  return (
    <div className="toolbar" role="toolbar" aria-label="Map tools">
      {open && (
        <>
          {TOOLS.map((t, i) => (
            <span key={t.tool} className="toolbar-group">
              {i === 1 || i === 2 ? <span className="sep" aria-hidden="true" /> : null}
              <button
                type="button"
                aria-label={t.label}
                aria-pressed={tool === t.tool}
                aria-keyshortcuts={t.key}
                title={`${t.title} (${t.key})`}
                onClick={() => chooseTool(t.tool)}
              >
                <Icon name={t.tool} />
                <span className="lbl" aria-hidden="true">
                  {t.label}
                </span>{' '}
                <kbd aria-hidden="true">{t.key}</kbd>
              </button>
            </span>
          ))}
          <button
            type="button"
            aria-label="Fit map to view"
            aria-keyshortcuts="F"
            title="Fit map to view (F)"
            onClick={() => currentEditor()?.fitView()}
          >
            <Icon name="fit" />
          </button>
          <button
            type="button"
            aria-label="Undo"
            aria-keyshortcuts="Control+Z Meta+Z"
            title="Undo (Ctrl+Z)"
            disabled={!canUndo && !drafting && !reviewCanUndo}
            onClick={undoAction}
          >
            <Icon name="undo" />
          </button>
          <button
            type="button"
            aria-label="Redo"
            aria-keyshortcuts="Control+Shift+Z Meta+Shift+Z Control+Y"
            title="Redo (Ctrl+Shift+Z)"
            disabled={!canRedo || drafting}
            onClick={redoAction}
          >
            <Icon name="redo" />
          </button>
          <span className="sep" aria-hidden="true" />
        </>
      )}
      <button
        type="button"
        aria-label="Keyboard shortcuts"
        aria-keyshortcuts="?"
        title="Keyboard shortcuts (?)"
        onClick={() => setHelpOpen(true)}
      >
        ?
      </button>
    </div>
  );
}

const hintSubscribers = new Set<(collapsed: boolean) => void>();

export function subscribeTouchHintCollapsed(callback: (collapsed: boolean) => void): () => void {
  hintSubscribers.add(callback);
  return () => {
    hintSubscribers.delete(callback);
  };
}

export function resetTouchHintCollapsed(): void {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.removeItem(TOUCH_HINT_STORAGE_KEY);
    }
  } catch {
    // Ignore storage errors
  }
  for (const sub of hintSubscribers) {
    try {
      sub(false);
    } catch {
      // Ignore subscriber errors
    }
  }
}

export function TipLine() {
  const [coarsePointer, setCoarsePointer] = useState(false);
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return window.localStorage.getItem(TOUCH_HINT_STORAGE_KEY) === 'true';
    } catch {
      return false;
    }
  });

  useEffect(() => subscribeTouchHintCollapsed(setCollapsed), []);
  const hasMap = useApp((s) => s.session !== null);
  const tool = useApp((s) => s.tool);
  const smartFollow = useApp((s) => s.session?.project.trace.smartFollow ?? false);
  const reviewing = useApp((s) => s.candidates !== null);
  const state = { hasMap, tool, smartFollow, reviewing };
  const text = tipFor({ ...state, coarsePointer });
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia('(pointer: coarse)');
    const update = () => setCoarsePointer(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  const toggleCollapsed = () => {
    setCollapsed((previous) => {
      const next = !previous;
      try {
        window.localStorage.setItem(TOUCH_HINT_STORAGE_KEY, String(next));
      } catch {
        // The hint remains usable when storage is unavailable; remembering is best effort.
      }
      return next;
    });
  };
  return (
    <div className={`tip${coarsePointer ? ' touch-tip' : ''}`} aria-live="polite">
      {coarsePointer && (
        <button
          type="button"
          className="tip-toggle"
          aria-label={collapsed ? 'Show map hint' : 'Collapse map hint'}
          aria-expanded={!collapsed}
          onClick={toggleCollapsed}
        >
          {collapsed ? '?' : '×'}
        </button>
      )}
      {(!coarsePointer || !collapsed) && <span className="tip-text">{text}</span>}
    </div>
  );
}
