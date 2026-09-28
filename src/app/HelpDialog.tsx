/** @jsxRuntime automatic */
// Lane B. Keyboard shortcuts help dialog (T-215), opened from the toolbar's "?" button or the
// "?" key. Traps focus while open and returns it to the opener on close, using Lane C's
// focusTrap.ts (T-311) rather than a second copy of the same hook.
import { useRef } from 'react';
import { useApp } from '../state/hooks';
import { setHelpOpen } from '../state/store';
import { TOOLS } from '../ui/editor/Toolbar';
import { useFocusTrap } from '../ui/georef/focusTrap';

/** Everything but the tool letters (those come from Toolbar's own TOOLS so they can't drift). */
const OTHER_SHORTCUTS: readonly { keys: string; desc: string }[] = [
  { keys: 'Tab / Shift+Tab', desc: 'Step to the next or previous vertex of the selected trail' },
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
    keys: 'Arrow keys on Split button',
    desc: 'Choose the split point on a focused candidate; Shift + Arrow steps by 10 vertices',
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

export function HelpDialog() {
  const open = useApp((s) => s.helpOpen);
  const ref = useRef<HTMLDivElement>(null);
  const close = () => setHelpOpen(false);
  useFocusTrap({ active: open, containerRef: ref, onClose: close });
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
        <div className="row">
          <button type="button" className="btn small primary" onClick={close}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
