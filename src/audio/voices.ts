/**
 * The timbre table — what each kind of bus event *sounds* like.
 *
 * This file exists because of a specific failure: the player heard neither the rifle nor the
 * spiders. The old stage had exactly three voicings — a footstep, a landing, and a prop material
 * — and everything else fell through to the footstep. A gunshot was a footstep. A spider's click
 * was a footstep. That is why the rifle sounded like knocking on a wall and why the pack was
 * inaudible: not a volume problem, a *wrong sound* problem, so no amount of gain would have
 * fixed it.
 *
 * The rules here:
 *
 * **One event, one timbre, chosen from the event alone.** `timbreFor` is a pure function of the
 * `SoundEvent`. No scripted triggers, no per-emitter state, nothing the three consumers of the
 * bus could disagree about.
 *
 * **Layers, not samples.** A timbre is a short list of noise bursts and tones with envelopes.
 * Filtered noise gives the body, tones give the identity, the delays between them give the
 * rhythm (a spider "click" is really two to four ticks a few tens of milliseconds apart — that
 * pattern is what makes it read as a creature rather than as a knock).
 *
 * **Loudness is metres, not amplitude.** The bus contract says `loudness` is the range at which
 * a noise can be noticed. So it drives the *distance rolloff* (see `audio.ts`), and only a mild
 * within-source term of the amplitude, relative to that source's own `ref`. Otherwise a 90 m
 * gunshot and a 26 m thump end up at the same level, which is exactly what the old
 * `min(1, loudness / 26)` did — the rifle could not be louder than a heavy landing even in
 * principle.
 *
 * **Determinism.** Every random-looking choice comes from `event.seq` through `hash01`, so a
 * replayed scenario renders sample-identical. No `Math.random()`.
 */
import type { SoundEvent } from '../events/bus';
import { MATERIALS, type MaterialName } from '../props/shapes';

/** One element of a timbre: a filtered noise burst or a tone, with an exponential envelope. */
export interface Layer {
  readonly kind: 'noise' | 'tone';
  /** Seconds after the event's onset that this layer starts. */
  readonly delay: number;
  /** Peak level of the layer, relative to the timbre's own gain. */
  readonly gain: number;
  /** Seconds from onset to peak. Sub-millisecond for anything that should read as a transient. */
  readonly attack: number;
  /** Exponential decay time to silence, seconds. */
  readonly decay: number;
  /** Centre/cutoff frequency at onset, Hz. */
  readonly freq: number;
  /** Frequency at the end of the decay, if the layer sweeps. Real impacts fall in pitch. */
  readonly freqEnd?: number;
  /** Noise only: filter shape and resonance. */
  readonly filter?: BiquadFilterType;
  readonly q?: number;
  /** Tone only. */
  readonly wave?: OscillatorType;
}

export interface Timbre {
  /** Overall level before distance, 0..1. This is the perceptual weight of the source. */
  readonly gain: number;
  /**
   * The loudness (metres) at which this source sounds "normal". Louder-than-ref events of the
   * same source get proportionally more amplitude, quieter ones less — a steel-shelf spider step
   * over a concrete one, a hard prop impact over a nudge — without letting the metre scale set
   * the absolute level.
   */
  readonly ref: number;
  /** Total lifetime, seconds. The voice is held this long. */
  readonly dur: number;
  readonly layers: readonly Layer[];
  /**
   * True for the muzzle blast: it bypasses the ducking bus and then triggers it, so the shot
   * itself is at full size and the world after it is not.
   */
  readonly blast?: boolean;
  /** Short label for the offline renderer and the debug overlay. */
  readonly name: string;
  /**
   * For timbres that are a *phrase* rather than one hit (only the chatter, so far): the onset of
   * each element, seconds from the start. It exists so the rhythm can be *measured* — the ear's
   * keyframe run prints these intervals, because "it is not on a grid" is a claim about numbers
   * and the previous version failed it while sounding fine in a code review.
   */
  readonly onsets?: readonly number[];
}

