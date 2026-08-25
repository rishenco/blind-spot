/**
 * The Halo's hum — the audible half of §3.8's self-readout.
 *
 * "A ring around the reticle whose brightness equals your current audible radius, plus a matching
 * hum pitch. You always know exactly how loud you are." The ring is in `ui/hud.ts`; this is the
 * hum, and the word that governs both is *matching*. Neither computes a radius, neither computes
 * a pitch: `paint/halo.ts` owns the quantity and `humPitch` is the one map from it to a
 * frequency, so the two faces of the readout cannot drift apart.
 *
 * It is the only continuous voice in the game. Everything in `voices.ts` is a strike — built,
 * scheduled, and left to decay — because everything in `voices.ts` is a `SoundEvent`, and §1's
 * "one bus, two senses" means every event both paints and sounds. The hum is neither: it is not
 * on the bus, it paints nothing, nothing in the world can hear it, and the spider will never
 * investigate it. It is the rig telling its own pilot what the rig is doing, and it lives in a
 * separate file for exactly that reason — a drone in `voices.ts` would be a sound with no paint,
 * which §1 says is impossible to produce.
 *
 * **Why it ducks.** §3.8 asks for a level that "stays low and near-constant (≈ −21 dBFS) and
 * ducks under events, so the information rides on pitch and the tone can sit under everything
 * without fatiguing". A tone that never stops is a tone that masks, and the things it would mask
 * are footfalls — the player's primary source of geometry (§3.3: "moving fast **is** scanning").
 * So every voice the mixer builds pushes the hum down for a moment and lets it back up. The duck
 * is on the hum's own gain and not on the master, so what ducks is the readout and never the
 * world: an event is never quieter for having arrived while the hum was playing.
 */

import { humPitch } from '../paint/halo';

/**
 * The hum's output level, pre-master.
 *
 * §3.8 fixes the result rather than this number — "≈ −21 dBFS" — and 0.05 is what lands there
 * through the 0.85 master. It is low on purpose: a readout the player mutes is a readout the
 * player does not have, and §3.8's playtest gate is about whether testers keep it on.
 */
export const HALO_LEVEL = 0.05;

/**
 * The partials, as [frequency ratio, gain] against the fundamental.
 *
 * A near-unison at +0.7 % gives the tone a slow beat so it reads as a *machine idling* rather
 * than as a test tone, and the quiet 2.5× partial keeps it audible on speakers that give up
 * below 80 Hz — which is most of them, and the bottom of this range is 55 Hz. Neither changes
 * the pitch the player reads: `estimateF0` and the ear both track the fundamental, and the
 * detune's whole contribution is the few cents of sharpness `HALO_PITCH_TOLERANCE_CENTS` allows.
 */
const PARTIALS: readonly (readonly [number, number])[] = [
  [1, 1],
  [1.007, 0.8],
  [2.5, 0.12],
];

/** Cutoff of the lowpass the bank passes through, Hz — takes the edge off the 2.5× partial. */
const TONE_LP_HZ = 520;
const TONE_LP_Q = 0.6;

/**
 * How long a pitch change takes to arrive, seconds.
 *
 * Not the glide — §3.8's glide is `HALO_GLIDE_SEC`, it lives on the simulation side, and both
 * readouts share it. This is one frame's worth of smoothing on top, so that pushing a value in
 * once per frame is a continuous sweep rather than a 60 Hz staircase. Long enough to remove the
 * step, far shorter than the glide it is carrying, so it cannot be mistaken for tuning.
 */
const TRACK_SEC = 0.02;

/**
 * How far the hum drops under an event, and how fast it goes and comes back.
 *
 * −10 dB is enough to get out of a footstep's way and not so much that the readout disappears
 * while the player is moving — which would be the failure, since moving is when the reading
 * matters. Down fast (12 ms) because the event it is making room for has already started; back
 * slowly (120 ms) because a hum that snapped back would pump audibly at a sprint's step rate.
 */
