import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// Single-file build: the keyframe generators open dist/*.html over file://, and a build split
// across module chunks cannot be loaded that way.
//
// The project has two pages — index.html (the inherited 3D prototype) and handball.html (the 2D
// playground) — and vite-plugin-singlefile inlines everything into one document, which rollup
// only allows for a single input. So they are built one after the other by tools/build.mjs
// rather than as two inputs of one build.
const pollEnv = (globalThis as { process?: { env?: Record<string, string | undefined> } })
  .process?.env?.VITE_POLL;

export default defineConfig({
  base: './',
  plugins: [viteSingleFile()],
  // Inside docker on macOS/Windows, bind-mount file events can be lost; VITE_POLL=1 makes the
  // watcher poll instead. Native runs and the build path are untouched. (globalThis, not a bare
  // `process`: the project has no @types/node and `npm run build` typechecks this file.)
  server: pollEnv ? { watch: { usePolling: true, interval: 300 } } : undefined,
  // The keyframe generator writes out/index.html (the gallery). Without this the dev server's
  // dependency scan treats it as a second entry point and reports errors about generated files.
  optimizeDeps: { entries: ['index.html'] },
  build: {
    target: 'es2022',
    cssCodeSplit: false,
    assetsInlineLimit: 100 * 1024 * 1024,
  },
});
