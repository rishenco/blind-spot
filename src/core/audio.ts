/**
 * Procedural audio (engine-plan §8). No asset files anywhere: every sound is synthesised from
 * noise buffers and oscillators at trigger time.
 *
 * Audio is a CONSUMER OF THE EVENT BUS, never a second truth (engine-plan §8). If you can hear
 * it, an event exists that says so — and that same event paints the world. That is what makes
 * "your own footsteps are your headlights" honest instead of decorative: the tick in your ears
 * and the dots on your screen are the same fact, delivered twice.
 *
 * Milestone 2 covers the self classes movement emits — footsteps, landings, slides. Pings, gait,
 * clatter, chain, hum and the beacon arrive with their milestones; unhandled classes are ignored
 * here rather than faked. Delivery is not modelled yet either (M3 owns walls/quality), so this
 * plays what the player themselves emitted, at the player's own position.
 *
 * Browser autoplay policy: a context created before a user gesture starts suspended. `resume()`
 * is wired to the first gesture in main.ts; until then this is silent and harmless.
 */

import { AUDIO_MASTER_GAIN } from './const.js';
import type { EventBus, SoundEvent } from './events.js';
import { clamp01, makeRng } from './math.js';

type Ctor = new () => AudioContext;

const NOISE_SECONDS = 0.5;

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private unsubscribe: (() => void) | null = null;
  private muted = false;
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

  /** Subscribe to the bus. Safe to call before `resume()`; safe where WebAudio does not exist. */
  attach(bus: EventBus): void {
    this.unsubscribe?.();
    this.unsubscribe = bus.on((e) => this.play(e));
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
    }
    void this.ctx.resume?.();
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
    // M2: only what the player themselves emits. M3's delivery pass decides audibility for the
    // rest, and this filter becomes "quality > 0".
    if (e.source !== 'self') return;

    const t = ctx.currentTime;
    switch (e.class) {
      case 'crouchStep':
        this.tick(t, 0.1, 1500, 0.035, e.fuzzSeed);
        break;
      case 'walkStep':
        this.tick(t, 0.26, 900, 0.05, e.fuzzSeed);
        break;
      case 'sprintStep':
        this.tick(t, 0.45, 620, 0.07, e.fuzzSeed);
        break;
      case 'landing':
        this.thud(t, clamp01(e.intensity), e.fuzzSeed);
        break;
      case 'slide':
        this.scrape(t, 0.22);
        break;
      default:
        return;
    }
    this.played++;
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
  private thud(t: number, strength: number, seed: number): void {
    const ctx = this.ctx!;
    this.tick(t, 0.35 + 0.35 * strength, 380, 0.12, seed);
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(95, t);
    osc.frequency.exponentialRampToValueAtTime(42, t + 0.18);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.25 + 0.35 * strength, t);
    g.gain.exponentialRampToValueAtTime(0.0005, t + 0.26);
    osc.connect(g).connect(this.master!);
    osc.start(t);
    osc.stop(t + 0.28);
  }

  /** A slide: overlapping low-passed noise, one per 0.5 m — the events themselves make it continuous. */
  private scrape(t: number, gain: number): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise!;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(2200, t);
    lp.frequency.exponentialRampToValueAtTime(700, t + 0.22);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.03);
    g.gain.exponentialRampToValueAtTime(0.0005, t + 0.24);
    src.connect(lp).connect(g).connect(this.master!);
    src.start(t, 0.05);
    src.stop(t + 0.26);
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
