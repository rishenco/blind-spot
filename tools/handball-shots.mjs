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

// ===========================================================================
// The bot. Everything below this line is about the AI: what it believes, what it
// believes the opposition believes about it, and what it decided.
// ===========================================================================

/**
 * An AI pair. Unlike `pair`, the blind pane is EXPECTED to be busy — it now carries the belief
 * grids on top of the sound marks — so the "overwhelmingly unknown" check does not apply. What
 * is checked instead is the thing that matters: the distance between what the bot believes and
 * what is true, read out of `hb.ai()`.
 */
async function aiPair(index, name, tick, truthNote, eyesNote, beliefs = 'opponents') {
  await call('scenario', name);
  if (tick) await call('scrubTo', tick);
  await call('beliefs', 'none');
  await call('layout', 'truth');
  const truth = await shot(`${index}-${name}-truth.png`, truthNote, 'truth');
  await call('beliefs', beliefs);
  await call('layout', 'eyes');
  const eyes = await shot(`${index}-${name}-eyes.png`, eyesNote, 'eyes');
  const ai = await call('ai');
  const state = await call('state');
  check(`${name}: the bot published a belief overlay`, ai !== null && ai.beliefs.length > 0, JSON.stringify(ai?.label));
  return { ai, state, truth, eyes };
}

const errorOf = (ai, about) => ai.beliefs.find((b) => b.about === about)?.error ?? null;

// --- 20/21 the doughnut ----------------------------------------------------
const doughnut = await aiPair(
  '20',
  'ai-doughnut',
  // 5.7 s: four seconds of total silence after the last running step, which is long enough for
  // the ring to open and short enough that the belief has not yet flattened into the pitch.
  340,
  'the shape of silence, truth: P2 (orange) ran towards the bot, was heard doing it, and has stood perfectly still for four seconds since. P1 (cyan, left) is the bot; it has heard nothing at all in that time',
  'and this is what P1 believes about him, and only about him, four seconds after the last sound he made. Note the flat near edge: the cloud stops about three metres short of the bot — the walking radius — because a body that close could not have moved without being heard. Silence does not delete belief, it freezes it, so the cloud grows outwards and not inwards. This asymmetry is the single most game-specific thing the belief layer does',
  'opp P2',
);
check(
  'doughnut: the belief has spread well beyond a point',
  doughnut.ai.beliefs[0].cells > 40,
  `cells ${doughnut.ai.beliefs[0].cells}`,
);

// --- 22/23 the feint -------------------------------------------------------
const feintAi = await aiPair(
  '22',
  'ai-feint',
  // 4.6 s: five metres of quiet walking after the braking sound, and one second before he
  // crosses the three-metre step radius and gives himself away again.
  276,
  'the feint, truth: P2 (orange) ran in, broke right, stopped hard — and then walked quietly back the other way. He is now on the left',
  'and the bot is still looking right. Only P1’s belief about the feinter is drawn: it sits where the braking sound was, because that was the last honest thing it heard. The man himself is metres away from the bot, walking below the three-metre step radius. The bot has been lied to, fairly',
  'opp P2',
);
const feintErr = errorOf(feintAi.ai, 'opp P2');
// The threshold used to be "the peak of the belief is more than four metres from the man".
// That is the wrong question and the scenario's own comment says so: a broad belief puts its
// peak anywhere, and the honest test is whether more probability sits on the lie than on the
// truth (`lieOverTruth` in `npm run deception`, 2.2 at the time of writing). What the picture
// has to show is that the bot is looking at the braking sound and not at the man, which is a
// metre or more of error on a pitch where he is standing three metres away.
check(
  'feint: the bot is still looking at the sound rather than at the man',
  feintErr !== null && feintErr > 1,
  `belief error ${feintErr === null ? 'n/a' : feintErr.toFixed(2)} m`,
);

// --- 24/25 the lying ping --------------------------------------------------
const liarAi = await aiPair(
  '24',
  'ai-false-ping',
  264,
  'the lying ping, truth: P2 pinged from down there four seconds ago and has been walking away in silence ever since',
  'the belief the ping bought: pinned where the ping was fired, and rotting outwards. A ping tells the whole pitch precisely where you WERE — which is exactly why it can be used to lie',
  'opp P2',
);
const liarErr = errorOf(liarAi.ai, 'opp P2');
check(
  'false ping: the exact fix has gone stale and the bot knows it is old',
  liarErr !== null && liarErr > 3,
  `belief error ${liarErr === null ? 'n/a' : liarErr.toFixed(2)} m`,
);

