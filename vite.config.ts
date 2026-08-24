import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// Single-file build: the keyframe generator opens dist/index.html over file://, and a
// build split across module chunks cannot be loaded that way.
export default defineConfig({
  base: './',
  plugins: [viteSingleFile()],
  build: {
    target: 'es2022',
    cssCodeSplit: false,
    assetsInlineLimit: 100 * 1024 * 1024,
  },
});
