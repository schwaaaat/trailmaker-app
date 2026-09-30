import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.TRAILMAKER_PAGES_PORT ?? 4177);
const baseURL = `http://127.0.0.1:${port}/trailmaker-app/`;

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: ['pages.spec.ts'],
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: 'list',
  use: { baseURL, trace: 'retain-on-failure' },
  projects: [{ name: 'chromium-pages', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `pnpm exec tsx tests/e2e/pages-server.ts`,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