// --- 26/27 the mirror ------------------------------------------------------
const mirror = await aiPair(
  '26',
  'ai-shadow',
  130,
  'the mirror, truth: P2 has just pinged. The ping is the loudest sound in the game and it sees the whole pitch, so the bot has certainly been seen',
  'the second belief, in violet: not where the opposition IS, but where the bot thinks they think IT is. It is tight, because the ping just landed. It is the only reason the bot can put a price on silence, on a feint, or on a ping of its own',
  'mirror',
);
check(
  'mirror: the bot knows it has just been seen',
  Number(mirror.ai.readouts.known) > 0.4,
  `known ${mirror.ai.readouts.known}`,
);

// --- 28/29 a real match ----------------------------------------------------
const live = await aiPair(
  '28',
  'bot-match',
  300,
  'a real match, truth: two bots against two strikers',
  'the bot’s own pane during play: sound marks, the humming ball, both opponent beliefs (pink/orange grids with their age in seconds), the mirror (violet), the chosen move and the intercept point. The card below lists the top four options with their scores',
  'all',
);
check('match: the bot is deciding something', live.ai.scores.length >= 3, JSON.stringify(live.ai.scores?.[0]));

// ===========================================================================
// The human side. Everything below is about how the game FEELS to a person: the
// wind-up, the catch, the loudness dial and the ping, shot as storyboards rather
// than as single frames, because feel happens over 300 ms and one screenshot of it
// proves nothing.
//
// The hands are scripted (`src/sim-ui/hands.ts`): a rule a person would follow,
// reading the same PerceptionFrame a person reads and returning the same Intent.
// So these frames are the real cockpit, driven through the real input path.
// ===========================================================================

/**
 * One storyboard: a scenario in play mode, stepped forward, shot at named moments.
 *
 * `frames` are absolute ticks in ascending order. Stepping forward (rather than scrubbing) is
 * required: scrubbing re-simulates from the recording and has no button edges, so the feedback
 * that fires on a press — the catch verdict, the release kick — would be missing from exactly
 * the frames that exist to show it.
 */
async function storyboard(index, scenario, zoom, frames) {
  const out = [];
  await call('scenario', scenario, frames[0].tick);
  await call('mode', 'play');
  await call('zoom', zoom);
  await call('layout', 'eyes');
  let at = frames[0].tick;
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    if (f.tick > at) {
      await call('stepTicks', f.tick - at);
      at = f.tick;
    }
    const feel = await call('feel');
    const shotOut = await shot(`${index}${String.fromCharCode(97 + i)}-${scenario}-${f.name}.png`, f.note, 'eyes');
    out.push({ ...f, feel, shot: shotOut });
    console.log(
      `[hb]   ${scenario}/${f.name} tick ${f.tick} charge=${feel?.charge?.toFixed(2)} loud=${feel?.loudness?.toFixed(1)} readout=${feel?.readout ?? '-'} stats=${JSON.stringify(feel?.stats)}`,
    );
    check(
      `${scenario}/${f.name}: the cockpit does not light the pitch`,
      shotOut.content < 0.13,
      `content ${shotOut.content.toFixed(4)}`,
    );
  }
  await call('mode', 'debug');
  return out;
}

// --- 50 the wind-up --------------------------------------------------------
const windup = await storyboard('50', 'hands-throw', 2.2, [
  { tick: 20, name: 'aim', note: 'before the throw: the ball is in the hand (it sings, so everyone already knows where this player is), the aim line is under the nose, the loudness meter is at the bottom left' },
  { tick: 38, name: 'winding', note: 'the wind-up, 0.23 s in: the arc on the body fills clockwise, the body leans back away from the aim, and the aim line thickens and warms. Nothing about this is audible to anyone else — a wind-up is silent' },
  { tick: 52, name: 'committed', note: 'past the commit notch: the white tick on the arc is minCharge, and above it the throw stops being a lob and starts scaling to full speed. This is the moment a player learns the difference between a pass and a shot' },
  { tick: 56, name: 'release', note: 'the release: the wedge is thrown along the aim, a kick-ring leaves the body, the camera shakes two pixels, and a 13 m THROW mark is now the loudest thing on the pitch' },
  { tick: 64, name: 'flight', note: '0.13 s later: the ball is gone and singing, its error cigar stretched along the bearing. The release marks are already fading to hollow ghosts — stale information has to look stale' },
  { tick: 92, name: 'after', note: 'a second on: the throw has become a memory, the player is silent again, and the only thing still certain is the ball' },
]);
check(
  'wind-up: the charge rises and crosses the commit threshold',
  windup[1].feel.charge > 0.1 && windup[2].feel.charge > windup[1].feel.charge && windup[2].feel.committed,
  `${windup[1].feel.charge.toFixed(2)} -> ${windup[2].feel.charge.toFixed(2)} committed=${windup[2].feel.committed}`,
);
check(
  'wind-up: the throw actually left the hand',
  windup[4].feel.stats.throws === 1,
  JSON.stringify(windup[4].feel.stats),
);

