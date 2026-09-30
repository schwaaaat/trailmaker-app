// Lane C. PWA configuration for vite-plugin-pwa (card T-310, D-023; T-323 base path).
import { normalizeBaseUrl, withBaseUrl } from './base';

export function createPwaManifest(baseUrl: string) {
  const base = normalizeBaseUrl(baseUrl);
  const asset = (path: string) => withBaseUrl(path, base);
  return {
    name: 'Trailmaker',
    short_name: 'Trailmaker',
    description: 'Turn park and trail maps into GPS files that work offline',
    start_url: base,
    scope: base,
    display: 'standalone' as const,
    orientation: 'any' as const,
    theme_color: '#24412f',
    background_color: '#18201b',
    icons: [
      {
        src: asset('icons/icon-192.png'),
        sizes: '192x192',
        type: 'image/png',
      },
      {
        src: asset('icons/icon-512.png'),
        sizes: '512x512',
        type: 'image/png',
      },
      {
        src: asset('icons/icon-maskable-192.png'),
        sizes: '192x192',
        type: 'image/png',
        purpose: 'maskable',
      },
      {
        src: asset('icons/icon-maskable-512.png'),
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
      {
        src: asset('apple-touch-icon.png'),
        sizes: '180x180',
        type: 'image/png',
      },
      {
        src: asset('icons/icon.svg'),
        sizes: 'any',
        type: 'image/svg+xml',
      },
    ],
  };
}

export const pwaManifest = createPwaManifest('/');

export const pwaConfig = {
  registerType: 'prompt' as const,
  injectRegister: 'script' as const,
  strategies: 'injectManifest' as const,
  srcDir: 'src/io/pwa',
  filename: 'sw.ts',
  manifest: pwaManifest,
  includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
  injectManifest: {
    globPatterns: ['**/*.{js,mjs,css,html,ico,png,svg,wasm,woff,woff2}'],
    maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
  },
};
