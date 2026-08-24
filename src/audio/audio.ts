/**
 * Procedural spatial audio — the third consumer of the sound bus.
 *
 * Three rules the milestone spec sets, and how they land here:
 *
 * **Spatial, HRTF.** Every voice ends in its own `PannerNode` in `HRTF` mode, positioned at the
 * event's world point, with the listener driven from the camera each frame. Mono would be kitsch
 * in a game whose whole proposition is "where did that come from".
 *
 * **Synthesised, never sampled.** We have no textures and no materials, so we have no sample
 * library either. A hit is two things summed: a *body* — filtered noise, the scrape and crush of
 * the collision — and a *ring* — a decaying partial at the material's own frequency. Both come
 * straight out of `MATERIALS` (`ring`, `decay`, `noise`, `gain`), the same five numbers the
 * physics and the mask already use. Glass is a bright short ping over almost no noise; wood is
 * a dead thud that is almost all noise; steel rings low and long. Nobody authored a wav.
 *
 * **A bounded pool with priority eviction.** A stack going over is dozens of impacts inside half
 * a second. An unbounded `new PannerNode` per hit is both a stall and a wall of mud, so there is
 * a fixed ring of voices, and a new sound only takes one if it out-ranks the weakest voice
 * currently sounding. Rank is loudness over distance — a quiet far knock never evicts a loud
 * near one, which is exactly the failure mode the spec calls out.
 *
 * The whole thing is optional at runtime. The keyframe harness runs in headless Chromium with no
 * audio device and must never touch an `AudioContext`; browsers also refuse to start one before
 * a gesture. So the stage is inert until `resume()` is called from a real key press, and every
 * method is safe to call when it never starts at all. Nothing in the simulation reads back from
 * here — audio is a pure sink, so its presence or absence cannot change a frame.
 */
import type { SoundEvent } from '../events/bus';
import { MATERIALS, type MaterialName } from '../props/shapes';

/** One voice's fixed chain. Built once; only its parameters change per sound. */
interface Voice {
  readonly panner: PannerNode;
  readonly gain: GainNode;
  /** When this voice frees up, in AudioContext time. 0 = idle. */
  until: number;
  /** Rank of the sound currently held, for eviction. */
  rank: number;
  seq: number;
}

/** Per-source voicing for things that are not prop impacts and so have no material. */
interface Profile {
  ring: number;
  decay: number;
  noise: number;
  gain: number;
}

const FOOTSTEP: Profile = { ring: 120, decay: 0.09, noise: 0.92, gain: 0.5 };
const LANDING: Profile = { ring: 90, decay: 0.16, noise: 0.9, gain: 0.8 };

export interface AudioTunables {
  /** Simultaneous voices. Each one is an HRTF panner, which is the expensive part. */
  voices: number;
  /** Master gain. */
  volume: number;
  /** Metres at which a sound of loudness L is at half amplitude — the panner's reference. */
  refDistance: number;
  /** Above this age (seconds) an event is stale and is dropped rather than played late. */
  maxLatency: number;
}

export function defaultAudioTunables(): AudioTunables {
  return { voices: 24, volume: 0.5, refDistance: 1.2, maxLatency: 0.25 };
}

export interface AudioStats {
  /** 'off' until resume() succeeds, then the AudioContext's own state. */
  state: string;
  /** Voices sounding right now. */
  active: number;
  /** Total sounds played. */
  played: number;
  /** Sounds dropped because every voice held something louder. */
  dropped: number;
}

export class AudioStage {
  readonly tunables: AudioTunables;
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private voices: Voice[] = [];
  private cursor = 0;
  private readonly stats: AudioStats = { state: 'off', active: 0, played: 0, dropped: 0 };
  /**
   * Set false by the keyframe harness before it sends any input. A headless run has no device,
   * no listener and nothing to prove by opening one, and an AudioContext there is pure noise in
   * the frame budget we are measuring.
   */
  private enabled = true;
  /** Scene time of the last bus event, so we can tell a fresh event from a replayed one. */
  private sceneTime = 0;
  /** Our own copy of the ear position: the Web Audio listener is write-only. */
  private lx = 0;
  private ly = 0;
  private lz = 0;

  constructor(tunables: AudioTunables) {
    this.tunables = tunables;
  }

