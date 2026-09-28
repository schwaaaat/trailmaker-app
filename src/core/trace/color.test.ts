import { describe, expect, it } from 'vitest';
import type { Rgb } from '../types';
import {
  colorDistance,
  featureColorForInk,
  hexToRgb,
  luminance,
  nameColor,
  rgbToHex,
  rgbToHsl,
} from './color';
// @ts-expect-error Verbatim prototype is untyped and test-only.
import * as prototype from '../geo/__prototype__/utilities.js';
const { nameColor: prototypeNameColor, rgbToHsl: prototypeHsl } = prototype;

describe('color characterization', () => {
  const names: [Rgb, string][] = [
    [[0, 0, 0], 'Black'],
    [[255, 255, 255], 'White'],
    [[120, 120, 120], 'Gray'],
    [[100, 70, 50], 'Brown'],
    [[160, 70, 0], 'Brown'],
    [[255, 0, 0], 'Red'],
    [[255, 140, 0], 'Orange'],
    [[255, 220, 0], 'Yellow'],
    [[0, 180, 0], 'Green'],
    [[0, 150, 170], 'Teal'],
    [[0, 0, 255], 'Blue'],
    [[180, 0, 255], 'Purple'],
    [[255, 0, 140], 'Pink'],
  ];
  for (const [rgb, expected] of names)
    it(`names ${rgb} as ${expected}`, () => {
      expect(nameColor(rgb)).toBe(expected);
      expect(nameColor(rgb)).toBe(prototypeNameColor(rgb));
      expect(rgbToHsl(rgb)).toEqual(prototypeHsl(rgb));
    });
  it('calculates Euclidean color distance and luminance', () => {
    expect(colorDistance([0, 0, 0], [3, 4, 12])).toBe(13);
    expect(luminance([255, 255, 255])).toBeCloseTo(1, 15);
    expect(featureColorForInk([25, 50, 75], '#123456')).toBe('#19324b');
    expect(featureColorForInk([255, 255, 255], '#123456')).toBe('#123456');
  });
  it('rounds and clamps hex channels, parses short and long forms', () => {
    expect(rgbToHex([255.4, -5, 128.6])).toBe('#ff0081');
    expect(hexToRgb('#abc')).toEqual([170, 187, 204]);
    expect(hexToRgb('Aa22ff')).toEqual([170, 34, 255]);
    expect(hexToRgb('#12xz34')).toBeNull();
    expect(hexToRgb('#abcd')).toBeNull();
  });
});
