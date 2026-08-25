/**
 * Procedural spatial audio for BLIND HANDBALL.
 *
 * In a game about hearing, sound is not decoration — it is half the interface, and the half
 * that carries direction. The architecture is lifted from the inherited 3D prototype
 * (`src/audio/audio.ts`): a fixed pool of HRTF panner voices, priority eviction by
 * loudness-over-distance, everything synthesised from a handful of numbers and not one sample
 * file. What is new here is what the 2D game needs and the old engine had no concept of:
 *
 *   * **A continuous emitter.** The ball sings without pause, so it is not a stream of one-shots
 *     but a permanently running voice whose panner follows the ball and whose pitch rides its
 *     speed. It is the player's anchor and it must never stutter.
 *   * **The ping as an event with a body.** A sweep for the scream itself, then soft blips as
 *     the front finds bodies — so the wavefront is audible as a wavefront.
 *   * **The wind-up.** A rising filtered tone while a throw is charged, cut hard on release.
 *     This is what makes a blind throw feel like a throw: you hear the effort you put in.
 *
 * **It is fed from perception, never from the world.** Every position handed to this file comes
 * out of a `PerceptionFrame` — which means the localisation error the concept specifies is
 * audible as such: a distant footstep is panned to where the player *thinks* it was. Wiring it
 * to the truth would be both a lie and a cheat, and it would be inaudible in a screenshot,
 * which is exactly the kind of bug this project cannot afford.
 *
 * Inert until `resume()` is called from a real gesture, and never started at all under the
 * keyframe harness — headless Chromium has no device and the frame budget is being measured.
 */
import type { PerceptionFrame, SonarHit, SoundKind, Vec2 } from '../sim/types';

interface Voice {
  readonly panner: PannerNode;
  readonly gain: GainNode;
  until: number;
  rank: number;
}

/** The five numbers that make a noise a noise. Same shape as the 3D engine's material voice. */
interface Profile {
  /** Centre frequency of the body and of the ring, Hz. */
  ring: number;
  /** Decay time, seconds. */
  decay: number;
  /** 0..1 — how much of it is noise rather than tone. */
  noise: number;
  gain: number;
  /** Band-pass Q of the body. High = a click, low = a thump. */
  q: number;
}

/**
 * One row per sound in the game, and they are deliberately far apart in timbre: a player has to
 * name a sound before they can act on it, and eleven variations of "thud" are one sound.
 */
const BALL_RING = 320;

const FALLBACK: Profile = { ring: 300, decay: 0.14, noise: 0.85, gain: 0.7, q: 1 };

/** Partial on purpose: a sound kind added by the rules layer gets `FALLBACK` and not a crash. */
const PROFILES: Partial<Record<SoundKind, Profile>> = {
  'step-walk': { ring: 150, decay: 0.06, noise: 0.95, gain: 0.35, q: 0.8 },
  'step-run': { ring: 210, decay: 0.09, noise: 0.9, gain: 0.75, q: 0.7 },
  brake: { ring: 900, decay: 0.22, noise: 0.98, gain: 0.9, q: 0.5 },
  dive: { ring: 120, decay: 0.3, noise: 0.97, gain: 0.9, q: 0.4 },
  catch: { ring: 420, decay: 0.07, noise: 0.85, gain: 0.7, q: 1.4 },
  fumble: { ring: 260, decay: 0.28, noise: 0.6, gain: 1, q: 1.1 },
  throw: { ring: 620, decay: 0.16, noise: 0.55, gain: 1, q: 1.2 },
  'ball-hum': { ring: 320, decay: 0.2, noise: 0.2, gain: 0.5, q: 3 },
  'ball-wall': { ring: 780, decay: 0.12, noise: 0.35, gain: 0.9, q: 2.4 },
  sonar: { ring: 1400, decay: 0.5, noise: 0.25, gain: 1, q: 2 },
  whistle: { ring: 2100, decay: 0.45, noise: 0.1, gain: 0.8, q: 6 },
};

