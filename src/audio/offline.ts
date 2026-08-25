/**
 * The proof rig: the mixer, rendered without a device.
 *
 * A sound cannot be screenshotted, so this renders fixed scenes of bus events through the *same*
 * synthesis the player hears (`buildTimbre`, `timbreFor`, the same distance mapping) into an
 * `OfflineAudioContext`, and hands back a WAV. `tools/audio.mjs` writes those WAVs, measures
 * them, and draws spectrograms — so "the shot is an order of magnitude bigger than a click" and
 * "clicks exist at all" become numbers and pictures instead of claims.
 *
 * Everything here is deterministic: fixed scenes, fixed seq numbers, fixed sample rate, seeded
 * noise. Two runs are byte-identical.
 *
 * `legacy: true` re-creates the *previous* stage — the one where every source that was not a
 * footstep, a landing or a prop impact fell through to the footstep profile, and where amplitude
 * was `min(1, loudness / 26)`. It exists for exactly one purpose: to show, side by side, that
 * the rifle and the spiders were not quiet but *wrong*, and that no volume knob would have
 * reached them.
 */
import type { SoundEvent, SoundSource, SpiderKind } from '../events/bus';
import { MATERIALS, type MaterialName } from '../props/shapes';
import { refDistanceFor } from './audio';
import { applyDeafen, defaultDeafTunables } from './deafen';
import { buildTimbre, hash01, loudnessGain, makeNoiseBuffer, timbreFor } from './voices';

export interface SceneEvent {
  /** Seconds from the start of the scene. */
  t: number;
  source: SoundSource;
  x: number;
  y: number;
  z: number;
  loudness: number;
  material?: string;
  kind?: SpiderKind;
}

export interface Scene {
  readonly name: string;
  readonly what: string;
  readonly seconds: number;
  /** The ear, at the origin looking down -Z unless a scene says otherwise. */
  readonly ear?: { x: number; y: number; z: number };
  readonly events: readonly SceneEvent[];
}

const CLICK = 12;
const STEP_FLOOR = 1.6;
const STEP_METAL = 3.6;

/**
 * A pack talking somewhere off to your right, at five ranges. The last one is deliberately past
 * even the chatter's widened reach, so the scene still proves the cull.
 *
 * The ranges were 3/8/14/22 while the chatter died at 14; they now run out to 45, because the
 * complaint being answered is that the hall did not sound inhabited from across it.
 *
 * All scene coordinates are relative to the ear, which stands at eye height — so y = -1.4 is the
 * floor and y = -0.3 is a shelf lip.
 */
function clickTrain(): SceneEvent[] {
  const out: SceneEvent[] = [];
  const ranges = [3, 10, 20, 30, 45];
  ranges.forEach((r, i) => {
    // A phrase now runs up to about 0.7 s and its rhythm is deliberately ragged, so the three
    // phrases at one range are spaced far enough apart not to overlap each other, and the ranges
    // far enough apart that one range's tail cannot be measured as the next range's phrase. The
    // old 0.22/0.9 spacing did exactly that once the phrases got longer, and it read as the cull
    // failing when what had really happened was that the windows had gone stale.
    const t0 = 0.15 + i * 1.6;
    for (let k = 0; k < 3; k++) {
      out.push({
        t: t0 + k * 0.45, source: 'spider', kind: 'chatter',
        x: r * 0.7, y: -1.3, z: -r * 0.71, loudness: CLICK,
      });
    }
  });
  return out;
}