const DUCK_GAIN = 0.32;
const DUCK_ATTACK_SEC = 0.012;
const DUCK_HOLD_SEC = 0.05;
const DUCK_RELEASE_SEC = 0.12;

/** How long the level takes to reach zero when the hum is stopped, seconds. */
const STOP_FADE_SEC = 0.02;

/**
 * One `setTargetAtTime` segment, remembered so the next one can start where this one got to.
 *
 * An `AudioParam` will not tell you its value at a future time, and the duck has to be
 * retriggerable mid-flight — a sprint lands a footfall every ~350 ms and the release is 120 ms,
 * so overlapping ducks are the normal case, not the edge one. Two numbers of bookkeeping buy the
 * retrigger a starting point, which is what stops it from stepping.
 */
interface Segment {
  readonly at: number;
  readonly from: number;
  readonly to: number;
  readonly tau: number;
}

const segmentAt = (s: Segment, t: number): number =>
  s.to + (s.from - s.to) * Math.exp(-(t - s.at) / s.tau);

/**
 * Pin a param's value at the instant a `setTargetAtTime` is about to start from it.
 *
 * In a browser this is redundant: a `setTarget` leaves the value alone until its start time and
 * then departs from whatever it was. The offline backend the audio suite and `tools/listen.mjs`
 * render through (`node-web-audio-api`) does not — a `setTarget` with nothing scheduled before it
 * evaluates its own exponential *backwards* from the start time, which for a 12 ms time constant
 * half a second out is e^41 and puts the render at +352 dBFS. Measured, not theorised.
 *
 * An explicit anchor is what a browser does implicitly, costs one event, and makes the intended
 * starting value readable instead of inferred. So it is not a workaround kept out of sight: every
 * `setTargetAtTime` in this file is preceded by one.
 */
function anchor(param: AudioParam, value: number, when: number): void {
  param.setValueAtTime(value, when);
}

export interface HaloHumOptions {
  /** Output level, pre-master. Defaults to `HALO_LEVEL`; a volume slider is §3.8's own idea. */
  readonly level?: number;
  /** Context time to start at. Defaults to the context's current time. */
  readonly startAt?: number;
  /** Audible radius at the start, metres. Defaults to the readout's floor. */
  readonly radiusM?: number;
}

/**
 * The running hum. Built once when audio comes up and fed a radius every frame.
 *
 * Takes its destination as an argument like every voice does, so the offline renderer can
 * measure the shipped graph rather than a copy of it.
 */
export class HaloHum {
  private readonly oscillators: OscillatorNode[] = [];
  private readonly duckGain: GainNode;
  private readonly levelGain: GainNode;
  /** Context time the last pitch ramp lands at — keeps the automation strictly ordered. */
  private scheduledAt: number;
  private stopped = false;
  private duckDown: Segment | null = null;
  private duckUp: Segment | null = null;

  constructor(ctx: BaseAudioContext, out: AudioNode, options: HaloHumOptions = {}) {
    const startAt = options.startAt ?? ctx.currentTime;
    const hz = humPitch(options.radiusM ?? 0);

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = TONE_LP_HZ;
    lp.Q.value = TONE_LP_Q;

    // Two gains and not one. `levelGain` is the level §3.8 pins and the one an accessibility
    // slider belongs on; `duckGain` is the automation lane. Sharing a node would make every duck
    // fight whatever last set the level, and a slider drag mid-duck would cancel the recovery.
    this.duckGain = ctx.createGain();
    this.duckGain.gain.value = 1;
    this.levelGain = ctx.createGain();
    this.levelGain.gain.value = options.level ?? HALO_LEVEL;

    lp.connect(this.duckGain);
    this.duckGain.connect(this.levelGain);
    this.levelGain.connect(out);

    for (const [ratio, gain] of PARTIALS) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(hz * ratio, startAt);
      const g = ctx.createGain();
      g.gain.value = gain;
      osc.connect(g);
      g.connect(lp);
      osc.start(startAt);
      this.oscillators.push(osc);
    }

