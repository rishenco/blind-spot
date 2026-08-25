/**
 * The ear's keyframe generator.
 *
 * A sound cannot be screenshotted, so this is the substitute the milestone spec asks for: fixed
 * scenes of bus events are rendered offline through the *same* synthesis the player hears
 * (`src/audio/offline.ts` → `src/audio/voices.ts`), written out as WAVs you can listen to, and
 * drawn as spectrograms you can look at. Every scene is rendered twice — through the mixer as it
 * is now, and through a reconstruction of the pre-M4b mixer — because the complaint being fixed
 * ("no spider clicks at all", "the rifle sounds like knocking on a wall") is not a volume
 * problem and a picture of the difference is the only honest way to show that.
 *
 *   node tools/audio.mjs [dist/index.html]
 *
 * Writes out/audio/<n>-<scene>.wav, out/audio/<n>-<scene>-before.wav and
 * out/audio/<n>-<scene>.png (now on top, before underneath). Prints a table and a set of pass/
 * fail checks; exits non-zero if any of them fail.
 */
import { chromium } from 'playwright';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
// The picture itself lives in tools/spectro.mjs, because tools/shoot.mjs draws the same one.
import {
  encodePng,
  drawText,
  wavToMono,
  rmsOf,
  peakOf,
  db,
  highRms,
  highFraction,
  drawPanel,
  spectrogram,
  FFT_N,
  W,
  PANEL_H,
  WAVE_H,
  HEAD,
} from './spectro.mjs';

const htmlPath = resolve(process.argv[2] ?? 'dist/index.html');
if (!existsSync(htmlPath)) {
  console.error(`[audio] build not found: ${htmlPath} (run \`npm run build\` first)`);
  process.exit(2);
}
const outDir = resolve('out/audio');
mkdirSync(outDir, { recursive: true });

// ---- drive the page --------------------------------------------------------

const launchOptions = {
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
};
const PREINSTALLED = process.env.BLINDSPOT_CHROMIUM ?? '/opt/pw-browsers/chromium';
if (existsSync(PREINSTALLED)) launchOptions.executablePath = PREINSTALLED;

const browser = await chromium.launch(launchOptions);
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
await page.goto(pathToFileURL(htmlPath).href);
await page.waitForFunction(() => window.bs !== undefined, null, { timeout: 180000 });
// No device is opened: the offline renderer needs neither an AudioContext nor a gesture.
await page.evaluate(() => window.bs.audio(false));

const t0 = Date.now();
const now = await page.evaluate(() => window.bs.audioRender({}));
const before = await page.evaluate(() => window.bs.audioRender({ legacy: true }));
// Two more passes that exist only to measure the deafening: the ring left in your ears is
// switched off in both, and the ducking in one of them. Nothing else differs, so the gap between
// them *is* the deafening — measured, not asserted.
const ducked = await page.evaluate(() => window.bs.audioRender({ tinnitus: 0 }));
const noduck = await page.evaluate(() =>
  window.bs.audioRender({ deafDepth: 1, deafCutoff: 20000, tinnitus: 0 }));
// Not a render: the phrase skeletons the chatter timbre schedules, so the rhythm can be checked
// as numbers. A spectrogram cannot tell an even train from a torn one at this time resolution.
const phrases = await page.evaluate(() => window.bs.audioPhrases(16));
const renderMs = Date.now() - t0;


const failures = [];
const check = (label, ok, detail = '') => {
  const line = `${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`;
  console.log(`[audio] ${line}`);
  if (!ok) failures.push(line);
};

