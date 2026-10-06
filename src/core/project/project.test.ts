import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { zipSync } from 'fflate';
import { describe, expect, test } from 'vitest';
import type { MapImage, Project } from '../types';
import { DEFAULT_COLORS, PROJECT_VERSION } from '../types';
import {
  deserializeProject,
  deserializeProjectAsync,
  extFromMimeType,
  importPrototypeJson,
  migrateProject,
  mimeTypeFromExt,
  newProject,
  projectTestSeam,
  registerMigration,
  resetMigrations,
  serializeProject,
  serializeProjectAsync,
  setProjectTestSeam,
  stableStringify,
  validateProject,
  type StoredImage,
} from './index';

function createSampleMapImage(overrides: Partial<MapImage> = {}): MapImage {
  return {
    fileName: 'sample-map',
    width: 2400,
    height: 1800,
    originalWidth: 2400,
    originalHeight: 1800,
    source: { kind: 'image', mimeType: 'image/png' },
    sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    ...overrides,
  };
}

describe('newProject', () => {
  test('creates a project with prototype defaults', () => {
    const img = createSampleMapImage({ width: 2400, height: 1800 });
    const now = '2026-09-24T12:00:00.000Z';
    const p = newProject(img, 'Test Project', now);

    expect(p.version).toBe(PROJECT_VERSION);
    expect(p.name).toBe('Test Project');
    expect(p.image).toEqual(img);
    expect(p.anchors).toEqual([]);
    expect(p.features).toEqual([]);
    expect(p.fitMethod).toBe('auto');
    expect(p.units).toBe('mi');
    expect(p.seq).toBe(1);
    expect(p.updatedAt).toBe(now);

    expect(p.trace).toEqual({
      smartFollow: true,
      tolerance: 60,
      ink: null,
    });

    // max(2400, 1800) = 2400. 2400 / 80 = 30
    expect(p.autoTrace).toEqual({
      chips: [],
      gapPx: 30,
      minLengthPct: 4,
    });
  });

  test('gapPx is clamped between 6 and 120 px', () => {
    const smallImg = createSampleMapImage({ width: 200, height: 150 });
    const pSmall = newProject(smallImg, 'Small', '2026-09-24T12:00:00.000Z');
    // 200 / 80 = 2.5 -> 3, clamped to 6
    expect(pSmall.autoTrace.gapPx).toBe(6);

    const hugeImg = createSampleMapImage({ width: 12000, height: 15000 });
    const pHuge = newProject(hugeImg, 'Huge', '2026-09-24T12:00:00.000Z');
    // 15000 / 80 = 188, clamped to 120
    expect(pHuge.autoTrace.gapPx).toBe(120);
  });
});

