import { describe, expect, it } from 'vitest';
import { formatLatLon, parseLatLon } from './parse';
// @ts-expect-error Verbatim prototype is untyped and test-only.
import { parseLL } from './__prototype__/utilities.js';

describe('coordinate parsing', () => {
  const expected = [26.3683, -80.1289];
  const accepted = [
    '26.3683, -80.1289',
    '26.3683 -80.1289',
    '26.3683N 80.1289W',
    '80.1289W 26.3683N',
    '26.3683n, 80.1289w',
    'https://maps.google.com/maps/@26.3683,-80.1289,15z',
    'https://maps.google.com/?q=26.3683,-80.1289',
    'https://maps.google.com/?x=1&query=26.3683,-80.1289',
    'https://maps.google.com/?x=1&ll=26.3683,-80.1289',
    '26°22\'5.88"N 80°7\'44.04"W',
    '80º7′44.04″W 26º22′5.88″N',
    '26deg22’5.88”N, 80deg7’44.04”W',
    "26°22'5.88''N 80°7'44.04''W",
  ];
  for (const input of accepted) {
    it(`accepts ${input}`, () => {
      const actual = parseLatLon(input);
      expect(actual).not.toBeNull();
      expect(actual![0]).toBeCloseTo(expected[0]!, 6);
      expect(actual![1]).toBeCloseTo(expected[1]!, 6);
      expect(actual).toEqual(parseLL(input));
    });
  }
  for (const input of ['', 'garbage', '91, 0', '0, 181', 'NaN, 4', 'one 26 two -80']) {
    it(`rejects ${input}`, () => expect(parseLatLon(input)).toBeNull());
  }
  it('formats six decimals by default', () => {
    expect(formatLatLon([26.3683, -80.1289])).toBe('26.368300, -80.128900');
    expect(formatLatLon([26.3683, -80.1289], 2)).toBe('26.37, -80.13');
  });
});
