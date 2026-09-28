import { defineConfig, devices } from '@playwright/test';
// Keep this stable across Playwright's separate config evaluations for server and workers.
const port = Number(process.env.TRAILMAKER_PREVIEW_PORT ?? 4176);
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: ['trace-worker.spec.ts', 'basemap.spec.ts', 'longtask-stress.spec.ts', 'pwa-offline.spec.ts'],
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: 'list',
  use: { baseURL, trace: 'retain-on-failure' },
  projects: [{ name: 'chromium-preview', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `pnpm exec vite build --mode test && pnpm preview --host 127.0.0.1 --port ${port} --strictPort`,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
