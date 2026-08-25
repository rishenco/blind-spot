/**
 * The audio system — the second subscriber to the sound bus.
 *
 * §1's commitment is that the paint system and the mixer are *siblings* on one event stream:
 * "the same event paints the world and makes the noise, so sight and hearing can never
 * disagree — a sound with no paint, or paint with no sound, is impossible to produce". This
 * class is the second half of that sentence. It subscribes to the same `SoundBus` the
 * `PaintSystem` does, hands every event to the same director, and turns what comes back into
 * WebAudio. It has no emitters of its own and never will: there is no second path to a noise.
 *
 * It does almost nothing itself. `director.ts` decides whether and how loud, `voices.ts` builds
 * the graph, and what is left here is the two things only a live browser has — a context, and a
 * user gesture to start it with.
 *
 * **The one sound that is not an event, and why it is not a hole in §1.** §3.8's Halo hum runs
 * here too (`setHaloRadius`), and it never touches the bus. That is not an exception to "one bus,
 * two senses" because the hum is not a thing that happens in the world: it is the rig's own gauge,
 * audible to nobody but its pilot, painting nothing and heard by nothing. The law it would break
 * is the one about *the world* — a sound with no paint — and the test that keeps it honest is
 * that the hum has no position, no emitter and no carry radius to give it one. What it does need
 * from the mixer is the master bus and a notification on every voice, so it can duck.
 *
 * **The autoplay policy is handled by not having a context.** Every browser refuses to start
 * audio before a user gesture, and the usual arrangement — construct an `AudioContext` up front
 * and resume it later — costs a console warning on load in Chromium and a suspended context that
 * silently swallows whatever is scheduled into it. So this holds `null` until `unlock()` is
 * called from a real gesture, and until then every event is counted and dropped. Nothing throws,
 * nothing warns, nothing is scheduled into a context that cannot play it, and a headless run with
 * no gesture at all (`tools/shoot.mjs`) produces exactly zero audio work and zero console output.
 *
 * The cost is stated rather than hidden: between the first sound and the first gesture, the world
 * paints and does not speak. That is a platform rule and not a design choice — the bus still
 * carried the event and the paint still happened — and `droppedSilent` counts every one of them
 * so it is a number rather than a mystery.
 */

import { AudioDirector, type ListenerState, type VoiceSpec } from './director';
import { HaloHum } from './halo';
import { playVoice } from './voices';
import type { SoundBus, SoundEvent } from '../paint/soundEvents';

/**
 * How a context is obtained. Injected so a test can supply an `OfflineAudioContext` — the same
 * base class, rendered faster than real time — and so a platform with no WebAudio at all is a
 * `null` return rather than a thrown constructor.
 */
export type AudioContextFactory = () => BaseAudioContext | null;

/**
 * Level of the bus everything is summed through, and the hook the mix pass will hang off.
 *
 * One gain node between every voice and the destination, from the first commit, because
 * retrofitting a master bus means finding every `connect(ctx.destination)` that was written
 * without one. §3.8's Halo needs exactly this to duck under events, and a volume slider — which
 * §3.8 calls an accessibility control — needs it too.
 */
export const DEFAULT_MASTER_GAIN = 0.85;

/** The default factory: the browser's own constructor, or `null` where there is none. */
export function browserAudioContext(): BaseAudioContext | null {
  const g = globalThis as {
    AudioContext?: new () => BaseAudioContext;
    webkitAudioContext?: new () => BaseAudioContext;
  };
  const Ctor = g.AudioContext ?? g.webkitAudioContext;
  if (typeof Ctor !== 'function') return null;
  return new Ctor();
}

