import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// base './' so the build works at any path (GitHub Pages subfolder, repo renames).
export default defineConfig({
  base: './',
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        viewer: resolve(__dirname, 'viewer.html'),
      },
    },
  },
});
