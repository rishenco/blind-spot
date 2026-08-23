/**
 * Procedural audio (engine-plan §8). No asset files anywhere: every sound is synthesised from
 * noise buffers and oscillators at trigger time.
 *
 * Audio is a CONSUMER OF THE EVENT BUS, never a second truth (engine-plan §8). If you can hear
 * it, an event exists that says so — and that same event paints the world. That is what makes
 * "your own footsteps are your headlights" honest instead of decorative: the tick in your ears
 * and the dots on your screen are the same fact, delivered twice.
 *
 * Covered so far: the self classes movement emits — footsteps, landings, slides, the mantle scuff
 * (and the jump takeoff, which reuses the footstep rows) — plus both pings and the halo hum. Dog
 * gait, clatter, chain and the beacon arrive with their milestones; unhandled classes are ignored
 * here rather than faked.
 *
 * What is played is what the LISTENER RECEIVED, not what the bus carried: this subscribes to the
 * delivered feed (`PaintPipeline.onDelivered`), so the delivery predicate — engine-plan §4's
 * `d <= max(HEARING_BASE, hearRadius)` and `walls <= 1` — is computed in exactly one file and the
 * ears cannot claim a sound the dots never got. It matters from M4 on: the E-ping's far end is a
 * SELF event that happens up to 40 m away, and past 30 m you are simply not there to hear it.
 *
 * The halo hum is the ONE thing here that is not triggered by an event, and it cannot be: vision
 * §3.8 asks for a continuous readout of how loud you are, so it is a held oscillator steered from
 * `PlayerView.audibleRadius` — the same number the ring's brightness comes from, so the two halves
 * of the readout can never disagree. It still lives under the master gain like everything else.
 *
 * Browser autoplay policy: a context created before a user gesture starts suspended. `resume()`
 * is wired to the first gesture in main.ts; until then this is silent and harmless.
 */

import { AUDIO_MASTER_GAIN, EV, HALO_FULL_M } from './const.js';
import type { SoundEvent } from './events.js';
import { clamp01, invLerp, makeRng } from './math.js';

type Ctor = new () => AudioContext;

/**
 * What audio listens to: one listener's DELIVERED events, `quality` filled in.
 * `PaintPipeline` (core/paint.ts) is the implementation and owns the gate.
 *
 * Structural rather than an import of the class, so core/audio.ts stays a leaf: this file knows
 * about a feed of delivered sound and nothing about surfels, worlds or wall counting.
 */
export interface DeliveredFeed {
  onDelivered(fn: (e: SoundEvent) => void): () => void;
}

const NOISE_SECONDS = 0.5;

/**
 * The quietest a DELIVERED sound may be played at, as a fraction of its class gain.
 *
 * `quality` (core/math.ts `eventQuality`) reaches 0 exactly at the hear radius, so scaling by it
 * alone would make the edge of audibility silent — and delivery is the world's own statement that
 * you heard the thing. So the scalar spans [floor, 1]: at the rim a ping's return is a hint, at
 * point blank it is the full sound, and nothing that got here vanishes.
 */
const DELIVERY_FLOOR = 0.08;

/**
 * The hum's pitch and volume at silence and at full scale (vision §3.8: "a matching hum pitch",
 * "barely audible at crouch loudness, clearly present at sprint/ping loudness" — engine-plan §8).
 * A crouch step's 2 m sits at 7 % of full scale, which is where the low gain has to still be
 * audible-but-ignorable; a sprint step's 24 m is at 80 %.
 */