const scenes = new Map();
now.forEach((r, i) => {
  const idx = String(i + 1).padStart(2, '0');
  const a = wavToMono(Buffer.from(r.wav, 'base64'));
  const b = wavToMono(Buffer.from(before[i].wav, 'base64'));
  writeFileSync(resolve(outDir, `${idx}-${r.name}.wav`), Buffer.from(r.wav, 'base64'));
  writeFileSync(resolve(outDir, `${idx}-${r.name}-before.wav`), Buffer.from(before[i].wav, 'base64'));

  const h = (HEAD + PANEL_H + 2 + WAVE_H + 8) * 2 + 26;
  const px = Buffer.alloc(W * h * 3, 8);
  drawText(px, W, h, 6, 6, `${idx} ${r.name} - ${r.what}`.slice(0, 74), 2, [235, 235, 235]);
  let y = 26;
  y = drawPanel(px, W, h, y, a.mono, a.rate, r.seconds, `NOW  PEAK ${db(a.peak).toFixed(1)} DBFS  RMS ${db(rmsOf(a.mono)).toFixed(1)}`);
  drawPanel(px, W, h, y, b.mono, b.rate, r.seconds, `BEFORE (M4A)  PEAK ${db(b.peak).toFixed(1)} DBFS  RMS ${db(rmsOf(b.mono)).toFixed(1)}`);
  writeFileSync(resolve(outDir, `${idx}-${r.name}.png`), encodePng(W, h, px));

  scenes.set(r.name, {
    r, a, b,
    d: wavToMono(Buffer.from(ducked[i].wav, 'base64')),
    n: wavToMono(Buffer.from(noduck[i].wav, 'base64')),
  });
  console.log(
    `[audio] ${idx} ${r.name.padEnd(9)} now peak ${db(a.peak).toFixed(1).padStart(6)} dB  rms ${db(rmsOf(a.mono)).toFixed(1).padStart(6)} dB` +
      `   before peak ${db(b.peak).toFixed(1).padStart(6)} dB  rms ${db(rmsOf(b.mono)).toFixed(1).padStart(6)} dB` +
      `   voiced ${Object.entries(r.voiced).map(([k, v]) => `${k}x${v}`).join(' ')}${r.culled ? ` culled ${r.culled}` : ''}`,
  );
});

const win = (s, from, to) => [Math.floor(from * s.rate), Math.floor(to * s.rate)];

// 1. The chatter — the thing the player never heard once, and then still could not tell was
//    alive. The scene puts three-call phrases at 3, 10, 20, 30 and 45 m; every range is
//    measured and printed, so "at what distance does the pack stop reading" is a table and not
//    a memory.
{
  const { a, b, r } = scenes.get('clicks');
  const RANGES = [3, 10, 20, 30, 45];
  const at = RANGES.map((m, i) => {
    const t0 = 0.15 + i * 1.6;
    const w = win(a, t0 - 0.05, t0 + 1.45);
    return { m, peak: peakOf(a.mono, ...w), rms: rmsOf(a.mono, ...w) };
  });
  console.log(
    `[audio] chatter by range: ${at.map((x) => `${x.m} m ${db(x.peak).toFixed(1)}`).join('  ')} dBFS peak`,
  );
  const near = win(a, 0.1, 1.55);
  const nowPeak = at[0].peak;
  const oldPeak = peakOf(b.mono, ...near);
  check('the pack at 3 m is unmistakable', db(nowPeak) > -20,
    `${db(nowPeak).toFixed(1)} dBFS (was ${db(oldPeak).toFixed(1)} before any of this)`);
  const hiNow = highFraction(a.mono, a.rate, near[0], near[1] - 1, 2000);
  const hiOld = highFraction(b.mono, b.rate, near[0], near[1] - 1, 2000);
  check('and it sits above everything else in the game', hiNow > 0.5,
    `${(hiNow * 100).toFixed(0)}% of its energy is over 2 kHz (was ${(hiOld * 100).toFixed(0)}%)`);
  // The whole point of this pass: the hall has to sound inhabited from across it, not only
  // when something is already on top of you.
  check('at 20 m it still reads', db(at[2].peak) > -34,
    `${db(at[2].peak).toFixed(1)} dBFS, ${(db(nowPeak) - db(at[2].peak)).toFixed(1)} dB under the 3 m phrase`);
  check('at 30 m it is thin but there', db(at[3].peak) > -40,
    `${db(at[3].peak).toFixed(1)} dBFS`);
  check('past its reach it is gone', db(at[4].peak) < -70,
    `${db(at[4].peak).toFixed(1)} dBFS at 45 m, ${r.culled} events culled by range`);
  // "Живое, а не аппаратура": a tick generator holds one pitch, a throat does not. Measured as
  // the spectral centroid of a single call's first half against its second — a static tick moves
  // it by a percent or two, a glide moves it by a lot.
  const centroid = (from, to) => {
    const [i0, i1] = win(a, from, to);
    const cols = spectrogram(a.mono.subarray(i0, i1), Math.max(1, Math.floor((i1 - i0) / 6)));
    let num = 0;
    let den = 0;
    for (const col of cols) {
      for (let k = 1; k < FFT_N / 2; k++) {
        const f = (k * a.rate) / FFT_N;
        if (f < 800 || f > 12000) continue;
        num += f * col[k];
        den += col[k];
      }
    }
    return den > 0 ? num / den : 0;
  };
  const c1 = centroid(0.152, 0.19);
  const c2 = centroid(0.19, 0.235);
  const move = Math.abs(c2 - c1) / Math.max(1, Math.min(c1, c2));
  check('and every call is a glide, not a tick', move > 0.08,
    `one call's centre of gravity travels ${(c1 / 1000).toFixed(2)} → ${(c2 / 1000).toFixed(2)} kHz, ${(move * 100).toFixed(0)}%`);
}

