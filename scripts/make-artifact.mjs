// Wraps dist-artifact/game.js into one self-contained HTML page (three.js imported from jsDelivr by URL).
// usage: npx vite build -c vite.artifact.config.ts && node scripts/make-artifact.mjs <out.html>
import { readFileSync, writeFileSync } from 'node:fs';

const out = process.argv[2] ?? 'dist-artifact/rampage-peak.html';
const THREE = 'https://cdn.jsdelivr.net/npm/three@0.186.1/';
// No import map (the artifact host doesn't apply it): point the bare "three" import straight at the CDN.
const js = readFileSync('dist-artifact/game.js', 'utf8')
  .replace(/from\s*["']three["']/g, `from"${THREE}build/three.module.js"`)
  .replace(/<\/script/gi, '<\\/script');
if (/from\s*["']three/.test(js.replace(THREE, ''))) throw new Error('unmapped three import left in bundle');
const html = `<title>Rampage Peak</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Luckiest+Guy&display=swap" rel="stylesheet">
<style>
  /* Single deliberate look: the game's own sky color behind a full-bleed canvas. */
  :root { --sky: #9fc4ee; color-scheme: light; }
  html, body { height: 100%; margin: 0; overflow: hidden; background: var(--sky); }
  canvas { display: block; }
</style>
<script type="module">
${js}
</script>
`;
writeFileSync(out, html);
console.log('wrote', out, (html.length / 1024).toFixed(0) + ' KB');
