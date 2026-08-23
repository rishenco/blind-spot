// `vitest/config` rather than `vite` so the one config file can carry the test block too. It is a
// superset of Vite's own `defineConfig`; every Vite option below means exactly what it did.
import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  base: './',
  server: { port: 5173, strictPort: true },
  test: {
    /**
     * `npm test` means "this tree's specs", and nothing else.
     *
     * Parallel agents keep git worktrees at `.claude/worktrees/<agent>/` — inside this directory,
     * git-ignored, and each holding its own COPY of `test/`. Vitest's default include glob is
     * rooted at the project and happily collects all of them, which turns one command into three
     * suites: slower, and worse, it hangs this tree's gate on somebody else's half-finished edit.
     * A fresh clone never sees them; a working checkout does, so the exclusion is stated rather
     * than assumed. Defaults are spread, not replaced — `exclude` overwrites when it is set.
     */
    exclude: [...configDefaults.exclude, '**/.claude/**'],
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    chunkSizeWarningLimit: 1200,
  },
});