describe('serializeProject & deserializeProject round-trip', () => {
  test('round-trips project and original image data exactly', () => {
    const img = createSampleMapImage({
      attribution: 'Imagery: USDA NAIP via USGS The National Map',
      acquisitionYear: 2024,
    });
    const proj: Project = {
      version: PROJECT_VERSION,
      name: 'Full Round Trip',
      image: img,
      anchors: [
        { id: 'a1', px: [100, 200], ll: [45.123, -71.456], source: 'paste' },
        { id: 'a2', px: [300, 400], ll: null, source: 'basemap' },
      ],
      fitMethod: 'affine',
      features: [
        {
          id: 'f1',
          name: 'Main Trail',
          color: DEFAULT_COLORS.trail,
          notes: 'Test trail note',
          kind: 'trail',
          pts: [
            [10, 20],
            [30, 40],
            [50, 60],
          ],
          ink: [217, 72, 15],
        },
        {
          id: 'f2',
          name: 'Campground',
          color: DEFAULT_COLORS.area,
          notes: 'Tent sites',
          kind: 'area',
          pts: [
            [100, 100],
            [200, 100],
            [150, 200],
          ],
        },
        {
          id: 'f3',
          name: 'Peak View',
          color: DEFAULT_COLORS.poi,
          notes: 'Summit marker',
          kind: 'poi',
          at: [500, 600],
          poiType: 'Viewpoint',
        },
      ],
      units: 'km',
      trace: {
        smartFollow: false,
        tolerance: 45,
        ink: [10, 20, 30],
      },
      autoTrace: {
        chips: [
          {
            id: 'c1',
            rgb: [255, 0, 0],
            name: 'Red',
            enabled: true,
            share: 0.05,
            named: true,
          },
        ],
        gapPx: 18,
        minLengthPct: 5,
      },
      seq: 10,
      updatedAt: '2026-09-24T12:30:00.000Z',
    };

    const storedImage: StoredImage = {
      bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]),
      mimeType: 'image/png',
    };

    const zipBytes = serializeProject(proj, storedImage);
    expect(zipBytes).toBeInstanceOf(Uint8Array);
    expect(zipBytes.length).toBeGreaterThan(0);

    const restored = deserializeProject(zipBytes);
    expect(restored).toEqual({
      project: proj,
      image: storedImage,
    });
  });

  test('round-trips directed trail routes (one-way and loop) in v4', () => {
    const img = createSampleMapImage();
    const proj: Project = {
      version: PROJECT_VERSION,
      name: 'Directed Routes',
      image: img,
      anchors: [],
      fitMethod: 'auto',
      features: [
        {
          id: 'f1',
          name: 'One-Way Trail',
          color: DEFAULT_COLORS.trail,
          notes: '',
          kind: 'trail',
          pts: [
            [0, 0],
            [10, 10],
          ],
          ink: null,
          route: { kind: 'one-way' },
        },
        {
          id: 'f2',
          name: 'Loop Trail',
          color: DEFAULT_COLORS.trail,
          notes: '',
          kind: 'trail',
          pts: [
            [0, 0],
            [10, 0],
            [10, 10],
            [0, 0],
          ],
          ink: null,
          route: { kind: 'loop', direction: 'clockwise' },
        },
      ],
      units: 'mi',
      trace: { smartFollow: true, tolerance: 60, ink: null },
      autoTrace: { chips: [], gapPx: 10, minLengthPct: 4 },
      seq: 3,
      updatedAt: '2026-10-05T12:00:00.000Z',
    };
    const zip = serializeProject(proj, { bytes: new Uint8Array([1, 2, 3]), mimeType: 'image/png' });
    const { project } = deserializeProject(zip);
    expect(project.version).toBe(4);
    expect(project.features).toEqual(proj.features);
  });

  test('round-trips an embedded tile bundle alongside the overview image', async () => {
    const image = createSampleMapImage({
      source: {
        kind: 'tiles',
        sourceId: 'martin-county',
        z: 20,
        tileSize: 256,
        origin: { x: 1000, y: 2000 },
        boundary: [[27.1, -80.2], [27.2, -80.2], [27.2, -80.1]],
        tileCount: 1,
      },
    });
    const project = newProject(image, 'Tiled map', '2026-10-04T00:00:00.000Z');
    const tile = { level: 0, col: 0, row: 0, bytes: new Uint8Array([9, 8, 7]), mimeType: 'image/jpeg' };
    const detailTile = {
      level: -1,
      col: 1,
      row: 2,
      bytes: new Uint8Array([6, 5, 4]),
      mimeType: 'image/jpeg',
    };
    const archive = serializeProject(
      project,
      { bytes: new Uint8Array([1, 2]), mimeType: 'image/jpeg' },
      undefined,
      [tile, detailTile],
    );
    const restored = deserializeProject(archive);
    expect(restored.tiles).toHaveLength(2);
    expect(restored.tiles).toEqual(expect.arrayContaining([tile, detailTile]));
    expect(restored.project.image.source.kind).toBe('tiles');
    const asyncArchive = await serializeProjectAsync(
      project,
      { bytes: new Uint8Array([1, 2]), mimeType: 'image/jpeg' },
      undefined,
      [tile, detailTile],
    );
    const asyncRestored = await deserializeProjectAsync(asyncArchive);
    expect(asyncRestored.tiles).toHaveLength(2);
    expect(asyncRestored.tiles).toEqual(expect.arrayContaining([tile, detailTile]));
    const overviewOnly = deserializeProject(
      serializeProject(project, { bytes: new Uint8Array([1, 2]), mimeType: 'image/jpeg' }),
    );
    expect(overviewOnly.tiles).toBeUndefined();
  });

  test('round-trips with JPEG and WebP images', () => {
    const imgJpg = createSampleMapImage({
      source: { kind: 'image', mimeType: 'image/jpeg' },
    });
    const projJpg = newProject(imgJpg, 'Jpg Project', '2026-09-24T12:00:00.000Z');
    const storedJpg: StoredImage = {
      bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 10, 20]),
      mimeType: 'image/jpeg',
    };
    const restoredJpg = deserializeProject(serializeProject(projJpg, storedJpg));
    expect(restoredJpg.image.mimeType).toBe('image/jpeg');
    expect(restoredJpg.image.bytes).toEqual(storedJpg.bytes);

    const imgWebp = createSampleMapImage({
      source: { kind: 'image', mimeType: 'image/webp' },
    });
    const projWebp = newProject(imgWebp, 'Webp Project', '2026-09-24T12:00:00.000Z');
    const storedWebp: StoredImage = {
      bytes: new Uint8Array([0x52, 0x49, 0x46, 0x46, 30, 40]),
      mimeType: 'image/webp',
    };
    const restoredWebp = deserializeProject(serializeProject(projWebp, storedWebp));
    expect(restoredWebp.image.mimeType).toBe('image/webp');
  });

  test('round-trips with PDF source map', () => {
    const imgPdf = createSampleMapImage({
      source: { kind: 'pdf', page: 2, pageCount: 5, renderScale: 2.5 },
    });
    const projPdf = newProject(imgPdf, 'PDF Project', '2026-09-24T12:00:00.000Z');
    const storedPdf: StoredImage = {
      bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46, 1, 2, 3]),
      mimeType: 'application/pdf',
    };
    const restoredPdf = deserializeProject(serializeProject(projPdf, storedPdf));
    expect(restoredPdf.image.mimeType).toBe('application/pdf');
    expect(restoredPdf.project.image.source).toEqual({
      kind: 'pdf',
      page: 2,
      pageCount: 5,
      renderScale: 2.5,
    });
  });

  test('round-trips with optional imported.gpx bytes in .trailmaker archive (card T-312)', () => {
    const img = createSampleMapImage();
    const proj = newProject(img, 'GPX Project', '2026-09-24T12:00:00.000Z');
    const stored: StoredImage = {
      bytes: new Uint8Array([1, 2, 3]),
      mimeType: 'image/png',
    };
    const gpxText = '<gpx version="1.1"><wpt lat="38.5" lon="-78.3"><name>W1</name></wpt></gpx>';
    const gpxBytes = new TextEncoder().encode(gpxText);

    const zip = serializeProject(proj, stored, gpxBytes);
    const restored = deserializeProject(zip);

    expect(restored.project.name).toBe('GPX Project');
    expect(restored.gpxBytes).toBeDefined();
    expect(new TextDecoder().decode(restored.gpxBytes)).toBe(gpxText);
  });

  test('stableStringify produces deterministic, alphabetically sorted keys', () => {
    const objA = { z: 1, a: 2, m: { y: 3, b: 4 } };
    const objB = { a: 2, m: { b: 4, y: 3 }, z: 1 };
    expect(stableStringify(objA)).toBe(stableStringify(objB));
    expect(stableStringify(objA)).toBe('{"a":2,"m":{"b":4,"y":3},"z":1}');
  });
});

