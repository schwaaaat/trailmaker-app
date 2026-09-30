// Lane B, T-221. Controls for choosing and committing a trail connector.
import React from 'react';
import { DEFAULT_COLORS } from '../../core/types';
import { appStore, setConnectSession, showToast } from '../../state/store';
import { connectSelectedPoints } from '../../state/topology-actions';
import { useApp } from '../../state/hooks';
import { currentEditor } from '../editor/EditorStage';

void React;

export function ConnectPanel() {
  const session = useApp((s) => s.connectSession);
  const tool = useApp((s) => s.tool);
  if (tool !== 'connect') return null;
  const points = session?.points ?? [];
  const choose = async (mode: 'straight' | 'follow' | 'draw') => {
    if (points.length !== 2) return;
    const a = points[0]!;
    const b = points[1]!;
    if (mode === 'straight') {
      setConnectSession({ points, mode, connector: [a.point, b.point], drawing: false });
      return;
    }
    if (mode === 'draw') {
      setConnectSession({ points, mode, connector: [a.point, b.point], drawing: true });
      return;
    }
    const p = appStore.getState().session?.project;
    const editor = currentEditor();
    const hops = editor?.hopProvider;
    if (!editor || !p?.trace.smartFollow || !hops?.start) {
      showToast('Turn on Follow the map in Trace settings first');
      return;
    }
    try {
      const { ink } = await hops.start(a.point, editor.view, 'trail');
      if (appStore.getState().connectSession?.points !== points) return;
      const tail = await hops.hop(
        a.point,
        b.point,
        {
          kind: 'trail',
          pts: [a.point],
          cps: [1],
          ink,
          color: DEFAULT_COLORS.trail,
          name: 'Connector',
          editId: null,
        },
        editor.view,
      );
      if (!tail?.length) {
        showToast('Could not follow the map between these points');
        return;
      }
      if (appStore.getState().connectSession?.points !== points) return;
      setConnectSession({
        points,
        mode,
        connector: [a.point, ...tail.slice(0, -1), b.point],
        drawing: false,
      });
    } catch (error) {
      if (appStore.getState().connectSession?.points !== points) return;
      showToast(error instanceof Error ? error.message : 'Could not follow the map');
    }
  };
  const commit = () => {
    if (!session || session.points.length !== 2 || !session.connector) return;
    if (connectSelectedPoints(session.points[0]!, session.points[1]!, session.connector))
      setConnectSession(null);
  };
  const cancel = () => {
    currentEditor()?.hopProvider?.cancel?.();
    setConnectSession(null);
  };
  return (
    <section className="connect-panel" aria-label="Connect trails">
      <h3>Connect trails</h3>
      <p aria-live="polite">
        {points.length === 0
          ? 'Choose a point on the first trail.'
          : points.length === 1
            ? 'Choose a point on a trail to connect to.'
            : session?.drawing
              ? 'Tap or click to add points, then finish the line.'
              : session?.mode
                ? 'Preview the line, then connect the trails.'
                : 'Choose how the connector should run.'}
      </p>
      {points.length === 2 && !session?.mode && (
        <div className="row">
          <button className="btn" type="button" onClick={() => void choose('straight')}>
            Straight
          </button>
          <button className="btn" type="button" onClick={() => void choose('follow')}>
            Follow the map
          </button>
          <button className="btn" type="button" onClick={() => void choose('draw')}>
            Draw it
          </button>
        </div>
      )}
      {session?.mode && (
        <div className="row">
          {session.drawing ? (
            <button
              className="btn primary"
              type="button"
              onClick={() => setConnectSession({ ...session, drawing: false })}
            >
              Finish drawing
            </button>
          ) : null}
          {!session.drawing && (
            <button className="btn primary" type="button" onClick={commit}>
              Connect trails
            </button>
          )}
          <button
            className="btn"
            type="button"
            onClick={() =>
              setConnectSession({ points, mode: null, connector: null, drawing: false })
            }
          >
            Choose another style
          </button>
        </div>
      )}
      <button className="btn" type="button" onClick={cancel}>
        Cancel
      </button>
    </section>
  );
}
