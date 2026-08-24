import { defineConfig } from 'vitest/config';

/**
 * The Node test layer — the refactoring safety net for the simulation.
 *
 * The whole simulation (world, collision, sound bus, paint, player controller) runs in bare
 * Node with no DOM: three.js is pure JS below `WebGLRenderer`, so these tests import and drive
 * the real code with no mocks and no jsdom. `environment: 'node'` is load-bearing — see the
 * `typeof document === 'undefined'` guard in tests/determinism.test.ts.
 *
 * Deliberately separate from vite.config.ts: the app build inlines everything through
 * vite-plugin-singlefile, which has nothing to say about a test run.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
