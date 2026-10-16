import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    testTimeout: 60000,
    hookTimeout: 60000,
    // Each file boots its own in-memory MongoDB; run them one after another (low-RAM machines).
    fileParallelism: false,
  },
});