    this.scheduledAt = startAt;
  }

  /**
   * Point the hum at a radius — §3.3's right-hand column, already glided by `paint/halo.ts`.
   *
   * An *exponential* ramp, because pitch is perceived logarithmically: a linear ramp from 55 to
   * 220 Hz spends most of its time in the top octave and reads as a lurch. Safe by construction
   * — `humPitch` has a floor of 55 Hz, and exponential ramps are only illegal through zero.
   *
   * **A ramp is scheduled every frame, including when the radius has not moved**, and skipping
   * the no-op is the bug that looks like an optimization. A ramp interpolates from the *previous
   * event*, wherever that is: a plateau that scheduled nothing leaves the previous event at the
   * far end of the plateau, and the ramp that finally ends it then spans the whole silence. It
   * was measured — a crouch held for 1.8 s and then broken into a walk reads 169 cents sharp for
   * the entire crouch, because the walk's first ramp started sliding at the beginning of it. The
   * readout was reporting the future.
   *
   * Calls that do not advance the timeline are dropped: a `when` behind the ramp already in
   * flight would schedule automation into the past.
   */
  setRadius(radiusM: number, when: number): void {
    if (this.stopped) return;
    const at = when + TRACK_SEC;
    if (at <= this.scheduledAt) return;
    const hz = humPitch(radiusM);
    for (let i = 0; i < this.oscillators.length; i++) {
      const ratio = PARTIALS[i]![0];
      this.oscillators[i]!.frequency.exponentialRampToValueAtTime(hz * ratio, at);
    }
    this.scheduledAt = at;
  }

  /**
   * Push the hum down for a moment — called once per voice the mixer builds (§3.8).
   *
   * Retriggerable on purpose. A sprint lands a footfall roughly every 350 ms against a 120 ms
   * release, so ducks overlap constantly, and a second duck that inherited the first one's
   * release would let the hum surge back up between steps — a pump at the step rate, in the one
   * channel §3.8 asks to stay near-constant. So the new duck starts from wherever the old one
   * had got to (`segmentAt`), and `cancelScheduledValues` drops the release it replaces.
   *
   * `setTargetAtTime` rather than ramps for exactly that reason: a `setTarget` is a point event,
   * so cancelling from `when` cannot rewrite the automation *before* `when`, where a cancelled
   * linear ramp would have left a step behind.
   */
  duck(when: number): void {
    if (this.stopped) return;
    const gain = this.duckGain.gain;
    const from = this.duckValueAt(when);
    const down: Segment = { at: when, from, to: DUCK_GAIN, tau: DUCK_ATTACK_SEC };
    const releaseAt = when + DUCK_HOLD_SEC;
    const up: Segment = {
      at: releaseAt,
      from: segmentAt(down, releaseAt),
      to: 1,
      tau: DUCK_RELEASE_SEC,
    };
    gain.cancelScheduledValues(when);
    anchor(gain, from, when);
    gain.setTargetAtTime(DUCK_GAIN, when, DUCK_ATTACK_SEC);
    gain.setTargetAtTime(1, releaseAt, DUCK_RELEASE_SEC);
    this.duckDown = down;
    this.duckUp = up;
  }

  /** Where the duck envelope has got to at `t` — the two segments, most recent first. */
  private duckValueAt(t: number): number {
    const up = this.duckUp;
    if (up !== null && t >= up.at) return segmentAt(up, t);
    const down = this.duckDown;
    if (down !== null && t >= down.at) return segmentAt(down, t);
    return 1;
  }

  /** Fade out and release the oscillators. Idempotent; the hum does not come back. */
  stop(when?: number): void {
    if (this.stopped) return;
    this.stopped = true;
    const at = when ?? this.scheduledAt;
    const gain = this.levelGain.gain;
    gain.cancelScheduledValues(at);
    anchor(gain, gain.value, at);
    gain.setTargetAtTime(0, at, STOP_FADE_SEC);
    // Ten fade constants later there is nothing left to click.
    for (const osc of this.oscillators) osc.stop(at + STOP_FADE_SEC * 10);
  }

  /** Whether `stop` has been called. */
  get running(): boolean {
    return !this.stopped;
  }
}