describe('serializeProjectAsync & deserializeProjectAsync (card T-313)', () => {
  test('round-trips project and image asynchronously with identical data', async () => {
    const img = createSampleMapImage();
    const proj = newProject(img, 'Async Round Trip', '2026-09-27T12:00:00.000Z');
    const stored: StoredImage = {
      bytes: new Uint8Array([10, 20, 30, 40]),
      mimeType: 'image/png',
    };
    const gpxText = '<gpx version="1.1"><wpt lat="38.5" lon="-78.3"><name>W1</name></wpt></gpx>';
    const gpxBytes = new TextEncoder().encode(gpxText);

    const asyncZip = await serializeProjectAsync(proj, stored, gpxBytes);
    const syncZip = serializeProject(proj, stored, gpxBytes);

    // Both can be deserialized by both sync and async deserializers
    const restoredFromAsync = await deserializeProjectAsync(asyncZip);
    const restoredFromSync = deserializeProject(asyncZip);
    const restoredSyncFromAsync = await deserializeProjectAsync(syncZip);

    expect(restoredFromAsync.project.name).toBe('Async Round Trip');
    expect(restoredFromAsync.image.mimeType).toBe('image/png');
    expect(restoredFromAsync.image.bytes).toEqual(stored.bytes);
    expect(restoredFromAsync.gpxBytes).toEqual(gpxBytes);

    expect(restoredFromSync.project.name).toBe('Async Round Trip');
    expect(restoredSyncFromAsync.project.name).toBe('Async Round Trip');
  });

  test('round-trips with PDF source map asynchronously', async () => {
    const imgPdf = createSampleMapImage({
      source: { kind: 'pdf', page: 3, pageCount: 6, renderScale: 1.5 },
    });
    const projPdf = newProject(imgPdf, 'Async PDF Project', '2026-09-27T12:00:00.000Z');
    const storedPdf: StoredImage = {
      bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46, 9, 8, 7]),
      mimeType: 'application/pdf',
    };
    const zip = await serializeProjectAsync(projPdf, storedPdf);
    const restored = await deserializeProjectAsync(zip);
    expect(restored.image.mimeType).toBe('application/pdf');
    expect(restored.project.image.source).toEqual({
      kind: 'pdf',
      page: 3,
      pageCount: 6,
      renderScale: 1.5,
    });
  });

  test('rejects non-Uint8Array input and invalid zip in deserializeProjectAsync', async () => {
    // @ts-expect-error testing invalid argument
    await expect(deserializeProjectAsync('not-bytes')).rejects.toThrow(
      'Invalid Trailmaker project file: input must be a Uint8Array'
    );
    const garbage = new Uint8Array([1, 2, 3, 4]);
    await expect(deserializeProjectAsync(garbage)).rejects.toThrow('not a valid zip archive');
  });

  test('supports test seam injection via setProjectTestSeam', async () => {
    const img = createSampleMapImage();
    const proj = newProject(img, 'Seam Project', '2026-09-27T12:00:00.000Z');
    const stored: StoredImage = {
      bytes: new Uint8Array([1, 2]),
      mimeType: 'image/png',
    };

    const mockZipBytes = new Uint8Array([99, 100]);
    setProjectTestSeam({
      serializeAsync: async () => mockZipBytes,
      deserializeAsync: async () => ({
        project: proj,
        image: stored,
      }),
    });

    try {
      const zip = await serializeProjectAsync(proj, stored);
      expect(zip).toBe(mockZipBytes);

      const unzipped = await deserializeProjectAsync(zip);
      expect(unzipped.project.name).toBe('Seam Project');
    } finally {
      setProjectTestSeam(null);
    }

    expect(projectTestSeam.serializeAsync).toBeNull();
    expect(projectTestSeam.deserializeAsync).toBeNull();
  });
});

describe('deserializeProject rejection cases', () => {
  test('rejects non-Uint8Array input', () => {
    // @ts-expect-error testing invalid argument
    expect(() => deserializeProject('not-bytes')).toThrow(
      'Invalid Trailmaker project file: input must be a Uint8Array'
    );
  });

  test('rejects non-zip data with user-readable message', () => {
    const garbage = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(() => deserializeProject(garbage)).toThrow('not a valid zip archive');
  });

  test('rejects archive with missing project.json', () => {
    const zip = zipSync({
      'image.png': new Uint8Array([1, 2, 3]),
    });
    expect(() => deserializeProject(zip)).toThrow('missing project.json');
  });

  test('rejects archive with missing image', () => {
    const zip = zipSync({
      'project.json': new TextEncoder().encode(
        JSON.stringify(newProject(createSampleMapImage(), 'No Image', '2026-09-24T12:00:00.000Z'))
      ),
    });
    expect(() => deserializeProject(zip)).toThrow('missing map image');
  });

  test('rejects corrupted project.json with invalid JSON syntax', () => {
    const zip = zipSync({
      'project.json': new TextEncoder().encode('{ invalid json...'),
      'image.png': new Uint8Array([1, 2, 3]),
    });
    expect(() => deserializeProject(zip)).toThrow('project.json is not valid JSON');
  });

  test('rejects a newer version project with specified user-readable message', () => {
    const newerProject = {
      ...newProject(createSampleMapImage(), 'Newer Version', '2026-09-24T12:00:00.000Z'),
      version: 99,
    };
    const zip = zipSync({
      'project.json': new TextEncoder().encode(JSON.stringify(newerProject)),
      'image.png': new Uint8Array([1, 2, 3]),
    });
    expect(() => deserializeProject(zip)).toThrow('This project was made by a newer Trailmaker');
  });
});

