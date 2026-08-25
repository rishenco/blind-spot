#!/usr/bin/env node
/**
 * The listening room — the ear's counterpart to `tools/shoot.mjs`.
 *
 *   node tools/listen.mjs [outdir] [--only substring] [--no-hum]
 *
 * `shoot.mjs` is the end-to-end oracle for pixels: it drives the real game and writes pictures a
 * human can look at. There was no equivalent for the ear. The phonometric suite in `tests/audio/`
 * measures the synthesis to a tenth of a decibel, but a number is not a sound — nothing in the
 * repo could answer "does a sprint across a steel walkway actually *sound* like one", and nothing
 * produced a file anybody could play.
 *
 * This does. It drives the headless simulation through a scripted timeline, renders what the
 * player would have heard offline, and writes `.wav` files, each with a printed annotation of
 * what happens when — so you play the file with the timeline next to it and judge.
 *
 * **A listening tool first.** Almost every assertion below is the "the render came out broken"
 * kind: NaN, clipping, digital silence, a voice the mixer dropped, a scene that drove the
 * simulation and produced no sound at all. Pinning a level or a decay is `tests/audio/`'s job and
 * it does it better than a tool run by hand ever could; a second, weaker copy of it here would be
 * a suite nobody trusts and everybody has to update. What this catches is the class of failure a
 * number cannot: the mix being wrong in a way that is obvious the moment you hear it.
 *
 * **Two scenes measure, and the exception has a shape.** 05 and 06 characterise the detonation,
 * because the things worth saying about a boom are *relations between sounds in one run* and the
 * suite cannot construct one: it renders a voice at a gain it chose, and a relation needs a
 * simulation to throw twice at two distances it picked itself, with the arm that threw them still
 * in the file. So 05 asks whether the two booms stand in the ratio their metres demand, whether
 * the boom towers over the tick that launched it, and whether it decays like mass where that tick
 * decays like a click; 06 asks whether four booms over four floors arrive at one level. None of
 * those is a number the suite owns, and none survives a listener — a human is very good at "that
 * was loud" and hopeless at "that was 7 dB". Only two absolute pins appear anywhere (05's shares
 * below 120 Hz and above 2 kHz) and both are looser than `DETONATION` in
 * `tests/support/audioSpec.ts`, on purpose: this is the same sound through the whole mixer and a
 * 16-bit encode rather than alone at unit gain, and a tool that pinned it tighter than the suite
 * would be the second, weaker copy this paragraph exists to refuse.
 *
 * **It is the shipped audio path, with one substitution.** The scenes mount the real
 * `AudioSystem` on the real `SoundBus` of a real `GameSim`, and the events are the ones the
 * player's own feet and pings emit. The only thing replaced is the clock: an `OfflineAudioContext`
 * reports `currentTime === 0` until it renders, so it is wrapped in a proxy that answers with the
 * *simulation's* clock instead. Every level, every material, every duck and the Halo's whole glide
 * are then produced by `src/audio/` exactly as a browser would produce them. Nothing here decides
 * how loud anything is.
 *
 * **Stereo files, mono content, on purpose.** Spatialization is M2 and deliberately not built, so
 * the two channels are currently identical — a voice connects to the master bus and the master
 * upmixes. The files are written as stereo anyway so that the day a `PannerNode` slots in between,
 * these same scenes gain width and nothing here has to change.
 *
 * `--no-hum` renders the same scenes with §3.8's readout switched off. It is a listening aid and
 * not a mode: the hum sits at ≈ −21 dBFS, which is level with a walk-step's own attack peak, so
 * every judgement about the voices is a judgement about the voices *plus* a tone that ducks under
 * them. Hearing them without it is the only way to tell "this material is indistinct" from "the
 * readout is masking it", and telling those two apart is the whole reason a person is listening.
 * The measuring scenes run either way and always measure the Halo-free take — for a machine the
 * tone is not a masker, it is an addend, and it is a large one.
 *
 * Exits non-zero if any scene fails a guard.
 */

import { runnerImport } from 'vite';
import { OfflineAudioContext } from 'node-web-audio-api';
import * as THREE from 'three';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 48 kHz, matching `tests/support/audioRender.ts`.
 *
 * Not imported from it: that file is test support and this is a tool, and the day one of them
 * wants a different rate the other should not silently follow. They agree because browsers pick
 * 48 kHz, which is the actual reason, and it is written down in both places.
 */
const SAMPLE_RATE = 48000;

/** Fixed simulation rate. The browser loop's rate, so a scene here is a scene there. */
const SIM_HZ = 120;

/** Run seed, so two runs of this tool produce byte-identical files. */
const SEED = 1;

// ---------------------------------------------------------------------------
//  loading the game
// ---------------------------------------------------------------------------

/*
 * The sources are TypeScript and this is a plain Node script, so Vite's module runner does the
 * transform — the same transform the dev server and the build use. `node --experimental-strip-types`
 * cannot do it: the codebase imports without file extensions, which Node's resolver refuses.
 */
const load = async (id) => (await runnerImport(id, { root: ROOT })).module;

const { createHeadlessGame } = await load('/src/game/headless.ts');
const { AudioSystem } = await load('/src/audio/system.ts');
const { PLAYER_EMITTER_ID, SoundBus } = await load('/src/paint/soundEvents.ts');
const { MATERIAL_NAMES } = await load('/src/paint/materials.ts');
const { canOccupy } = await load('/src/core/collision.ts');
const { humPitch } = await load('/src/paint/halo.ts');
const { SPHERE_RADIUS } = await load('/src/game/spheres.ts');
/*
 * The phonometric vocabulary, borrowed from the suite rather than rewritten here.
 *
 * `SAMPLE_RATE` above is deliberately *not* imported from test support, and this deliberately is,
 * which looks like two minds until you ask what each one is. 48 kHz is a choice, and two files
 * that make the same choice for the same reason should each own it, so that changing one does not
 * silently drag the other. A decibel is not a choice. If this tool computed a band share its own
 * way, the repo would hold two numbers for one fact about one sound, and the day they disagreed
 * nobody could say which was the sound and which was the arithmetic. `audioMetrics.ts` was
 * written to be read from anywhere — nothing in it knows what a game or a test is, and its own
 * header names a decoded file as one of the things it measures.
 */
const metrics = await load('/tests/support/audioMetrics.ts');
/*
 * What counts as "the attack", and where the near field ends — both read from the shipped code
 * rather than repeated here. The first is the window §3.9 normalizes over, so a scene that
 * measured a different one would be describing a sound the synthesis never agreed to make. The
 * second is the clamp in `gainFor`: inside it level stops following distance, and a scene that
 * argued about the distance law without knowing where the law stops applying would be right by
 * luck, until somebody moved a throw a metre closer.
 */
const { ATTACK_WINDOW_SEC } = await load('/src/audio/voices.ts');
const { NEAR_FIELD_M } = await load('/src/audio/director.ts');

// ---------------------------------------------------------------------------
//  writing a wav
// ---------------------------------------------------------------------------

