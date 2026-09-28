// Lane B test support (T-202): hand-built ExportDocuments for the writer tests, and golden-file
// comparison. Lives in __golden__ (test-only: excluded from app, core lint and coverage).
import { readFileSync, writeFileSync } from 'node:fs';
import { expect } from 'vitest';
import type { ExportDocument, ExportOptions, GeoFeature, KmlOverlay } from '../../types';

export const OPTS: ExportOptions = { units: 'mi', time: '2026-09-24T12:00:00.000Z' };
export const OPTS_KM: ExportOptions = { units: 'km', time: '2026-09-24T12:00:00.000Z' };

export const TRAIL: GeoFeature = {
  kind: 'trail',
  id: 'f1',
  name: `Mist Trail <&"'> \u{1F97E}`,
  color: '#D9480F',
  notes: 'Steep granite steps.\nBring water.',
  pts: [
    [10, 10],
    [50, 40],
    [90, 80],
  ],
  ink: [200, 60, 20],
  ll: [
    [37.72713456789, -119.55812349876],
    [37.7265, -119.5512],
    [37.72591, -119.54357777],
  ],
  lengthM: 1234.5678,
};

export const AREA: GeoFeature = {
  kind: 'area',
  id: 'f2',
  name: 'Emerald Pool',
  color: '#3a7d44',
  notes: '',
  pts: [
    [0, 0],
    [9, 0],
    [9, 9],
  ],
  ll: [
    [37.7281, -119.5421],
    [37.7283, -119.5409],
    [37.7274, -119.5405],
  ],
  lengthM: 845.2,
};

export const TRAILHEAD: GeoFeature = {
  kind: 'poi',
  id: 'f3',
  name: 'Happy Isles Trailhead',
  color: '#1F6FB2',
  notes: 'Shuttle stop 16',
  at: [5, 5],
  poiType: 'Trailhead',
  ll: [37.7327, -119.5578],
};

export const TAP: GeoFeature = {
  kind: 'poi',
  id: 'f4',
  name: 'Tap & "fountain"',
  color: '#1F6FB2',
  notes: '',
  at: [6, 6],
  poiType: 'Water',
  ll: [37.73, -119.556],
};

/** Every kind, with hostile names. */
export const MIXED: ExportDocument = { name: 'Yosemite <Valley> & "Mist"', features: [TRAIL, AREA, TRAILHEAD, TAP] };
export const TRAILS_ONLY: ExportDocument = { name: 'Trails only', features: [TRAIL] };
export const POIS_ONLY: ExportDocument = { name: 'Points only', features: [TRAILHEAD, TAP] };
export const EMPTY: ExportDocument = { name: 'Empty', features: [] };
/** Characters illegal in XML 1.0, a short hex color and southern/eastern hemispheres. */
export const ODD: ExportDocument = {
  name: 'Bell\u0007 park',
  features: [
    {
      ...TRAIL,
      name: 'Tab\tand bell\u0007',
      notes: 'nul\u0000 here',
      color: '#abc',
      ll: [
        [-33.8567844, 151.2152967],
        [-33.85, 151.22],
      ],
    },
    { ...TAP, color: 'not-a-color', ll: [-0.0000001, 0] },
  ],
};

export const ALL_DOCS = { MIXED, TRAILS_ONLY, POIS_ONLY, EMPTY, ODD };

export const OVERLAY: KmlOverlay = {
  href: 'files/map.jpg',
  quad: [
    [37.72, -119.56],
    [37.72, -119.54],
    [37.735, -119.54],
    [37.735, -119.56],
  ],
};

/** Compare against __golden__/<name>; UPDATE_GOLDEN=1 rewrites the file. */
export function expectGolden(name: string, actual: string): void {
  const url = new URL(`./${name}`, import.meta.url);
  if (process.env.UPDATE_GOLDEN === '1') writeFileSync(url, actual);
  expect(actual).toBe(readFileSync(url, 'utf8'));
}