export interface AudioTunables {
  voices: number;
  volume: number;
  /** Metres at which a sound is at half amplitude. Small: this pitch is 24 m across. */
  refDistance: number;
}

export function defaultAudioTunables(): AudioTunables {
  return { voices: 20, volume: 0.55, refDistance: 2.5 };
}

export interface AudioStats {
  state: string;
  played: number;
  dropped: number;
}

/** World (x, y) → Web Audio (x, 0, -y): the pitch is the horizontal plane, ears are level. */
const AX = (p: Vec2): [number, number, number] => [p.x, 0, -p.y];

export class HandballAudio {
  readonly tunables: AudioTunables;
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private voices: Voice[] = [];
  private cursor = 0;
  private enabled = true;
  private stats: AudioStats = { state: 'off', played: 0, dropped: 0 };
  /** A deterministic dither stream — `Math.random()` is banned project-wide. */
  private seed = 0x9e3779b9;

  // The ball's permanent voice.
  private ballPanner: PannerNode | null = null;
  private ballGain: GainNode | null = null;
  private ballOsc: OscillatorNode | null = null;
  private ballSub: OscillatorNode | null = null;

  // The wind-up voice.
  private chargeOsc: OscillatorNode | null = null;
  private chargeGain: GainNode | null = null;

  private listenerPos: Vec2 = { x: 0, y: 0 };

  constructor(tunables: AudioTunables = defaultAudioTunables()) {
    this.tunables = tunables;
  }

  private rand(): number {
    this.seed = (this.seed * 1664525 + 1013904223) >>> 0;
    return this.seed / 0xffffffff;
  }

  /** Must be called from a user gesture. Safe to call repeatedly and safe never to call. */
  resume(): void {
    if (!this.enabled) return;
    if (this.ctx === null) {
      const Ctor = (window as unknown as { AudioContext?: typeof AudioContext }).AudioContext;
      if (Ctor === undefined) return;
      try {
        this.ctx = new Ctor();
      } catch {
        this.ctx = null;
        return;
      }
      this.build();
    }
    void this.ctx.resume().catch(() => undefined);
    this.stats.state = this.ctx.state;
  }

  get running(): boolean {
    return this.ctx !== null && this.ctx.state === 'running';
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (!on) this.dispose();
  }

  setVolume(v: number): void {
    this.tunables.volume = v;
    if (this.master) this.master.gain.value = v;
  }

  getStats(): AudioStats {
    if (this.ctx) this.stats.state = this.ctx.state;
    return this.stats;
  }