/**
 * 16-bit PCM WAV, interleaved, from an `AudioBuffer`.
 *
 * Sixteen bits and not float32 because the point of this file is that a human double-clicks it,
 * and 16-bit PCM is the one encoding every player on every platform opens without being asked
 * twice. The precision that costs is precision nothing here measures — the assertions run on the
 * float buffer, before this.
 *
 * Returns how many samples had to be clamped, which is the clipping guard: an honest count of the
 * mix exceeding full scale, taken at the only place that can see it.
 */
function encodeWav(buffer) {
  const channels = buffer.numberOfChannels;
  const frames = buffer.length;
  const data = Buffer.alloc(44 + frames * channels * 2);
  data.write('RIFF', 0);
  data.writeUInt32LE(36 + frames * channels * 2, 4);
  data.write('WAVE', 8);
  data.write('fmt ', 12);
  data.writeUInt32LE(16, 16); // PCM header size
  data.writeUInt16LE(1, 20); // format: PCM
  data.writeUInt16LE(channels, 22);
  data.writeUInt32LE(buffer.sampleRate, 24);
  data.writeUInt32LE(buffer.sampleRate * channels * 2, 28); // byte rate
  data.writeUInt16LE(channels * 2, 32); // block align
  data.writeUInt16LE(16, 34); // bits per sample
  data.write('data', 36);
  data.writeUInt32LE(frames * channels * 2, 40);

  const src = [];
  for (let c = 0; c < channels; c++) src.push(buffer.getChannelData(c));
  let clamped = 0;
  let at = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      const s = src[c][i];
      const clip = s > 1 ? 1 : s < -1 ? -1 : s;
      if (clip !== s) clamped++;
      data.writeInt16LE(Math.round(clip * 32767), at);
      at += 2;
    }
  }
  return { data, clamped };
}

/**
 * Reads a 16-bit PCM WAV back into channels of floats.
 *
 * Here so the tool can check its own product. Everything else measures the float buffer, which
 * is the thing that never leaves memory — a bug in the header arithmetic below would ship a file
 * that no player opens, or opens at the wrong rate, and every assertion would still pass. The
 * round-trip is the only guard that is about the artefact rather than about the render.
 */
function decodeWav(data) {
  if (data.toString('ascii', 0, 4) !== 'RIFF' || data.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('listen: what was written is not a RIFF/WAVE file');
  }
  const channels = data.readUInt16LE(22);
  const sampleRate = data.readUInt32LE(24);
  const bits = data.readUInt16LE(34);
  const bytes = data.readUInt32LE(40);
  const frames = bytes / ((bits / 8) * channels);
  const out = Array.from({ length: channels }, () => new Float32Array(frames));
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      out[c][i] = data.readInt16LE(44 + (i * channels + c) * 2) / 32767;
    }
  }
  return { channels: out, sampleRate, frames, declaredBytes: bytes + 44, actualBytes: data.length };
}

/** The worst a written file differs from the render it came from, in 16-bit steps. */
function roundTripError(buffer, data) {
  const file = decodeWav(data);
  if (file.sampleRate !== buffer.sampleRate) return { why: `rate ${file.sampleRate}`, steps: Infinity };
  if (file.channels.length !== buffer.numberOfChannels) return { why: `${file.channels.length} channels`, steps: Infinity };
  if (file.frames !== buffer.length) return { why: `${file.frames} frames`, steps: Infinity };
  if (file.declaredBytes !== file.actualBytes) return { why: `header claims ${file.declaredBytes} bytes, file is ${file.actualBytes}`, steps: Infinity };
  let worst = 0;
  for (let c = 0; c < file.channels.length; c++) {
    const src = buffer.getChannelData(c);
    const back = file.channels[c];
    for (let i = 0; i < back.length; i++) {
      const d = Math.abs(src[i] - back[i]) * 32767;
      if (d > worst) worst = d;
    }
  }
  return { why: null, steps: worst };
}

/** Peak and RMS of the whole render, dBFS, plus whether anything is not a number. */
function survey(buffer) {
  let peak = 0;
  let peakAt = 0;
  let energy = 0;
  let nan = false;
  let n = 0;
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < d.length; i++) {
      const s = d[i];
      if (!Number.isFinite(s)) {
        nan = true;
        continue;
      }
      const a = s < 0 ? -s : s;
      if (a > peak) {
        peak = a;
        peakAt = i / buffer.sampleRate;
      }
      energy += s * s;
      n++;
    }
  }
  const db = (v) => (v > 0 ? 20 * Math.log10(v) : -Infinity);
  return { peakDb: db(peak), peakAt, rmsDb: db(Math.sqrt(energy / Math.max(n, 1))), nan };
}

// ---------------------------------------------------------------------------
//  staging
// ---------------------------------------------------------------------------

/**
 * The yaw, in the compass degrees `setSpawn` takes, that points the body along (dx, dz).
 *
 * Derived from the camera basis rather than guessed: forward is `(-sin y, -cos y)`, so the
 * heading that faces a direction is `atan2(-dx, -dz)`. A tool that hard-coded "0 is north" would
 * be one refactor away from walking every material scene backwards off its platform.
 */
const headingTowards = (dx, dz) => (Math.atan2(-dx, -dz) * 180) / Math.PI;

/**
 * Whether a body of this shape can stand with its feet here.
 *
 * `canOccupy` and the body's own radius and height, rather than a rule of this tool's own. The
 * room's tallest surface is the tank cap at 6.9 m and the ceiling is at 7.0, so "highest top" and
 * "somewhere you can stand" are different questions — asking the first one placed the body inside
 * the ceiling, where the collision pass ejected it through a wall and it fell out of the world
 * forever, which is a silent scene and a confusing bug report. The collision system already knows
 * the answer; nothing here should be re-deriving it.
 */
const fits = (world, body, x, feetY, z) =>
  canOccupy(world.boxes, x, feetY, z, body.radius, body.standHeight);

/**
 * The best place in this room to walk on `mat`, or `null` if the room has no such surface.
 *
 * Found by searching the collider list rather than written down as coordinates, because the room
 * is under active construction and a scene pinned to a crate at (12, 1.5) becomes a scene that
 * silently walks on concrete the day that crate moves. The consequence to like: when a material
 * gains a surface, its segment appears here on its own; when one has none, the report says so
 * instead of quietly rendering the wrong thing.
 */
function surfaceFor(world, body, mat) {
  let best = null;
  for (const b of world.boxes) {
    if (b.mat !== mat) continue;
    const w = b.maxX - b.minX;
    const d = b.maxZ - b.minZ;
    const cx = (b.minX + b.maxX) / 2;
    const cz = (b.minZ + b.maxZ) / 2;
    // Standable: a body fits on the footprint with margin, and — the part that is not obvious —
    // fits *above* it as well. The ceiling slab is a concrete surface with an enormous footprint,
    // and it is the headroom test and not the height cap that rules it out.
    if (Math.min(w, d) < body.radius * 2 + 0.2) continue;
    if (!fits(world, body, cx, b.maxY + 0.05, cz)) continue;
    const run = Math.max(w, d);
    if (best === null || run > best.run) {
      // The box itself rides along, because a scene that stages a throw *onto* this surface has
      // to be able to prove afterwards that the thing came down on it. Two of the room's
      // materials share a height — the dust apron is the same continuous slab as the concrete
      // floor (§3.9) — so "landed at the right altitude" does not distinguish them and a
      // footprint is the only answer that does.
      best = { run, top: b.maxY, cx, cz, alongX: w >= d, mat, box: b };
    }
  }
  return best;
}