describe('validateProject structural checks', () => {
  const validBase = () =>
    newProject(createSampleMapImage(), 'Valid Project', '2026-09-24T12:00:00.000Z');

  test('accepts valid project', () => {
    expect(() => validateProject(validBase())).not.toThrow();
  });

  test('rejects non-object root or missing version', () => {
    expect(() => validateProject(null)).toThrow('root must be an object');
    expect(() => validateProject({ ...validBase(), version: '1' })).toThrow(
      'version must be between 1'
    );
    expect(() => validateProject({ ...validBase(), version: 0 })).toThrow(
      'version must be between 1'
    );
    expect(() => validateProject({ ...validBase(), name: 123 })).toThrow('name must be a string');
  });

  test('rejects invalid image fields', () => {
    expect(() =>
      validateProject({ ...validBase(), image: { ...createSampleMapImage(), width: -10 } })
    ).toThrow('image.width must be a positive number');

    expect(() =>
      validateProject({ ...validMapImageProject(), image: { ...createSampleMapImage(), sha256: '' } })
    ).toThrow('image.sha256 must be a non-empty string');

    expect(() =>
      validateProject({ ...validBase(), image: { ...createSampleMapImage(), attribution: '' } })
    ).toThrow('image.attribution must be a non-empty string when present');
    expect(() =>
      validateProject({ ...validBase(), image: { ...createSampleMapImage(), acquisitionYear: 2024.5 } })
    ).toThrow('image.acquisitionYear must be a positive integer when present');

    expect(() =>
      validateProject({
        ...validBase(),
        image: {
          ...createSampleMapImage(),
          source: { kind: 'pdf', page: 0, pageCount: 2, renderScale: 1 },
        },
      })
    ).toThrow('image.source.page must be an integer >= 1');

    expect(() =>
      validateProject({
        ...validBase(),
        image: {
          ...createSampleMapImage(),
          source: { kind: 'unknown' },
        },
      })
    ).toThrow('unknown image.source.kind');
  });

  function validMapImageProject() {
    return validBase();
  }

  test('rejects invalid anchors', () => {
    expect(() =>
      validateProject({
        ...validBase(),
        anchors: [{ id: 'a1', px: [100, NaN], ll: null, source: 'paste' }],
      })
    ).toThrow('anchor[0].px must be a finite [x, y] pair');

    expect(() =>
      validateProject({
        ...validBase(),
        anchors: [{ id: 'a1', px: [100, 200], ll: [45, Infinity], source: 'paste' }],
      })
    ).toThrow('anchor[0].ll must be null or a finite [lat, lon] pair');

    expect(() =>
      validateProject({
        ...validBase(),
        anchors: [{ id: 'a1', px: [100, 200], ll: null, source: 'invalid' }],
      })
    ).toThrow("anchor[0].source must be 'paste' or 'basemap'");
  });

  test('rejects invalid features and non-finite pts', () => {
    // Trail with < 2 pts
    expect(() =>
      validateProject({
        ...validBase(),
        features: [
          {
            id: 'f1',
            name: 'Short trail',
            color: '#000',
            notes: '',
            kind: 'trail',
            pts: [[10, 20]],
            ink: null,
          },
        ],
      })
    ).toThrow('trail[0].pts must contain at least 2 points');

    // Trail with non-finite pt
    expect(() =>
      validateProject({
        ...validBase(),
        features: [
          {
            id: 'f1',
            name: 'NaN trail',
            color: '#000',
            notes: '',
            kind: 'trail',
            pts: [
              [10, 20],
              [NaN, 40],
            ],
            ink: null,
          },
        ],
      })
    ).toThrow('trail[0].pts[1] must be a finite [x, y] pair');

    // Area with < 3 pts
    expect(() =>
      validateProject({
        ...validBase(),
        features: [
          {
            id: 'f2',
            name: 'Short area',
            color: '#000',
            notes: '',
            kind: 'area',
            pts: [
              [10, 20],
              [30, 40],
            ],
          },
        ],
      })
    ).toThrow('area[0].pts must contain at least 3 points');

    // POI with invalid poiType
    expect(() =>
      validateProject({
        ...validBase(),
        features: [
          {
            id: 'f3',
            name: 'Bad POI',
            color: '#000',
            notes: '',
            kind: 'poi',
            at: [10, 20],
            poiType: 'NonExistentPoiType',
          },
        ],
      })
    ).toThrow('poi[0].poiType must be one of POI_TYPES');

    // Trail with invalid route kind
    expect(() =>
      validateProject({
        ...validBase(),
        features: [
          {
            id: 'f4',
            name: 'Bad Route',
            color: '#000',
            notes: '',
            kind: 'trail',
            pts: [
              [0, 0],
              [10, 10],
            ],
            ink: null,
            route: { kind: 'invalid' as unknown as 'one-way' },
          },
        ],
      })
    ).toThrow('unknown trail[0].route.kind "invalid"');

    // One-way trail that is closed
    expect(() =>
      validateProject({
        ...validBase(),
        features: [
          {
            id: 'f5',
            name: 'Closed One-way',
            color: '#000',
            notes: '',
            kind: 'trail',
            pts: [
              [0, 0],
              [10, 0],
              [10, 10],
              [0, 0],
            ],
            ink: null,
            route: { kind: 'one-way' },
          },
        ],
      })
    ).toThrow('trail[0] has one-way route but is closed or degenerate');

    // Loop trail that is open
    expect(() =>
      validateProject({
        ...validBase(),
        features: [
          {
            id: 'f6',
            name: 'Open Loop',
            color: '#000',
            notes: '',
            kind: 'trail',
            pts: [
              [0, 0],
              [10, 0],
              [10, 10],
            ],
            ink: null,
            route: { kind: 'loop', direction: 'clockwise' },
          },
        ],
      })
    ).toThrow('trail[0] loop must be closed with at least 3 distinct vertices');

    // Loop trail with invalid direction
    expect(() =>
      validateProject({
        ...validBase(),
        features: [
          {
            id: 'f7',
            name: 'Bad Dir Loop',
            color: '#000',
            notes: '',
            kind: 'trail',
            pts: [
              [0, 0],
              [10, 0],
              [10, 10],
              [0, 0],
            ],
            ink: null,
            route: { kind: 'loop', direction: 'sideways' as unknown as 'clockwise' },
          },
        ],
      })
    ).toThrow("trail[0].route.direction must be 'clockwise' or 'counterclockwise'");

    // Loop trail with mismatched winding (geometry is clockwise, direction says counterclockwise)
    expect(() =>
      validateProject({
        ...validBase(),
        features: [
          {
            id: 'f8',
            name: 'Mismatched Winding Loop',
            color: '#000',
            notes: '',
            kind: 'trail',
            pts: [
              [0, 0],
              [10, 0],
              [10, 10],
              [0, 0],
            ],
            ink: null,
            route: { kind: 'loop', direction: 'counterclockwise' },
          },
        ],
      })
    ).toThrow('trail[0] loop direction is counterclockwise but geometry winding is clockwise');

    // Loop trail with collinear / zero area
    expect(() =>
      validateProject({
        ...validBase(),
        features: [
          {
            id: 'f9',
            name: 'Collinear Loop',
            color: '#000',
            notes: '',
            kind: 'trail',
            pts: [
              [0, 0],
              [5, 5],
              [10, 10],
              [0, 0],
            ],
            ink: null,
            route: { kind: 'loop', direction: 'clockwise' },
          },
        ],
      })
    ).toThrow('trail[0] loop must have non-zero signed area');
  });

  test('rejects invalid fitMethod, units, seq, trace and autoTrace', () => {
    expect(() => validateProject({ ...validBase(), fitMethod: 'unknown' })).toThrow(
      'invalid fitMethod'
    );
    expect(() => validateProject({ ...validBase(), units: 'meters' })).toThrow("units must be 'mi' or 'km'");
    expect(() => validateProject({ ...validBase(), seq: 0 })).toThrow('seq must be an integer >= 1');
    expect(() =>
      validateProject({ ...validBase(), trace: { smartFollow: 'true', tolerance: 60, ink: null } })
    ).toThrow('trace.smartFollow must be a boolean');
    expect(() =>
      validateProject({ ...validBase(), autoTrace: { chips: [], gapPx: -5, minLengthPct: 4 } })
    ).toThrow('autoTrace.gapPx must be a non-negative number');
    expect(() =>
      validateProject({ ...validBase(), updatedAt: '' })
    ).toThrow('updatedAt must be a non-empty string');
  });
});