export interface AudioSystemOptions {
  /** The bus to listen on — the *same* instance the paint system subscribed to. */
  readonly bus: SoundBus;
  /**
   * Where the ears are, asked at the moment each event arrives.
   *
   * A function rather than a pose pushed in once a tick, and the difference is not style. The
   * paint system reads its listener *during* the bus fan-out, and `GameSim.tick` syncs that
   * listener before anything is allowed to emit — so a pose handed to the mixer before or after
   * the tick is the pose from the other side of `syncListener`, one tick stale. Five centimetres
   * at a sprint, which is nothing until an event lands within five centimetres of a hearing
   * radius: then the paint system hears it and the mixer does not, and §1's "a sound with no
   * paint, or paint with no sound, is impossible to produce" becomes a sentence with an
   * exception. Read at emit time, both senses are answering with the same ears.
   */
  readonly listener: () => ListenerState;
  /** How to get a context. Defaults to the browser's. */
  readonly createContext?: AudioContextFactory;
  readonly masterGain?: number;
}

export class AudioSystem {
  private readonly director: AudioDirector;
  private readonly readListener: () => ListenerState;
  private readonly createContext: AudioContextFactory;
  private readonly masterLevel: number;
  private readonly unsubscribe: () => void;

  private ctx: BaseAudioContext | null = null;
  private master: GainNode | null = null;
  /** Set once a factory has answered `null` — there is no audio here and asking again is noise. */
  private unavailable = false;

  /**
   * §3.8's hum, built on the first `setHaloRadius` after audio comes up.
   *
   * Lazy and not built in `unlock`, because the hum is a *readout* and this class is a mixer: a
   * caller that never asks for a Halo — a test measuring one footstep, a tool rendering one
   * ping — should get exactly the sounds it asked for and no drone underneath them.
   */
  private hum: HaloHum | null = null;

  private playedCount = 0;
  private droppedCount = 0;
  /**
   * The last thing that went wrong starting or scheduling audio, if anything did.
   *
   * Recorded rather than logged. `tools/shoot.mjs` fails the build on a single console error or
   * warning, and it is right to — but a browser refusing to start audio is a normal condition,
   * not a defect, and a game that printed a red line every time a tab was loaded without a click
   * would have taught everyone to ignore the console. So the failure is a value someone can
   * assert on, which is also what makes it testable.
   */
  private failure: string | null = null;

  constructor(options: AudioSystemOptions) {
    this.readListener = options.listener;
    this.director = new AudioDirector(options.listener());
    this.createContext = options.createContext ?? browserAudioContext;
    this.masterLevel = options.masterGain ?? DEFAULT_MASTER_GAIN;
    this.unsubscribe = options.bus.subscribe(this.handle);
  }

  /**
   * Start audio. Safe to call on every gesture: it builds a context at most once, and resuming an
   * already-running one is free.
   *
   * Returns whether audio is live afterwards, so a caller that wants to stop asking can.
   */
  unlock(): boolean {
    if (this.unavailable) return false;
    if (this.ctx === null) {
      let made: BaseAudioContext | null = null;
      try {
        made = this.createContext();
      } catch (error) {
        // A constructor that throws is a platform without usable audio, not a bug in the game.
        this.failure = String(error);
        this.unavailable = true;
        return false;
      }
      if (made === null) {
        this.unavailable = true;
        return false;
      }
      this.ctx = made;
      const master = made.createGain();
      master.gain.value = this.masterLevel;
      master.connect(made.destination);
      this.master = master;
    }
    return this.resume();
  }

  /**
   * Nudge a suspended context back to running, swallowing the rejection a browser hands back when
   * the call did not come from a gesture.
   */
  private resume(): boolean {
    const ctx = this.ctx;
    if (ctx === null) return false;
    if (ctx.state === 'running') return true;
    const resumable = ctx as BaseAudioContext & { resume?: () => Promise<void> };
    if (typeof resumable.resume !== 'function') return false;
    // Fire and forget: the promise settles a frame later and nothing here waits on it — law 5
    // says movement never waits for information, and it certainly never waits for a mixer.
    resumable.resume().catch((error: unknown) => {
      this.failure = String(error);
    });
    // Not live *yet*: the promise settles after this returns. Callers that care ask again next
    // gesture, which is why `unlock` is written to be safe to call every time.
    return false;
  }