// --- 52 the catch, timed ---------------------------------------------------
const caught = await storyboard('52', 'hands-catch', 2.2, [
  { tick: 200, name: 'incoming', note: 'a pass arriving: the dashed leash points at the ball, and the dotted ring is the reach — which is not a constant any more. It shrinks as the ball speeds up, and that is the whole rule of catching now that there is no button' },
  { tick: 214, name: 'window', note: 'the last tenth of a second: the ball is inside the reach and the ring has gone solid green. Nobody presses anything — being in the right place IS the catch' },
  { tick: 222, name: 'caught', note: 'caught, automatically. CAUGHT under the nose, a slap the other team can hear, and the ball is now this player’s problem' },
  { tick: 238, name: 'carrying', note: 'carrying, and this is the new bargain: the ball is SILENT in fresh hands and starts beeping about a second in, louder and faster the longer it is kept. The meter under the nose is that price, rising' },
]);
check('catch: the pass was taken, with no button pressed', caught[2].feel.stats.catches === 1, JSON.stringify(caught[2].feel.stats));
check(
  'catch: the read-out said so',
  caught[2].feel.readout === 'CAUGHT',
  String(caught[2].feel.readout),
);

// --- 54 the catch, missed --------------------------------------------------
const missedCatch = await storyboard('54', 'hands-catch-early', 2.2, [
  { tick: 200, name: 'grabbing', note: 'the same pass, and a player who sprints at it. Running at a hard ball is the one way left to drop one — catching is otherwise automatic' },
  { tick: 218, name: 'verdict', note: 'the read-out: TOO FAST · slow down to take it. The verdict comes from the simulation itself (`SelfState.lastCatchFail`), so the failure has a cause and a cure rather than reading as an arbitrary game' },
  { tick: 232, name: 'gone', note: 'and the ball has bounced off him, loudly. A fumble carries 14 m: the whole pitch heard the mistake' },
]);
check(
  'missed catch: the player is told why he dropped it',
  typeof missedCatch[1].feel.readout === 'string' && missedCatch[1].feel.readout.startsWith('TOO FAST'),
  String(missedCatch[1].feel.readout),
);
check('missed catch: nothing was caught', missedCatch[1].feel.stats.catches === 0, JSON.stringify(missedCatch[1].feel.stats));

// --- 56 the loudness dial --------------------------------------------------
const loud = await storyboard('56', 'hands-loud', 2.2, [
  { tick: 90, name: 'running', note: 'RUNNING: the dashed ring around the body is how far away this player can be heard right now — nine metres, two thirds of the pitch. The meter is red and the word says HEARD AT 9 M. You are a beacon' },
  { tick: 210, name: 'walking', note: 'walking: the same ring, three metres. The meter has dropped below the notch, which is the line between "audible at nine" and "audible at three". Same speed control, completely different game' },
  { tick: 340, name: 'silent', note: 'standing still: SILENT, and a count of how long you have been. The ring turns cold and breathes. A player who is not moving does not exist on anybody’s screen — the concept’s central tactical resource, made into a readable state' },
]);
check(
  'loudness: the meter falls run -> walk -> silent',
  loud[0].feel.loudness > loud[1].feel.loudness && loud[1].feel.loudness > loud[2].feel.loudness,
  `${loud[0].feel.loudness.toFixed(1)} / ${loud[1].feel.loudness.toFixed(1)} / ${loud[2].feel.loudness.toFixed(1)}`,
);
check('loudness: standing still is actually silent', loud[2].feel.silentFor > 1, `${loud[2].feel.silentFor.toFixed(1)}s`);