describe('migrateProject', () => {
  test('v1 project runs identity migration and succeeds validation', () => {
    const p = newProject(createSampleMapImage(), 'V1 Project', '2026-09-24T12:00:00.000Z');
    const migrated = migrateProject(p);
    expect(migrated).toEqual(p);
  });

  test('v2 project data migrates sequentially through v3 to version 4 and preserves existing fields', () => {
    const p3 = newProject(createSampleMapImage(), 'V2 Project', '2026-09-24T12:00:00.000Z');
    const rawV2 = { ...p3, version: 2 };
    const migrated = migrateProject(rawV2);
    expect(migrated.version).toBe(4);
    expect(migrated.name).toBe('V2 Project');
    expect(migrated.image).toEqual(p3.image);
    expect(migrated.anchors).toEqual(p3.anchors);
    expect(migrated.features).toEqual(p3.features);
    expect(migrated.fitMethod).toBe(p3.fitMethod);
    expect(migrated.trace).toEqual(p3.trace);
  });

  test('v3 project data migrates to version 4 and strips unknown route data from pre-v4 input', () => {
    const p = newProject(createSampleMapImage(), 'V3 Project', '2026-09-24T12:00:00.000Z');
    const rawV3 = {
      ...p,
      version: 3,
      features: [
        {
          id: 'f1',
          kind: 'trail',
          name: 'Old Trail',
          color: '#333333',
          notes: '',
          pts: [
            [0, 0],
            [10, 10],
          ],
          ink: null,
          route: { kind: 'unknown-future-data' },
        },
      ],
    };
    const migrated = migrateProject(rawV3);
    expect(migrated.version).toBe(4);
    expect(migrated.name).toBe('V3 Project');
    const trail = migrated.features[0]!;
    expect(trail.kind).toBe('trail');
    if (trail.kind === 'trail') {
      expect(trail.route).toBeUndefined();
    }
  });

  test('v1 project data migrates sequentially through v2 and v3 to version 4', () => {
    const p2 = newProject(createSampleMapImage(), 'V1 Project', '2026-09-24T12:00:00.000Z');
    const rawV1 = { ...p2, version: 1 };
    const migrated = migrateProject(rawV1);
    expect(migrated.version).toBe(4);
    expect(migrated.name).toBe('V1 Project');
    expect(migrated.anchors).toEqual(p2.anchors);
    expect(migrated.features).toEqual(p2.features);
  });

  test('a v1 .trailmaker zip archive opens in the v4 build with version migrated to 4', () => {
    const p2 = newProject(createSampleMapImage(), 'Legacy V1 Zip', '2026-09-24T12:00:00.000Z');
    const v1Json = JSON.stringify({ ...p2, version: 1 });
    const v1Zip = zipSync({
      'project.json': new TextEncoder().encode(v1Json),
      'image.png': new Uint8Array([1, 2, 3]),
    });
    const { project } = deserializeProject(v1Zip);
    expect(project.version).toBe(4);
    expect(project.name).toBe('Legacy V1 Zip');
  });

  test('saving any project, including one opened from v1, writes version 4', () => {
    const p2 = newProject(createSampleMapImage(), 'V1 To Resave', '2026-09-24T12:00:00.000Z');
    const v1Json = JSON.stringify({ ...p2, version: 1 });
    const v1Zip = zipSync({
      'project.json': new TextEncoder().encode(v1Json),
      'image.png': new Uint8Array([1, 2, 3]),
    });
    const opened = deserializeProject(v1Zip);
    expect(opened.project.version).toBe(4);

    const resavedZip = serializeProject(opened.project, opened.image);
    const unzipped = deserializeProject(resavedZip);
    expect(unzipped.project.version).toBe(4);
    expect(unzipped.project.name).toBe('V1 To Resave');
  });

  test('a v2 file fed to a v1-only registry gets the "made by a newer Trailmaker" error', () => {
    resetMigrations(true);
    try {
      const v3Proj = newProject(createSampleMapImage(), 'V2 Proj', '2026-09-24T12:00:00.000Z');
      const v2Proj = { ...v3Proj, version: 2 };
      const v2Zip = zipSync({
        'project.json': new TextEncoder().encode(JSON.stringify(v2Proj)),
        'image.png': new Uint8Array([1, 2, 3]),
      });

      // Feeding v2 zip to v1 registry (maxVersion 1) throws newer Trailmaker error
      expect(() => deserializeProject(v2Zip, 1)).toThrow(
        'This project was made by a newer Trailmaker (version 2, latest supported: 1).'
      );

      // Feeding v2 json to v1 registry (maxVersion 1) throws newer Trailmaker error
      expect(() => migrateProject(v2Proj, 1)).toThrow(
        'This project was made by a newer Trailmaker (version 2, latest supported: 1).'
      );
    } finally {
      resetMigrations();
    }
  });

  test('runs migration steps sequentially and in order', () => {
    resetMigrations(true);
    try {
      const order: string[] = [];

      registerMigration(1, (raw) => {
        order.push('step1');
        return {
          ...raw,
          version: 2,
          step1Done: true,
        };
      });

      registerMigration(2, (raw) => {
        order.push('step2');
        return {
          ...raw,
          version: 3,
          step2Done: true,
        };
      });

      const p = {
        ...newProject(createSampleMapImage(), 'Migrating Project', '2026-09-24T12:00:00.000Z'),
        version: 1,
      };
      const migrated = migrateProject(p) as unknown as Record<string, unknown>;

      expect(order).toEqual(['step1', 'step2']);
      expect(migrated.version).toBe(3);
      expect(migrated.step1Done).toBe(true);
      expect(migrated.step2Done).toBe(true);
    } finally {
      resetMigrations();
    }
  });

  test('rejects version higher than max supported version', () => {
    resetMigrations();
    expect(() => migrateProject({ version: 5 })).toThrow(
      'This project was made by a newer Trailmaker'
    );
  });

  test('rejects invalid version numbers', () => {
    expect(() => migrateProject({})).toThrow('missing or invalid version number');
    expect(() => migrateProject({ version: 0 })).toThrow('unsupported version 0');
  });
});

