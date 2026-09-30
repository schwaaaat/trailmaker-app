import { describe, expect, it } from 'vitest';
import { normalizeBaseUrl, withBaseUrl } from './base';

describe('PWA base URL helpers', () => {
  it('normalizes the base to an absolute path ending in a slash', () => {
    expect(normalizeBaseUrl('/')).toBe('/');
    expect(normalizeBaseUrl('/trailmaker-app')).toBe('/trailmaker-app/');
    expect(() => normalizeBaseUrl('trailmaker-app')).toThrow(/absolute path/);
  });

  it('joins app paths under the configured base', () => {
    expect(withBaseUrl('sw.js', '/')).toBe('/sw.js');
    expect(withBaseUrl('/icons/icon.svg', '/trailmaker-app/')).toBe(
      '/trailmaker-app/icons/icon.svg',
    );
  });
});
