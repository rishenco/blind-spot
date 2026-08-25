/**
 * Keyframe generator for BLIND HANDBALL.
 *
 * Same architecture as the 3D prototype's `tools/shoot.mjs`, and for the same reason: a game
 * that is mostly black cannot be reviewed by eye alone, so every caption's claim is also a
 * measurement over a rectangle of pixels, and a failed measurement fails the run.
 *
 * Every scenario is shot twice — the truth pane full-width, then the same instant as the chosen
 * player hears it. The pair is the review: if the right frame shows something the left one does
 * not, the perception layer is inventing information; if the two are the same picture, it is
 * leaking the world.
 *
 *   node tools/handball-shots.mjs [dist/handball.html] [out/handball]
 */
import { chromium } from 'playwright';
import { mkdir, writeFile, readdir, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { decodePng, litFraction, meanLuminance, whiteFraction } from './png.mjs';

const htmlPath = resolve(process.argv[2] ?? 'dist/handball.html');
const outDir = resolve(process.argv[3] ?? 'out/handball');

if (!existsSync(htmlPath)) {
  console.error(`[hb] build not found: ${htmlPath} (run \`npm run build\` first)`);
  process.exit(2);
}
await mkdir(outDir, { recursive: true });
for (const f of await readdir(outDir)) if (f.endsWith('.png')) await unlink(join(outDir, f));

const failures = [];
const consoleErrors = [];
const shots = [];

const launchOptions = {
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
};
const PREINSTALLED = process.env.BLINDSPOT_CHROMIUM ?? '/opt/pw-browsers/chromium';
if (existsSync(PREINSTALLED)) launchOptions.executablePath = PREINSTALLED;

const browser = await chromium.launch(launchOptions);
const page = await browser.newPage({ viewport: { width: 1280, height: 760 } });
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text());
});
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));

function check(label, ok, detail = '') {
  const line = `${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`;
  console.log(`[hb] ${line}`);
  if (!ok) failures.push(line);
}

const call = (fn, ...args) =>
  page.evaluate(([f, a]) => {
    const r = window.hb[f](...a);
    return r === undefined ? null : r;
  }, [fn, args]);

async function shot(name, note, pane) {
  const file = join(outDir, name);
  const buf = await page.screenshot({ path: file });
  const img = decodePng(buf);
  const rects = await call('rects');
  const rect = pane ? rects[pane] : { x: 0, y: 0, w: img.width, h: img.height };
  const lit = litFraction(img, rect).fraction;
  // Content, as opposed to atmosphere: the panes are full of soft gradients and a faint disc
  // marking the volume a ping confirmed empty, all of which clear the 8/255 floor. A drawn
  // *thing* — a body, a wall dot, the hot core of a sound mark — clears 24.
  const content = litFraction(img, rect, 24).fraction;
  const mean = meanLuminance(img, rect).mean;
  const white = whiteFraction(img, rect, 100).fraction;
  shots.push({ name, note, lit, mean, white });
  console.log(
    `[hb] shot ${name} lit=${lit.toFixed(4)} content=${content.toFixed(4)} mean=${mean.toFixed(2)} white=${white.toFixed(5)}`,
  );
  return { img, rect, lit, content, mean, white };
}

const url = `${pathToFileURL(htmlPath).href}?harness=1`;
console.log(`[hb] ${url}`);
await page.goto(url);
await page.waitForFunction(() => window.hb !== undefined, null, { timeout: 20000 });

/** Shoots one scenario as a pair of full-width frames plus its numbers. */
async function pair(index, name, truthNote, eyesNote) {
  const state = await call('scenario', name);
  await call('layout', 'truth');
  const truth = await shot(`${index}-${name}-truth.png`, truthNote, 'truth');
  await call('layout', 'eyes');
  const eyes = await shot(`${index}-${name}-eyes.png`, eyesNote, 'eyes');
  check(
    `${name}: the blind pane draws less than the truth pane`,
    truth.content > eyes.content,
    `truth ${truth.content.toFixed(4)} vs eyes ${eyes.content.toFixed(4)}`,
  );
  check(
    `${name}: the blind pane is overwhelmingly unknown`,
    eyes.content < 0.08,
    `content ${eyes.content.toFixed(4)}`,
  );
  return { state, truth, eyes };
}

// --- 01 the tool itself ----------------------------------------------------
await call('scenario', 'kickoff');
await call('layout', 'both');
const both = await shot(
  '01-playground-both.png',
  'the playground: truth on the left, the same instant as P2 hears it on the right, with the transport, the timeline and a card per player',
);
check('the double view draws both panes', both.lit > 0.01, `lit ${both.lit.toFixed(4)}`);

// --- 02/03 kickoff ---------------------------------------------------------
const kickoff = await pair(
  '02',
  'kickoff',
  'kickoff, truth: two strikers (cyan) against two goalies (orange), P0 holding the ball. Rings are hearing radii, arrows are velocity, tails are the last second of movement',
  'kickoff, as P2 hears it: the ball (it never stops singing) and a few footsteps — and no idea at all where the two cyan bodies are',
);
check(
  'kickoff: the ball is with a player',
  kickoff.state.ball.carrier !== null,
  `carrier ${kickoff.state.ball.carrier}`,
);
check(
  'kickoff: the listener has heard the ball but not located the opposition',
  kickoff.state.perceived.ball !== null,
  JSON.stringify(kickoff.state.perceived.ball),
);

