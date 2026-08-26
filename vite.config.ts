import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// Single-file build: everything (JS, CSS, assets) is inlined into dist/index.html so the
// prototype runs from file:// and inside a strict-CSP artifact frame with zero network use.
export default defineConfig({
  base: './',
  plugins: [viteSingleFile()],
  build: {
    target: 'es2022',
    assetsInlineLimit: 100 * 1024 * 1024,
    cssCodeSplit: false,
    chunkSizeWarningLimit: 8000,
  },
});