describe('importPrototypeJson', () => {
  test('imports checked-in prototype sample file accurately', async () => {
    const fixturePath = resolve(__dirname, 'prototype-sample.json');
    const jsonText = readFileSync(fixturePath, 'utf8');

    const { project, image } = await importPrototypeJson(jsonText);

    expect(project.version).toBe(PROJECT_VERSION);
    expect(project.name).toBe('Bear Mountain Trail Map');
    expect(project.units).toBe('mi');
    expect(project.fitMethod).toBe('affine');
    expect(project.seq).toBe(42);

    // MapImage
    expect(project.image.width).toBe(3200);
    expect(project.image.height).toBe(2400);
    expect(project.image.originalWidth).toBe(3200);
    expect(project.image.originalHeight).toBe(2400);
    expect(project.image.source).toEqual({ kind: 'image', mimeType: 'image/png' });
    expect(project.image.sha256).toBe(
      'c414cd0e204de974f73753c7e28d7638e7b3691bb8b1a2bab6b25bb7fed7ce77'
    );

    // Anchors
    expect(project.anchors).toHaveLength(4);
    expect(project.anchors[0]).toEqual({
      id: 'g1',
      px: [120, 240],
      ll: [41.312, -74.005],
      source: 'paste',
    });
    // NaN / null coordinates map to null
    expect(project.anchors[2]?.ll).toBeNull();
    expect(project.anchors[3]?.ll).toBeNull();

    // Features
    expect(project.features).toHaveLength(4);
    const [trail, poiKnown, poiUnknown, area] = project.features;
    expect(trail?.kind).toBe('trail');
    if (trail?.kind === 'trail') {
      expect(trail.name).toBe('Appalachian Trail');
      expect(trail.notes).toBe('Rocky section');
      expect(trail.pts).toEqual([
        [120, 240],
        [130, 255],
        [145, 270],
      ]);
      expect(trail.ink).toEqual([217, 72, 15]);
    }

    expect(poiKnown?.kind).toBe('poi');
    if (poiKnown?.kind === 'poi') {
      expect(poiKnown.poiType).toBe('Parking');
      expect(poiKnown.at).toEqual([120, 240]);
    }

    expect(poiUnknown?.kind).toBe('poi');
    if (poiUnknown?.kind === 'poi') {
      // Unknown sym maps to Waypoint
      expect(poiUnknown.poiType).toBe('Waypoint');
    }

    expect(area?.kind).toBe('area');
    if (area?.kind === 'area') {
      expect(area.pts).toEqual([
        [400, 400],
        [500, 400],
        [450, 500],
      ]);
    }

    // Chips
    expect(project.autoTrace.chips).toHaveLength(2);
    expect(project.autoTrace.chips[0]).toEqual({
      id: 'c1',
      rgb: [217, 72, 15],
      name: 'Red Blazes',
      enabled: true,
      share: 0.042,
      named: true, // fromLegend: true -> named: true
    });
    expect(project.autoTrace.chips[1]).toEqual({
      id: 'c2',
      rgb: [31, 111, 178],
      name: 'Blue Blazes',
      enabled: false,
      share: null,
      named: false, // fromLegend: false -> named: false
    });

    // Settings
    expect(project.trace.tolerance).toBe(45);
    expect(project.trace.smartFollow).toBe(true);
    expect(project.autoTrace.gapPx).toBe(30);
    expect(project.autoTrace.minLengthPct).toBe(5);

    // StoredImage
    expect(image.mimeType).toBe('image/png');
    expect(image.bytes.length).toBeGreaterThan(0);
  });

  test('rejects non-Trailmaker JSON', async () => {
    await expect(importPrototypeJson('not json')).rejects.toThrow(
      "That JSON file isn't a Trailmaker project."
    );
    await expect(importPrototypeJson('{"app":"other"}')).rejects.toThrow(
      "That JSON file isn't a Trailmaker project."
    );
    await expect(importPrototypeJson('{"app":"trailmaker"}')).rejects.toThrow(
      "That JSON file isn't a Trailmaker project."
    );
    await expect(
      importPrototypeJson('{"app":"trailmaker","image":"not-data-url"}')
    ).rejects.toThrow('invalid image data URL');
  });

  test('importPrototypeJson handles fallback branches and edge cases', async () => {
    // Non-string raw.image
    await expect(
      importPrototypeJson(JSON.stringify({ app: 'trailmaker', image: 12345 }))
    ).rejects.toThrow('missing image data');

    // Missing meta fields, invalid chip rgb, incomplete features, missing savedAt
    const minimalPrototypeJson = JSON.stringify({
      app: 'trailmaker',
      image:
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      meta: {
        features: [
          // Trail with < 2 valid points -> filtered out
          { id: 'f_bad_trail', type: 'trail', pts: [[10, 20]] },
          // Area with < 3 valid points -> filtered out
          { id: 'f_bad_area', type: 'area', pts: [[10, 20], [30, 40]] },
          // Point with empty pts -> fallback [0, 0]
          { id: 'f_empty_pt', type: 'point', pts: [] },
        ],
        chips: [
          // Invalid rgb -> fallback [0, 0, 0]
          { id: 'c_bad_rgb', rgb: [255], on: true },
        ],
      },
    });

    const { project } = await importPrototypeJson(minimalPrototypeJson);
    expect(project.seq).toBe(1);
    expect(project.features).toHaveLength(1);
    const [firstFeat] = project.features;
    expect(firstFeat?.kind).toBe('poi');
    if (firstFeat?.kind === 'poi') {
      expect(firstFeat.at).toEqual([0, 0]);
    }
    expect(project.autoTrace.chips[0]?.rgb).toEqual([0, 0, 0]);
  });
});

