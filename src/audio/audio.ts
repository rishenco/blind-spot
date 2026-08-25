/**
 * Procedural spatial audio — the third consumer of the sound bus.
 *
 * The stage owns *where* and *how loud*; `voices.ts` owns *what it sounds like*. Splitting them
 * that way is what let the offline renderer (`offline.ts`, `tools/audio.mjs`) prove the timbres
 * without a device: both paths run the same `buildTimbre`.
 *
 * **Spatial, HRTF.** Every voice ends in its own `PannerNode` in `HRTF` mode, positioned at the
 * event's world point, with the listener driven from the camera each frame. Mono would be kitsch
 * in a game whose whole proposition is "where did that come from".
 *
 * **Loudness is metres.** The bus contract calls `loudness` the range at which a noise can be
 * noticed, so that is what it does here: it sets the panner's rolloff so the sound has actually
 * faded out around that range, and it does *not* set the level. The previous version made it the
 * amplitude (`min(1, loudness / 26)`), which capped everything at 26 m and made a 90 m gunshot
 * exactly as loud as a heavy landing — half of why the rifle sounded like a knock on a door.
 *
 * **A bounded pool with priority eviction.** A stack going over is dozens of impacts inside half
 * a second. An unbounded `new PannerNode` per hit is both a stall and a wall of mud, so there is
 * a fixed ring of voices, and a new sound only takes one if it out-ranks the weakest voice
 * currently sounding. Rank is loudness over distance — a quiet far knock never evicts a loud
 * near one.
 *
 * **The blast is privileged.** The muzzle flash is the loudest event in the game by a factor of
 * six, and the spec asks for «разрыв пространства»: it gets its own voice that the pool can
 * never steal, it goes into the master *ahead* of the ducking bus, and it slams that bus shut
 * behind itself. For the next half second the hall is quiet and muffled — the shot has taken
 * your hearing, not the mixer's headroom. A limiter across the master keeps the peak inside the
 * rails, so it is loud the way a mix is loud, not the way clipping is loud.
 *
 * The whole thing is optional at runtime. The keyframe harness runs in headless Chromium with no
 * audio device and must never touch an `AudioContext`; browsers also refuse to start one before
 * a gesture. So the stage is inert until `resume()` is called from a real key press, and every
 * method is safe to call when it never starts at all. Nothing in the simulation reads back from
 * here — audio is a pure sink, so its presence or absence cannot change a frame.
 */
import type { SoundEvent } from '../events/bus';
import { buildTimbre, loudnessGain, makeNoiseBuffer, timbreFor, type Timbre } from './voices';

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

export interface AudioTunables {
  /** Simultaneous voices. Each one is an HRTF panner, which is the expensive part. */
  voices: number;
  /** Master gain. */
  volume: number;
  /** Above this age (seconds) an event is stale and is dropped rather than played late. */
  maxLatency: number;
  /**
   * How far the world is pushed down while the shot is still in your ears, 0..1. 0.25 means the
   * hall comes back at a quarter of its level and climbs out of it.
   */
  deafDepth: number;
  /** How long that takes to recover, seconds. */
  deafSeconds: number;
  /** Cutoff of the muffling filter at the bottom of the duck, Hz. */
  deafCutoff: number;
  /** The ring left in your ears after a shot, 0..1. 0 turns it off. */
  tinnitus: number;
}

export function defaultAudioTunables(): AudioTunables {
  return {
    voices: 24,
    volume: 0.7,
    maxLatency: 0.25,
    deafDepth: 0.15,
    deafSeconds: 0.9,
    deafCutoff: 700,
    tinnitus: 0.03,
  };
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
  /** Sounds skipped because the ear was outside their loudness radius. */
  outOfRange: number;
  /** Name of the last timbre played — the quickest way to see the table is being reached. */
  last: string;
}

/**
 * Distance mapping. `loudness` is the radius at which the event is still noticeable, so pick a
 * reference distance that puts the inverse curve near the floor at exactly that radius: with
 * `refDistance = loudness / 12` the gain at `loudness` metres is ~1/12 of the close-range level,
 * which is quiet-but-there, and the cull at `loudness * 1.2` finishes the job.
 */
export function refDistanceFor(loudness: number): number {
  return Math.min(8, Math.max(0.45, loudness / 12));
}

export class AudioStage {
  readonly tunables: AudioTunables;
  private ctx: AudioContext | null = null;
  /** Post-everything: volume, then the limiter, then out. */
  private master: GainNode | null = null;
  /** Everything except the blast passes through here, and the blast closes it. */
  private duck: GainNode | null = null;
  private muffle: BiquadFilterNode | null = null;
  private noise: AudioBuffer | null = null;
  private voices: Voice[] = [];
  /** The muzzle blast's own voice: pre-duck, never evicted, never evicting. */
  private blast: Voice | null = null;
  private cursor = 0;
  private readonly stats: AudioStats = {
    state: 'off', active: 0, played: 0, dropped: 0, outOfRange: 0, last: '-',
  };
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

    // out ← limiter ← master(volume) ← { blast direct | muffle ← duck ← voices }
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -3;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.22;
    limiter.connect(ctx.destination);

    const master = ctx.createGain();
    master.gain.value = this.tunables.volume;
    master.connect(limiter);
    this.master = master;

    const muffle = ctx.createBiquadFilter();
    muffle.type = 'lowpass';
    muffle.frequency.value = 20000;
    muffle.Q.value = 0.7;
    muffle.connect(master);
    this.muffle = muffle;

