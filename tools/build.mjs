/**
 * Production build.
 *
 * Two pages, two passes. `vite-plugin-singlefile` inlines a whole page into one HTML document,
 * and rollup refuses to do that for more than one input at a time — so index.html (the inherited
 * 3D prototype) and handball.html (the 2D playground) are built one after the other into the same
 * dist/, the second pass leaving the first one's output alone.
 *
 *   node tools/build.mjs
 */
import { build } from 'vite';

await build({ configFile: 'vite.config.ts' });
await build({
  configFile: 'vite.config.ts',
  build: {
    emptyOutDir: false,
    rollupOptions: { input: { handball: 'handball.html' } },
  },
});
console.log('[build] dist/index.html (3D prototype) and dist/handball.html (2D playground)');