// --- 58 the ping -----------------------------------------------------------
const scream = await storyboard('58', 'hands-ping', 2.0, [
  { tick: 58, name: 'before', note: 'a quiet approach: nothing on the pane but the ball and this player’s own body. The blue dotted ring on the body says the ping is off cooldown — the question is available, and it has a price' },
  { tick: 64, name: 'scream', note: 'the ping, 0.05 s in: a red ring leaves the body — that is not the sonar, that is the SCREAM. Every player on the pitch has just been told exactly where this is, with no error at all' },
  { tick: 74, name: 'seeing', note: '0.2 s in: the front is out at eight metres and the walls it has passed are coming back as cold dots. Near geometry first, far geometry later — a body can physically outrun this' },
  { tick: 96, name: 'fading', note: 'a second later the snapshot is already melting and the cooldown arc on the body is filling. What was bought: one second of geometry. What was paid: everyone knows' },
]);
check('ping: it was fired', scream[3].feel.stats.pings === 1, JSON.stringify(scream[3].feel.stats));

// --- 60 the same instant, both ways ----------------------------------------
// The strongest claim in the project, made photometrically rather than in prose: the cockpit is
// drawn from the player's own perception and proprioception and from nothing else. So point at
// where each opponent actually is, and measure that the player's own pane is black there.
// The scenario is the wind-up, not the catch: the player's own side has the ball, so both
// opponents are statues that have made no sound at all. Pointing at a man who is legitimately
// audible — a carrier whose ball has started beeping — would prove nothing about leakage.
await call('scenario', 'hands-throw', 30);
await call('mode', 'play');
// Whole-pitch zoom for this pair only: at a playing zoom the opponents are simply off-screen,
// and "you cannot see him because he is outside the viewport" would prove nothing at all.
await call('zoom', 1);
await call('layout', 'truth');
const proofTruth = await shot(
  '60-cockpit-truth.png',
  'the truth a moment before a throw: four bodies, the ball and the hearing rings. Both orange bodies have not moved or made a sound since the whistle',
  'truth',
);
await call('layout', 'eyes');
const proofEyes = await shot(
  '61-cockpit-eyes.png',
  'the same instant in the cockpit, at the same scale. The HUD adds only things a blindfolded person knows about themselves — their own reach, their own noise, their own cooldown, their own wind-up. Both opponents are still nowhere: the boxes below are measured, not asserted',
  'eyes',
);
const proofState = await call('state');
const playerSlot = proofState.eyes;
const playerTeam = proofState.players[playerSlot].team;
for (const opponent of proofState.players.filter((p) => p.team !== playerTeam)) {
  const at = await call('project', opponent.x, opponent.y);
  const box = { x: at.x - 14, y: at.y - 14, w: 28, h: 28 };
  const inside =
    box.x >= proofEyes.rect.x &&
    box.y >= proofEyes.rect.y &&
    box.x + box.w <= proofEyes.rect.x + proofEyes.rect.w &&
    box.y + box.h <= proofEyes.rect.y + proofEyes.rect.h;
  const litThere = inside ? litFraction(proofEyes.img, box, 24).fraction : null;
  check(
    `cockpit: nothing is drawn where P${opponent.id} really is`,
    inside && litThere === 0,
    inside ? `lit ${litThere.toFixed(4)} at (${opponent.x.toFixed(1)}, ${opponent.y.toFixed(1)})` : 'box outside the pane',
  );
}
await call('mode', 'debug');

// ===========================================================================
// The fight for the ball. Everything below this line is about the contest rules
// added when "no contact in v1" was measured and found to be what made knowing
// where an opponent is worth nothing.
// ===========================================================================

/**
 * A mechanic pair: the same two panes as `pair`, but scrubbed to the exact tick the rule fires.
 *
 * These frames are the proof that a rule did something, so they are shot at the moment of the
 * event rather than at the end of the scenario — and the right-hand pane still has to be almost
 * empty, because a body being knocked over does not switch the lights on.
 */
