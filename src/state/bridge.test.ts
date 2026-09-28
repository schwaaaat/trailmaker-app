import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../ui/contract';
import { sessionBridge } from './bridge';
import * as C from './commands';
import { makeSession } from './fixtures.test.helper';
import { appStore, edit, redo, selectFeature, setTool, undo } from './store';
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
