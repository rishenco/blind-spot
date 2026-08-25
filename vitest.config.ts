import { defineConfig } from 'vitest/config';

// A config of its own, deliberately: the app's vite.config.ts carries the single-file build
// plugin, which has nothing to do with running the simulation's tests in node.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
