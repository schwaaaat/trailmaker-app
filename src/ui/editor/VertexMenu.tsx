/** @jsxRuntime automatic */
// Lane B. Right-click vertex menu (card T-209): delete this vertex, or split the trail here.
// A floating DOM overlay, not part of the canvas; the Editor class stays plain (no menu state).
import { useEffect, useRef } from 'react';
import { deleteVertex } from '../../state/commands';
import { useApp } from '../../state/hooks';
import { appStore, edit, openVertexMenu } from '../../state/store';
import { splitHere } from '../../state/topology-actions';

export function VertexMenu() {
  const menu = useApp((s) => s.vertexMenu);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menu) return;
    const onPointerDown = (e: PointerEvent) => {
      const inside = e.target instanceof Node && ref.current?.contains(e.target);
      if (!inside) openVertexMenu(null);
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => window.removeEventListener('pointerdown', onPointerDown, true);
  }, [menu]);

  if (!menu) return null;
  const p = appStore.getState().session?.project ?? null;

  return (
    <div
      ref={ref}
      role="menu"
      aria-label="Vertex actions"
      className="vertex-menu"
      style={{ left: menu.client.x, top: menu.client.y }}
      onKeyDown={(event) => {
        if (event.key.toLowerCase() === 's' && menu.canSplit) {
          event.preventDefault();
          event.stopPropagation();
          splitHere(menu.featureId, menu.index);
          openVertexMenu(null);
        } else if (event.key === 'Delete' || event.key === 'Backspace') {
          event.preventDefault();
          event.stopPropagation();
          if (p) edit(deleteVertex(p, menu.featureId, menu.index));
          openVertexMenu(null);
        }
      }}
    >
      {menu.canSplit ? (
        <button
          type="button"
          role="menuitem"
          aria-keyshortcuts="S"
          title="Split the trail here (S)"
          onClick={() => {
            splitHere(menu.featureId, menu.index);
            openVertexMenu(null);
          }}
        >
          Split here <kbd>S</kbd>
        </button>
      ) : null}
      <button
        type="button"
        role="menuitem"
        aria-keyshortcuts="Delete Backspace"
        onClick={() => {
          if (p) edit(deleteVertex(p, menu.featureId, menu.index));
          openVertexMenu(null);
        }}
      >
        Delete point <kbd>Delete / Backspace</kbd>
      </button>
    </div>
  );
}
