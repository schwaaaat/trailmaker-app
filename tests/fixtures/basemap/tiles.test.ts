import { describe, expect, it } from 'vitest';
import { fixtureNames, makeTruth } from '../generate';
import { coversTile, fixtureTilePng, maxZoom, minZoom, tileXY } from './tiles';

describe('offline basemap tiles', () => {
  it('covers every synthetic fixture truth extent at zooms 10–16', () => {
    for (const name of fixtureNames) {
      const truth = makeTruth(name);
      const corners = [
        [0, 0],
        [truth.width, 0],
        [0, truth.height],
        [truth.width, truth.height],
      ] as const;
      for (let z = minZoom; z <= maxZoom; z++) {
        for (const [x, y] of corners) {
          const ll = [
            truth.transform.origin[0] - y / truth.transform.metersPerDegree[1],
            truth.transform.origin[1] + x / truth.transform.metersPerDegree[0],
          ] as const;
          const [tx, ty] = tileXY(ll[1], ll[0], z);
          expect(coversTile(z, tx, ty), `${name} at z${z}`).toBe(true);
        }
      }
    }
  });

  it('generates byte-identical coordinate-coded PNGs', async () => {
    const [x, y] = tileXY(-78.395, 38.597, 14);
    const first = await fixtureTilePng(14, x, y);
    expect((await fixtureTilePng(14, x, y)).equals(first)).toBe(true);
    expect(first.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    await expect(fixtureTilePng(9, x, y)).rejects.toThrow(RangeError);
  });
});