export const SCENES: readonly Scene[] = [
  {
    name: 'shot',
    what: 'one round at the muzzle: crack, blast, sub, and the hall answering',
    seconds: 1.6,
    events: [{ t: 0.1, source: 'gunshot', x: 0.1, y: -0.1, z: -0.45, loudness: 90 }],
  },
  {
    name: 'burst',
    what: 'three rounds and their impacts 12 m out - the price of looking',
    seconds: 2.4,
    events: [
      { t: 0.1, source: 'gunshot', x: 0.1, y: -0.1, z: -0.45, loudness: 90 },
      { t: 0.14, source: 'bullet-hit', x: 1.5, y: -0.6, z: -11.5, loudness: 15, material: 'steel' },
      { t: 0.42, source: 'gunshot', x: 0.1, y: -0.1, z: -0.45, loudness: 90 },
      { t: 0.46, source: 'bullet-hit', x: 2.5, y: -0.4, z: -11, loudness: 15, material: 'glass' },
      { t: 0.74, source: 'gunshot', x: 0.1, y: -0.1, z: -0.45, loudness: 90 },
      { t: 0.78, source: 'bullet-hit', x: 0.5, y: -1.0, z: -12, loudness: 15 },
    ],
  },
  {
    name: 'clicks',
    what: 'chatter at 3, 10, 20, 30 and 45 m - the last set is past even its widened reach',
    seconds: 8.4,
    events: clickTrain(),
  },
  {
    name: 'steps',
    what: 'a spider on concrete, the same spider on steel shelving, then your own boot',
    seconds: 3.2,
    events: [
      // Both at the same range, so the difference you hear is the material and nothing else. A
      // spider's footfall carries 1.6 m on concrete and 3.6 m on steel: this is close work.
      { t: 0.15, source: 'spider', x: 0.8, y: -1.2, z: -1.0, loudness: STEP_FLOOR, kind: 'step' },
      { t: 0.55, source: 'spider', x: 0.8, y: -1.2, z: -1.0, loudness: STEP_FLOOR, kind: 'step' },
      { t: 0.95, source: 'spider', x: 0.8, y: -1.2, z: -1.0, loudness: STEP_FLOOR, kind: 'step' },
      { t: 1.6, source: 'spider', x: 0.8, y: -1.2, z: -1.0, loudness: STEP_METAL, material: 'steel', kind: 'step' },
      { t: 2.0, source: 'spider', x: 0.8, y: -1.2, z: -1.0, loudness: STEP_METAL, material: 'steel', kind: 'step' },
      { t: 2.4, source: 'spider', x: 0.8, y: -1.2, z: -1.0, loudness: STEP_METAL, material: 'steel', kind: 'step' },
      { t: 2.9, source: 'player-step', x: 0, y: -1.5, z: 0, loudness: 9 },
    ],
  },
  {
    name: 'props',
    what: 'the clutter: glass, tin, steel, wood, plastic - one formula, five materials',
    seconds: 3.6,
    events: [
      { t: 0.1, source: 'prop-impact', x: 2, y: -1.4, z: -3, loudness: 14, material: 'glass' },
      { t: 0.75, source: 'prop-impact', x: 2, y: -1.4, z: -3, loudness: 11, material: 'tin' },
      { t: 1.4, source: 'prop-impact', x: 2, y: -1.4, z: -3, loudness: 18, material: 'steel' },
      { t: 2.05, source: 'prop-impact', x: 2, y: -1.4, z: -3, loudness: 9, material: 'wood' },
      { t: 2.7, source: 'prop-impact', x: 2, y: -1.4, z: -3, loudness: 6, material: 'plastic' },
    ],
  },
  {
    name: 'deafened',
    what: 'a pack chattering 6 m away, one shot at 1.0 s - the hall goes muffled and climbs back',
    seconds: 5.0,
    events: [
      ...Array.from({ length: 21 }, (_, i): SceneEvent => ({
        t: 0.15 + i * 0.22,
        source: 'spider',
        x: 4.2 * (i % 2 === 0 ? 1 : -1),
        y: -1.3,
        z: -4.2,
        loudness: CLICK,
        kind: 'chatter',
      })),
      { t: 1.0, source: 'gunshot', x: 0.1, y: -0.1, z: -0.45, loudness: 90 },
    ],
  },
  {
    /**
     * The concussion, given room to be seen. One round in an otherwise empty seven seconds, with
     * a click every second afterwards so the *world's* return is visible against the ring that is
     * still going. The spectrogram of this is the whole point of the pass: a narrow rough band
     * outlasting the ducking by three times over, with the hall crawling back underneath it.
     */
    name: 'concussion',
    what: 'one round, then seven seconds of being deaf: the hall falls through the floor and a rough band keeps ringing',
    seconds: 7,
    events: [
      { t: 0.4, source: 'gunshot', x: 0.1, y: -0.1, z: -0.45, loudness: 90 },
      ...Array.from({ length: 6 }, (_, i): SceneEvent => ({
        t: 1.0 + i, source: 'spider', kind: 'chatter',
        x: 3.0 * (i % 2 === 0 ? 1 : -1), y: -1.3, z: -3.4, loudness: CLICK,
      })),
    ],
  },
  {
    /**
     * The three voices of the animal side by side at the same range, in the same order every
     * time: talk, bite, death. The death cry has to stay the worst thing in the set — making the
     * chatter wetter must not have quietly promoted it.
     */
    name: 'voices',
    what: 'the same spider at 8 m: chatter, then a bite, then dying',
    seconds: 4.2,
    events: [
      { t: 0.2, source: 'spider', kind: 'chatter', x: 5.6, y: -1.2, z: -5.7, loudness: CLICK },
      { t: 1.5, source: 'spider', kind: 'bite', x: 5.6, y: -1.2, z: -5.7, loudness: 24 },
      { t: 2.8, source: 'spider', kind: 'death', x: 5.6, y: -1.2, z: -5.7, loudness: 24 },
    ],
  },
  {
    name: 'hall',
    what: 'everything at once: your boot, the clutter, the pack, a bite, a shot',
    seconds: 5.0,
    events: [
      { t: 0.2, source: 'player-step', x: 0, y: -1.5, z: 0, loudness: 9 },
      { t: 0.55, source: 'spider', x: 5, y: -1.3, z: -6, loudness: CLICK, kind: 'chatter' },
      { t: 0.8, source: 'player-step', x: 0, y: -1.5, z: 0, loudness: 9 },
      { t: 1.1, source: 'prop-impact', x: -3, y: -1.4, z: -4, loudness: 12, material: 'tin' },
      { t: 1.35, source: 'spider', x: -4, y: -1.3, z: -5, loudness: CLICK, kind: 'chatter' },
      { t: 1.6, source: 'spider', x: 1.4, y: -0.4, z: -1.1, loudness: STEP_METAL, material: 'steel', kind: 'step' },
      { t: 1.9, source: 'spider', x: 3, y: -1.3, z: -3.4, loudness: CLICK, kind: 'chatter' },
      { t: 2.2, source: 'spider', x: -2, y: -1.3, z: -2.6, loudness: CLICK, kind: 'chatter' },
      { t: 2.5, source: 'spider', x: 1.2, y: -1.1, z: -1.4, loudness: 24, kind: 'bite' },
      { t: 2.9, source: 'gunshot', x: 0.1, y: -0.1, z: -0.45, loudness: 90 },
      { t: 2.94, source: 'bullet-hit', x: 1.4, y: -1.1, z: -2.2, loudness: 15 },
      { t: 3.4, source: 'spider', x: -5, y: -1.3, z: -4, loudness: CLICK, kind: 'chatter' },
      { t: 3.9, source: 'prop-impact', x: 4, y: -1.4, z: -5, loudness: 16, material: 'glass' },
      { t: 4.3, source: 'spider', x: -1.5, y: -1.3, z: -2, loudness: CLICK, kind: 'chatter' },
    ],
  },
];

