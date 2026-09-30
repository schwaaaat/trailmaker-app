/** @jsxRuntime automatic */
// Lane B. Keyboard shortcuts help dialog (T-215), opened from the toolbar's "?" button or the
// "?" key. Traps focus while open and returns it to the opener on close, using Lane C's
// focusTrap.ts (T-311) rather than a second copy of the same hook.
import { useEffect, useRef, useState } from 'react';
import { RESET_INTERFACE_ITEMS, RESET_INTERFACE_NOTE } from '../io/settings';
import { useApp } from '../state/hooks';
import { setHelpOpen } from '../state/store';
import { TOOLS } from '../ui/editor/Toolbar';
import { useFocusTrap } from '../ui/georef/focusTrap';
import { resetInterface } from './resetInterface';

/** Everything but the tool letters (those come from Toolbar's own TOOLS so they can't drift). */
const OTHER_SHORTCUTS: readonly { keys: string; desc: string }[] = [
  { keys: 'Tab / Shift+Tab', desc: 'Step to the next or previous vertex of the selected trail' },
  { keys: ', / .', desc: 'Move to the previous or next point on the selected trail' },
  { keys: '< / >, [ / ]', desc: 'Move 10 points backward or forward on the selected trail' },
  { keys: 'Arrow keys', desc: 'Nudge the focused vertex, or pan the map with none focused' },
  { keys: 'Shift + Arrow keys', desc: 'Nudge or pan in larger steps' },
  {
    keys: 'Delete / Backspace',
    desc: 'Remove the focused vertex, or the selected trail/area/point',
  },
  {
    keys: 'Enter',
    desc: 'Finish the trail/area being traced, or place a point at the view centre',
  },
  { keys: 'Escape', desc: 'Release the focused vertex, or deselect' },
  { keys: 'S', desc: 'Split the selected trail at the focused (or hovered) vertex' },
  {
    keys: 'Arrows, , / . on Split button',
    desc: 'Choose a candidate split point; Shift + Arrow, < / >, or [ / ] steps by 10 points',
  },
  { keys: 'Enter on Split button', desc: 'Split the candidate at the chosen point' },
  {
    keys: 'Shift + Enter / Space on feature row',
    desc: 'Select a second trail to join with the selected trail',
  },
  { keys: 'J', desc: 'Join the selected trail with the shift-selected second one' },
  { keys: 'F', desc: 'Fit the map to the view' },
  { keys: '+ / -', desc: 'Zoom in or out' },
  { keys: 'Ctrl/Cmd + Z', desc: 'Undo' },
  { keys: 'Ctrl/Cmd + Shift + Z', desc: 'Redo' },
  { keys: '?', desc: 'Open this dialog' },
];

export interface HelpDialogProps {
  readonly onResetInterface?: (() => void) | undefined;
}

export function HelpDialog({ onResetInterface = resetInterface }: HelpDialogProps = {}) {
  const open = useApp((s) => s.helpOpen);
  const [confirmingReset, setConfirmingReset] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  const close = () => {
    setConfirmingReset(false);
    setHelpOpen(false);
  };

  useEffect(() => {
    if (!open) setConfirmingReset(false);
  }, [open]);

  useFocusTrap({ active: open, containerRef: ref, onClose: close, initialFocusRef: closeBtnRef });
  if (!open) return null;
  return (
    <div className="dialog-scrim" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby="help-dialog-title"
        className="dialog help-dialog"
      >
        <h2 id="help-dialog-title">Keyboard shortcuts</h2>
        <table>
          <tbody>
            {TOOLS.map((t) => (
              <tr key={t.tool}>
                <td>
                  <kbd>{t.key}</kbd>
                </td>
                <td>{t.title}</td>
              </tr>
            ))}
            {OTHER_SHORTCUTS.map((row) => (
              <tr key={row.keys}>
                <td>
                  <kbd>{row.keys}</kbd>
                </td>
                <td>{row.desc}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <section aria-labelledby="help-points-title">
          <h3 id="help-points-title">Points and splitting</h3>
          <p>
            Select a trail, then tap or click a point (or use , / . to move between points). Press S
            to split there, or open the point menu and choose Split here. Right-click or long-press
            a point to open its menu.
          </p>
        </section>

        {confirmingReset ? (
          <div
            className="reset-interface-confirm"
            role="alertdialog"
            aria-labelledby="help-reset-confirm-title"
          >
            <h3 id="help-reset-confirm-title">Reset interface to defaults?</h3>
            <p className="reset-confirm-desc">This will reset:</p>
            <ul className="reset-confirm-list">
              {RESET_INTERFACE_ITEMS.map((item, i) => (
                <li key={i}>{item}</li>
              ))}
            </ul>
            <p className="reset-confirm-note">{RESET_INTERFACE_NOTE}</p>
            <div className="row reset-confirm-actions">
              <button
                type="button"
                className="btn small danger btn-confirm-reset"
                onClick={() => {
                  onResetInterface();
                  close();
                }}
              >
                Reset interface
              </button>
              <button
                type="button"
                className="btn small secondary btn-cancel-reset"
                onClick={() => setConfirmingReset(false)}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="row help-dialog-footer">
            <button
              ref={closeBtnRef}
              type="button"
              className="btn small primary"
              onClick={close}
            >
              Close
            </button>
            <button
              type="button"
              className="btn small secondary btn-reset-interface"
              onClick={() => setConfirmingReset(true)}
            >
              Reset interface…
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