  /**
   * The hook the bus calls — the mirror of `PaintSystem.handle`, on the same events.
   *
   * An arrow property so it can be handed to `subscribe` and to `unsubscribe` as the same
   * reference, the same way the paint system's is.
   */
  private handle = (event: SoundEvent): void => {
    // The ears, as of this event — see `AudioSystemOptions.listener` for why it is read here and
    // not pushed in once a tick.
    this.director.setListener(this.readListener());
    const spec = this.director.decide(event);
    // Inaudible is not silence-with-a-gain-of-zero. An event the listener never heard must not
    // reach the mixer at all, or the voice count grows with the world's noise rather than with
    // what can actually be heard.
    if (spec === null) return;
    this.play(spec);
  };

  /** Builds one voice, if there is anywhere to build it. */
  private play(spec: VoiceSpec): void {
    const ctx = this.ctx;
    const master = this.master;
    if (ctx === null || master === null || ctx.state !== 'running') {
      this.droppedCount++;
      return;
    }
    try {
      playVoice(ctx, master, spec, ctx.currentTime);
      // §3.8: the hum "ducks under events". Every voice, not just loud ones — the hum is a
      // constant tone and constant tones mask, so what it has to get out of the way of is
      // whatever just arrived, at whatever level the director gave it.
      this.hum?.duck(ctx.currentTime);
      this.playedCount++;
    } catch (error) {
      // A graph that will not build must not take the frame down with it. Counted as dropped and
      // recorded, for the same reason `unlock` records rather than logs.
      this.failure = String(error);
      this.droppedCount++;
    }
  }

  /**
   * Tell §3.8's hum how loud the player currently is — the glided radius from `GameSim.halo`.
   *
   * Called every frame and cheap enough to be: the hum builds itself the first time, and after
   * that this is one exponential ramp per partial. A radius, not a pitch, because `humPitch` is
   * the one map and both faces of the readout have to go through it.
   *
   * Silently does nothing while audio is not live — the ring is still showing the same number,
   * which is precisely why §3.8 calls the ring the guaranteed readout.
   */
  setHaloRadius(radiusM: number): void {
    const ctx = this.ctx;
    const master = this.master;
    if (ctx === null || master === null || ctx.state !== 'running') return;
    if (this.hum === null) {
      try {
        this.hum = new HaloHum(ctx, master, { radiusM });
        return;
      } catch (error) {
        // Same rule as `play`: a graph that will not build is recorded, never logged, and never
        // takes the frame with it. The player loses the hum and keeps the ring.
        this.failure = String(error);
        return;
      }
    }
    this.hum.setRadius(radiusM, ctx.currentTime);
  }

  /** Whether §3.8's hum has been built and is still running. */
  get humming(): boolean {
    return this.hum !== null && this.hum.running;
  }

  /** Whether audio is live: a context exists and the browser is letting it run. */
  get running(): boolean {
    return this.ctx !== null && this.ctx.state === 'running';
  }

  /** Voices actually built. */
  get played(): number {
    return this.playedCount;
  }

  /**
   * Audible events that made no sound — no context yet, or a context the browser has suspended.
   *
   * The number that says "the world painted and did not speak", which is the one honest gap in
   * the two-senses commitment and deserves to be visible.
   */
  get droppedSilent(): number {
    return this.droppedCount;
  }

  /** The last thing that went wrong, if anything did. Never logged; assert on it instead. */
  get lastFailure(): string | null {
    return this.failure;
  }

  /** The master bus, for the mix pass and §3.8's ducking. Null until `unlock` succeeds. */
  get masterBus(): GainNode | null {
    return this.master;
  }

  dispose(): void {
    this.unsubscribe();
    // The one voice that would otherwise outlive the game: everything else is a strike that has
    // already been scheduled to end, and the hum runs until told not to.
    this.hum?.stop();
    this.hum = null;
    const closable = this.ctx as (BaseAudioContext & { close?: () => Promise<void> }) | null;
    if (closable !== null && typeof closable.close === 'function') {
      closable.close().catch(() => {
        // Closing a context that is already closed is not an error worth having.
      });
    }
    this.ctx = null;
    this.master = null;
  }
}