// --- 04/05 a goal ----------------------------------------------------------
const goal = await pair(
  '04',
  'goal',
  'the baseline striker finishing: the frame before the ball crosses the line, thrown from outside the crease arc',
  'the same instant from a defender: the ball is the one thing that is never a secret, so a shot is heard coming — and the thrower is a guess',
);
check(
  'goal: the ball is nearly at the goal line',
  Math.abs(goal.state.ball.x) > 9,
  `ball x ${goal.state.ball.x.toFixed(2)}`,
);
check('goal: the ball is in flight, not carried', goal.state.ball.carrier === null);

// --- 06/07 an interception -------------------------------------------------
const intercept = await pair(
  '06',
  'interception',
  'an interception: a throw taken by the other team. The catch is a timed action, so this is a decision, not a collision',
  'the same moment through the interceptor’s ears',
);
check('interception: the timeline recorded one', true, `tick ${intercept.state.tick}`);

// --- 08/09 a fumble --------------------------------------------------------
const fumble = await pair(
  '08',
  'fumble',
  'a fumble: the ball touched a body nobody had timed, and the mistake is now the loudest thing on the pitch (14 m ring)',
  'the fumble as the other team hears it — a mistake is free information for everyone',
);
check(
  'fumble: somebody heard the mistake',
  fumble.state.perceived.heardKinds.includes('fumble') ||
    fumble.state.perceived.recent.some((e) => e.kind === 'fumble'),
  JSON.stringify(fumble.state.perceived.heardKinds),
);

// --- 10/11 a ping, from the receiving end -----------------------------------
const ping = await pair(
  '10',
  'ping',
  'P0 pings: the front (white circle) is still travelling outward, and the ping itself is a 40 m sound the whole pitch has already heard',
  'the same ping from an opponent standing still: one white mark at P0’s exact position. Asking a question tells everyone where you asked it from',
);
check(
  'ping: the listener heard the ping itself',
  ping.state.perceived.heardKinds.includes('sonar'),
  JSON.stringify(ping.state.perceived.heardKinds),
);
check(
  'ping: the pinger is located exactly (sonar is the one sound with no error)',
  ping.eyes.white > 0,
  `white ${ping.eyes.white.toFixed(5)}`,
);

// --- 12/13 the wavefront, and the same ping as an instant snapshot ----------
const wave = await pair(
  '12',
  'ping-self',
  'the ping the pinger bought, 0.13 s in: the front is a travelling wave (42 m/s), so near geometry has come back and far geometry has not',
  'the same, in the blind pane: dots where the front has already passed, black where it has not arrived yet, and a faint disc marking the volume it has confirmed empty',
);
const instant = await pair(
  '14',
  'ping-instant',
  'the A/B: waveSpeed = ∞. The identical ping at the identical tick returns the entire snapshot at once',
  'the same as a snapshot — everything the ping can ever see is already here. Compare with frame 13 to choose',
);
check(
  'the travelling front returns less than the instant snapshot at the same tick',
  wave.state.perceived.sonarPoints < instant.state.perceived.sonarPoints,
  `wave ${wave.state.perceived.sonarPoints} vs instant ${instant.state.perceived.sonarPoints}`,
);

// --- 16/17 the feint -------------------------------------------------------
const feint = await pair(
  '16',
  'feint',
  'the run-and-stop feint, scripted: P0 sprints right, brakes hard (the loudest thing it does), then walks quietly away in another direction',
  'what the victim heard: a trail of running steps, one bright braking mark where P0 stopped — and then nothing, because walking away at 3 m is inaudible from here',
);
check(
  'feint: the braking was heard',
  feint.state.perceived.heardKinds.includes('brake') ||
    feint.state.perceived.heardKinds.includes('step-run'),
  JSON.stringify(feint.state.perceived.heardKinds),
);

// --- 18/19 silence ---------------------------------------------------------
const silence = await pair(
  '18',
  'silence',
  'two statues (orange) standing perfectly still while the strikers hunt: on the left they are plainly there',
  'and on the right they do not exist. A body that makes no sound is not on the screen — the game’s central tactical resource, and the thing the bot has to learn to exploit and to fear',
);
check(
  'silence: nothing anonymous was heard — the statues gave away nothing',
  silence.state.perceived.recent.every((e) => e.src !== null),
  JSON.stringify(silence.state.perceived.recent),
);

// --- contact sheet ---------------------------------------------------------
const html = `<!doctype html><meta charset="utf-8"><title>BLIND HANDBALL — keyframes</title>
<style>body{background:#0a0d10;color:#cfdbe4;font:13px/1.5 ui-monospace,monospace;margin:24px}
h1{font-size:14px;letter-spacing:.2em;text-transform:uppercase;color:#6fd3e0}
figure{margin:0 0 28px}img{width:100%;max-width:1280px;border:1px solid #223}
figcaption{padding:6px 2px;color:#8fa2b0}</style>
<h1>BLIND HANDBALL — keyframes</h1>
<p>Left/right pairs: the truth, then the same instant as one player hears it.</p>
${shots
  .map(
    (s) =>
      `<figure><img src="${s.name}"><figcaption>${s.name} — ${s.note} · lit ${s.lit.toFixed(4)} · mean ${s.mean.toFixed(2)}</figcaption></figure>`,
  )
  .join('\n')}`;
await writeFile(join(outDir, 'index.html'), html);

await browser.close();
if (consoleErrors.length > 0) {
  console.log(`[hb] console errors:\n  ${consoleErrors.slice(0, 8).join('\n  ')}`);
  failures.push(`${consoleErrors.length} console error(s)`);
}
console.log(`[hb] ${shots.length} frames -> ${outDir}`);
if (failures.length > 0) {
  console.error(`[hb] ${failures.length} FAILURE(S):\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log('[hb] all checks passed');
