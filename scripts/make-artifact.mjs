// Wraps dist-artifact/game.js into one self-contained HTML page (three.js via import map from jsDelivr).
// usage: npx vite build -c vite.artifact.config.ts && node scripts/make-artifact.mjs <out.html>
import { readFileSync, writeFileSync } from 'node:fs';

const out = process.argv[2] ?? 'dist-artifact/rampage-peak.html';
const js = readFileSync('dist-artifact/game.js', 'utf8').replace(/<\/script/gi, '<\\/script');
const THREE = 'https://cdn.jsdelivr.net/npm/three@0.186.1/';
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
<script type="importmap">
{ "imports": { "three": "${THREE}build/three.module.js", "three/examples/jsm/": "${THREE}examples/jsm/" } }
</script>
<script type="module">
${js}
</script>
`;
writeFileSync(out, html);
console.log('wrote', out, (html.length / 1024).toFixed(0) + ' KB');