  private build(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const master = ctx.createGain();
    master.gain.value = this.tunables.volume;
    master.connect(ctx.destination);
    this.master = master;

    const rate = ctx.sampleRate;
    const buf = ctx.createBuffer(1, rate, rate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = this.rand() * 2 - 1;
    this.noise = buf;

    for (let i = 0; i < this.tunables.voices; i++) {
      const panner = this.makePanner(ctx);
      const gain = ctx.createGain();
      gain.gain.value = 0;
      gain.connect(panner);
      panner.connect(master);
      this.voices.push({ panner, gain, until: 0, rank: 0 });
    }

    // --- the ball: one voice that never stops -----------------------------
    // Two detuned partials plus a touch of noise would be a synth pad; the ball wants to be a
    // *thing*, so it is a narrow band around one moving partial with a sub underneath. The
    // sub is what makes it locatable at range on laptop speakers, where HRTF alone is thin.
    const bp = this.makePanner(ctx);
    const bg = ctx.createGain();
    bg.gain.value = 0;
    bg.connect(bp);
    bp.connect(master);
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = BALL_RING;
    const sub = ctx.createOscillator();
    sub.type = 'sine';
    sub.frequency.value = BALL_RING / 2;
    const subGain = ctx.createGain();
    subGain.gain.value = 0.5;
    osc.connect(bg);
    sub.connect(subGain);
    subGain.connect(bg);
    osc.start();
    sub.start();
    this.ballPanner = bp;
    this.ballGain = bg;
    this.ballOsc = osc;
    this.ballSub = sub;

    // --- the wind-up: centred in the head, because it is your own arm ------
    const cg = ctx.createGain();
    cg.gain.value = 0;
    cg.connect(master);
    const co = ctx.createOscillator();
    co.type = 'sawtooth';
    co.frequency.value = 90;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 300;
    filter.Q.value = 4;
    co.connect(filter);
    filter.connect(cg);
    co.start();
    this.chargeOsc = co;
    this.chargeGain = cg;

    this.stats.state = ctx.state;
  }

  private makePanner(ctx: AudioContext): PannerNode {
    const p = ctx.createPanner();
    p.panningModel = 'HRTF';
    p.distanceModel = 'inverse';
    p.refDistance = this.tunables.refDistance;
    p.rolloffFactor = 1.1;
    p.maxDistance = 60;
    return p;
  }

  private setPos(p: PannerNode, at: Vec2): void {
    const [x, y, z] = AX(at);
    const t = this.ctx!.currentTime;
    if (p.positionX) {
      // A short ramp, not a jump: teleporting a panner clicks, and the ball moves every tick.
      p.positionX.setTargetAtTime(x, t, 0.01);
      p.positionY.setTargetAtTime(y, t, 0.01);
      p.positionZ.setTargetAtTime(z, t, 0.01);
    } else {
      (p as unknown as { setPosition(x: number, y: number, z: number): void }).setPosition(x, y, z);
    }
  }

  /** The ear: the player's own body and facing, straight out of proprioception. */
  private setListener(pos: Vec2, aim: Vec2): void {
    const ctx = this.ctx;
    if (!ctx) return;
    this.listenerPos = pos;
    const l = ctx.listener;
    const t = ctx.currentTime;
    const [px, py, pz] = AX(pos);
    const [fx, fy, fz] = AX(aim);
    if (l.positionX) {
      l.positionX.setTargetAtTime(px, t, 0.02);
      l.positionY.setValueAtTime(py, t);
      l.positionZ.setTargetAtTime(pz, t, 0.02);
      l.forwardX.setTargetAtTime(fx, t, 0.02);
      l.forwardY.setValueAtTime(fy, t);
      l.forwardZ.setTargetAtTime(fz, t, 0.02);
      l.upX.setValueAtTime(0, t);
      l.upY.setValueAtTime(1, t);
      l.upZ.setValueAtTime(0, t);
    } else {
      const legacy = l as unknown as {
        setPosition(x: number, y: number, z: number): void;
        setOrientation(fx: number, fy: number, fz: number, ux: number, uy: number, uz: number): void;
      };
      legacy.setPosition(px, py, pz);
      legacy.setOrientation(fx, fy, fz, 0, 1, 0);
    }
  }

  /**
   * One tick of the world, as one player heard it. This is the whole public surface.
   *
   * Everything it reads is on the frame: the events of this tick, the ball emitter, the sonar
   * returns, and the player's own charge state. There is no second argument carrying truth.
   */
  render(frame: PerceptionFrame): void {
    if (!this.running) return;
    const self = frame.self;
    this.setListener(self.pos, self.aim);

    for (const ev of frame.events) {
      // Own footsteps are damped rather than dropped: a body with no sound of its own feels
      // like a camera, and the point of this game is that you are a body.
      const scale = ev.self ? (ev.kind === 'step-run' || ev.kind === 'step-walk' ? 0.35 : 0.7) : 1;
      this.one(ev.kind, ev.pos, ev.intensity, scale, ev.self);
    }

    // --- the ball ---------------------------------------------------------
    const ball = frame.emitters.find((e) => e.kind === 'ball');
    if (ball && this.ballGain && this.ballOsc && this.ballPanner) {
      const t = this.ctx!.currentTime;
      this.setPos(this.ballPanner, ball.pos);
      const held = self.hasBall;
      this.ballGain.gain.setTargetAtTime(held ? 0.1 : 0.16, t, 0.05);
      // Pitch rides distance a little and speed a lot: a ball flying at you is a rising tone,
      // which is the only cue a blind player gets that a pass is arriving hard.
      const d = Math.hypot(ball.pos.x - self.pos.x, ball.pos.y - self.pos.y);
      const closing = this.ballClosing(frame, ball.pos);
      const f = BALL_RING * (1 + closing * 0.045) * (1 - Math.min(0.25, d * 0.006));
      this.ballOsc.frequency.setTargetAtTime(f, t, 0.06);
      this.ballSub?.frequency.setTargetAtTime(f / 2, t, 0.06);
    } else if (this.ballGain) {
      this.ballGain.gain.setTargetAtTime(0, this.ctx!.currentTime, 0.05);
    }

    // --- the wind-up ------------------------------------------------------
    if (this.chargeGain && this.chargeOsc) {
      const t = this.ctx!.currentTime;
      const charging = self.charging && self.hasBall;
      const k = Math.min(1, self.chargeT / 0.6);
      this.chargeGain.gain.setTargetAtTime(charging ? 0.035 + k * 0.07 : 0, t, charging ? 0.03 : 0.01);
      this.chargeOsc.frequency.setTargetAtTime(70 + k * 130, t, 0.05);
    }

    // --- the ping's returns, as the front finds them ----------------------
    for (const ret of frame.sonar) {
      for (const hit of ret.hits) this.blip(hit);
    }
  }

  private lastBallPos: Vec2 | null = null;

  /** Closing speed of the ball, from successive perceived positions. Noisy, and honestly so. */
  private ballClosing(frame: PerceptionFrame, at: Vec2): number {
    const prev = this.lastBallPos;
    this.lastBallPos = { x: at.x, y: at.y };
    if (!prev) return 0;
    const self = frame.self.pos;
    const dPrev = Math.hypot(prev.x - self.x, prev.y - self.y);
    const dNow = Math.hypot(at.x - self.x, at.y - self.y);
    return Math.max(-12, Math.min(12, (dPrev - dNow) * 60));
  }

  /** A sonar return that found a body or the ball. Geometry is silent — it would be a wall of clicks. */
  private blip(hit: SonarHit): void {
    if (hit.kind === 'wall' || hit.kind === 'crease') return;
    const ctx = this.ctx!;
    const voice = this.take(6);
    if (!voice) return;
    this.setPos(voice.panner, hit.pos);
    const t0 = ctx.currentTime + 0.005;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(hit.kind === 'ball' ? 1800 : 1150, t0);
    voice.gain.gain.cancelScheduledValues(t0);
    voice.gain.gain.setValueAtTime(0.5, t0);
    voice.gain.gain.exponentialRampToValueAtTime(0.0005, t0 + 0.14);
    osc.connect(voice.gain);
    osc.start(t0);
    osc.stop(t0 + 0.15);
    voice.until = t0 + 0.15;
    voice.rank = 6;
  }

  /**
   * One discrete sound.
   *
   * Body (band-passed noise) plus ring (a decaying partial). Amplitude comes from the event's
   * loudness in metres — the same units the concept's table is written in — while the distance
   * work is left entirely to the panner, so it never gets folded in twice.
   */
  private one(kind: SoundKind, at: Vec2, intensity: number, scale: number, isSelf: boolean): void {
    const ctx = this.ctx;
    if (!ctx || !this.noise) return;
    const dist = Math.max(0.4, Math.hypot(at.x - this.listenerPos.x, at.y - this.listenerPos.y));
    const rank = intensity / dist;
    const voice = this.take(rank);
    if (!voice) {
      this.stats.dropped++;
      return;
    }
    const prof = PROFILES[kind] ?? FALLBACK;
    this.setPos(voice.panner, isSelf ? { x: at.x, y: at.y } : at);

    const t0 = ctx.currentTime + 0.004;
    const decay = prof.decay;
    const dur = Math.min(1.4, decay * 3 + 0.05);
    // A ping is the loudest thing in the game and must be felt as such; everything else is
    // scaled by its own audible radius, which is what the loudness table already encodes.
    const amp = Math.min(1, intensity / 22) * prof.gain * scale * (kind === 'sonar' ? 1.6 : 1);

    voice.gain.gain.cancelScheduledValues(t0);
    voice.gain.gain.setValueAtTime(amp, t0);
    voice.gain.gain.exponentialRampToValueAtTime(0.0005, t0 + dur);

    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const band = ctx.createBiquadFilter();
    band.type = kind === 'sonar' ? 'bandpass' : 'bandpass';
    band.frequency.setValueAtTime(prof.ring, t0);
    if (kind === 'sonar') {
      // The scream sweeps downward, which is what makes it read as something leaving you.
      band.frequency.exponentialRampToValueAtTime(prof.ring * 0.25, t0 + dur);
    }
    band.Q.value = prof.q;
    const bodyGain = ctx.createGain();
    bodyGain.gain.setValueAtTime(prof.noise, t0);
    bodyGain.gain.exponentialRampToValueAtTime(0.0005, t0 + Math.min(dur, 0.04 + decay * 0.7));
    src.connect(band);
    band.connect(bodyGain);
    bodyGain.connect(voice.gain);
    const off = this.rand() * Math.max(0.01, this.noise.duration - dur - 0.02);
    src.start(t0, off, dur);
    src.stop(t0 + dur);

    if (prof.noise < 0.97) {
      const osc = ctx.createOscillator();
      osc.type = kind === 'whistle' ? 'sine' : 'triangle';
      const detune = 1 + (this.rand() - 0.5) * 0.1;
      osc.frequency.setValueAtTime(prof.ring * detune, t0);
      osc.frequency.exponentialRampToValueAtTime(prof.ring * detune * (kind === 'throw' ? 0.55 : 0.85), t0 + dur);
      const ringGain = ctx.createGain();
      ringGain.gain.setValueAtTime(Math.max(0.03, 1 - prof.noise), t0);
      ringGain.gain.exponentialRampToValueAtTime(0.0005, t0 + dur);
      osc.connect(ringGain);
      ringGain.connect(voice.gain);
      osc.start(t0);
      osc.stop(t0 + dur);
    }

    voice.until = t0 + dur;
    voice.rank = rank;
    this.stats.played++;
  }

  /** Round-robin for a free voice; otherwise the weakest voice yields, and only to its better. */
  private take(rank: number): Voice | null {
    const ctx = this.ctx;
    if (!ctx) return null;
    const now = ctx.currentTime;
    const n = this.voices.length;
    for (let i = 0; i < n; i++) {
      const v = this.voices[(this.cursor + i) % n]!;
      if (v.until <= now) {
        this.cursor = (this.cursor + i + 1) % n;
        return v;
      }
    }
    let weakest: Voice | null = null;
    for (const v of this.voices) if (!weakest || v.rank < weakest.rank) weakest = v;
    if (weakest && weakest.rank < rank) {
      weakest.gain.gain.cancelScheduledValues(now);
      weakest.gain.gain.setTargetAtTime(0, now, 0.008);
      return weakest;
    }
    return null;
  }

  dispose(): void {
    if (!this.ctx) return;
    void this.ctx.close().catch(() => undefined);
    this.ctx = null;
    this.voices = [];
    this.ballGain = null;
    this.ballOsc = null;
    this.ballSub = null;
    this.ballPanner = null;
    this.chargeGain = null;
    this.chargeOsc = null;
    this.stats.state = 'off';
  }
}