/**
 * The highest a body can stand in the clear column above (x, z), or `null` if it cannot stand
 * there at all.
 *
 * Scanned upward from the floor and stopped at the first illegal pose, so what comes back is the
 * top of an *unobstructed* column rather than merely a legal pose — above the ceiling is legal
 * and is not a place to drop from.
 */
function ceilingOver(world, body, x, z) {
  let best = null;
  for (let y = 0.2; y <= 20; y += 0.1) {
    if (!fits(world, body, x, y, z)) break;
    best = y;
  }
  return best;
}

// ---------------------------------------------------------------------------
//  the harness
// ---------------------------------------------------------------------------

/**
 * Runs one scene and returns its buffer, its event log and its counts.
 *
 * The clock is the whole trick. `simTime` advances *before* the tick, because `GameSim.tick`
 * advances the paint clock on its first line — so during a tick the proxy's `currentTime` is
 * exactly the stamp the events emitted in that tick carry, and a footfall is scheduled at the
 * instant the simulation says it happened rather than a tick early.
 */
async function renderScene(scene, withHum) {
  const game = createHeadlessGame({ seed: SEED, hz: SIM_HZ });
  const target = new OfflineAudioContext(
    2,
    Math.ceil(scene.seconds * SAMPLE_RATE),
    SAMPLE_RATE,
  );

  let simTime = 0;
  /*
   * Everything below `state`, `currentTime` and `resume` is the genuine context: real nodes, a
   * real render. `OfflineAudioContext` has no `state` a mixer would call live and its `resume`
   * waits for a render loop nothing here starts, so those two are supplied and the clock is
   * replaced. `tests/audio/system.test.ts` wears the same proxy for the same reason.
   */
  const ctx = new Proxy(target, {
    get(t, key) {
      if (key === 'state') return 'running';
      if (key === 'currentTime') return simTime;
      if (key === 'resume') return () => Promise.resolve();
      const value = Reflect.get(t, key);
      return typeof value === 'function' ? value.bind(t) : value;
    },
  });

  const ears = () => {
    const p = game.sim.paint.listenerPosition;
    return {
      x: p.x,
      y: p.y,
      z: p.z,
      range: game.sim.paint.perception.hearingRange,
      emitter: PLAYER_EMITTER_ID,
    };
  };
  const audio = new AudioSystem({ bus: game.sim.bus, listener: ears, createContext: () => ctx });
  if (!audio.unlock()) throw new Error(`${scene.file}: the mixer would not start`);

  // The annotation. Audibility is `SoundBus.canHear` and not a rule of this tool's own — the same
  // predicate the paint system and the mixer are both gated on (§3.1).
  const log = [];
  game.sim.bus.subscribe((event) => {
    const p = game.sim.paint.listenerPosition;
    log.push({
      t: event.time,
      cls: event.class,
      mat: event.mat === null ? null : MATERIAL_NAMES[event.mat],
      carries: event.hearingRadius,
      // Where it happened. A scene that stages one sound per surface has to be able to say which
      // surface each one came off, and for the classes that carry no material — the sphere's own
      // boom is the whole of that list (§3.3) — the position is the only thing that can say it.
      x: event.x,
      y: event.y,
      z: event.z,
      // How far the ear was from it. Not printed — the timeline is for a listener and a column
      // of metres is noise there — but half of `gainFor` is this number, so a scene that wants
      // to argue about level between two events has to be able to show they were equally far.
      d: Math.hypot(event.x - p.x, event.y - p.y, event.z - p.z),
      audible: SoundBus.canHear(event, p.x, p.y, p.z, game.sim.paint.perception.hearingRange),
    });
  });

  const staged = {};
  const stage = {
    staged,
    input: game.input,
    sim: game.sim,
    /** Puts the body over a surface, facing along it, `drop` metres up. */
    placeOn(surface, drop = 1.6) {
      const back = Math.min(surface.run / 2 - 0.45, 3);
      const dx = surface.alongX ? 1 : 0;
      const dz = surface.alongX ? 0 : 1;
      game.sim.player.setSpawn(
        new THREE.Vector3(surface.cx - dx * back, surface.top + drop, surface.cz - dz * back),
        headingTowards(dx, dz),
      );
    },
    /**
     * Turns the body, in degrees, through the mouse.
     *
     * Through `look` and the simulation's own sensitivity rather than by writing to `yaw`,
     * because a tool that set the yaw directly would be the one thing `ScriptedInput` exists to
     * avoid: a pose the player could not have produced. The conversion is read from
     * `cameraTunables` so retuning the mouse does not silently turn every scene by a different
     * amount.
     *
     * Pitch through the same call and the same conversion, because aim is one thing: a scene
     * that threw down at the floor by writing `pitch` would be aiming from a pose no mouse can
     * reach, and the clamp at ±89° would never get a say in it.
     */
    turn(yawDegrees, pitchDegrees = 0) {
      const sens = game.sim.cameraTunables.sensitivity;
      game.input.look(-yawDegrees / sens, -pitchDegrees / sens);
    },
    /**
     * Puts the body as high as it can legally stand above where it is standing now.
     *
     * Records where it left from, because "the body came back down to the floor it started on"
     * is the only thing that distinguishes a staged fall from a staged fall through the ceiling,
     * and a scene that stages the wrong thing sounds fine.
     */
    dropFromCeiling() {
      const p = game.sim.player.position;
      const body = game.sim.movement;
      const top = ceilingOver(game.sim.world, body, p.x, p.z);
      if (top === null) throw new Error('listen: nothing to drop from over the body');
      staged.dropped = { from: p.y, to: top };
      game.sim.player.setSpawn(new THREE.Vector3(p.x, top, p.z), 0);
    },
  };

  const step = game.stepSeconds;
  const ticks = Math.round(scene.seconds / step);
  const cues = [...scene.cues].sort((a, b) => a[0] - b[0]);
  let next = 0;
  let haloMin = Infinity;
  let haloMax = 0;
  for (let i = 0; i < ticks; i++) {
    while (next < cues.length && cues[next][0] <= simTime + 1e-9) cues[next++][1](stage);
    simTime += step;
    game.step();
    // What `Game.update` does every frame, with the same argument: the glided radius, not a pitch.
    if (withHum) audio.setHaloRadius(game.sim.halo.radius);
    if (game.sim.halo.radius < haloMin) haloMin = game.sim.halo.radius;
    if (game.sim.halo.radius > haloMax) haloMax = game.sim.halo.radius;
  }

  const buffer = await target.startRendering();
  const heard = log.filter((e) => e.audible).length;
  /*
   * `staged` and the simulation itself ride out with the render, because a scene's own guards are
   * asked *after* the run and from the run loop rather than from here — a scene that measures its
   * sound is handed a second render as well (see `measured`), and this function renders one.
   */
  const result = {
    staged,
    sim: game.sim,
    buffer,
    log,
    heard,
    played: audio.played,
    dropped: audio.droppedSilent,
    failure: audio.lastFailure,
    humming: audio.humming,
    halo: { min: haloMin, max: haloMax },
  };
  audio.dispose();
  return result;
}

