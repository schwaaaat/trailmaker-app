// @vitest-environment jsdom
import { Blob as NodeBlob } from 'node:buffer';
globalThis.Blob = NodeBlob as unknown as typeof Blob;
if (typeof window !== 'undefined') {
  window.Blob = NodeBlob as unknown as typeof Blob;
}

import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deserializeProject, newProject, serializeProject } from '../core/project';
import type { Session, SessionBridge } from '../ui/contract';
import { makeMap, makeProject } from '../state/fixtures.test.helper';
import {
  clearAutosave,
  readAutosave,
  resetAutosaveForTests,
  startAutosave,
} from './autosave';
import {
  clearActiveGpx,
  getActiveGpx,
  loadGpxBlob,
  setActiveGpx,
  subscribeActiveGpx,
  type StoredGpxLayer,
} from './gpxStorage';

function createFakeBridge(initialSession: Session | null = null): {
  bridge: SessionBridge;
  setSession: (s: Session | null) => void;
} {
  let current = initialSession;
  const listeners = new Set<(s: Session | null) => void>();

  const bridge: SessionBridge = {
    getSession: () => current,
    openSession: (s) => {
      current = s;
      listeners.forEach((l) => l(current));
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };

  return {
    bridge,
    setSession: (s) => {
      current = s;
      listeners.forEach((l) => l(current));
    },
  };
}

async function flushAsyncWork(ms = 200): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe('GPX Storage & Persistence (card T-312)', () => {
  beforeEach(() => {
    resetAutosaveForTests();
    clearActiveGpx();
  });

  afterEach(() => {
    resetAutosaveForTests();
    clearActiveGpx();
  });

  const SAMPLE_GPX = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Trailmaker" xmlns="http://www.topografix.com/GPX/1/1">
  <wpt lat="38.5971" lon="-78.3952">
    <name>Peak Landmark</name>
  </wpt>
  <trk>
    <name>Overlook Trail</name>
    <trkseg>
      <trkpt lat="38.5975" lon="-78.3950" />
      <trkpt lat="38.5980" lon="-78.3940" />
    </trkseg>
  </trk>
</gpx>`;

  it('manages active GPX layer in memory and notifies subscribers', () => {
    const notifications: (StoredGpxLayer | null)[] = [];
    const unsub = subscribeActiveGpx((layer) => notifications.push(layer));

    expect(getActiveGpx()).toBeNull();

    const layer: StoredGpxLayer = {
      fileName: 'survey.gpx',
      points: [
        { id: 'wpt-1', name: 'Peak', ll: [38.5, -78.3], kind: 'wpt' },
      ],
      tracks: [{ name: 'Overlook', points: [[38.5, -78.3], [38.6, -78.2]] }],
      totalPointsInFile: 1,
      wasDecimated: false,
    };

    setActiveGpx(layer);
    expect(getActiveGpx()).toEqual(layer);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toEqual(layer);

    clearActiveGpx();
    expect(getActiveGpx()).toBeNull();
    expect(notifications).toHaveLength(2);
    expect(notifications[1]).toBeNull();

    unsub();
  });

  it('loads and parses a GPX blob into active layer', async () => {
    const blob = new Blob([SAMPLE_GPX], { type: 'application/gpx+xml' });
    const res = await loadGpxBlob(blob, 'field.gpx');
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.fileName).toBe('field.gpx');
    expect(res.points).toHaveLength(3);

    const active = getActiveGpx();
    expect(active).not.toBeNull();
    expect(active?.points).toHaveLength(3);
    expect(active?.points[0]?.name).toBe('Peak Landmark');
    expect(active?.tracks).toHaveLength(1);
  });

  it('persists imported GPX through autosave in IndexedDB', async () => {
    const project = makeProject({ name: 'Shenandoah Map' });
    const map = makeMap(project);
    const session: Session = { project, map };

    const { bridge } = createFakeBridge(session);
    const stop = startAutosave(bridge, { debounceMs: 50 });

    const blob = new Blob([SAMPLE_GPX], { type: 'application/gpx+xml' });
    // GPX import schedules autosave itself without modifying session bridge
    await loadGpxBlob(blob, 'hike.gpx');

    await flushAsyncWork(150);

    // Read back from autosave
    const restored = await readAutosave();
    expect(restored).not.toBeNull();
    expect(restored?.project.name).toBe('Shenandoah Map');
    expect(restored?.gpx).not.toBeNull();
    expect(restored?.gpx?.fileName).toBe('hike.gpx');
    expect(restored?.gpx?.points).toHaveLength(3);
    expect(restored?.gpx?.points[0]?.name).toBe('Peak Landmark');

    stop();
  });

  it('schedules autosave write on GPX import without session bridge edit', async () => {
    const project = makeProject({ name: 'Import Write Regression' });
    const map = makeMap(project);
    const session: Session = { project, map };

    const { bridge } = createFakeBridge(session);
    const stop = startAutosave(bridge, { debounceMs: 50 });

    const blob = new Blob([SAMPLE_GPX], { type: 'application/gpx+xml' });
    await loadGpxBlob(blob, 'survey.gpx');

    await flushAsyncWork(150);

    const saved = await readAutosave();
    expect(saved).not.toBeNull();
    expect(saved?.project.name).toBe('Import Write Regression');
    expect(saved?.gpx?.fileName).toBe('survey.gpx');
    expect(saved?.gpx?.points).toHaveLength(3);

    stop();
  });

  it('schedules autosave clear on GPX removal without session bridge edit', async () => {
    const project = makeProject({ name: 'Removal Clear Regression' });
    const map = makeMap(project);
    const session: Session = { project, map };

    const { bridge } = createFakeBridge(session);
    const stop = startAutosave(bridge, { debounceMs: 50 });

    const blob = new Blob([SAMPLE_GPX], { type: 'application/gpx+xml' });
    await loadGpxBlob(blob, 'survey.gpx');
    await flushAsyncWork(150);

    let saved = await readAutosave();
    expect(saved?.gpx?.fileName).toBe('survey.gpx');

    // Remove active GPX without touching session bridge
    clearActiveGpx();
    await flushAsyncWork(150);

    saved = await readAutosave();
    expect(saved).not.toBeNull();
    expect(saved?.project.name).toBe('Removal Clear Regression');
    expect(saved?.gpx).toBeNull();

    stop();
  });

  it('clears persisted GPX when clearAutosave is called', async () => {
    const project = makeProject({ name: 'Test Map' });
    const map = makeMap(project);
    const session: Session = { project, map };

    const { bridge } = createFakeBridge(session);
    const stop = startAutosave(bridge, { debounceMs: 50 });

    const blob = new Blob([SAMPLE_GPX], { type: 'application/gpx+xml' });
    await loadGpxBlob(blob, 'hike.gpx');
    await flushAsyncWork(150);

    expect(getActiveGpx()).not.toBeNull();

    await clearAutosave();
    expect(getActiveGpx()).toBeNull();

    const restored = await readAutosave();
    expect(restored).toBeNull();

    stop();
  });

  it('serializes and deserializes GPX with .trailmaker project files', () => {
    const project = newProject(
      {
        fileName: 'map.png',
        width: 100,
        height: 100,
        originalWidth: 100,
        originalHeight: 100,
        source: { kind: 'image', mimeType: 'image/png' },
        sha256: 'abc12345',
      },
      'Trail Project',
      new Date().toISOString(),
    );

    const imageBytes = new Uint8Array([137, 80, 78, 71]);
    const storedImage = { bytes: imageBytes, mimeType: 'image/png' };
    const gpxBytes = new TextEncoder().encode(SAMPLE_GPX);

    const zipBytes = serializeProject(project, storedImage, gpxBytes);
    expect(zipBytes.length).toBeGreaterThan(0);

    const restored = deserializeProject(zipBytes);
    expect(restored.project.name).toBe('Trail Project');
    expect(restored.gpxBytes).toBeDefined();

    const gpxText = new TextDecoder().decode(restored.gpxBytes);
    expect(gpxText).toContain('<name>Peak Landmark</name>');
  });
});