// 2. The shot is an event, not a knock.
{
  const shot = scenes.get('shot');
  const clicks = scenes.get('clicks');
  const shotPeak = peakOf(shot.a.mono);
  const clickPeak = peakOf(clicks.a.mono, ...win(clicks.a, 0.1, 0.85));
  // This gap used to be 22 dB, and the pack was inaudible. Spending some of the rifle's headroom
  // on the animals was the whole point of the pass; the shot still has to be the biggest thing in
  // the game by a wide margin, and 10 dB of peak plus its body and its ducking is that margin.
  check('the shot towers over the pack', db(shotPeak) - db(clickPeak) > 10,
    `${(db(shotPeak) - db(clickPeak)).toFixed(1)} dB above a 3 m phrase, peak to peak`);
  check('the shot does not clip', shotPeak < 0.999, `peak ${db(shotPeak).toFixed(2)} dBFS`);
  // A real muzzle blast is low-heavy, so the absolute share of high frequency is never large.
  // What matters is that there is a crack there at all, which is precisely what the old
  // footstep-shaped shot did not have.
  const [ta, tb] = win(shot.a, 0.1, 0.115);
  const hiNow = highFraction(shot.a.mono, shot.a.rate, ta, tb, 1500);
  const hiOld = highFraction(shot.b.mono, shot.b.rate, ta, tb, 1500);
  check('it opens with a crack, not a thud', hiNow > hiOld * 2.5,
    `${(hiNow * 100).toFixed(1)}% of the first 15 ms is over 1.5 kHz, against ${(hiOld * 100).toFixed(1)}% before`);
  const [sa, sb] = win(shot.a, 0.35, 0.75);
  check('and leaves a tail', db(rmsOf(shot.a.mono, sa, sb)) > -46, `${db(rmsOf(shot.a.mono, sa, sb)).toFixed(1)} dB 250-650 ms later`);
}

// 3. The shot deafens. Measured against the identical scene with the ducking switched off, so
//    the shot's own tail is present in both and cancels out of the comparison.
{
  const { a, d, n } = scenes.get('deafened');
  // The two clicks that land while the shot is still in your ears, at 1.25 s and 1.47 s. The
  // blast's own tail bypasses the duck by design, so the comparison is made in the band the
  // clicks own rather than over the whole spectrum.
  const hurt = win(a, 1.24, 1.53);
  const later = win(a, 2.6, 3.55);
  // Measured over 2 kHz, where the clicks live and the blast's low tail does not.
  const duckedHi = highRms(d.mono, d.rate, hurt[0], hurt[1] - 1, 2000);
  const openHi = highRms(n.mono, n.rate, hurt[0], hurt[1] - 1, 2000);
  check('the clicks that land while you are deaf are pushed down', db(openHi) - db(duckedHi) > 5,
    `${(db(openHi) - db(duckedHi)).toFixed(1)} dB below the same scene without ducking`);
  // Muffled means the top drops *further* than the whole does — a share-of-energy test says
  // nothing when the source is all treble to begin with, which the chatter now is.
  const dropAll = db(rmsOf(n.mono, ...hurt)) - db(rmsOf(d.mono, ...hurt));
  const dropTop = db(highRms(n.mono, n.rate, hurt[0], hurt[1] - 1, 4000)) -
    db(highRms(d.mono, d.rate, hurt[0], hurt[1] - 1, 4000));
  check('and goes muffled, not just quiet', dropTop > dropAll + 1.5,
    `over 4 kHz it drops ${dropTop.toFixed(1)} dB against ${dropAll.toFixed(1)} dB overall`);
  const lateDucked = db(rmsOf(d.mono, ...later));
  const lateOpen = db(rmsOf(n.mono, ...later));
  check('and comes back', Math.abs(lateOpen - lateDucked) < 2.5,
    `${(lateOpen - lateDucked).toFixed(1)} dB apart a second and a half later`);
}