/**
 * The event log as something you can read while the file plays.
 *
 * Consecutive events of the same class on the same material collapse into one line with a time
 * span and a count, because the useful annotation for a listener is "here comes a run of walking
 * on stone", not forty timestamps.
 */
function annotate(log) {
  const lines = [];
  for (const e of log) {
    const last = lines[lines.length - 1];
    if (last && last.cls === e.cls && last.mat === e.mat && last.audible === e.audible) {
      last.to = e.t;
      last.n++;
      continue;
    }
    lines.push({ from: e.t, to: e.t, n: 1, cls: e.cls, mat: e.mat, carries: e.carries, audible: e.audible });
  }
  return lines.map((l) => {
    const when = l.n === 1 ? `${l.from.toFixed(2)}s` : `${l.from.toFixed(2)}–${l.to.toFixed(2)}s`;
    const count = l.n === 1 ? '' : ` ×${l.n}`;
    const on = l.mat === null ? '' : ` on ${l.mat}`;
    const gate = l.audible ? '' : '  (out of earshot — painted, not played)';
    return `    ${when.padEnd(14)} ${l.cls}${count}${on}, carries ${l.carries.toFixed(1)} m${gate}`;
  });
}

// ---------------------------------------------------------------------------
//  the scenes
// ---------------------------------------------------------------------------

const hold = (...actions) => (s) => actions.forEach((a) => s.input.hold(a));
const release = (...actions) => (s) => actions.forEach((a) => s.input.release(a));
const tap = (code) => (s) => s.input.tapKey(code);

/**
 * One material segment: drop onto the surface, walk along it, let it ring.
 *
 * The drop is not decoration. A landing is the loudest thing a surface says (§3.3's landing row
 * is the widest radius on the table), so it is the clearest sample of a material's voice — and it
 * arrives before the walk rather than after, so the ear has the surface's identity before it has
 * to judge a stride on it.
 */
function materialSegment(mat, at) {
  return (surface) => [
    [at, (s) => s.placeOn(surface)],
    [at + 0.9, hold('forward')],
    [at + 0.9 + Math.min(2, (surface.run - 0.9) / 3.5), release('forward')],
  ];
}