describe('serializeProject validation', () => {
  test('rejects non-Uint8Array image bytes', () => {
    const proj = newProject(createSampleMapImage(), 'Proj', '2026-09-24T12:00:00.000Z');
    expect(() =>
      // @ts-expect-error testing invalid bytes
      serializeProject(proj, { bytes: 'not-bytes', mimeType: 'image/png' })
    ).toThrow('image bytes must be a Uint8Array');
  });
});

describe('MIME type and extension utilities', () => {
  test('extFromMimeType handles common types and fallbacks', () => {
    expect(extFromMimeType('image/png')).toBe('png');
    expect(extFromMimeType('image/jpeg')).toBe('jpg');
    expect(extFromMimeType('image/jpg')).toBe('jpg');
    expect(extFromMimeType('image/webp')).toBe('webp');
    expect(extFromMimeType('application/pdf')).toBe('pdf');
    expect(extFromMimeType('image/tiff')).toBe('tiff');
    expect(extFromMimeType('image/x-custom')).toBe('custom');
    expect(extFromMimeType('unknown')).toBe('bin');
  });

  test('mimeTypeFromExt handles common extensions and fallback', () => {
    expect(mimeTypeFromExt('png')).toBe('image/png');
    expect(mimeTypeFromExt('jpg')).toBe('image/jpeg');
    expect(mimeTypeFromExt('jpeg')).toBe('image/jpeg');
    expect(mimeTypeFromExt('webp')).toBe('image/webp');
    expect(mimeTypeFromExt('pdf')).toBe('application/pdf');
    expect(mimeTypeFromExt('unknown')).toBe('application/octet-stream');
  });
});

