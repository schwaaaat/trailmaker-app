import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { createPwaManifest, pwaConfig } from './src/io/pwa/config';

const isolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig(({ mode }) => ({
  base: process.env.TRAILMAKER_BASE ?? '/',
  build: {
    rollupOptions: {
      input:
        mode === 'test'
          ? {
              app: resolve('index.html'),
              offlineBasemapHarness: resolve('tests/fixtures/basemap/harness.html'),
            }
          : resolve('index.html'),
    },
  },
  plugins: [
    react(),
    VitePWA({
      ...pwaConfig,
      manifest: createPwaManifest(process.env.TRAILMAKER_BASE ?? '/'),
    }),
    {
      name: 'exclude-test-reference-code',
      resolveId(source) {
        if (/[/\\]__(prototype|golden)__[/\\]/.test(source)) {
          throw new Error('Test reference code must not enter the application bundle');
        }
      },
    },
    {
      name: 'serve-image-loader-test-harness',
      configureServer(server) {
        server.middlewares.use('/test-image-loader.html', async (_request, response) => {
          response.setHeader('Content-Type', 'text/html; charset=utf-8');
          response.end(await readFile(resolve('tests/fixtures/test-image-loader.html'), 'utf8'));
        });
      },
    },
  ],
  server: {
    port: Number(process.env.PASEO_PORT) || 5173,
    strictPort: !!process.env.PASEO_PORT,
    ...(process.env.HOST ? { host: process.env.HOST } : {}),
    allowedHosts: ['.localhost'],
    headers: isolationHeaders,
  },
  preview: {
    headers: isolationHeaders,
  },
}));
