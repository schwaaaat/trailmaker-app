import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { resolve } from 'node:path';
import { pwaConfig } from './src/io/pwa/config';

const isolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig(({ mode }) => ({
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
    VitePWA(pwaConfig),
    {
      name: 'exclude-test-reference-code',
      resolveId(source) {
        if (/[/\\]__(prototype|golden)__[/\\]/.test(source)) {
          throw new Error('Test reference code must not enter the application bundle');
        }
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