const HUM_HZ_QUIET = 62;
const HUM_HZ_LOUD = 148;
const HUM_GAIN_QUIET = 0.006;
const HUM_GAIN_LOUD = 0.075;
/** Seconds for the hum to chase a change in loudness. Long enough that a footstep swells it. */
const HUM_GLIDE = 0.09;

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private unsubscribe: (() => void) | null = null;
  private muted = false;
  private humOsc: OscillatorNode | null = null;
  private humGain: GainNode | null = null;
  /** Last loudness handed to `setHalo`, replayed when the context finally starts. */
  private humRadius = 0;
  /** Events actually sounded — the F3 overlay reads it to prove the bus reached audio. */
  played = 0;

  get available(): boolean {
    return getCtor() !== null;
  }

  get running(): boolean {
    return this.ctx?.state === 'running';
  }

  get isMuted(): boolean {
    return this.muted;
  }

  /** Follow a delivered feed. Safe before `resume()`; safe where WebAudio does not exist. */
  attach(feed: DeliveredFeed): void {
    this.unsubscribe?.();
    this.unsubscribe = feed.onDelivered((e) => this.play(e));
  }

  detach(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /** Call from a user gesture (pointer lock, key, click). Idempotent. */
  resume(): void {
    const Ctx = getCtor();
    if (!Ctx) return;
    if (!this.ctx) {
      this.ctx = new Ctx();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.muted ? 0 : AUDIO_MASTER_GAIN;
      this.master.connect(this.ctx.destination);
      this.noise = makeNoise(this.ctx);
      this.startHum();
    }
    void this.ctx.resume?.();
  }

  /**
   * Steer the halo hum. Called every frame from the boot layer with `PlayerView.audibleRadius`;
   * safe before the context exists (the value is kept and applied when it does).
   *
   * Both pitch and volume move together and both are ramped rather than set: the halo itself is
   * already a smoothed max-hold (core/player.ts), so a stepped oscillator would add a second,
   * uglier quantisation on top of a value that is deliberately continuous.
   */
  setHalo(audibleRadius: number): void {
    this.humRadius = audibleRadius;
    const ctx = this.ctx;
    const osc = this.humOsc;
    const gain = this.humGain;
    if (!ctx || !osc || !gain) return;
    const loud = clamp01(audibleRadius / HALO_FULL_M);
    const t = ctx.currentTime;
    osc.frequency.setTargetAtTime(HUM_HZ_QUIET + (HUM_HZ_LOUD - HUM_HZ_QUIET) * loud, t, HUM_GLIDE);
    gain.gain.setTargetAtTime(HUM_GAIN_QUIET + (HUM_GAIN_LOUD - HUM_GAIN_QUIET) * loud, t, HUM_GLIDE);
  }

  setMuted(m: boolean): void {
    this.muted = m;
    if (this.master && this.ctx) {
      this.master.gain.setTargetAtTime(m ? 0 : AUDIO_MASTER_GAIN, this.ctx.currentTime, 0.01);
    }
  }

  toggleMute(): boolean {
    this.setMuted(!this.muted);
    return this.muted;
  }

  dispose(): void {
    this.detach();
    this.humOsc?.stop();
    this.humOsc = null;
    this.humGain = null;
    void this.ctx?.close?.();
    this.ctx = null;
    this.master = null;
    this.noise = null;
  }

  // ----------------------------------------------------------------------------------------

  private play(e: SoundEvent): void {
    const ctx = this.ctx;
    const master = this.master;
    const noise = this.noise;
    if (!ctx || !master || !noise || ctx.state !== 'running') return;
    // Only the player's own classes have voices so far; a dog's gait and a prop's clatter get
    // their own synths with their milestones and are ignored rather than faked until then.
    // Audibility is NOT decided here — everything reaching this point already passed the
    // delivery gate in paint.ts (see the header).
    if (e.source !== 'self') return;

    // How well it arrived, as a gain scalar. One number for every class: a sound heard from the
    // far side of the room, or through a wall, is the same sound quieter (vision §3.4).
    const v = DELIVERY_FLOOR + (1 - DELIVERY_FLOOR) * clamp01(e.quality);
    const t = ctx.currentTime;
    switch (e.class) {
      case 'crouchStep':
        this.tick(t, 0.1 * v, 1500, 0.035, e.fuzzSeed);
        break;
      case 'walkStep':
        this.tick(t, 0.26 * v, 900, 0.05, e.fuzzSeed);
        break;
      case 'sprintStep':
        this.tick(t, 0.45 * v, 620, 0.07, e.fuzzSeed);
        break;
      case 'landing':
        // `intensity` is a constant of the class; the PAINT RADIUS is what the fall height moves
        // (vision §3.3: landing paints 8 m at the threshold, 14 m at the top of the scale). Read
        // the strength back out of it so a 2 m step-down and an 8 m plunge do not sound alike —
        // the ears and the dots have to agree about how loud you just were (§3.8).
        this.thud(t, clamp01(invLerp(EV.landing.paint, EV.landing.paintMax, e.paintRadius)), e.fuzzSeed, v);
        break;
      case 'slide':
        this.scrape(t, 0.22 * v, 0.22, 2200, 700, e.fuzzSeed);
        break;
      case 'mantle':
        // A braced heave onto a ledge: one short, dry, upward scuff. Same machinery as the slide
        // (a swept low-pass over noise) with its own character — shorter, quieter, and sweeping
        // UP rather than down, so it never reads as "you are sliding".
        this.scrape(t, 0.14 * v, 0.1, 900, 2600, e.fuzzSeed);
        break;
      case 'ePing':
        // Engine-plan §8: a chirp rising 300 -> 1400 Hz over 90 ms. The `far` variant is the same
        // chirp arriving back from wherever the beam landed (core/player.ts) — quieter, duller,
        // and late by the wavefront's real flight time. That delay is not dressing: it is the
        // beam's range read out in your ears, and it is honest because it comes from the event's
        // own timestamp, not from a scripted echo (vision §1.2).
        //
        // `v` is what makes the return read as a RANGE rather than a beep: the same wall answering
        // from 5 m is present and from 30 m is a whisper, off the event's own delivery numbers.
        if (e.variant === 'far') this.chirp(t, 0.055 * v, 300, 1400, 0.13, 1400);
        else this.chirp(t, 0.24 * v, 300, 1400, 0.09, 9000);
        break;
      case 'qPing':
        // A soft 500 Hz pulse: the room-read, deliberately blunt next to the E-ping's question.
        this.pulse(t, 0.2 * v, 500, 0.16);
        break;
      default:
        return;
    }
    this.played++;
  }

  /** The hum runs for the life of the context; `setHalo` is the only thing that moves it. */
  private startHum(): void {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = HUM_HZ_QUIET;
    const g = ctx.createGain();
    g.gain.value = 0;
    osc.connect(g).connect(this.master!);
    osc.start();
    this.humOsc = osc;
    this.humGain = g;
    this.setHalo(this.humRadius);
  }

  /** A ping: a swept sine under a low-pass ceiling, so the far return can be dulled as well as dimmed. */
  private chirp(t: number, gain: number, fromHz: number, toHz: number, dur: number, ceilHz: number): void {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(fromHz, t);
    osc.frequency.exponentialRampToValueAtTime(toHz, t + dur);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = ceilHz;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(gain, t + dur * 0.15);
    g.gain.exponentialRampToValueAtTime(0.0005, t + dur + 0.06);
    osc.connect(lp).connect(g).connect(this.master!);
    osc.start(t);
    osc.stop(t + dur + 0.08);
  }

  /** A single soft tone with no sweep — the Q-ping's flat pulse. */
  private pulse(t: number, gain: number, hz: number, dur: number): void {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = hz;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0005, t + dur);
    osc.connect(g).connect(this.master!);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  /** A footstep: a short band-passed noise tick. Heavier gait = louder and lower. */
  private tick(t: number, gain: number, freq: number, decay: number, seed: number): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise!;
    src.playbackRate.value = 0.85 + seed * 0.3;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = freq * (0.9 + seed * 0.2);
    bp.Q.value = 1.1;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0005, t + decay);
    src.connect(bp).connect(g).connect(this.master!);
    src.start(t, seed * (NOISE_SECONDS - decay - 0.01));
    src.stop(t + decay + 0.01);
  }

  /** A landing: the tick plus a body — a low sine dropping in pitch. */
  private thud(t: number, strength: number, seed: number, vol: number): void {
    const ctx = this.ctx!;
    this.tick(t, (0.35 + 0.35 * strength) * vol, 380, 0.12, seed);
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(95, t);
    osc.frequency.exponentialRampToValueAtTime(42, t + 0.18);
    const g = ctx.createGain();
    g.gain.setValueAtTime((0.25 + 0.35 * strength) * vol, t);
    g.gain.exponentialRampToValueAtTime(0.0005, t + 0.26);
    osc.connect(g).connect(this.master!);
    osc.start(t);
    osc.stop(t + 0.28);
  }

  /**
   * A swept-filter noise grain: the slide's scrape (one per 0.5 m — the events themselves make it
   * continuous) and the mantle's scuff.
   *
   * `seed` is the event's own jitter and is NOT optional in spirit: a slide emits ~15 of these a
   * second and they overlap. Identical overlapping noise grains do not sum to noise, they sum to
   * a periodic comb — the slide would ring rather than hiss. So the seed moves the playback rate,
   * the filter corner AND the offset into the noise buffer, exactly as `tick` does for footsteps.
   */
  private scrape(t: number, gain: number, dur: number, fromHz: number, toHz: number, seed: number): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise!;
    src.playbackRate.value = 0.85 + seed * 0.3;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(fromHz * (0.9 + seed * 0.2), t);
    lp.frequency.exponentialRampToValueAtTime(toHz * (0.9 + seed * 0.2), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(gain, t + Math.min(0.03, dur * 0.3));
    g.gain.exponentialRampToValueAtTime(0.0005, t + dur + 0.02);
    src.connect(lp).connect(g).connect(this.master!);
    src.start(t, seed * (NOISE_SECONDS - dur - 0.05));
    src.stop(t + dur + 0.04);
  }
}

function getCtor(): Ctor | null {
  const g = globalThis as { AudioContext?: Ctor; webkitAudioContext?: Ctor };
  return g.AudioContext ?? g.webkitAudioContext ?? null;
}

/** Deterministic white noise — no Math.random() in this engine, not even for a hiss. */
function makeNoise(ctx: AudioContext): AudioBuffer {
  const n = Math.floor(ctx.sampleRate * NOISE_SECONDS);
  const buf = ctx.createBuffer(1, n, ctx.sampleRate);
  const d = buf.getChannelData(0);
  const rng = makeRng(0x51de5eed);
  for (let i = 0; i < n; i++) d[i] = rng() * 2 - 1;
  return buf;
}
