import { defineConfig, coverageConfigDefaults } from 'vitest/config';

export default defineConfig({
  esbuild: { jsx: 'automatic' },
  test: {
    // The KMZ wall-clock probe runs separately without instrumentation or competing suites.
    testNamePattern: /^(?!.*stress \(2,000 x 50 trails)/,
    projects: [
      {
        test: {
          name: 'core',
          environment: 'node',
          include: ['src/core/**/*.test.ts', 'tests/**/*.test.ts'],
          testTimeout: 30000,
        },
      },
      {
        test: {
          name: 'ui',
          environment: 'jsdom',
          include: ['src/**/*.test.{ts,tsx}'],
          exclude: ['src/core/**'],
        },
      },
    ],
    coverage: {
      provider: 'v8',
      include: ['src/core/**/*.ts'],
      exclude: [
        ...coverageConfigDefaults.exclude,
        '**/__prototype__/**',
        '**/__golden__/**',
      ],
      thresholds: { lines: 85 },
      reporter: ['text', 'json-summary', 'html'],
    },
  },
});