describe('additional structural validation edge cases', () => {
  const validBase = () =>
    newProject(createSampleMapImage(), 'Valid Project', '2026-09-24T12:00:00.000Z');

  test('rejects image with empty fileName, non-positive heights/widths, or missing source', () => {
    expect(() =>
      validateProject({ ...validBase(), image: { ...createSampleMapImage(), fileName: '' } })
    ).toThrow('image.fileName must be a non-empty string');

    expect(() =>
      validateProject({ ...validBase(), image: { ...createSampleMapImage(), height: 0 } })
    ).toThrow('image.height must be a positive number');

    expect(() =>
      validateProject({ ...validBase(), image: { ...createSampleMapImage(), originalWidth: 0 } })
    ).toThrow('image.originalWidth must be a positive number');

    expect(() =>
      validateProject({ ...validBase(), image: { ...createSampleMapImage(), originalHeight: -1 } })
    ).toThrow('image.originalHeight must be a positive number');

    expect(() =>
      validateProject({
        ...validBase(),
        image: { ...createSampleMapImage(), source: null },
      })
    ).toThrow('image.source must be an object');

    expect(() =>
      validateProject({
        ...validBase(),
        image: { ...createSampleMapImage(), source: { kind: 'image', mimeType: '' } },
      })
    ).toThrow('image.source.mimeType must be a non-empty string');

    expect(() =>
      validateProject({
        ...validBase(),
        image: {
          ...createSampleMapImage(),
          source: { kind: 'pdf', page: 1, pageCount: 0, renderScale: 1 },
        },
      })
    ).toThrow('image.source.pageCount must be an integer >= 1');

    expect(() =>
      validateProject({
        ...validBase(),
        image: {
          ...createSampleMapImage(),
          source: { kind: 'pdf', page: 1, pageCount: 2, renderScale: 0 },
        },
      })
    ).toThrow('image.source.renderScale must be a positive number');
  });

  test('rejects invalid anchor objects or missing fields', () => {
    expect(() =>
      validateProject({
        ...validBase(),
        anchors: ['not-an-object'],
      })
    ).toThrow('anchor[0] must be an object');

    expect(() =>
      validateProject({
        ...validBase(),
        anchors: [{ id: '', px: [0, 0], ll: null, source: 'paste' }],
      })
    ).toThrow('anchor[0].id must be a non-empty string');
  });

  test('rejects non-array anchors or features', () => {
    expect(() =>
      validateProject({
        ...validBase(),
        anchors: null,
      })
    ).toThrow('anchors must be an array');

    expect(() =>
      validateProject({
        ...validBase(),
        features: null,
      })
    ).toThrow('features must be an array');
  });

  test('rejects invalid feature objects and ink/poi/area edge cases', () => {
    expect(() =>
      validateProject({
        ...validBase(),
        features: ['not-an-object'],
      })
    ).toThrow('feature[0] must be an object');

    expect(() =>
      validateProject({
        ...validBase(),
        features: [
          {
            id: '',
            name: 'F1',
            color: '#000',
            notes: '',
            kind: 'trail',
            pts: [
              [0, 0],
              [1, 1],
            ],
            ink: null,
          },
        ],
      })
    ).toThrow('feature[0].id must be a non-empty string');

    expect(() =>
      validateProject({
        ...validBase(),
        features: [
          {
            id: 'f1',
            name: 123,
            color: '#000',
            notes: '',
            kind: 'trail',
            pts: [
              [0, 0],
              [1, 1],
            ],
            ink: null,
          },
        ],
      })
    ).toThrow('feature[0].name must be a string');

    expect(() =>
      validateProject({
        ...validBase(),
        features: [
          {
            id: 'f1',
            name: 'Trail',
            color: null,
            notes: '',
            kind: 'trail',
            pts: [
              [0, 0],
              [1, 1],
            ],
            ink: null,
          },
        ],
      })
    ).toThrow('feature[0].color must be a string');

    expect(() =>
      validateProject({
        ...validBase(),
        features: [
          {
            id: 'f1',
            name: 'Trail',
            color: '#000',
            notes: null,
            kind: 'trail',
            pts: [
              [0, 0],
              [1, 1],
            ],
            ink: null,
          },
        ],
      })
    ).toThrow('feature[0].notes must be a string');

    expect(() =>
      validateProject({
        ...validBase(),
        features: [
          {
            id: 'f1',
            name: 'Mystery',
            color: '#000',
            notes: '',
            kind: 'mystery',
          },
        ],
      })
    ).toThrow('unknown feature[0].kind');

    expect(() =>
      validateProject({
        ...validBase(),
        features: [
          {
            id: 'f1',
            name: 'Trail',
            color: '#000',
            notes: '',
            kind: 'trail',
            pts: [
              [0, 0],
              [1, 1],
            ],
            ink: [255, 0],
          },
        ],
      })
    ).toThrow('trail[0].ink must be null or an RGB triplet');

    expect(() =>
      validateProject({
        ...validBase(),
        features: [
          {
            id: 'f1',
            name: 'Poi',
            color: '#000',
            notes: '',
            kind: 'poi',
            at: [10],
            poiType: 'Trailhead',
          },
        ],
      })
    ).toThrow('poi[0].at must be a finite [x, y] pair');

    expect(() =>
      validateProject({
        ...validBase(),
        features: [
          {
            id: 'f1',
            name: 'Area',
            color: '#000',
            notes: '',
            kind: 'area',
            pts: [
              [1, 2],
              [3, 4],
              [5],
            ],
          },
        ],
      })
    ).toThrow('area[0].pts[2] must be a finite [x, y] pair');
  });

  test('rejects invalid trace and autoTrace objects and chip fields', () => {
    expect(() =>
      validateProject({
        ...validBase(),
        trace: null,
      })
    ).toThrow('trace must be an object');

    expect(() =>
      validateProject({
        ...validBase(),
        trace: { smartFollow: true, tolerance: NaN, ink: null },
      })
    ).toThrow('trace.tolerance must be a finite number');

    expect(() =>
      validateProject({
        ...validBase(),
        trace: { smartFollow: true, tolerance: 50, ink: [1, 2] },
      })
    ).toThrow('trace.ink must be null or an RGB triplet');

    expect(() =>
      validateProject({
        ...validBase(),
        autoTrace: null,
      })
    ).toThrow('autoTrace must be an object');

    expect(() =>
      validateProject({
        ...validBase(),
        autoTrace: { chips: null, gapPx: 10, minLengthPct: 4 },
      })
    ).toThrow('autoTrace.chips must be an array');

    expect(() =>
      validateProject({
        ...validBase(),
        autoTrace: {
          chips: ['not-an-object'],
          gapPx: 10,
          minLengthPct: 4,
        },
      })
    ).toThrow('autoTrace.chips[0] must be an object');

    expect(() =>
      validateProject({
        ...validBase(),
        autoTrace: {
          chips: [{ id: '', rgb: [0, 0, 0], name: 'c', enabled: true, share: null, named: false }],
          gapPx: 10,
          minLengthPct: 4,
        },
      })
    ).toThrow('autoTrace.chips[0].id must be a non-empty string');

    expect(() =>
      validateProject({
        ...validBase(),
        autoTrace: {
          chips: [{ id: 'c1', rgb: [0, 0], name: 'c', enabled: true, share: null, named: false }],
          gapPx: 10,
          minLengthPct: 4,
        },
      })
    ).toThrow('autoTrace.chips[0].rgb must be an RGB triplet');

    expect(() =>
      validateProject({
        ...validBase(),
        autoTrace: {
          chips: [
            { id: 'c1', rgb: [0, 0, 0], name: 123, enabled: true, share: null, named: false },
          ],
          gapPx: 10,
          minLengthPct: 4,
        },
      })
    ).toThrow('autoTrace.chips[0].name must be a string');

    expect(() =>
      validateProject({
        ...validBase(),
        autoTrace: {
          chips: [
            { id: 'c1', rgb: [0, 0, 0], name: 'c', enabled: 'yes', share: null, named: false },
          ],
          gapPx: 10,
          minLengthPct: 4,
        },
      })
    ).toThrow('autoTrace.chips[0].enabled must be a boolean');

    expect(() =>
      validateProject({
        ...validBase(),
        autoTrace: {
          chips: [
            { id: 'c1', rgb: [0, 0, 0], name: 'c', enabled: true, share: NaN, named: false },
          ],
          gapPx: 10,
          minLengthPct: 4,
        },
      })
    ).toThrow('autoTrace.chips[0].share must be null or a finite number');

    expect(() =>
      validateProject({
        ...validBase(),
        autoTrace: {
          chips: [
            { id: 'c1', rgb: [0, 0, 0], name: 'c', enabled: true, share: null, named: 'yes' },
          ],
          gapPx: 10,
          minLengthPct: 4,
        },
      })
    ).toThrow('autoTrace.chips[0].named must be a boolean');

    expect(() =>
      validateProject({
        ...validBase(),
        autoTrace: { chips: [], gapPx: 10, minLengthPct: -1 },
      })
    ).toThrow('autoTrace.minLengthPct must be a non-negative number');
  });
});