export interface RenderOptions {
  sampleRate?: number;
  volume?: number;
  /** Render through a reconstruction of the pre-M4b stage, for the before/after picture. */
  legacy?: boolean;
  /** The concussion after the blast; live defaults when omitted. */
  deafDepth?: number;
  deafSeconds?: number;
  deafCutoff?: number;
  tinnitus?: number;
  tinnitusSeconds?: number;
  tinnitusFreq?: number;
  /** Render only these scenes, by name — the main keyframe run takes a two-scene subset. */
  only?: readonly string[];
}

export interface RenderResult {
  name: string;
  what: string;
  sampleRate: number;
  seconds: number;
  /** 16-bit stereo WAV, base64 — small enough to hand back through the harness. */
  wav: string;
  /** Per-source counts, so a scenario can assert that every event was voiced. */
  voiced: Record<string, number>;
  culled: number;
}

/** The old stage's four numbers, kept only so the comparison is honest rather than remembered. */
const LEGACY_FOOTSTEP = { ring: 120, decay: 0.09, noise: 0.92, gain: 0.5 };
const LEGACY_LANDING = { ring: 90, decay: 0.16, noise: 0.9, gain: 0.8 };

function legacyProfile(ev: SoundEvent): { ring: number; decay: number; noise: number; gain: number } {
  if (ev.source === 'player-step') return LEGACY_FOOTSTEP;
  if (ev.source === 'player-land') return LEGACY_LANDING;
  const name = ev.material as MaterialName | undefined;
  const m = name !== undefined && name in MATERIALS ? MATERIALS[name] : undefined;
  if (m === undefined) return LEGACY_FOOTSTEP; // ← gunshot, bullet-hit and every spider sound
  return { ring: m.ring, decay: m.decay, noise: m.noise, gain: m.gain * 0.5 };
}

