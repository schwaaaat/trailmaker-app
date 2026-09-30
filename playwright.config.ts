import { defineConfig, devices } from '@playwright/test';
// Keep this stable across Playwright's separate config evaluations for server and workers.
const port = Number(process.env.TRAILMAKER_E2E_PORT ?? 4175);
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: './tests/e2e',
  testIgnore: ['trace-worker.spec.ts', 'pwa-offline.spec.ts', 'pages.spec.ts'],
  fullyParallel: true,
  // Large image decode cases compete with worker timing tests when Chromium
  // launches several pages at once; keep the gate reproducible on one machine.
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: 'list',
  use: { baseURL, trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `pnpm dev --host 127.0.0.1 --port ${port} --strictPort`,
    url: baseURL,
    reuseExistingServer: false,
  },
});
