import { defineConfig } from 'vitest/config';

// Keep the T-207 wall-clock measurement in the gate without coverage or competing files.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/core/export/kmz.test.ts'],
    testNamePattern: /stress \(2,000 x 50 trails/,
    maxWorkers: 1,
    fileParallelism: false,
    testTimeout: 60_000,
  },
});
