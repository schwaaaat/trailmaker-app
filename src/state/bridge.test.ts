import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LoadedMap, Session } from '../ui/contract';
import { sessionBridge } from './bridge';
import * as C from './commands';
import { makeSession } from './fixtures.test.helper';
import { appStore, edit, redo, selectAnchor, selectFeature, setTool, undo } from './store';
import { installTestHook, testHookEnabled } from './test-hook';

beforeEach(() => sessionBridge.openSession(makeSession()));

describe('sessionBridge', () => {
  it('fires once after each execute, undo, redo and openSession, then stops after unsubscribe', () => {
    const seen: (Session | null)[] = [];
    const off = sessionBridge.subscribe((s) => seen.push(s));

    edit(C.setUnits(sessionBridge.getSession()!.project, 'km'));
    expect(seen).toHaveLength(1);
    expect(seen[0]!.project.units).toBe('km');

    undo();
    redo();
    expect(seen).toHaveLength(3);
    expect(seen.map((s) => s!.project.units)).toStrictEqual(['km', 'mi', 'km']);

    // UI-only changes are not session changes.
    setTool('trail');
    selectFeature(null);
    expect(seen).toHaveLength(3);

    // A new map with the same project still notifies.
    const next = { ...sessionBridge.getSession()!, map: makeSession().map };
    sessionBridge.openSession(next);
    expect(seen).toHaveLength(4);
    expect(seen[3]).toBe(next);
    expect(sessionBridge.getSession()).toBe(next);

    off();
    edit(C.setUnits(next.project, 'mi'));
    expect(seen).toHaveLength(4);
  });

  it('reports a null session', () => {
    const listener = vi.fn();
    const off = sessionBridge.subscribe(listener);
    appStore.setState({ session: null });
    expect(listener).toHaveBeenCalledExactlyOnceWith(null);
    expect(sessionBridge.getSession()).toBeNull();
    off();
  });

  it('replaces map pixels while preserving the current project, history and selections', () => {
    const project = makeSession().project;
    const session = makeSession({
      ...project,
      anchors: [{ id: 'anchor-1', px: [1, 2], ll: null, source: 'paste' }],
      features: [
        {
          kind: 'trail',
          id: 'trail-1',
          name: 'Trail',
          color: '#D9480F',
          notes: '',
          pts: [
            [0, 0],
            [5, 5],
          ],
          ink: null,
        },
      ],
    });
    sessionBridge.openSession(session);
    selectFeature('trail-1');
    selectAnchor('anchor-1');

    edit(C.setUnits(session.project, 'km'));
    edit(C.addAnchor(appStore.getState().session!.project, [10, 10]).command);
    expect(undo()).toBe(true);
    const before = appStore.getState();
    const currentSession = before.session!;
    const nextMap = { ...currentSession.map, raster: { ...currentSession.map.raster } };

    expect(sessionBridge.replaceMap).toBeTypeOf('function');
    expect(sessionBridge.replaceMap!(currentSession.map, nextMap as LoadedMap)).toBe(true);

    const after = appStore.getState();
    expect(after.session!.map).toBe(nextMap);
    expect(after.session!.project).toBe(currentSession.project);
    expect(after.history).toEqual(before.history);
    expect(after.selectedFeatureId).toBe('trail-1');
    expect(after.selectedAnchorId).toBe('anchor-1');
    expect(undo()).toBe(true);
    expect(appStore.getState().session!.project.units).toBe('mi');
    expect(redo()).toBe(true);
    expect(appStore.getState().session!.project.units).toBe('km');
    expect(redo()).toBe(true);
    expect(appStore.getState().session!.project.anchors).toHaveLength(2);
  });

  it('rejects a stale expected map after another session opens', () => {
    const staleMap = sessionBridge.getSession()!.map;
    const nextMap = makeSession().map;
    const nextSession = makeSession();
    sessionBridge.openSession(nextSession);

    expect(sessionBridge.replaceMap!(staleMap, nextMap)).toBe(false);
    expect(sessionBridge.getSession()).toBe(nextSession);
  });
});

describe('test hook', () => {
  it('is installed in test mode and merges members', () => {
    expect(testHookEnabled).toBe(true);
    installTestHook({ session: sessionBridge });
    expect(window.__trailmaker?.session).toBe(sessionBridge);
    const idle = () => Promise.resolve();
    installTestHook({ idle });
    expect(window.__trailmaker?.session).toBe(sessionBridge);
    expect(window.__trailmaker?.idle).toBe(idle);
  });
});