function legacyVoice(
  ctx: BaseAudioContext, dest: AudioNode, noise: AudioBuffer, ev: SoundEvent, t0: number,
): number {
  const prof = legacyProfile(ev);
  const amp = Math.min(1, ev.loudness / 26) * prof.gain;
  const dur = Math.min(1.6, prof.decay * 3 + 0.06);
  const g = ctx.createGain();
  g.gain.setValueAtTime(amp, t0);
  g.gain.exponentialRampToValueAtTime(0.0005, t0 + dur);
  g.connect(dest);

  const src = ctx.createBufferSource();
  src.buffer = noise;
  const band = ctx.createBiquadFilter();
  band.type = 'bandpass';
  band.frequency.value = Math.min(9000, prof.ring * 2.2);
  band.Q.value = 0.9;
  const bodyGain = ctx.createGain();
  bodyGain.gain.setValueAtTime(prof.noise, t0);
  bodyGain.gain.exponentialRampToValueAtTime(0.0005, t0 + Math.min(dur, 0.05 + prof.decay * 0.6));
  src.connect(band);
  band.connect(bodyGain);
  bodyGain.connect(g);
  const off = Math.max(0, hash01(ev.seq, 5) * (noise.duration - dur - 0.01));
  src.start(t0, off, dur);
  src.stop(t0 + dur);

  const osc = ctx.createOscillator();
  osc.type = 'triangle';
  const detune = 1 + (hash01(ev.seq, 9) - 0.5) * 0.12;
  osc.frequency.setValueAtTime(prof.ring * detune, t0);
  osc.frequency.exponentialRampToValueAtTime(prof.ring * detune * 0.86, t0 + dur);
  const ringGain = ctx.createGain();
  ringGain.gain.setValueAtTime(Math.max(0.03, 1 - prof.noise), t0);
  ringGain.gain.exponentialRampToValueAtTime(0.0005, t0 + dur);
  osc.connect(ringGain);
  ringGain.connect(g);
  osc.start(t0);
  osc.stop(t0 + dur);
  return t0 + dur;
}

/** Renders one scene to a base64 WAV. Runs in the page; needs no device and no gesture. */
export async function renderScene(scene: Scene, opts: RenderOptions = {}): Promise<RenderResult> {
  const rate = opts.sampleRate ?? 48000;
  const legacy = opts.legacy === true;
  const Ctor = (globalThis as unknown as { OfflineAudioContext?: typeof OfflineAudioContext })
    .OfflineAudioContext;
  if (Ctor === undefined) throw new Error('no OfflineAudioContext');
  const ctx = new Ctor(2, Math.ceil(scene.seconds * rate), rate);

  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -3;
  limiter.knee.value = 0;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.002;
  limiter.release.value = 0.22;
  limiter.connect(ctx.destination);

  const master = ctx.createGain();
  master.gain.value = opts.volume ?? 0.7;
  master.connect(limiter);

  const muffle = ctx.createBiquadFilter();
  muffle.type = 'lowpass';
  muffle.frequency.value = 20000;
  muffle.Q.value = 0.7;
  muffle.connect(master);

  const duck = ctx.createGain();
  duck.gain.value = 1;
  duck.connect(muffle);

  const ear = scene.ear ?? { x: 0, y: 1.6, z: 0 };
  const l = ctx.listener;
  if (l.positionX !== undefined) {
    l.positionX.value = ear.x;
    l.positionY.value = ear.y;
    l.positionZ.value = ear.z;
    l.forwardX.value = 0;
    l.forwardY.value = 0;
    l.forwardZ.value = -1;
    l.upY.value = 1;
  } else {
    (l as unknown as {
      setPosition(x: number, y: number, z: number): void;
      setOrientation(a: number, b: number, c: number, d: number, e: number, f: number): void;
    }).setPosition(ear.x, ear.y, ear.z);
  }

  const noise = makeNoiseBuffer(ctx);
  const voiced: Record<string, number> = {};
  let culled = 0;

  scene.events.forEach((se, i) => {
    // Scene coordinates are relative to the ear, which sits at eye height.
    const ev: SoundEvent = {
      source: se.source,
      x: ear.x + se.x,
      y: ear.y + se.y,
      z: ear.z + se.z,
      loudness: se.loudness,
      material: se.material,
      kind: se.kind,
      time: se.t,
      seq: i * 7 + 1,
    };
    const dist = Math.max(0.25, Math.hypot(ev.x - ear.x, ev.y - ear.y, ev.z - ear.z));
    const t0 = se.t;
    const timbre = timbreFor(ev);
    const reach = legacy ? 1 : timbre.reach ?? 1;
    if (dist > ev.loudness * 1.2 * reach) {
      culled++;
      return;
    }
    const blast = !legacy && timbre.blast === true;

    const panner = ctx.createPanner();
    panner.panningModel = 'HRTF';
    panner.distanceModel = 'inverse';
    panner.refDistance = legacy ? 1.2 : refDistanceFor(ev.loudness) * reach;
    panner.rolloffFactor = 1;
    panner.maxDistance = legacy ? 200 : Math.max(4, ev.loudness * 1.25 * reach);
    if (panner.positionX !== undefined) {
      panner.positionX.value = ev.x;
      panner.positionY.value = ev.y;
      panner.positionZ.value = ev.z;
    } else {
      (panner as unknown as { setPosition(x: number, y: number, z: number): void })
        .setPosition(ev.x, ev.y, ev.z);
    }
    panner.connect(blast ? master : duck);

    if (legacy) {
      legacyVoice(ctx, panner, noise, ev, t0);
    } else {
      buildTimbre(ctx, panner, timbre, noise, t0, loudnessGain(ev.loudness, timbre.ref), ev.seq);
      if (blast) {
        // The identical concussion the player gets — same module, same numbers. That identity is
        // the only reason the spectrograms below prove anything about the game.
        const d = defaultDeafTunables();
        applyDeafen(ctx, { duck, muffle, master }, noise, t0, {
          deafDepth: opts.deafDepth ?? d.deafDepth,
          deafSeconds: opts.deafSeconds ?? d.deafSeconds,
          deafCutoff: opts.deafCutoff ?? d.deafCutoff,
          tinnitus: opts.tinnitus ?? d.tinnitus,
          tinnitusSeconds: opts.tinnitusSeconds ?? d.tinnitusSeconds,
          tinnitusFreq: opts.tinnitusFreq ?? d.tinnitusFreq,
        });
      }
    }
    const key = legacy ? `${se.source}` : timbre.name;
    voiced[key] = (voiced[key] ?? 0) + 1;
  });

  const buf = await ctx.startRendering();
  return {
    name: scene.name,
    what: scene.what,
    sampleRate: rate,
    seconds: scene.seconds,
    wav: encodeWav(buf),
    voiced,
    culled,
  };
}