// 4. Concept: "по железному стеллажу громче, чем по бетону".
{
  const { a } = scenes.get('steps');
  const concrete = peakOf(a.mono, ...win(a, 0.1, 1.5));
  const steel = peakOf(a.mono, ...win(a, 1.55, 2.85));
  check('a spider on steel is louder than on concrete', db(steel) - db(concrete) > 3 && db(concrete) > -60,
    `${db(steel).toFixed(1)} against ${db(concrete).toFixed(1)} dBFS, ${(db(steel) - db(concrete)).toFixed(1)} dB apart`);
  const boot = peakOf(a.mono, ...win(a, 2.87, 3.19));
  check('the player’s own boot is there but quiet', db(boot) > -40 && db(boot) < -10, `${db(boot).toFixed(1)} dBFS`);
}

// 5. The pack talks in phrases, not in metronome ticks.
//    "Ровный ритм" is half of what made the old chatter read as a device rather than an animal,
//    and it is invisible on a spectrogram — so it is measured here, on the onsets the timbre
//    actually schedules, and printed as numbers.
{
  const all = [];
  for (const p of phrases) all.push(...p.gaps);
  all.sort((x, y) => x - y);
  const mean = all.reduce((s, x) => s + x, 0) / all.length;
  const sd = Math.sqrt(all.reduce((s, x) => s + (x - mean) ** 2, 0) / all.length);
  const cv = sd / mean;
  const lo = all[0];
  const hi = all[all.length - 1];
  const lens = phrases.map((p) => p.onsets.length);
  console.log(
    `[audio] phrase gaps over ${phrases.length} seeds: n=${all.length}  ` +
      `min ${(lo * 1000).toFixed(0)} ms  mean ${(mean * 1000).toFixed(0)} ms  max ${(hi * 1000).toFixed(0)} ms  ` +
      `sd ${(sd * 1000).toFixed(0)} ms  cv ${cv.toFixed(2)}  elements per phrase ${Math.min(...lens)}-${Math.max(...lens)}`,
  );
  for (const p of phrases.slice(0, 4)) {
    console.log(
      `[audio]   seq ${String(p.seq).padStart(2)}: ${p.gaps.map((g) => `${(g * 1000).toFixed(0)}`).join(' ')} ms`,
    );
  }
  check('the gaps between calls are not one number', cv > 0.4,
    `spread ${(lo * 1000).toFixed(0)}-${(hi * 1000).toFixed(0)} ms around a ${(mean * 1000).toFixed(0)} ms mean, cv ${cv.toFixed(2)}`);
  // A phrase whose own gaps are all equal is still a metronome even if the *tempo* wanders
  // between phrases, so irregularity is required inside each phrase too.
  // A phrase whose own gaps are all equal is still a metronome even if the *tempo* wanders
  // between phrases, so irregularity is required inside phrases too. The median and not the
  // minimum: with the gaps drawn independently, one phrase in a dozen will come out nearly even
  // by chance, and that is a property of honest randomness rather than a bug to assert away.
  const swings = phrases
    .filter((p) => p.gaps.length >= 2)
    .map((p) => (Math.max(...p.gaps) - Math.min(...p.gaps)) / Math.max(...p.gaps))
    .sort((x, y) => x - y);
  const median = swings[swings.length >> 1];
  check('and they are not one number inside a single phrase either', median > 0.35,
    `the median phrase swings its own gaps by ${(median * 100).toFixed(0)}%` +
      ` (flattest ${(swings[0] * 100).toFixed(0)}%, most torn ${(swings[swings.length - 1] * 100).toFixed(0)}%)`);
  check('and the phrase length itself varies', Math.max(...lens) - Math.min(...lens) >= 2,
    `${Math.min(...lens)} to ${Math.max(...lens)} calls`);
}

// 6. The death cry had to survive the chatter pass. The chatter was made a lot louder and moved
//    into the same register, and the risk was that dying now sounds like talking.
{
  const { a } = scenes.get('voices');
  const talk = win(a, 0.15, 1.4);
  const bite = win(a, 1.45, 2.7);
  const death = win(a, 2.75, 4.2);
  const pTalk = peakOf(a.mono, ...talk);
  const pBite = peakOf(a.mono, ...bite);
  const pDeath = peakOf(a.mono, ...death);
  console.log(
    `[audio] one spider at 8 m: chatter ${db(pTalk).toFixed(1)}  bite ${db(pBite).toFixed(1)}  ` +
      `death ${db(pDeath).toFixed(1)} dBFS peak`,
  );
  check('dying is still nothing like talking', db(pDeath) - db(pTalk) > 5,
    `${(db(pDeath) - db(pTalk)).toFixed(1)} dB over a phrase from the same animal at the same range`);
  // Loudness alone is not the difference — a scream is *long*. The chatter's whole phrase is
  // under half a second; the death cry has to still be going after that.
  const tail = db(rmsOf(a.mono, ...win(a, 3.3, 3.9)));
  const talkTail = db(rmsOf(a.mono, ...win(a, 0.75, 1.35)));
  check('and it holds on after a phrase would have stopped', tail - talkTail > 10,
    `${tail.toFixed(1)} against ${talkTail.toFixed(1)} dB half a second in`);
}

