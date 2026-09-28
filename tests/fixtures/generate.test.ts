import { expect, test } from 'vitest';
import sharp from 'sharp';
import { PDFDocument } from 'pdf-lib';
import { fixtureNames, makeTruth, renderFixture } from './generate';
import { pixelToLatLon, warpPixel } from './truth';

test.each(fixtureNames)('%s has byte-identical seeded PNG, PDF and truth', async (name) => {
  const a = await renderFixture(name, 42);
  const b = await renderFixture(name, 42);
  expect(a.png.equals(b.png)).toBe(true);
  expect(Buffer.from(a.pdf).equals(Buffer.from(b.pdf))).toBe(true);
  expect(a.truth).toEqual(b.truth);
  expect(JSON.stringify(a.truth, null, 2)).toBe(JSON.stringify(b.truth, null, 2));
  expect(makeTruth(name, 43).polylines).not.toEqual(a.truth.polylines);
  expect((await PDFDocument.load(a.pdf)).getPageCount()).toBe(2);
  const meta = await sharp(a.png).metadata();
  expect([meta.width, meta.height]).toEqual([a.truth.width, a.truth.height]);
  expect(a.truth.anchors).toHaveLength(6);
  for (const anchor of a.truth.anchors)
    expect(anchor.ll).toEqual(pixelToLatLon(anchor.px, a.truth.transform));
});

test('sinusoidal warp has an independent exact inverse and preserves geography', () => {
  const affine = makeTruth('solid').transform;
  const warped = makeTruth('warped').transform;
  const px = [100, 150] as const;
  expect(warpPixel(px, warped)).toEqual([109, 150]);
  expect(pixelToLatLon(warpPixel(px, warped), warped)).toEqual(pixelToLatLon(px, affine));
});