/** Deterministic 0..1 from an integer. Cheap, well-mixed, and the same in every browser. */
export function hash01(n: number, salt = 0): number {
  let x = (n * 2654435761 + salt * 40503 + 0x9e3779b9) >>> 0;
  x ^= x >>> 15;
  x = Math.imul(x, 0x2c1b3c6d) >>> 0;
  x ^= x >>> 12;
  x = Math.imul(x, 0x297a2d39) >>> 0;
  x ^= x >>> 15;
  // `^=` hands back a *signed* 32-bit int, so the shift back to unsigned is not optional: a
  // negative "0..1" here reached a buffer offset and threw.
  return (x >>> 0) / 4294967296;
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/**
 * The muzzle blast. Four layers, and the order of them is the whole effect:
 *   crack — a couple of milliseconds of bright noise, then a 1.7 kHz snap behind it. This is the
 *           part that reads as "gun" and not as "thud"; without it a shot is a door slam.
 *   blast — the pressure wave: noise falling from 800 Hz to 160 Hz in a tenth of a second.
 *   punch — the sub, 120 Hz sliding to 40. What you feel rather than hear.
 *   room  — half a second of band-limited tail. The hall answering.
 * Together with the ducking in `audio.ts` this is the "разрыв пространства" the spec asks for:
 * huge, then everything else muffled for a beat. Peak stays under the limiter, so it is loud in
 * the way a mix is loud, not in the way clipping is loud.
 */
function gunshot(seq: number): Timbre {
  const v = hash01(seq, 11);
  return {
    name: 'gunshot',
    gain: 1,
    ref: 90,
    dur: 0.62,
    blast: true,
    layers: [
      { kind: 'noise', delay: 0, gain: 1, attack: 0.0004, decay: 0.014, freq: lerp(3200, 4200, v), q: 0.6, filter: 'highpass' },
      { kind: 'noise', delay: 0.0004, gain: 0.9, attack: 0.0005, decay: 0.035, freq: 1750, freqEnd: 800, q: 0.9, filter: 'bandpass' },
      { kind: 'noise', delay: 0.0008, gain: 0.85, attack: 0.0006, decay: 0.1, freq: 820, freqEnd: 160, q: 0.7, filter: 'lowpass' },
      { kind: 'tone', delay: 0.001, gain: 0.7, attack: 0.001, decay: 0.16, freq: lerp(115, 128, v), freqEnd: 40, wave: 'sine' },
      { kind: 'noise', delay: 0.02, gain: 0.3, attack: 0.012, decay: 0.44, freq: 900, freqEnd: 420, q: 0.45, filter: 'bandpass' },
    ],
  };
}

/**
 * The pack talking. «Переговариваются птичьими щелчками» — read literally, but read *alive*.
 *
 * Two verdicts shaped this. The first version was a row of band-passed noise ticks at a fixed
 * pitch and read as *equipment* — a Geiger counter in the dark. The second one fixed the pitch
 * by gliding it, and read as a *bell*: still a clean tone, still laid out on an even accelerating
 * grid, so the ear heard a musical instrument. Pitch + periodicity = instrument; that is the
 * whole diagnosis.
 *
 * So this version gives the call a body instead of a note:
 *
 *   - **no oscillators.** Every element is resonant noise (a bandpass at Q≈14 swept over its
 *     20 ms) rather than a triangle wave. A filtered hiss with a formant in it is a throat; a
 *     tone is a tuning fork. This is the single change that stops it sounding like a bell.
 *   - **no centre of pitch.** Each element lands anywhere across two thirds of an octave around
 *     the animal's own voice, so nothing in a phrase agrees on a key. The old version drifted
 *     the pitch up by a fixed 3.5% per element, which is a *scale*.
 *   - **breath.** A wide low hiss rides under each element, a sip fills every long gap, and the
 *     phrase ends on an audible exhale. That is the layer you hear *between* the clicks, and it
 *     is what makes the silence sound like an animal holding still rather than a device idling.
 *   - **a torn rhythm.** Gaps are drawn from three populations — a stutter (two calls almost on
 *     top of each other), an ordinary gap, and a pause where the thing stops to listen — so the
 *     intervals inside one phrase differ by an order of magnitude and never repeat. `onsets`
 *     records them so `tools/audio.mjs` can print the numbers instead of claiming it.
 *
 * The band, roughly 1.5-6 kHz, still sits where nothing else in the game lives (the rifle's body
 * is under a kilohertz, footsteps under 300 Hz, prop rings top out near 1.6 kHz), so the pack can
 * still be heard *through* a noisy hall — «главный способ их обнаружить».
 */
function chatter(seq: number): Timbre {
  const n = 3 + Math.floor(hash01(seq, 3) * 4);
  // The animal's own voice. Wide, because two spiders must not sound like one sound played twice.
  const base = lerp(1900, 4200, hash01(seq, 5));
  const layers: Layer[] = [];
  const onsets: number[] = [];
  let t = 0;
  for (let i = 0; i < n; i++) {
    const v = hash01(seq, 7 + i * 3);
    const w = hash01(seq, 8 + i * 3);
    const u = hash01(seq, 9 + i * 3);
    // The arc: quiet at the edges of the phrase, loudest a third of the way in.
    const arc = 0.55 + 0.45 * Math.sin(Math.PI * Math.min(1, (i + 0.6) / n));
    const g = arc * lerp(0.75, 1, w);
    // Each element picks its own formant. No ladder, no key.
    const f0 = base * lerp(0.66, 1.5, v);
    const span = lerp(1.3, 2.3, w);
    const f1 = u > 0.42 ? f0 * span : f0 / span;
    const dur = lerp(0.012, 0.03, v);
    onsets.push(t);
    // The mandible: the hard wet front edge of the call, gone in four milliseconds.
    layers.push({ kind: 'noise', delay: t, gain: g * 0.5, attack: 0.0003, decay: 0.004, freq: f0 * 1.45, q: 4, filter: 'bandpass' });
    // The call itself — a formant sweeping through noise. A throat, not an oscillator.
    layers.push({ kind: 'noise', delay: t + 0.001, gain: g, attack: 0.0012, decay: dur, freq: f0, freqEnd: f1, q: 14, filter: 'bandpass' });
    // A second, inharmonic resonance riding above it: what gives the sound a size.
    layers.push({ kind: 'noise', delay: t + 0.0015, gain: g * 0.42, attack: 0.002, decay: dur * 0.8, freq: f0 * 2.02, freqEnd: f1 * 1.94, q: 6, filter: 'bandpass' });
    // Air moving with the call.
    layers.push({ kind: 'noise', delay: t + 0.001, gain: g * 0.22, attack: 0.003, decay: dur * 1.7, freq: f0 * 0.72, freqEnd: f1 * 0.66, q: 2.2, filter: 'bandpass' });

    // The gap after this element, from three populations. Nothing about it is a grid.
    const j = hash01(seq, 23 + i * 5);
    const k = hash01(seq, 24 + i * 5);
    let gap: number;
    if (j < 0.3) gap = lerp(0.017, 0.034, k);        // a stutter, two calls almost on top
    else if (j > 0.78) gap = lerp(0.13, 0.21, k);    // it stops and listens
    else gap = lerp(0.045, 0.105, k);
    // A sip in the long gaps: the breath between calls, which is the half you never heard.
    if (gap > 0.12) {
      layers.push({ kind: 'noise', delay: t + dur + 0.012, gain: 0.15, attack: 0.035, decay: gap * 0.4, freq: 2400, freqEnd: 1200, q: 0.9, filter: 'bandpass' });
    }
    t += gap;
    // Phrases stay under about half a second whatever the dice say: a longer one starts
    // overlapping the next animal and the pack turns into a texture.
    if (t > 0.42) break;
  }
  // The exhale that closes the phrase. Slow attack, no transient — it is the opposite of a click,
  // which is exactly why it reads as a body.
  layers.push({ kind: 'noise', delay: t + 0.008, gain: 0.26, attack: 0.045, decay: 0.11, freq: 2700, freqEnd: 1250, q: 0.8, filter: 'bandpass' });
  // The 1.3 is not a loudness change, it is the price of the timbre change: a bandpass at Q=14
  // hands back a fraction of the energy an oscillator of the same nominal gain did, so without
  // this the pack would have gone 9 dB quieter for reasons that have nothing to do with design.
  // The measured peak of a 3 m phrase is back where it was. Range (`loudness`) is untouched —
  // that number belongs to the spiders.
  return { name: 'spider-chatter', gain: 1.75, ref: 12, dur: t + 0.26, layers, onsets };
}

/**
 * The bite, and — a longer, lower, collapsing version of it — dying. The loudest thing a spider
 * ever does either way, and the one that gives the pack away.
 */
function screech(seq: number, dying: boolean): Timbre {
  const v = hash01(seq, 31);
  if (dying) {
    return {
      name: 'spider-death',
      // Nudged with the chatter's own parity compensation (M6c). The talk got its lost 5 dB
      // back when it stopped being an oscillator, and the death cry has to stay the same
      // distance above the talk as it was — otherwise fixing the voice quietly makes dying
      // sound like a conversation. Range (`ref`, and the event's loudness) is untouched.
      gain: 1.2,
      ref: 24,
      dur: 0.8,
      layers: [
        { kind: 'noise', delay: 0, gain: 1, attack: 0.003, decay: 0.34, freq: lerp(2200, 2900, v), freqEnd: 420, q: 2.5, filter: 'bandpass' },
        { kind: 'tone', delay: 0, gain: 0.55, attack: 0.003, decay: 0.3, freq: lerp(1300, 1700, v), freqEnd: 190, wave: 'sawtooth' },
        // The body giving up: a dry clatter of legs under the cry.
        { kind: 'noise', delay: 0.12, gain: 0.4, attack: 0.004, decay: 0.16, freq: 1100, freqEnd: 300, q: 1.1, filter: 'bandpass' },
      ],
    };
  }
  return {
    name: 'spider-screech',
    // Same parity nudge as the death cry above, for the same reason.
    gain: 1.1,
    ref: 24,
    dur: 0.42,
    layers: [
      { kind: 'noise', delay: 0, gain: 1, attack: 0.002, decay: 0.2, freq: lerp(2600, 3400, v), freqEnd: 900, q: 3.5, filter: 'bandpass' },
      { kind: 'tone', delay: 0, gain: 0.5, attack: 0.002, decay: 0.16, freq: lerp(1500, 1900, v), freqEnd: 520, wave: 'sawtooth' },
      { kind: 'tone', delay: 0.006, gain: 0.32, attack: 0.002, decay: 0.13, freq: lerp(2050, 2600, v), freqEnd: 700, wave: 'square' },
    ],
  };
}

/**
 * Spider footfalls. «По железному стеллажу громче, чем по бетону» — and not merely louder: the
 * steel one is a bright tick with the shelving's own 240 Hz ring under it, the concrete one is a
 * dry scuff with no pitch at all. The loudness the swarm emits (3.6 vs 1.6 m) then scales it
 * further through `ref`, so the difference is both timbral and in level.
 */
function spiderStep(seq: number, metal: boolean): Timbre {
  const v = hash01(seq, 41);
  if (metal) {
    return {
      name: 'spider-step-steel',
      gain: 0.5,
      ref: 3.6,
      dur: 0.3,
      layers: [
        { kind: 'noise', delay: 0, gain: 1, attack: 0.0004, decay: 0.02, freq: lerp(2000, 2900, v), q: 3, filter: 'bandpass' },
        { kind: 'tone', delay: 0.001, gain: 0.4, attack: 0.001, decay: 0.14, freq: MATERIALS.steel.ring * lerp(0.94, 1.08, v), freqEnd: MATERIALS.steel.ring * 0.8, wave: 'triangle' },
      ],
    };
  }
  return {
    name: 'spider-step-floor',
    gain: 0.34,
    ref: 1.6,
    dur: 0.12,
    layers: [
      { kind: 'noise', delay: 0, gain: 1, attack: 0.0008, decay: 0.022, freq: lerp(900, 1500, v), q: 1.2, filter: 'bandpass' },
    ],
  };
}

/** Bullet impact: spall. Bright, dry, over in 40 ms; the material only tints it. */
function bulletHit(seq: number, material: MaterialName | undefined): Timbre {
  const m = material !== undefined ? MATERIALS[material] : undefined;
  const ring = m?.ring ?? 1400;
  const v = hash01(seq, 53);
  return {
    name: 'bullet-hit',
    gain: 0.72,
    ref: 15,
    dur: 0.24,
    layers: [
      { kind: 'noise', delay: 0, gain: 1, attack: 0.0003, decay: 0.018, freq: lerp(2400, 3600, v), q: 1.1, filter: 'bandpass' },
      { kind: 'noise', delay: 0, gain: 0.5, attack: 0.0006, decay: 0.05, freq: 620, freqEnd: 260, q: 0.7, filter: 'lowpass' },
      { kind: 'tone', delay: 0.0008, gain: m === undefined ? 0.18 : 0.42, attack: 0.0005, decay: (m?.decay ?? 0.1) * 0.5, freq: ring * lerp(0.95, 1.06, v), freqEnd: ring * 0.82, wave: 'triangle' },
    ],
  };
}

/**
 * Prop impacts, straight out of `MATERIALS` — the same five numbers the physics and the marker
 * mask read. Glass is a bright short ping over almost no noise, wood is a dead thud that is
 * almost all noise, steel rings low and long. Nobody authored a wav.
 */
function propImpact(seq: number, material: MaterialName | undefined): Timbre {
  const m = material !== undefined ? MATERIALS[material] : MATERIALS.wood;
  const detune = lerp(0.94, 1.06, hash01(seq, 61));
  return {
    name: `prop-${m.name}`,
    gain: Math.min(1, m.gain * 0.62),
    ref: 10,
    dur: Math.min(1.6, m.decay * 3 + 0.06),
    layers: [
      { kind: 'noise', delay: 0, gain: m.noise, attack: 0.0006, decay: 0.03 + m.decay * 0.35, freq: Math.min(9000, m.ring * 2.2), q: 0.9, filter: 'bandpass' },
      { kind: 'tone', delay: 0, gain: Math.max(0.05, 1 - m.noise), attack: 0.0008, decay: m.decay, freq: m.ring * detune, freqEnd: m.ring * detune * 0.86, wave: 'triangle' },
    ],
  };
}

/** The player's own body. Quiet on purpose: it is pure cost, and it must not mask the pack. */
function playerStep(seq: number): Timbre {
  const v = hash01(seq, 71);
  return {
    name: 'player-step',
    gain: 0.3,
    ref: 9,
    dur: 0.16,
    layers: [
      { kind: 'noise', delay: 0, gain: 1, attack: 0.001, decay: 0.035, freq: lerp(260, 400, v), q: 0.8, filter: 'lowpass' },
      { kind: 'noise', delay: 0.004, gain: 0.22, attack: 0.002, decay: 0.05, freq: lerp(1600, 2400, v), q: 0.8, filter: 'bandpass' },
    ],
  };
}

function playerLand(seq: number): Timbre {
  const v = hash01(seq, 79);
  return {
    name: 'player-land',
    gain: 0.55,
    ref: 12,
    dur: 0.34,
    layers: [
      { kind: 'noise', delay: 0, gain: 1, attack: 0.001, decay: 0.07, freq: lerp(200, 300, v), q: 0.7, filter: 'lowpass' },
      { kind: 'tone', delay: 0, gain: 0.45, attack: 0.001, decay: 0.12, freq: 78, freqEnd: 44, wave: 'sine' },
    ],
  };
}

/**
 * Loudness (metres) is a range, not a level — but within one source it still carries the
 * physics: a hard collision is genuinely louder than a nudge, a steel step louder than a
 * concrete one. So the amplitude gets a square-root term around the timbre's own reference,
 * clamped so nothing can either vanish or take over the mix.
 */
export function loudnessGain(loudness: number, ref: number): number {
  return Math.min(2.2, Math.max(0.25, Math.sqrt(Math.max(0.01, loudness) / ref)));
}

/**
 * The one place an event becomes a sound.
 *
 * A note on spiders: one `source: 'spider'` covers four quite different noises, so the event
 * carries `kind` ('chatter' | 'step' | 'bite' | 'death') to say which. The swarm lands that field
 * in its own commit, so until then — and for any emitter that forgets — the old loudness guess is
 * kept as a fallback. It is only a fallback: it was already wrong the moment the chatter got
 * louder, which is exactly why the field exists.
 */
export function timbreFor(event: SoundEvent): Timbre {
  const mat = event.material as MaterialName | undefined;
  const known = mat !== undefined && mat in MATERIALS ? mat : undefined;
  switch (event.source) {
    case 'gunshot':
      return gunshot(event.seq);
    case 'bullet-hit':
      return bulletHit(event.seq, known);
    case 'prop-impact':
      return propImpact(event.seq, known);
    case 'player-step':
      return playerStep(event.seq);
    case 'player-land':
      return playerLand(event.seq);
    case 'spider':
      switch (event.kind) {
        case 'chatter':
          return chatter(event.seq);
        case 'step':
          return spiderStep(event.seq, known === 'steel');
        case 'bite':
          return screech(event.seq, false);
        case 'death':
          return screech(event.seq, true);
        default:
          // No `kind` yet: guess the way we used to, and keep the guess narrow. Only a footfall
          // is quiet and only the bite is very loud; everything between is talk.
          if (event.loudness >= 18) return screech(event.seq, false);
          if (event.loudness <= 5) return spiderStep(event.seq, known === 'steel');
          return chatter(event.seq);
      }
    default:
      return playerStep(event.seq);
  }
}

/**
 * Builds one timbre into `dest` at `t0`. Works on any `BaseAudioContext`, which is the point:
 * the live stage and the offline WAV renderer run the *same* synthesis, so the proof PNGs are
 * proof about the thing the player hears and not about a second implementation of it.
 *
 * Returns the time the last layer stops.
 */
export function buildTimbre(
  ctx: BaseAudioContext,
  dest: AudioNode,
  timbre: Timbre,
  noise: AudioBuffer,
  t0: number,
  amp: number,
  seq: number,
): number {
  let end = t0;
  for (let i = 0; i < timbre.layers.length; i++) {
    const l = timbre.layers[i]!;
    const start = t0 + l.delay;
    // Exponential tails never reach zero; four time constants is 50 dB down, which is silence
    // in a mix and saves the voice from holding a node that does nothing.
    const life = Math.min(timbre.dur, l.attack + l.decay * 4 + 0.005);
    const stop = start + life;
    if (stop > end) end = stop;

    const env = ctx.createGain();
    const peak = Math.max(0.0002, amp * timbre.gain * l.gain);
    env.gain.setValueAtTime(0.0001, start);
    env.gain.exponentialRampToValueAtTime(peak, start + Math.max(0.0002, l.attack));
    env.gain.exponentialRampToValueAtTime(0.0001, stop);
    env.connect(dest);

    if (l.kind === 'noise') {
      const src = ctx.createBufferSource();
      src.buffer = noise;
      const filter = ctx.createBiquadFilter();
      filter.type = l.filter ?? 'bandpass';
      filter.frequency.setValueAtTime(Math.min(18000, l.freq), start);
      if (l.freqEnd !== undefined) {
        filter.frequency.exponentialRampToValueAtTime(Math.max(20, l.freqEnd), stop);
      }
      filter.Q.value = l.q ?? 1;
      src.connect(filter);
      filter.connect(env);
      // A deterministic window of the shared buffer: same seq, same noise, sample for sample.
      const span = Math.max(0.01, noise.duration - life - 0.01);
      src.start(start, hash01(seq, 97 + i) * span, life);
      src.stop(stop);
    } else {
      const osc = ctx.createOscillator();
      osc.type = l.wave ?? 'sine';
      osc.frequency.setValueAtTime(Math.min(18000, l.freq), start);
      if (l.freqEnd !== undefined) {
        osc.frequency.exponentialRampToValueAtTime(Math.max(20, l.freqEnd), stop);
      }
      osc.connect(env);
      osc.start(start);
      osc.stop(stop);
    }
  }
  return end;
}

/** One second of deterministic white noise — the body of every impact in the game. */
export function makeNoiseBuffer(ctx: BaseAudioContext): AudioBuffer {
  const rate = ctx.sampleRate;
  const buf = ctx.createBuffer(1, rate, rate);
  const data = buf.getChannelData(0);
  let s = 0x9e3779b9;
  for (let i = 0; i < data.length; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    data[i] = (s / 0xffffffff) * 2 - 1;
  }
  return buf;
}