/** Every scene, in the order the report prints them. */
function buildScenes(world, body) {
  const scenes = [];

  scenes.push({
    file: '01-gait.wav',
    title: 'the gait ladder, and the Halo gliding through it',
    seconds: 10,
    listenFor: [
      'three stances in one take: crouch, walk, sprint. Each footfall harder and brighter than',
      'the last — that is `bright` in the class table, not volume, and it should read as effort.',
      'Under them, §3.8’s hum: one continuous glide from a low crouch to an insistent sprint,',
      'never a step between gears. If you can hear it change in jumps, the readout is quantized',
      'and the ring on screen is telling a different story than the tone.',
      'The last two seconds are the hum alone, sliding back down as the body coasts to a stop.',
    ],
    cues: [
      [0.3, hold('crouch', 'forward')],
      [3.0, release('crouch')],
      // The room is 30 m across and this walk would run out of it mid-sprint, pinning the body
      // against a wall where it stops striding — a gait file whose loudest stance is missing.
      // Turning is the fix that costs the listener nothing: with spatialization deliberately
      // deferred to M2 the two channels are identical, so which way the body faces is inaudible.
      [5.2, (s) => s.turn(180)],
      [5.4, hold('sprint')],
      [7.6, release('forward', 'sprint')],
    ],
  });

  scenes.push({
    file: '02-pings.wav',
    title: 'the two sonars, and the duck under them',
    seconds: 9,
    listenFor: [
      'Q then E then Q then E, standing still on concrete. They differ in *shape*, not reach',
      '(§3.5), so they have to differ in timbre: Q is the round 360° room-read, E the bright',
      'directed beam. If you cannot tell which one fired without looking at the timeline, the',
      'two pings sound like one ping with a knob turned.',
      'Behind them the hum sits at its floor and ducks out of the way of each — audible as the',
      'tone dipping and swelling back, not as it disappearing.',
    ],
    cues: [
      [1.0, tap('KeyQ')],
      [3.0, tap('KeyE')],
      [5.0, tap('KeyQ')],
      [7.0, tap('KeyE')],
    ],
  });

  // §3.9 — one segment per material the room actually has a surface for.
  const materials = [];
  let at = 0.4;
  const missing = [];
  for (let mat = 0; mat < MATERIAL_NAMES.length; mat++) {
    const surface = surfaceFor(world, body, mat);
    if (surface === null) {
      missing.push(MATERIAL_NAMES[mat]);
      continue;
    }
    materials.push({ name: MATERIAL_NAMES[mat], surface, at });
    at += 4.2;
  }
  scenes.push({
    file: '03-materials.wav',
    title: `§3.9's voices: ${materials.map((m) => m.name).join(' → ')}`,
    seconds: at + 0.8,
    note:
      missing.length > 0
        ? `no walkable surface in this room for: ${missing.join(', ')} — those segments are absent, not silent`
        : null,
    listenFor: [
      'The same body, the same stride, on each surface the room offers, four seconds apart.',
      'Each segment opens with a drop onto the surface and continues into a short walk.',
      'What must be audible is *identity*, not level: metal rings for a third of a second where',
      'concrete is gone in a twentieth, and that ring is the whole signature (§3.9 normalizes the',
      'attack precisely so the multiplier is the only level difference). If the segments differ',
      'mainly in how loud they are, the normalization has come undone.',
    ],
    cues: materials.flatMap((m) => materialSegment(m.name, m.at)(m.surface)),
    after: ({ log }) => {
      const sounded = new Set(log.filter((e) => e.audible).map((e) => e.mat));
      const silent = materials.filter((m) => !sounded.has(m.name)).map((m) => m.name);
      return [
        {
          label: 'each surface the scene staged is the surface that sounded',
          ok: silent.length === 0,
          detail:
            silent.length === 0
              ? `${[...sounded].join(', ')}`
              : `staged ${materials.map((m) => m.name).join(', ')} but heard ${[...sounded].join(', ')}`,
        },
      ];
    },
  });

  scenes.push({
    file: '04-drop.wav',
    title: 'a walk, and then a fall onto the same floor',
    seconds: 9,
    listenFor: [
      'A second and a half of ordinary walking first, so the ear has a reference, and then the',
      'body is lifted to the top of the clear column above it and dropped onto that same floor.',
      'The landing is the widest radius on §3.3’s table — it carries further than a Q-ping — and',
      'it has to arrive as *mass*: a low thump with the surface underneath it, not a louder',
      'footstep. If a landing and a sprint-step sound like the same event at two volumes, the',
      'thing law 4 asks for — a threat you hear before it reaches you — has nothing to work with.',
      'Note what is *not* here: a jump in place makes no sound at all. A hop peaks at 0.22 m and',
      'lands under the minimum impact a landing needs, so the fall is the only landing in the file.',
    ],
    cues: [
      [0.3, hold('forward')],
      [1.8, release('forward')],
      [3.0, (s) => s.dropFromCeiling()],
    ],
    after: ({ staged, sim }) => {
      const back = sim.player.position.y;
      const off = staged.dropped === undefined ? Infinity : Math.abs(back - staged.dropped.from);
      return [
        {
          label: 'the fall ended on the floor it started from',
          ok: off < 0.1,
          detail:
            staged.dropped === undefined
              ? 'the scene never staged a drop'
              : `left ${staged.dropped.from.toFixed(2)} m, dropped from ${staged.dropped.to.toFixed(2)} m, landed ${back.toFixed(2)} m`,
        },
      ];
    },
  });

  /*
   * §3.3's throwable rows, in the order one throw produces them.
   *
   * They are a scene of their own rather than another segment of 03 because every sound above
   * this line is a sound the body makes *at* the body — the ear is always within a metre of the
   * source, and distance is a thing the file asserts rather than a thing you hear. A sphere is
   * the first sound in the game that happens somewhere the player is not, and the only way to
   * judge whether that reads is to hear one arm, one flight and one boom as a single continuous
   * event with the metres audible in it.
   *
   * Everything here is the shipped path: `ScriptedInput` holds and releases the throw action on
   * the real `GameSim`, `game/spheres.ts` charges the arm and integrates the ballistics, and
   * `game/sim.ts` turns its contact records into bus events. Nothing in this file emits a sphere.
   */
  scenes.push({
    file: '05-throw.wav',
    title: 'the arm: a tap, a charge held to the click, and the silence after each',
    seconds: 8,
    // Guards about a sound rather than about the staging, so a Halo-free render to measure them
    // against. See the run loop for why that is necessary, and what the hum does to these
    // particular numbers if you skip it.
    measured: true,
    listenFor: [
      'One whole turn of the verb, twice, in the order a player performs it. First a tap: the arm',
      'starts with a dry tick at your own shoulder that carries 2.5 m and no further, and a sphere',
      'goes down the lane. One boom where it arrives — and then nothing.',
      'That nothing is the scene. A sphere is gone the instant it touches anything: there is no',
      'bounce, no skitter, no settle a second later, no tail addressed to the thrower. Two full',
      'seconds of room follow the first boom and they are empty, and if you ever hear a second',
      'sound out of one throw then something has survived its own contact.',
      'Then the charged throw, and the thing to count rather than listen to. Two ticks 0.9 s',
      'apart: the arm starting, and full tension. They are the same sound — one class, one voice,',
      'no second timbre for "ready" — so the *gap* is the meter and the second tick is the',
      'readout. There is no charge bar in this game, and anything within 2.5 m heard you wind it.',
      'Then a long flight, silent all the way, and one boom much further out than the first.',
      'The two booms are the same voice at two distances and nothing else: the boom is the',
      "sphere's own detonation, not the floor's (§3.3), so what changes between them is carry",
      'over distance and your sense of where the room is. 06 is that claim, controlled.',
      'And the judgement the guards below cannot make for you, which is the whole point of §14:',
      'is that a charge going off, or a weapon? It has to land as *pressure* — weight arriving,',
      'a room-sized thump you feel the size of, decaying over a second like something that moved',
      'air. If it ever reads as a crack, a snap or a hit — a sharp front, a bright edge, an',
      'impact against a surface — then the loudest thing a player owns has started sounding like',
      'a way to hurt the spider, and every player will start aiming at it instead of past it.',
    ],
    cues: [
      // A tap, level, straight down the spawn lane. `SPHERE_THROW_MIN` and no charge worth the
      // name: the throw a player makes without thinking about it, and therefore the one that has
      // to be legible with nothing held down to read.
      [0.4, hold('throw')],
      [0.45, release('throw')],
      // Nothing at all until 3.4 s. The empty stretch is load-bearing: it is the only way a file
      // can argue that a thrown thing made *one* sound, and it has to be long enough that a
      // listener stops expecting a second one.
      [3.4, hold('throw')],
      // Held 1.3 s, comfortably past `SPHERE_CHARGE_SECONDS`. Not "long enough to charge" — long
      // enough that the click lands well inside the hold, so a listener can hear that the arm
      // went quiet again afterwards, and that holding longer buys nothing but noise already made.
      [4.7, release('throw')],
    ],
    after: ({ sim, log, voices }) => {
      const winds = log.filter((e) => e.cls === 'throw-windup').map((e) => e.t);
      const booms = log.filter((e) => e.cls === 'sphere-boom');
      const after = booms.length === 0 ? [] : log.filter((e) => e.t > booms[0].t && e.t < 3.3);
      /*
       * The measuring apparatus, on the Halo-free render.
       *
       * A quarter-second rather than the attack window for the two level questions. The body of
       * the boom is filtered noise, and one 85 ms slice of one slot of the noise bank sits up to
       * a decibel off the class's own mean; a quarter-second holds the whole front and body and
       * averages more of the realisation. It does not remove the difference — both booms are the
       * same envelope over *different* slots, so what is left is a fixed per-pair offset that
       * every window length reports identically (0.36 dB here, at 0.085 s and at 0.5 s alike).
       * The tolerance covers that rather than pretending it away.
       */
      const LEVEL_WINDOW = 0.25;
      const LEVEL_TOL_DB = 1.5;
      /** How far into the decay the "is this a click" question is asked, and the line it draws. */
      const DECAY_AT = 0.3;
      const DECAY_LINE_DB = 30;
      // The mixdown, not channel 0: spatialization is M2 and the two channels are identical
      // today, but the day a `PannerNode` lands, a level read off one channel is a level plus a
      // pan, and every claim below would quietly become a claim about where the sphere went.
      const db = (t, win) => metrics.rmsDb(voices, undefined, t, t + win);
      /** A 100 ms window `offset` into a sound, in dB relative to that sound's own attack. */
      const rel = (t, offset) => db(t + offset, 0.1) - db(t, ATTACK_WINDOW_SEC);
      /** The first `n` of those, as a printable line — the decay a reader can see the shape of. */
      const shape = (t, n) =>
        Array.from({ length: n }, (_, i) => rel(t, i * 0.1).toFixed(1)).join(' ');
      /** The share of a sound's attack energy inside a band, 0–1. */
      const share = (t, lo, hi) => metrics.bandShare(voices, t, t + ATTACK_WINDOW_SEC, lo, hi);
      const tick = winds[0] ?? null;
      const [near, far] = booms;
      const two = booms.length === 2 && tick !== null;
      return [
        /*
         * The check that matters most in this scene, and the reason it is written down rather
         * than left to the ear. Every guard below the staging block passes on a scene that threw
         * nothing at all: a body standing still on concrete still makes sound, still does not
         * clip and still is not silence. Only the rack knows whether the arm ever moved.
         */
        {
          label: 'two spheres left the rack and neither came back',
          ok: sim.spheres.thrown === 2 && sim.spheres.carried === 2 && sim.spheres.refused === 0,
          detail:
            `thrown ${sim.spheres.thrown}, rack ${sim.spheres.carried}, ` +
            `refused ${sim.spheres.refused}, ${sim.spheres.inWorld} still in the air`,
        },
        {
          label: 'the arm wound twice and reached full tension once',
          ok: winds.length === 3,
          detail:
            winds.map((t) => `${t.toFixed(2)}s`).join(', ') +
            (winds.length === 3 ? ` — ${(winds[2] - winds[1]).toFixed(2)} s of held charge` : ''),
        },
        {
          // One throw, one sound, and the sound is the sphere's own: `sphere-boom` is not a
          // contact class, so it names no material and nothing scales it (§3.3, §3.9). A boom
          // that arrived carrying a material would be the surface speaking through it.
          label: 'each throw made exactly one boom, and the boom belongs to no surface',
          ok: booms.length === 2 && booms.every((b) => b.audible && b.mat === null),
          detail:
            booms.map((b) => `${b.t.toFixed(2)}s at ${b.d.toFixed(2)} m`).join(', ') ||
            'no booms',
        },
        {
          // The negative half, asked of the bus rather than of the ear. Nothing survives its own
          // contact, so between the first boom and the second wind-up the world has nothing to
          // say — no second impact, no settle, no knock. A tail here is a sphere that lived.
          label: 'and nothing at all followed it',
          ok: booms.length === 2 && after.length === 0,
          detail:
            after.length === 0
              ? `${(3.3 - (booms[0]?.t ?? 0)).toFixed(2)} s of empty room after the first boom`
              : `${after.length} event(s) after it: ${after.map((e) => e.cls).join(', ')}`,
        },
        /*
         * ---- and here the scene stops counting sounds and starts measuring one. ----
         *
         * What the three guards below have in common, and the reason they are not a second copy
         * of `tests/audio/boomVoice.test.ts`: each is a *difference between two sounds in this
         * one render*. The suite can build a detonation and pin it to a tenth of a decibel, but
         * it has no simulation, so it cannot throw twice from one arm at two distances it did
         * not choose and then ask whether the pair came out in the ratio the metres demand. That
         * relation, and the one between the boom and the tick that launched it, is where the
         * interesting facts about a detonation actually live.
         *
         * All three read the Halo-free render (`measured`, above). They are also all written to
         * fall over cleanly on a scene that threw nothing: `two` is false, the guard fails, and
         * the detail says which half of the scene went missing rather than reporting a decibel
         * measured off silence.
         */
        {
          /*
           * §3.3 arriving at the ear. The boom is the sphere's own voice (no material, fixed
           * 32 m carry), so the *only* thing that differs between these two is where the sphere
           * was when it went off: `gainFor` is carry over distance, the carries are identical,
           * and the prediction is the plain ratio of the metres. Both throws land well outside
           * `NEAR_FIELD_M`, which is checked rather than assumed — inside that clamp level stops
           * following distance at all and this guard would be passing for the wrong reason.
           *
           * Note what it is blind to, so nobody reads more into it than it says: a `gainFor`
           * that ignored `hearingRadius` entirely would scale both booms the same way and sail
           * through. The guard after this one is the one that would notice.
           */
          label: 'the two booms are one voice at two distances',
          ok:
            two &&
            Math.min(near.d, far.d) > NEAR_FIELD_M &&
            Math.abs(
              db(near.t, LEVEL_WINDOW) - db(far.t, LEVEL_WINDOW) -
                20 * Math.log10(far.d / near.d),
            ) <= LEVEL_TOL_DB,
          detail: !two
            ? 'the scene did not produce two booms and a wind-up'
            : `${(db(near.t, LEVEL_WINDOW) - db(far.t, LEVEL_WINDOW)).toFixed(2)} dB apart, ` +
              `${(20 * Math.log10(far.d / near.d)).toFixed(2)} dB from ` +
              `${near.d.toFixed(2)} → ${far.d.toFixed(2)} m`,
        },
        {
          /*
           * The carry column reached the mixer. A wind-up carries 2.5 m and a boom 32, and the
           * whole of §3.3's right-hand side is worth nothing if the number never becomes a level
           * — so the loudest deliberate act in the game has to tower over the arm that performed
           * it, in the same file, seconds apart, at distances the scene can print.
           *
           * An ordering and deliberately not a law. The two are different voice kinds, and their
           * builders are not levelled against each other: at unit gain the two *pings* alone sit
           * 6.6 dB apart, so asserting the exact 14.5 dB their carries and distances predict
           * would be asserting that `boomVoice` and `pingVoice` were built to a shared loudness
           * nothing in the mixer promises. The floor is set below the gap that measures (12.6 dB)
           * by more than any plausible retune of either voice, and above nothing at all.
           */
          label: 'and the boom towers over the arm that threw it',
          ok: two && db(near.t, LEVEL_WINDOW) - db(tick, LEVEL_WINDOW) >= 8,
          detail: !two
            ? 'no wind-up to compare against'
            : `boom ${db(near.t, LEVEL_WINDOW).toFixed(2)} dBFS over ${near.d.toFixed(2)} m, ` +
              `wind-up ${db(tick, LEVEL_WINDOW).toFixed(2)} dBFS at the shoulder — ` +
              `${(db(near.t, LEVEL_WINDOW) - db(tick, LEVEL_WINDOW)).toFixed(2)} dB`,
        },
        {
          /*
           * §14, measured: loud is not lethal. A detonation that hurt would announce it the two
           * ways a synthesised one can — a crack on top, and a click instead of a decay — and
           * this is both of those asked at once, with the wind-up standing in as the file's own
           * example of each. The tick is bright where the boom is not (3 % of its attack energy
           * below 120 Hz against the boom's 53 %) and it is *gone* where the boom is still going
           * (37 dB down at 300 ms against the boom's 22), so one line at 30 dB separates them.
           *
           * The two absolute pins here are the loose ends of `DETONATION` in `audioSpec.ts` on
           * purpose: this is the same sound through the whole mixer and a 16-bit encode rather
           * than alone at unit gain, and a tool that pinned it tighter than the suite would be
           * the second, weaker copy the file header refuses to become.
           */
          label: 'and it is a charge going off, not a weapon: weight underneath, no crack on top',
          ok:
            two &&
            booms.every((b) => share(b.t, 0, 120) > 0.4) &&
            booms.every((b) => share(b.t, 2000, 24000) < 1e-4) &&
            share(tick, 0, 120) < 0.1 &&
            booms.every((b) => rel(b.t, DECAY_AT) > -DECAY_LINE_DB) &&
            rel(tick, DECAY_AT) < -DECAY_LINE_DB &&
            // Monotone for a second: a detonation dies away, and anything that comes back up is
            // something that survived its own contact — the negative the whole scene is built on.
            booms.every((b) =>
              [1, 2, 3, 4, 5, 6, 7, 8, 9].every(
                (i) => rel(b.t, i * 0.1) < rel(b.t, (i - 1) * 0.1) + 0.5,
              ),
            ),
          detail: !two
            ? 'nothing to measure'
            : `below 120 Hz: booms ${booms.map((b) => share(b.t, 0, 120).toFixed(2)).join('/')} ` +
              `vs tick ${share(tick, 0, 120).toFixed(2)}; above 2 kHz ` +
              `${booms.map((b) => share(b.t, 2000, 24000).toExponential(1)).join('/')}; ` +
              // Four windows for the tick and six for the boom, because the fifth window after
              // the tick is the boom: this scene throws 0.49 s after the arm starts, and a
              // printed decay that walked into the next sound would look like a rebound.
              `decay/100 ms ${shape(near.t, 6)} vs tick ${shape(tick, 4)}`,
        },
      ];
    },
  });

  /*
   * The boom against every floor the room owns — a scene written to come out the same four times.
   *
   * §3.3 gives `sphere-boom` a fixed 12 m of paint and 32 m of carry and no material column, and
   * §3.9's multipliers scale contact sounds only. A sphere is not a can: it does not strike a
   * surface so much as stop existing against one, and the noise it makes is its own. So the
   * surface underneath a boom has no vote, and this file is how that is checked by ear.
   *
   * It is deliberately a negative result. 03 and the old throw-materials scene were written so
   * that a listener could tell four surfaces apart; this one is written so that they cannot, and
   * the moment anyone can, something has handed the boom a material it must not have.
   *
   * The body is set down 5 cm onto each surface where 03 drops it 1.6 m. 03 wants that landing —
   * a landing is the loudest thing a *surface* says and the fastest way to learn its voice. Here
   * it would be the loudest thing in the segment and it would be the body's voice, sitting on top
   * of the one sound the whole scene exists to compare.
   */
  const lobs = materials.map((m, i) => ({ ...m, at: 0.4 + i * 3.2 }));
  scenes.push({
    file: '06-boom-materials.wav',
    title: `the same boom over ${lobs.map((m) => m.name).join(' → ')}`,
    seconds: (lobs[lobs.length - 1]?.at ?? 0) + 2.6,
    // Measured, for one guard: the negative result this scene exists for is a statement about
    // four *levels*, and through the Halo it would be a statement about four levels plus a tone.
    measured: true,
    note:
      missing.length > 0
        ? `no surface in this room to throw at for: ${missing.join(', ')}`
        : null,
    listenFor: [
      'The same sphere, thrown identically, onto each floor the room has. The body stands on the',
      'surface and lobs it a metre along that same surface, so the ear is the same distance from',
      'all four booms — `gainFor` is carry over distance, and with the distance held equal the',
      'carry figures in the timeline *are* the level, exactly and nothing else.',
      'What you are listening for is that nothing changes. Four booms over four different floors,',
      'and steel, stone, concrete and dust get no say in any of them: the boom is the sphere',
      "going off, not the floor being struck, and §3.3 gives it no material column to read.",
      'If you can tell which segment is the steel one, a contact voice has leaked into a',
      'non-contact class and §3.9 is now scaling something it was never meant to touch.',
      'Note also what each segment does *not* end with. There is no settle, no second tick, no',
      'tail — four sounds in the whole file, one per throw, and long quiet stretches between them.',
    ],
    cues: lobs.flatMap((m) => [
      [m.at, (s) => s.placeOn(m.surface, 0.05)],
      /*
       * 60° down. Steep enough that the sphere is on the ground inside a second and never leaves
       * the surface its segment staged — a sphere that clears the bench and goes off on the floor
       * is a segment arguing about two surfaces at once. The tap that follows carries it about a
       * metre, which is far enough out that the boom is a place in the room rather than a noise
       * at the ear, and short enough to stay on the smallest surface the room offers.
       */
      [m.at + 0.25, (s) => s.turn(0, -60)],
      [m.at + 0.45, hold('throw')],
      [m.at + 0.55, release('throw')],
    ]),
    after: ({ log, voices }) => {
      const booms = log.filter((e) => e.cls === 'sphere-boom');
      /** The quarter-second the level is read over — 05's window, for 05's reason. */
      const LEVEL_WINDOW = 0.25;
      const levels = booms.map((b) => metrics.rmsDb(voices, undefined, b.t, b.t + LEVEL_WINDOW));
      const spread = levels.length === 0 ? Infinity : Math.max(...levels) - Math.min(...levels);
      /** Did this boom happen over the footprint of the surface its segment staged? */
      const over = (b, surface) => {
        const box = surface.box;
        return (
          b.x >= box.minX - 0.05 &&
          b.x <= box.maxX + 0.05 &&
          b.z >= box.minZ - 0.05 &&
          b.z <= box.maxZ + 0.05 &&
          Math.abs(b.y - (box.maxY + SPHERE_RADIUS)) < 0.05
        );
      };
      const placed =
        booms.length === lobs.length && booms.every((b, i) => over(b, lobs[i].surface));
      const reach = booms.map((b) => b.d);
      const dSpread = booms.length === 0 ? Infinity : Math.max(...reach) - Math.min(...reach);
      const carries = [...new Set(booms.map((b) => b.carries.toFixed(3)))];
      return [
        {
          label: 'each sphere went off over the surface its segment staged',
          ok: placed,
          detail:
            booms.length === 0
              ? `staged ${lobs.map((m) => m.name).join(' → ')}, nothing went off`
              : booms
                  .map((b, i) => `${lobs[i]?.name ?? '?'} at y=${b.y.toFixed(2)}`)
                  .join(', '),
        },
        {
          /*
           * The comparison is fair only if the ear was equally far from every boom. Level is
           * carry over distance, so a segment that flew a hand's breadth further would be
           * quieter for a reason that has nothing to do with the floor — and the file would then
           * be making the opposite of the argument it was written to make, inaudibly.
           */
          label: 'every segment threw the same throw',
          ok: dSpread < 0.01,
          detail: booms.map((b) => `${b.d.toFixed(3)} m`).join(', ') || 'no booms',
        },
        {
          /*
           * And the point of the scene, in one line. Same class, same carry, no material, equal
           * distance: four identical inputs to `voiceFor`, so four identical sounds. The day a
           * material reaches this event, this is the guard that says so rather than the ear.
           */
          label: 'and the four booms are one sound, four times',
          ok:
            booms.length === lobs.length &&
            carries.length === 1 &&
            booms.every((b) => b.mat === null),
          detail:
            `${booms.length} boom(s), carrying ${carries.join(' / ')} m, ` +
            `material ${[...new Set(booms.map((b) => String(b.mat)))].join('/')}`,
        },
        {
          /*
           * The same claim asked of the render instead of the log, because they can fail apart.
           * The guard above proves the *event* named no material; this one proves nothing
           * downstream of it invented one. A boom that reached `materialVoiceFor` on its way to
           * the mixer would carry §3.9's multipliers into a class the table gives no column, and
           * these four levels would spread across the whole band — metal's ×1.5 is +3.5 dB and
           * dust's ×0.6 is −4.4, so steel and dust alone would stand 8 dB apart.
           *
           * What is left when nothing leaks is the noise bank: each boom draws a different slot,
           * and one 0.25 s window of one slot sits a few tenths off the class's mean. That is the
           * 0.9 dB these four measure, it is unordered with respect to the materials, and it is
           * the only reason this is a tolerance rather than an equality. It cannot be tightened
           * to zero by any means available here — two booms are bit-identical only if they draw
           * the same slot, and the sequence counter guarantees they never do.
           */
          label: 'and they arrive at one level, four times',
          ok: booms.length === lobs.length && spread < 2,
          detail:
            levels.length === 0
              ? 'no booms to measure'
              : levels.map((v, i) => `${lobs[i]?.name ?? '?'} ${v.toFixed(2)}`).join(', ') +
                ` dBFS — ${spread.toFixed(2)} dB apart`,
        },
      ];
    },
  });

  return scenes;
}

