import { DEFAULT_COLORS, newProject } from '../core/project';
import type { LatLon, MapImage, Project, Px } from '../core/types';
import type { TiledImagerySource } from './tile-service';
import type { TiledBoundaryPlan } from './tiled-capture';

function worldPixelToLatLon(x: number, y: number, z: number, tileSize: number): LatLon {
  const world = tileSize * 2 ** z;
  const lon = (x / world) * 360 - 180;
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / world))) * 180) / Math.PI;
  return [lat, lon];
}

function latLonToImagePx([lat, lon]: LatLon, plan: TiledBoundaryPlan): Px {
  const world = plan.tileSize * 2 ** plan.z;
  const x = ((lon + 180) / 360) * world;
  const sin = Math.sin((lat * Math.PI) / 180);
  const y = (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * world;
  return [x - plan.origin.x, y - plan.origin.y];
}

/** Adds nine exact map-space control points and the editable original park boundary. */
export function createProjectForTiledMap(
  image: MapImage,
  source: TiledImagerySource,
  plan: TiledBoundaryPlan,
  boundary: readonly LatLon[],
  now = new Date().toISOString(),
): Project {
  if (image.source.kind !== 'tiles') throw new Error('Expected a tiled map image.');
  const base = newProject(image, source.name, now);
  const xs = [0, image.width / 2, image.width];
  const ys = [0, image.height / 2, image.height];
  const anchors = ys.flatMap((y, row) =>
    xs.map((x, col) => ({
      id: `tile-anchor-${row * 3 + col + 1}`,
      px: [x, y] as Px,
      ll: worldPixelToLatLon(plan.origin.x + x, plan.origin.y + y, plan.z, plan.tileSize),
      source: 'basemap' as const,
    })),
  );
  return {
    ...base,
    anchors,
    features: [
      {
        id: 'park-boundary',
        name: 'Park boundary',
        color: DEFAULT_COLORS.area,
        notes: '',
        kind: 'area',
        pts: boundary.map((point) => latLonToImagePx(point, plan)),
      },
    ],
  };
}
