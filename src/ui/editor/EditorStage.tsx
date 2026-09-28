/** @jsxRuntime automatic */
// Lane B. Mounts the canvas Editor into React. React renders only the <canvas>; the Editor
// class owns everything drawn on it.
import { useEffect, useRef } from 'react';
import { installTestHook } from '../../state/test-hook';
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
      <p id="editor-help-hint" className="sr-only">
        Press question mark for keyboard shortcuts.
      </p>
      <VertexMenu />
    </>
  );
}
