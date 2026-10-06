import { describe, expect, it } from 'vitest';
import type { Units } from '../types';
import { AREA, TAP, TRAIL, TRAILHEAD } from './__golden__/docs';
import { featureDescription, formatLength, normalizeColor, slugify, xmlEscape } from './format';

// The prototype's formulas, verbatim, as an independent oracle.
const protoFmtLen = (m: number, units: Units) =>
  units === 'mi'
    ? (m / 1609.344).toFixed(m < 1609 ? 2 : 1) + ' mi'
    : m < 1000
      ? Math.round(m) + ' m'
      : (m / 1000).toFixed(2) + ' km';
const protoSlug = (name: string) =>
  (name || 'park-map')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'park-map';

describe('formatLength', () => {
  it.each([
    [0, 'mi', '0.00 mi'],
    [675.9, 'mi', '0.42 mi'],
    [1608.9, 'mi', '1.00 mi'],
    [1609, 'mi', '1.0 mi'],
    [2092.1472, 'mi', '1.3 mi'],
    [48280.32, 'mi', '30.0 mi'],
    [0, 'km', '0 m'],
    [419.6, 'km', '420 m'],
    [999.4, 'km', '999 m'],
    [999.6, 'km', '1000 m'],
    [1000, 'km', '1.00 km'],
    [1250, 'km', '1.25 km'],
    [12345.6, 'km', '12.35 km'],
  ] as const)('%d m in %s -> %s', (m, units, text) => {
    expect(formatLength(m, units)).toBe(text);
  });

  it('matches the prototype across a sweep of lengths', () => {
    for (let m = 0; m < 60000; m += 7.37) {
      expect(formatLength(m, 'mi')).toBe(protoFmtLen(m, 'mi'));
      expect(formatLength(m, 'km')).toBe(protoFmtLen(m, 'km'));
    }
  });
});

describe('slugify', () => {
  it.each([
    ['Park map', 'park-map'],
    ['  Yosemite Valley!  ', 'yosemite-valley'],
    ['', 'park-map'],
    ['---', 'park-map'],
    ['A&B', 'a-b'],
    ['__x__', 'x'],
    ['Café Trails 2026', 'caf-trails-2026'],
    ['Mist Trail <&"\'>', 'mist-trail'],
  ])('%j -> %s', (name, slug) => {
    expect(slugify(name)).toBe(slug);
    expect(slugify(name)).toBe(protoSlug(name));
  });
});

describe('featureDescription', () => {
  it('joins notes and length/perimeter; POIs get notes only', () => {
    expect(featureDescription(TRAIL, 'mi')).toBe('Steep granite steps.\nBring water.\nLength: 0.77 mi');
    expect(featureDescription(AREA, 'km')).toBe('Perimeter: 845 m');
    expect(featureDescription(TRAILHEAD, 'mi')).toBe('Shuttle stop 16');
    expect(featureDescription(TAP, 'mi')).toBe('');
  });

  it('includes route classification and travel direction for classified trails', () => {
    const oneWayTrail = { ...TRAIL, route: { kind: 'one-way' as const } };
    expect(featureDescription(oneWayTrail, 'mi')).toBe(
      'Steep granite steps.\nBring water.\nRoute: One-way\nLength: 0.77 mi',
    );

    const loopTrailCw = {
      ...TRAIL,
      notes: '',
      route: { kind: 'loop' as const, direction: 'clockwise' as const },
    };
    expect(featureDescription(loopTrailCw, 'km')).toBe('Route: Loop (clockwise)\nLength: 1.23 km');

    const loopTrailCcw = {
      ...TRAIL,
      route: { kind: 'loop' as const, direction: 'counterclockwise' as const },
    };
    expect(featureDescription(loopTrailCcw, 'mi')).toBe(
      'Steep granite steps.\nBring water.\nRoute: Loop (counterclockwise)\nLength: 0.77 mi',
    );
  });
});

describe('xmlEscape', () => {
  it('escapes markup and drops characters XML 1.0 forbids', () => {
    expect(xmlEscape(`<a href="x">Tom's & Jerry's</a>`)).toBe(
      '&lt;a href=&quot;x&quot;&gt;Tom&apos;s &amp; Jerry&apos;s&lt;/a&gt;',
    );
    expect(xmlEscape('tab\tnl\ncr\r bell\u0007 nul\u0000 esc\u001b \u{1F97E} ￾')).toBe(
      'tab\tnl\ncr\r bell nul esc \u{1F97E} ',
    );
  });
});

describe('normalizeColor', () => {
  it('returns #RRGGBB upper-case, expanding #rgb and falling back when invalid', () => {
    expect(normalizeColor('#d9480f', '#000000')).toBe('#D9480F');
    expect(normalizeColor('#abc', '#000000')).toBe('#AABBCC');
    expect(normalizeColor('3a7d44', '#000000')).toBe('#3A7D44');
    expect(normalizeColor('red', '#1f6fb2')).toBe('#1F6FB2');
    expect(normalizeColor('', '#1F6FB2')).toBe('#1F6FB2');
  });
});