// 7. The concussion. `a` and `d` are the same scene with the ring switched off in `d`, so their
//    difference *is* the ring — no assumptions, and no second implementation to measure.
{
  const { a, d, r } = scenes.get('concussion');
  const ring = new Float32Array(a.mono.length);
  for (let i = 0; i < ring.length; i++) ring[i] = a.mono[i] - d.mono[i];
  const shotAt = 0.4;
  // Measured *after* the blast has gone, not on top of it: the ring changes what the limiter is
  // doing while the shot is peaking, so during those first few hundred milliseconds `a - d`
  // is mostly limiter difference and says nothing about the ring itself.
  const [w0, w1] = win(a, shotAt + 0.8, shotAt + 1.4);
  const hi = highFraction(ring, a.rate, w0, w1 - 1, 3000);
  check('the ring is a narrow band, not a hiss', hi > 0.85,
    `${(hi * 100).toFixed(0)}% of its energy is over 3 kHz`);
  // "Держится долго" — the point of the pass. The old whistle was one second of 3.9 kHz sine.
  const at = (o) => db(rmsOf(ring, ...win(a, shotAt + o, shotAt + o + 0.6)));
  const early = at(0.8);
  const late = at(3.4);
  const gone = db(rmsOf(ring, ...win(a, r.seconds - 0.3, r.seconds - 0.02)));
  console.log(
    `[audio] ring after the shot: ${[0.2, 0.8, 1.8, 2.8, 3.4, 4.4]
      .map((o) => `+${o.toFixed(1)} s ${at(o).toFixed(1)}`)
      .join('  ')}  end ${gone.toFixed(1)} dB`,
  );
  check('and it is still there seconds later', late > early - 14 && late > gone + 10,
    `${late.toFixed(1)} dB at +3.7 s — ${(early - late).toFixed(1)} dB under its own start, ` +
      `${(late - gone).toFixed(1)} dB over silence`);
  // It rings, it does not deafen you a second time: the shot itself must stay far above it, or
  // the ring stops being an after-effect and becomes the loudest thing in the game.
  check('and it never competes with the shot that caused it',
    db(peakOf(ring)) < db(peakOf(a.mono)) - 15,
    `${db(peakOf(ring)).toFixed(1)} against ${db(peakOf(a.mono)).toFixed(1)} dBFS`);
  // The other half of the concussion: the hall falls through the floor and then comes back.
  const { d: dd, n: nn } = scenes.get('concussion');
  // Over 2 kHz, where the chatter lives: the blast's own low tail bypasses the duck by design
  // and would otherwise sit in the middle of the measurement in both renders.
  const under = win(a, 1.0, 1.6);
  const back = win(a, 5.6, 6.6);
  const drop = db(highRms(nn.mono, nn.rate, under[0], under[1] - 1, 2000)) -
    db(highRms(dd.mono, dd.rate, under[0], under[1] - 1, 2000));
  const rec = db(highRms(nn.mono, nn.rate, back[0], back[1] - 1, 2000)) -
    db(highRms(dd.mono, dd.rate, back[0], back[1] - 1, 2000));
  check('the hall drops away under it and comes back', drop > 8 && Math.abs(rec) < 3,
    `${drop.toFixed(1)} dB down at +0.6 s, ${rec.toFixed(1)} dB apart at +5 s`);
}

// 8. Nothing anywhere is allowed to clip.
{
  let worst = 0;
  let worstName = '';
  for (const [name, s] of scenes) {
    if (s.a.peak > worst) {
      worst = s.a.peak;
      worstName = name;
    }
  }
  check('no scene clips', worst < 0.999, `loudest is ${worstName} at ${db(worst).toFixed(2)} dBFS`);
}

check('no page errors', errors.length === 0, errors.join('; '));
console.log(`[audio] rendered ${now.length} scenes twice in ${renderMs} ms → ${outDir}`);

await browser.close();
if (failures.length > 0) {
  console.error(`[audio] ${failures.length} check(s) failed`);
  process.exit(1);
}