    const duck = ctx.createGain();
    duck.gain.value = 1;
    duck.connect(muffle);
    this.duck = duck;

    this.noise = makeNoiseBuffer(ctx);

    for (let i = 0; i < this.tunables.voices; i++) this.voices.push(this.makeVoice(ctx, duck));
    this.blast = this.makeVoice(ctx, master);
    this.stats.state = ctx.state;
  }

  private makeVoice(ctx: AudioContext, dest: AudioNode): Voice {
    const panner = ctx.createPanner();
    panner.panningModel = 'HRTF';
    panner.distanceModel = 'inverse';
    panner.refDistance = 1;
    panner.rolloffFactor = 1;
    panner.maxDistance = 300;
    const gain = ctx.createGain();
    gain.gain.value = 1;
    gain.connect(panner);
    panner.connect(dest);
    return { panner, gain, until: 0, rank: 0, seq: -1 };
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

  /** A copy: the overlay used to be handed the live object and could not diff two samples. */
  getStats(): AudioStats {
    const ctx = this.ctx;
    if (ctx === null) return { ...this.stats };
    this.stats.state = ctx.state;
    const now = ctx.currentTime;
    let active = 0;
    for (const v of this.voices) if (v.until > now) active++;
    if (this.blast !== null && this.blast.until > now) active++;
    this.stats.active = active;
    return { ...this.stats };
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
    const dist = Math.max(0.25, Math.hypot(dx, dy, dz));
    // Loudness is "metres at which this can be noticed" (bus contract), so past that range there
    // is nothing to hear and no reason to spend a voice.
    if (dist > event.loudness * 1.2) {
      this.stats.outOfRange++;
      return;
    }
    const rank = event.loudness / dist;
    const timbre = timbreFor(event);

    const voice = timbre.blast === true ? this.blast : this.take(rank);
    if (voice === null) {
      this.stats.dropped++;
      return;
    }

    const t0 = ctx.currentTime + 0.005;
    this.place(voice, event, t0);
    voice.gain.gain.cancelScheduledValues(t0);
    voice.gain.gain.setValueAtTime(1, t0);

    const amp = loudnessGain(event.loudness, timbre.ref);
    const end = buildTimbre(ctx, voice.gain, timbre, this.noise, t0, amp, event.seq);

    if (timbre.blast === true) this.deafen(t0);

    voice.until = end;
    voice.rank = rank;
    voice.seq = event.seq;
    this.stats.played++;
    this.stats.last = timbre.name;
  }

  private place(voice: Voice, event: SoundEvent, t0: number): void {
    const p = voice.panner;
    p.refDistance = refDistanceFor(event.loudness);
    p.maxDistance = Math.max(4, event.loudness * 1.25);
    if (p.positionX !== undefined) {
      p.positionX.setValueAtTime(event.x, t0);
      p.positionY.setValueAtTime(event.y, t0);
      p.positionZ.setValueAtTime(event.z, t0);
    } else {
      (p as unknown as { setPosition(x: number, y: number, z: number): void })
        .setPosition(event.x, event.y, event.z);
    }
  }

  /**
   * «Разрыв пространства.» The blast has already gone past this point in the graph, so what it
   * shuts is everything *else*: the hall drops to a quarter of its level behind a lowpass and
   * climbs back out over about three quarters of a second, with a faint ring left on top. For
   * those few tenths the player is deaf, which is the price the concept keeps talking about,
   * and it is paid in perception rather than in a number on a HUD.
   */
  private deafen(t0: number): void {
    const ctx = this.ctx;
    const duck = this.duck;
    const muffle = this.muffle;
    const master = this.master;
    if (ctx === null || duck === null || muffle === null || master === null) return;
    const t = this.tunables;
    // Onset 20 ms after the trigger: the crack of the shot lands first, then the world goes.
    const shut = t0 + 0.02;
    const open = shut + t.deafSeconds;
    duck.gain.cancelScheduledValues(t0);
    duck.gain.setValueAtTime(duck.gain.value, t0);
    duck.gain.linearRampToValueAtTime(Math.max(0.01, t.deafDepth), shut);
    duck.gain.setTargetAtTime(1, shut, t.deafSeconds * 0.7);
    duck.gain.setValueAtTime(1, open + t.deafSeconds);

    muffle.frequency.cancelScheduledValues(t0);
    muffle.frequency.setValueAtTime(20000, t0);
    muffle.frequency.linearRampToValueAtTime(Math.max(120, t.deafCutoff), shut);
    muffle.frequency.setTargetAtTime(20000, shut, t.deafSeconds * 0.6);
    muffle.frequency.setValueAtTime(20000, open + t.deafSeconds);

    if (t.tinnitus > 0) {
      // Not a scripted scare: it is the shot's own after-image, born from the same event.
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(3900, shut);
      osc.frequency.exponentialRampToValueAtTime(3300, shut + t.deafSeconds * 1.4);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(t.tinnitus, shut);
      g.gain.exponentialRampToValueAtTime(0.0001, shut + t.deafSeconds * 1.4);
      osc.connect(g);
      g.connect(master);
      osc.start(t0);
      osc.stop(shut + t.deafSeconds * 1.4 + 0.02);
    }
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
    this.blast = null;
    this.master = null;
    this.duck = null;
    this.muffle = null;
    this.stats.state = 'off';
  }
}

export type { Timbre };
