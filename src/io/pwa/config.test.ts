import { describe, expect, it } from 'vitest';
import { createPwaManifest } from './config';

describe('PWA manifest base paths', () => {
  it('keeps the root build rooted at /', () => {
    const manifest = createPwaManifest('/');
    expect(manifest.start_url).toBe('/');
    expect(manifest.scope).toBe('/');
    expect(manifest.icons[0]?.src).toBe('/icons/icon-192.png');
  });

  it('places the install entry point and every icon under the configured subpath', () => {
    const manifest = createPwaManifest('/trailmaker-app/');
    expect(manifest.start_url).toBe('/trailmaker-app/');
    expect(manifest.scope).toBe('/trailmaker-app/');
    expect(manifest.icons.every((icon) => icon.src.startsWith('/trailmaker-app/'))).toBe(true);
  });
});