  /**
   * Start the device. Must be called from a user gesture — browsers will not start an
   * AudioContext otherwise, and a suspended context silently swallows everything.
   * Safe to call repeatedly; safe to never call at all.
   */
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

  private build(): void {
    const ctx = this.ctx;
    if (ctx === null) return;
    const master = ctx.createGain();
    master.gain.value = this.tunables.volume;
    master.connect(ctx.destination);
    this.master = master;

    // One second of white noise, shared by every voice and read from a random offset. The body
    // of every impact in the game comes out of this buffer; allocating a fresh one per hit is
    // the classic way to make a collapsing stack hitch.
    const rate = ctx.sampleRate;
    const buf = ctx.createBuffer(1, rate, rate);
    const data = buf.getChannelData(0);
    let s = 0x9e3779b9;
    for (let i = 0; i < data.length; i++) {
      s = (s * 1664525 + 1013904223) >>> 0;
      data[i] = (s / 0xffffffff) * 2 - 1;
    }
    this.noise = buf;

    for (let i = 0; i < this.tunables.voices; i++) {
      const panner = ctx.createPanner();
      panner.panningModel = 'HRTF';
      panner.distanceModel = 'inverse';
      panner.refDistance = this.tunables.refDistance;
      panner.rolloffFactor = 1;
      panner.maxDistance = 200;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      gain.connect(panner);
      panner.connect(master);
      this.voices.push({ panner, gain, until: 0, rank: 0, seq: -1 });
    }
    this.stats.state = ctx.state;
  }

  /** Off means off: an already-running device is closed, not just muted. */
  setEnabled(on: boolean): void {
    this.enabled = on;
    if (!on) this.dispose();
  }

  setVolume(v: number): void {
    this.tunables.volume = v;
    if (this.master !== null) this.master.gain.value = v;
  }

