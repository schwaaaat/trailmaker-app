/** @jsxRuntime automatic */
// Lane B. Mounts the canvas Editor into React. React renders only the <canvas>; the Editor
// class owns everything drawn on it.
import { useEffect, useRef, useState } from 'react';
import { installTestHook } from '../../state/test-hook';
import { useApp, useFit } from '../../state/hooks';
import { setEditorBackdrop, setEditorMapOpacity } from '../../state/store';
import { loadSettings, subscribeSettings } from '../../io/settings';
import { Editor } from './Editor';
import { idle, installSmartFollow } from './smart';
import { Tools } from './tools';
import { VertexMenu } from './VertexMenu';

let current: Editor | null = null;
const subscribers = new Set<(editor: Editor | null) => void>();

/** The mounted editor, or null. Tools (T-204) attach to it via onEditor. */
export function currentEditor(): Editor | null {
  return current;
}

/** Call fn with the editor now and whenever it is (re)mounted or destroyed. Returns unsubscribe. */
export function onEditor(fn: (editor: Editor | null) => void): () => void {
  subscribers.add(fn);
  fn(current);
  return () => subscribers.delete(fn);
}

function setCurrent(editor: Editor | null): void {
  current = editor;
  for (const fn of subscribers) fn(editor);
}

installTestHook({
  idle,
  imageToClient(px) {
    if (!current) throw new Error('The map editor is not mounted');
    return current.imageToClient(px);
  },
});

export function EditorStage() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const editor = new Editor();
    editor.mount(ref.current!);
    const tools = new Tools(editor);
    const unsmart = installSmartFollow(editor);
    setCurrent(editor);
    return () => {
      unsmart();
      tools.destroy();
      editor.destroy();
      if (current === editor) setCurrent(null);
    };
  }, []);
  const backdrop = useApp((s) => s.editorBackdrop ?? 'map');
  const opacity = useApp((s) => s.editorMapOpacity ?? 0);
  const fit = useFit();
  const [apiKey, setApiKey] = useState(() => loadSettings().basemap.esriApiKey ?? '');
  useEffect(
    () => subscribeSettings((settings) => setApiKey(settings.basemap.esriApiKey ?? '')),
    [],
  );
  const enabled = Boolean(fit?.ok && apiKey.trim());
  useEffect(() => {
    if (backdrop === 'esri' && !enabled) setEditorBackdrop('map');
  }, [backdrop, enabled]);
  return (
    <>
      {/* role="img" would put a screen reader in browse mode, which swallows Tab and the arrow
          keys before the tools' own keydown handler sees them (T-215, T-311 made the same call
          for the basemap). role="application" hands all keyboard input to this component. */}
      <canvas
        ref={ref}
        className="editor-canvas"
        role="application"
        aria-label="Park map editor"
        aria-describedby="editor-help-hint"
        tabIndex={0}
      />
      <div className="editor-backdrop-controls" role="group" aria-label="Editor backdrop controls">
        <span>Backdrop:</span>
        <button
          type="button"
          aria-pressed={backdrop === 'map'}
          onClick={() => setEditorBackdrop('map')}
        >
          Map
        </button>
        <button
          type="button"
          aria-pressed={backdrop === 'esri'}
          disabled={!enabled}
          aria-describedby={!enabled ? 'editor-esri-disabled-reason' : undefined}
          title={
            !apiKey.trim()
              ? 'Add an Esri API key in Basemap settings to enable Esri.'
              : !fit?.ok
                ? 'Add valid map anchors to enable Esri.'
                : undefined
          }
          onClick={() => setEditorBackdrop('esri')}
        >
          Esri (live)
        </button>
        {!enabled && (
          <span id="editor-esri-disabled-reason">
            {!apiKey.trim()
              ? 'Add an Esri API key in Basemap settings to enable Esri.'
              : 'Add valid map anchors to enable Esri.'}
          </span>
        )}
        {backdrop === 'esri' && (
          <label>
            Map opacity
            <input
              aria-label="Map image opacity over Esri"
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={opacity}
              onChange={(e) => setEditorMapOpacity(Number(e.target.value))}
            />
          </label>
        )}
      </div>
      {backdrop === 'esri' && (
        <div className="editor-esri-credit" role="note">
          Esri, Vantor, Earthstar Geographics, and the GIS User Community
        </div>
      )}
      <p id="editor-help-hint" className="sr-only">
        Press question mark for keyboard shortcuts.
      </p>
      <VertexMenu />
    </>
  );
}