/** 16-bit PCM stereo WAV as base64. Node writes it straight out; no dependency either side. */
function encodeWav(buf: AudioBuffer): string {
  const ch = Math.min(2, buf.numberOfChannels);
  const n = buf.length;
  const bytes = new Uint8Array(44 + n * ch * 2);
  const view = new DataView(bytes.buffer);
  const ascii = (off: number, s: string): void => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + n * ch * 2, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, ch, true);
  view.setUint32(24, buf.sampleRate, true);
  view.setUint32(28, buf.sampleRate * ch * 2, true);
  view.setUint16(32, ch * 2, true);
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, n * ch * 2, true);
  const data: Float32Array[] = [];
  for (let c = 0; c < ch; c++) data.push(buf.getChannelData(c));
  let off = 44;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < ch; c++) {
      const v = Math.max(-1, Math.min(1, data[c]![i]!));
      view.setInt16(off, v < 0 ? v * 32768 : v * 32767, true);
      off += 2;
    }
  }
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

/** Everything the tool needs, in one call: every scene, in order. */
export async function renderAll(opts: RenderOptions = {}): Promise<RenderResult[]> {
  const out: RenderResult[] = [];
  const wanted = opts.only;
  for (const s of SCENES) {
    if (wanted !== undefined && !wanted.includes(s.name)) continue;
    out.push(await renderScene(s, opts));
  }
  return out;
}

/**
 * The shape of the pack's phrases, as numbers rather than as a sound.
 *
 * The complaint the M6c pass answers is "it sounds like a toy bell", and a bell is two things:
 * one pitch, and one interval. The pitch is visible in the spectrograms; the interval is not —
 * an even train and a torn one look nearly identical at spectrogram resolution. So the timbre
 * hands out the onset of every element it schedules (`Timbre.onsets`) and this walks a spread of
 * seeds and reports them, which lets `tools/audio.mjs` assert irregularity instead of claiming
 * it. Nothing in the game calls this; it exists for the proof.
 */
export function phraseShapes(count = 16): { seq: number; onsets: number[]; gaps: number[] }[] {
  const out: { seq: number; onsets: number[]; gaps: number[] }[] = [];
  for (let seq = 0; seq < count; seq++) {
    const t = timbreFor({
      source: 'spider',
      kind: 'chatter',
      x: 0,
      y: 0,
      z: 0,
      loudness: 12,
      time: 0,
      seq,
    });
    const onsets = [...(t.onsets ?? [])];
    const gaps: number[] = [];
    for (let i = 1; i < onsets.length; i++) gaps.push(onsets[i] - onsets[i - 1]);
    out.push({ seq, onsets, gaps });
  }
  return out;
}