  /** The ear. Called once per frame from the camera. */
  setListener(px: number, py: number, pz: number, fx: number, fy: number, fz: number): void {
    const ctx = this.ctx;
    if (ctx === null) return;
    const l = ctx.listener;
    const t = ctx.currentTime;
    // Firefox still only has the deprecated setters; Chrome only the AudioParams. Support both
    // rather than picking a side, since the harness runs one browser and people play in another.
    if (l.positionX !== undefined) {
      l.positionX.setValueAtTime(px, t);
      l.positionY.setValueAtTime(py, t);
      l.positionZ.setValueAtTime(pz, t);
      l.forwardX.setValueAtTime(fx, t);
      l.forwardY.setValueAtTime(fy, t);
      l.forwardZ.setValueAtTime(fz, t);
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

  /** The ear again, in coordinates we can read back — used for range and rank. */
  setEar(x: number, y: number, z: number): void {
    this.lx = x;
    this.ly = y;
    this.lz = z;
  }

  setSceneTime(seconds: number): void {
    this.sceneTime = seconds;
  }

  getStats(): AudioStats {
    const ctx = this.ctx;
    if (ctx === null) return this.stats;
    this.stats.state = ctx.state;
    const now = ctx.currentTime;
    let active = 0;
    for (const v of this.voices) if (v.until > now) active++;
    this.stats.active = active;
    return this.stats;
  }

  /** Bus subscriber. Inert when the device never started. */
  handle(event: SoundEvent): void {
    const ctx = this.ctx;
    if (ctx === null || this.master === null || this.noise === null) return;
    if (ctx.state !== 'running') return;
    // Physics runs on a fixed step and can hand us a burst of events stamped in the past. A hit
    // that is already stale is dropped outright: playing it late is worse than not at all, and
    // it would take a voice from something happening now.
    if (this.sceneTime - event.time > this.tunables.maxLatency) return;

    const dx = event.x - this.lx;
    const dy = event.y - this.ly;
    const dz = event.z - this.lz;
    const dist = Math.max(0.3, Math.hypot(dx, dy, dz));
    // Loudness is "metres at which this can be noticed" (bus contract), so past that range there
    // is nothing to hear and no reason to spend a voice.
    if (dist > event.loudness * 1.2) return;
    const rank = event.loudness / dist;

    const voice = this.take(rank);
    if (voice === null) {
      this.stats.dropped++;
      return;
    }

    const prof = this.profileFor(event);
    // Amplitude: loud things are louder, but the panner does the distance work, so this must not
    // fold distance in twice.
    const amp = Math.min(1, event.loudness / 26) * prof.gain;
    const t0 = ctx.currentTime + 0.005;
    const decay = prof.decay;
    const dur = Math.min(1.6, decay * 3 + 0.06);

    voice.panner.positionX?.setValueAtTime(event.x, t0);
    voice.panner.positionY?.setValueAtTime(event.y, t0);
    voice.panner.positionZ?.setValueAtTime(event.z, t0);
    if (voice.panner.positionX === undefined) {
      (voice.panner as unknown as { setPosition(x: number, y: number, z: number): void })
        .setPosition(event.x, event.y, event.z);
    }
    voice.gain.gain.cancelScheduledValues(t0);
    voice.gain.gain.setValueAtTime(amp, t0);
    voice.gain.gain.exponentialRampToValueAtTime(0.0005, t0 + dur);

    // --- body: a burst of noise through a band-pass sitting on the material's own frequency.
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = Math.min(9000, prof.ring * 2.2);
    band.Q.value = 0.9;
    const bodyGain = ctx.createGain();
    bodyGain.gain.setValueAtTime(prof.noise, t0);
    bodyGain.gain.exponentialRampToValueAtTime(0.0005, t0 + Math.min(dur, 0.05 + decay * 0.6));
    src.connect(band);
    band.connect(bodyGain);
    bodyGain.connect(voice.gain);
    // A random window of the shared buffer, seeded from the event's own sequence number so a
    // replayed scenario sounds identical — determinism is a law here, audio included.
    const off = ((event.seq * 0.6180339887) % 1) * (this.noise.duration - dur - 0.01);
    src.start(t0, Math.max(0, off), dur);
    src.stop(t0 + dur);

    // --- ring: the partial that makes a bottle a bottle. Slightly detuned per event so twelve
    // identical cans do not phase into one synthetic tone.
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    const detune = 1 + (((event.seq * 2654435761) % 1000) / 1000 - 0.5) * 0.12;
    osc.frequency.setValueAtTime(prof.ring * detune, t0);
    // Real objects drop in pitch as the strike energy leaves them.
    osc.frequency.exponentialRampToValueAtTime(prof.ring * detune * 0.86, t0 + dur);
    const ringGain = ctx.createGain();
    ringGain.gain.setValueAtTime(Math.max(0.03, 1 - prof.noise), t0);
    ringGain.gain.exponentialRampToValueAtTime(0.0005, t0 + dur);
    osc.connect(ringGain);
    ringGain.connect(voice.gain);
    osc.start(t0);
    osc.stop(t0 + dur);

    voice.until = t0 + dur;
    voice.rank = rank;
    voice.seq = event.seq;
    this.stats.played++;
  }

  private profileFor(event: SoundEvent): Profile {
    if (event.source === 'player-step') return FOOTSTEP;
    if (event.source === 'player-land') return LANDING;
    const name = event.material as MaterialName | undefined;
    const m = name !== undefined && name in MATERIALS ? MATERIALS[name] : undefined;
    if (m === undefined) return FOOTSTEP;
    return { ring: m.ring, decay: m.decay, noise: m.noise, gain: m.gain * 0.5 };
  }

  /**
   * Priority eviction. A free voice is taken round-robin; otherwise the weakest sounding voice
   * gives way, and only if the newcomer really is stronger. That "only if" is the rule the spec
   * asks for by name: a quiet distant knock must lose to a loud near one, not the other way
   * round because it happened to arrive later.
   */
  private take(rank: number): Voice | null {
    const now = this.ctx!.currentTime;
    const n = this.voices.length;
    for (let i = 0; i < n; i++) {
      const v = this.voices[(this.cursor + i) % n]!;
      if (v.until <= now) {
        this.cursor = (this.cursor + i + 1) % n;
        return v;
      }
    }
    let weakest: Voice | null = null;
    for (const v of this.voices) {
      if (weakest === null || v.rank < weakest.rank) weakest = v;
    }
    if (weakest !== null && weakest.rank < rank) {
      weakest.gain.gain.cancelScheduledValues(now);
      // A hard cut is an audible click; 8 ms is inaudible as a fade and instant as an eviction.
      weakest.gain.gain.setTargetAtTime(0, now, 0.008);
      return weakest;
    }
    return null;
  }

  dispose(): void {
    if (this.ctx === null) return;
    void this.ctx.close().catch(() => undefined);
    this.ctx = null;
    this.voices = [];
    this.stats.state = 'off';
  }
}