// ---------------------------------------------------------------------------
//  run
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const onlyAt = args.indexOf('--only');
const only = onlyAt === -1 ? null : args[onlyAt + 1];
const withHum = !args.includes('--no-hum');
const positional = args.filter(
  (a, i) => !a.startsWith('--') && !(onlyAt !== -1 && i === onlyAt + 1),
);
const outDir = resolve(positional[0] ?? process.env.BLINDSPOT_EARS ?? 'ears');
await mkdir(outDir, { recursive: true });

const failures = [];
const check = (label, ok, detail) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(label);
};

const probe = createHeadlessGame({ seed: SEED, hz: SIM_HZ });
const scenes = buildScenes(probe.sim.world, probe.sim.movement).filter((s) => only === null || s.file.includes(only));
if (scenes.length === 0) {
  console.error(`[listen] no scene matches --only ${only}`);
  process.exit(2);
}

for (const scene of scenes) {
  const r = await renderScene(scene, withHum);
  const { data, clamped } = encodeWav(r.buffer);
  await writeFile(join(outDir, scene.file), data);
  const s = survey(r.buffer);
  /*
   * The measurement render: the same scene again with §3.8's readout off, for the scenes whose
   * guards are about a level rather than about the staging.
   *
   * Not an optimisation and not a purity gesture — the hum makes the numbers wrong, and by a lot.
   * It sits level with a walk-step's attack and ducks under events by an amount that depends on
   * what it is ducking under, so a window taken through it is the sound plus an unknown fraction
   * of a 55 Hz tone. Measured on 05: the two booms are 7.05 dB apart in the Halo-free render
   * against a distance law that says 7.41, and 0.68 dB apart through the hum. The decay is worse
   * — the same boom's envelope *rises* 6 dB over its first half-second through the hum, because
   * what the window is following is the tone coming back up out of its duck.
   *
   * Safe because the scene is deterministic: same seed, same rate, same cues, and the readout is
   * a mixer voice that no part of the simulation can hear. The two renders are the same events by
   * construction, and the guard below checks it rather than trusting it.
   */
  const measure = scene.measured && withHum ? await renderScene(scene, false) : r;
  const staging = scene.after
    ? scene.after({ staged: r.staged, sim: r.sim, log: r.log, voices: measure.buffer })
    : [];

  console.log(
    `\n[listen] ${scene.file} — ${scene.title} (${scene.seconds.toFixed(1)} s)` +
      (withHum ? '' : ', Halo off'),
  );
  if (scene.note) console.log(`  note: ${scene.note}`);
  console.log('  timeline');
  for (const line of annotate(r.log)) console.log(line);
  console.log(
    `    Halo swept ${r.halo.min.toFixed(1)}–${r.halo.max.toFixed(1)} m ` +
      `(${humPitch(r.halo.min).toFixed(0)}–${humPitch(r.halo.max).toFixed(0)} Hz)`,
  );
  console.log('  listen for');
  for (const line of scene.listenFor) console.log(`    ${line}`);

  check(`${scene.file}: the scene made sound`, r.heard > 0, `${r.heard} audible event(s)`);
  check(
    `${scene.file}: every audible event became a voice`,
    r.played === r.heard && r.dropped === 0,
    `heard ${r.heard}, played ${r.played}, dropped ${r.dropped}`,
  );
  check(`${scene.file}: the mixer had nothing to report`, r.failure === null, r.failure ?? 'no failure');
  check(
    `${scene.file}: the Halo hum is ${withHum ? 'running' : 'off'}`,
    r.humming === withHum,
    withHum ? `${humPitch(r.halo.max).toFixed(0)} Hz at the top` : 'the voices, unaccompanied',
  );
  check(`${scene.file}: no NaN in the render`, !s.nan);
  check(
    `${scene.file}: nothing clipped`,
    clamped === 0 && s.peakDb < 0,
    `peak ${s.peakDb.toFixed(2)} dBFS, ${clamped} sample(s) over full scale`,
  );
  check(
    `${scene.file}: not silence`,
    s.peakDb > -60,
    `peak ${s.peakDb.toFixed(2)} dBFS, rms ${s.rmsDb.toFixed(2)} dBFS`,
  );
  /*
   * The clock guard. An `OfflineAudioContext` reports `currentTime === 0` for its whole life, so
   * the failure mode this tool is one proxy away from is every voice in the scene landing on
   * sample zero in a heap — which still counts right, still does not clip, and still is not
   * silence. What it is not is a timeline. The loudest instant in the render has to be an event
   * the simulation logged, so this asks where the peak fell and whether any audible event is
   * near it. Loose on purpose: it is checking that the clock is connected, not what the mix is.
   */
  const nearest = r.log
    .filter((e) => e.audible)
    .reduce((best, e) => Math.min(best, Math.abs(s.peakAt - e.t)), Infinity);
  check(
    `${scene.file}: the loudest instant is one of the events`,
    nearest <= 0.15,
    `peak at ${s.peakAt.toFixed(2)}s, nearest event ${nearest === Infinity ? 'none' : `${nearest.toFixed(3)}s away`}`,
  );
  if (measure !== r) {
    /*
     * The substitution, checked rather than assumed. Everything the scene goes on to say about a
     * level is said about a render the listener never hears, and the only thing that makes that
     * legitimate is the two renders being the same run. Same count, same classes, same instants,
     * same metres: if the Halo ever grew a way to reach the simulation, this is the line that
     * notices, and every number underneath it would otherwise be about a different throw.
     */
    const key = (e) => `${e.cls}@${e.t.toFixed(4)}/${e.d.toFixed(4)}`;
    const same =
      measure.log.length === r.log.length && measure.log.every((e, i) => key(e) === key(r.log[i]));
    check(
      `${scene.file}: the measured render is the same scene`,
      same,
      same
        ? `${r.log.length} event(s), identical in both renders`
        : `${r.log.length} event(s) with the Halo on, ${measure.log.length} with it off`,
    );
  }
  for (const c of staging) check(`${scene.file}: ${c.label}`, c.ok, c.detail);
  const trip = roundTripError(r.buffer, data);
  check(
    `${scene.file}: the file is the render`,
    trip.why === null && trip.steps <= 1,
    trip.why ?? `worst ${trip.steps.toFixed(2)} of one 16-bit step over ${r.buffer.length} frames`,
  );
}

if (failures.length > 0) {
  console.error(`\n[listen] FAILED — ${failures.length} guard(s)`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`\n[listen] OK — ${scenes.length} file(s) in ${outDir}. Now go and play them.`);
