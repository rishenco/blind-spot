import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// Single-file build: the keyframe generator opens dist/index.html over file://, and a
// build split across module chunks cannot be loaded that way.
const pollEnv = (globalThis as { process?: { env?: Record<string, string | undefined> } })
  .process?.env?.VITE_POLL;

export default defineConfig({
  base: './',
  plugins: [viteSingleFile()],
  // Inside docker on macOS/Windows, bind-mount file events can be lost; VITE_POLL=1 makes the
  // watcher poll instead. Native runs and the build path are untouched. (globalThis, not a bare
  // `process`: the project has no @types/node and `npm run build` typechecks this file.)
  server: pollEnv ? { watch: { usePolling: true, interval: 300 } } : undefined,
  build: {
    target: 'es2022',
    cssCodeSplit: false,
    assetsInlineLimit: 100 * 1024 * 1024,
  },
});
