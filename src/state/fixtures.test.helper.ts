// Lane B test support: hand-built Projects and Sessions (T-201 must not wait for T-301's
// newProject). Excluded from the app build by the `*.test.*` pattern.
import { PROJECT_VERSION, type Project } from '../core/types';
import type { LoadedMap, Session } from '../ui/contract';

export function makeProject(over: Partial<Project> = {}): Project {
  return {
    version: PROJECT_VERSION,
    name: 'Test park',
    image: {
      fileName: 'test-park',
      width: 1000,
      height: 800,
      originalWidth: 1000,
      originalHeight: 800,
      source: { kind: 'image', mimeType: 'image/png' },
      sha256: '0'.repeat(64),
    },
    anchors: [],
    fitMethod: 'auto',
    features: [],
    units: 'mi',
    trace: { smartFollow: true, tolerance: 60, ink: null },
    autoTrace: { chips: [], gapPx: 24, minLengthPct: 4 },
    seq: 1,
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

export function makeMap(project: Project): LoadedMap {
  const { width, height } = project.image;
  return {
    meta: project.image,
    // jsdom has no ImageBitmap; nothing in src/state reads it.
    display: {} as ImageBitmap,
    raster: { width, height, data: new Uint8ClampedArray(0) },
    original: new Blob([]),
    pdf: null,
  };
}

export function makeSession(project: Project = makeProject()): Session {
  return { project, map: makeMap(project) };
}

/** Deterministic PRNG (mulberry32) for property tests. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