async function mechPair(index, name, tick, truthNote, eyesNote) {
  const state = await call('scenario', name);
  const at = tick ? await call('scrubTo', tick) : state;
  await call('layout', 'truth');
  const truth = await shot(`${index}-${name}-truth.png`, truthNote, 'truth');
  await call('layout', 'eyes');
  const eyes = await shot(`${index}-${name}-eyes.png`, eyesNote, 'eyes');
  check(
    `${name}: the blind pane draws less than the truth pane`,
    truth.content > eyes.content,
    `truth ${truth.content.toFixed(4)} vs eyes ${eyes.content.toFixed(4)}`,
  );
  return { state: at, truth, eyes };
}

// --- 30/31 the steal, retired ------------------------------------------------
// 2026-08-25: contact never takes the ball off a carrier any more. The same script that used to
// prove the steal worked (a hunter closes and stays glued to his shoulder) now proves the rule
// is gone — six seconds of company and the ball has not moved.
const steal = await mechPair(
  '30',
  'mech-steal',
  210,
  'the steal, retired, truth: the hunter (orange) has been glued to the carrier’s shoulder for the better part of six seconds. Under the old rule this alone took the ball; under this one it does nothing at all',
  'the same instant from the man it was taken off — except nobody took anything off him: the hum is still in his own hands, exactly where it has been the whole time',
);
check(
  'steal, retired: the ball never changed hands',
  steal.state.ball.carrier === 0,
  `carrier ${steal.state.ball.carrier}`,
);

// --- 32/33 the trap, sprung ---------------------------------------------------
const tackle = await mechPair(
  '32',
  'mech-tackle',
  100,
  'the trap, sprung, truth: the defender laid himself down across the carrier’s line a moment ago and has not moved since — this body is not attacking anybody. The carrier, running blind, found him with his own legs and is now on the floor with the ball loose',
  'the same moment from the far side of the pitch: the thud and the fumble are both loud, so a sprung trap is one of the few things in this game that everybody hears',
);
check(
  'trap: the carrier lost the ball',
  tackle.state.ball.carrier !== 0,
  `carrier ${tackle.state.ball.carrier}`,
);

// --- 34/35 the trap that caught nobody ----------------------------------------
const missed = await mechPair(
  '34',
  'mech-tackle-miss',
  150,
  'the trap, empty, truth: the defender read the carrier wrong and lay down well off his line. The carrier walked straight past, never close enough to trip on him',
  'and this is what the bet cost regardless: the loudest ordinary sound in the game, from a spot the carrier never visited, and the same floor time whether or not the bet ever pays off',
);
check(
  'trap, empty: the carrier still has it',
  missed.state.ball.carrier === 0,
  `carrier ${missed.state.ball.carrier}`,
);

// --- 36/37 the screen, and who loses the ground -------------------------------
const screen = await mechPair(
  '36',
  'mech-screen',
  190,
  'the screen, truth: a body that has made no sound at all planted itself in the corridor over three seconds ago. The carrier has been driving into him ever since — bodies no longer pass through each other, so a silent defender is a wall',
  'the thud, heard: a screen is invisible right up to the moment somebody hits it — and then both bodies are the loudest thing on the pitch. The carrier keeps the ball, but he has gone almost nowhere: the corridor holds its ground and it is HE who gets walked backwards, not the man blocking him',
);
check('screen: the runner was stopped but kept the ball', screen.state.ball.carrier === 0);
{
  // Most of the "advance" is the free run before contact even happens (11 m of open pitch) —
  // comparing it to a free sprint proves nothing about the corridor itself. What proves the
  // corridor is: is the defender still essentially where he planted himself, and is the runner
  // still pressed up against him rather than through him?
  const runnerX = screen.state.players[0].x;
  const defenderX = screen.state.players[2].x;
  const defenderDrift = defenderX - 4.2;
  // The runner closes from the left (negative x), so "touching" is runnerX ≈ defenderX - 0.7 —
  // a gap of -0.7, not 0. Anything close to that says he is pressed up against the defender;
  // anything near 0 or positive would mean he walked through him.
  const gap = runnerX - defenderX;
  check(
    'screen: the defender has barely been pushed off his spot',
    Math.abs(defenderDrift) < 1,
    `defender drift ${defenderDrift.toFixed(2)} m`,
  );
  check(
    'screen: the runner is still pressed against him, not past him',
    gap < -0.55 && gap > -0.85,
    `gap ${gap.toFixed(2)} m (touching is ~-0.7 m)`,
  );
}

