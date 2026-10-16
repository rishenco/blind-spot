import { defineConfig } from 'vite';

// Single-module build of the game for a claude.ai artifact: three.js stays external
// (imported from jsDelivr by URL), everything else is inlined into one file.
export default defineConfig({
  build: {
    outDir: 'dist-artifact',
    emptyOutDir: true,
    minify: true,
    lib: { entry: 'src/main.ts', formats: ['es'], fileName: () => 'game.js' },
    rollupOptions: { external: ['three'], output: { inlineDynamicImports: true } },
  },
});
