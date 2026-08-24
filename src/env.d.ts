/**
 * Ambient declarations for Vite's asset imports.
 *
 * `?url` hands back a string. With the build's very large `assetsInlineLimit` that string is
 * a base64 `data:` URI, which is what keeps the single-file dist self-contained (no runtime
 * fetch ever leaves the page). `vite/client` is not pulled in wholesale because tsconfig
 * pins `types: []` on purpose.
 */

declare module '*.glb?url' {
  const src: string;
  export default src;
}