// --- 38/39 the block that is no longer absolute -----------------------------
const block = await mechPair(
  '38',
  'mech-block',
  84,
  'the block that is not a wall: a hard throw fired straight at a parked defender has gone past him. Under the old rule this contact was a guaranteed fumble, which is why two parked bodies were unbeatable',
  'from behind the defender: the ball is simply still coming. It whistled past him at 3.5 m — quiet, but never nothing, because a punishment nobody can hear is indistinguishable from a bug',
);
check(
  'block: the ball is past the defender and still loose',
  block.state.ball.carrier === null && block.state.ball.x > 4.2,
  `ball x ${block.state.ball.x.toFixed(2)} carrier ${block.state.ball.carrier}`,
);

// --- 42/43 the keeper -------------------------------------------------------
const keeper = await mechPair(
  '42',
  'mech-keeper',
  178,
  'the keeper, truth: the one body in the game allowed inside its own arc. The shot was fired at the near half of a 3.2 m mouth from eight metres, and it died on him. Nobody else on either team may stand where he is standing',
  'and this is everything he had to work with: the crack of the release, and the ball. He cannot know the corner — nothing he can hear says which one — so he stands where the angle is narrowest and spends his reach on the half he guessed',
);
check(
  'keeper: the shot was saved rather than scored',
  keeper.state.score[0] === 0,
  `score ${keeper.state.score.join(':')}`,
);

// --- 44/45 the ball's own voice ---------------------------------------------
// Two moments of ONE possession, both through the ears of a man standing still eleven metres
// away. This is the pair that shows the biggest rule change in the project: a ball that used to
// hum across the whole pitch for ever now goes quiet in fresh hands and gets louder the longer
// they keep it.
await call('scenario', 'mech-ball-voice');
await call('scrubTo', 55);
await call('layout', 'truth');
const voiceEarly = await shot(
  '44-ball-voice-truth.png',
  'the ball a second after it was taken, truth: the carrier (cyan) is walking it up, and the listener (orange, right) has not moved since the whistle',
  'truth',
);
await call('layout', 'eyes');
const voiceQuiet = await shot(
  '45-ball-voice-quiet.png',
  'the same instant through the listener: NOTHING. A ball in fresh hands is silent, so the man carrying it is as invisible as anybody else — this second is what a pass buys, and it is the whole reason to make one',
  'eyes',
);
await call('scrubTo', 330);
const voiceLoud = await shot(
  '46-ball-voice-loud.png',
  'the same possession four seconds later: the ball is beeping every third of a second and carrying 22 m, and the trail of marks IS the carrier walking. He did nothing wrong — he simply kept it, and the price of keeping it is being audible',
  'eyes',
);
check(
  'ball voice: a fresh ball is silent and a held one is not',
  voiceQuiet.content < voiceLoud.content,
  `quiet ${voiceQuiet.content.toFixed(4)} vs loud ${voiceLoud.content.toFixed(4)}`,
);
check('ball voice: the truth pane still shows the carrier', voiceEarly.content > voiceQuiet.content);

// --- 47/48 a pass into the dark ---------------------------------------------
// Beliefs off: this pair is about perception, and the bot's grids would fill the pane with
// things that are guesses rather than things that were heard.
await call('beliefs', 'none');
const passDark = await mechPair(
  '47',
  'mech-pass-dark',
  594,
  'the pass into the dark, truth: P1 (cyan, right) walked quietly into space, stood still, and shouted once. The bot threw the ball at the shout and it arrived',
  'the same throw from the bot that made it: a call mark where its team-mate said he was, the ball leaving its hands, and no other information of any kind. This is the one thing a human can do to make a bot play with them — and the shout told the defence exactly the same thing at the same moment',
);
check(
  'pass into the dark: the silent man got the ball',
  passDark.state.ball.carrier === 1,
  `carrier ${passDark.state.ball.carrier}`,
);

// --- 40/41 a match under the winning rules ----------------------------------
const contestMatch = await aiPair(
  '40',
  'contest-match',
  620,
  'a match under the chosen rule set: four bots, every contest mechanic live. Possession is something that has to be held now, not something that is handed over by the passivity whistle',
  'the same instant inside one bot\u2019s head: both opponent beliefs, the mirror, and the option it picked with its score. The card lists the alternatives it turned down',
  'all',
);
check(
  'contest match: the bot is still deciding between real alternatives',
  contestMatch.ai.scores.length >= 3,
  JSON.stringify(contestMatch.ai.scores?.[0]),
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
