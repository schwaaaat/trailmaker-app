import type { TileLevel } from '../ui/contract';
import type { TileDownloadManifest } from './tile-store';
import type { PlannedMapTile } from './tiled-capture';

function plannedTileKey(tile: PlannedMapTile): string {
  return `${tile.z}/${tile.x}/${tile.y}`;
}

function matchesManifestPlan(
  tiles: readonly PlannedMapTile[],
  manifest: Pick<TileDownloadManifest, 'status' | 'tiles' | 'completedKeys' | 'missingKeys'>,
): boolean {
  if (manifest.status !== 'complete' || manifest.missingKeys.length > 0) return false;
  const expectedKeys = new Set(tiles.map(plannedTileKey));
  const manifestKeys = new Set(manifest.tiles.map(plannedTileKey));
  const completed = new Set(manifest.completedKeys);
  return (
    expectedKeys.size === manifestKeys.size &&
    [...expectedKeys].every((key) => manifestKeys.has(key) && completed.has(key))
  );
}

/** Requires every planned source tile and every generated overview tile before restoring full detail. */
export function hasCompleteTiledMapStorage(options: {
  readonly tiles: readonly PlannedMapTile[];
  readonly levels: readonly TileLevel[];
  readonly storedKeys: Iterable<string>;
  readonly overviewAvailable: boolean;
  readonly manifest?: Pick<
    TileDownloadManifest,
    'status' | 'tiles' | 'completedKeys' | 'missingKeys'
  >;
}): boolean {
  const { tiles, levels, storedKeys, overviewAvailable, manifest } = options;
  if (!overviewAvailable || !levels.length || !tiles.length) return false;
  if (manifest && !matchesManifestPlan(tiles, manifest)) return false;
  const stored = new Set(storedKeys);
  const required = new Set(tiles.map((tile) => `0/${tile.col}/${tile.row}`));
  for (const level of levels) {
    if (level.level <= 0) continue;
    for (let row = 0; row < level.rows; row++) {
      for (let col = 0; col < level.cols; col++) required.add(`${level.level}/${col}/${row}`);
    }
  }
  return [...required].every((key) => stored.has(key));
}
