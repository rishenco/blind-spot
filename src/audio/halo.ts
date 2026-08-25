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
 * §3.8 fixes the result rather than this number — "≈ −21 dBFS" — and 0.065 is what lands there
 * through the 0.85 master. It is low on purpose: a readout the player mutes is a readout the
 * player does not have, and §3.8's playtest gate is about whether testers keep it on.
 *
 * It was 0.05 while the near-unison ran at 0.8. Shrinking that partial to 0.35 to close the beat
 * nulls (see `PARTIALS`) took 2.3 dB of peak with it, and this puts it back: the tone is the same
 * level it always was, it just no longer gets there by briefly stacking two partials in phase.
 */
export const HALO_LEVEL = 0.065;

/**
 * The partials, as [frequency ratio, gain] against the fundamental.
 *
 * A near-unison at +0.7 % gives the tone a slow beat so it reads as a *machine idling* rather
 * than as a test tone, and the quiet 2.5× partial keeps it audible on speakers that give up
 * below 80 Hz — which is most of them, and the bottom of this range is 55 Hz. Neither changes
 * the pitch the player reads: `estimateF0` and the ear both track the fundamental, and the
 * detune's whole contribution is the few cents of sharpness `HALO_PITCH_TOLERANCE_CENTS` allows.
 *
 * **The near-unison's gain is the beat's depth, and it is the number that matters here.** Two
 * partials at gains `a` and `b` swing between `a + b` and `|a - b|`, so the original 0.8 against
 * 1.0 beat through 16-18 dB — not a shimmer but a gate, closing once per beat. That collided
 * with two things at once. §3.8 asks the level to stay "near-constant" so the reading rides on
 * pitch; and the silence gate below reserves *the absence of the tone* to mean "you are making
 * no noise at all", which a tone that nearly vanishes on its own once a second quietly spends.
 * The nulls were load-bearing in the tests, too: `HALO_PITCH_POINTS` picked its measurement
 * windows to dodge them, because at a null there is no pitch to read — a readout §3.8 calls
 * non-negotiable, with holes in it.
 *
 * 0.35 puts the swing at 6.2 dB across the whole range: still plainly a slow pulse, never
 * mistakable for the tone leaving. The cost is 1.6 dB of level, paid back in `HALO_LEVEL`.
 */
const PARTIALS: readonly (readonly [number, number])[] = [
  [1, 1],
  [1.007, 0.35],
  [2.5, 0.12],
];

/**
 * Cutoff of the lowpass the bank passes through, Hz — takes the edge off the 2.5× partial.
 *
 * **Averaged over the readout's whole range it is very nearly nothing, and that is measured
 * rather than guessed.** On the swept render `tests/audio/haloHum.test.ts` builds (2 → 11 → 24 →
 * 2 m), moving the cutoff to 20 kHz — the filter out of the way in all but name — takes the
 * sweep's spectral centroid from 155.5 Hz to 152.8 and its RMS down by 0.39 dB; raising `Q` to 4
 * takes them to 162.8 Hz and up by 0.24 dB. Recorded as a dated, falsifiable number (2026-08-25)
 * so the line above stops implying a filter that is doing more than that.
 *
 * It is not nothing where it matters, which is why it stays and why nothing asserts on it. Its
 * work is at the loud end, on the one partial that does not sit on the fundamental: with the
 * filter in place, moving the 2.5× partial to 5× *lowers* the sprint plateau's centroid, 251.4 →
 * 242.6 Hz, because 5 × 220 Hz lands past the cutoff; with the cutoff at 20 kHz the same change
 * raises it to 312.3. So the filter is what stops a partial's ratio from opening up the top of
 * the range, and the quiet end — where §3.8 asks the tone to be "felt more than heard" — is where
 * such a change shows instead. That end is bounded: `HALO_CROUCH_CENTROID_MAX_HZ`.
 */
const TONE_LP_HZ = 520;
const TONE_LP_Q = 0.6;

/**
 * How long a pitch change takes to arrive, seconds.
 *
 * Not the glide — §3.8's glide is `HALO_GLIDE_SEC`, it lives on the simulation side, and both
 * readouts share it. This is one frame's worth of smoothing on top, so that pushing a value in
 * once per frame is a continuous sweep rather than a 60 Hz staircase. Long enough to remove the
 * step, far shorter than the glide it is carrying, so it cannot be mistaken for tuning.
 *
 * It is also, unavoidably, how far the hum runs *behind* the ring: the ring is drawn from
 * `Halo.radius` on the frame it is read, and the pitch that reports the same reading does not
 * arrive until this much later. §3.8's argument is that the two faces of the readout cannot
 * disagree, and a lag is a disagreement the value checks cannot see — so the lag is measured as a
 * time, in `tests/audio/haloHum.test.ts`, against `HALO_TRACK_MAX_LAG_SEC`. Growing this number
 * is therefore not free the way it looks: at 0.1 s the ear is 650 cents behind the ring at the
 * start of a crouch→walk glide.
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
 * How fast the hum leaves and returns when the body falls silent, seconds.
 *
 * Slow enough not to click, fast enough that stopping dead reads as an event. The tone going
 * away *is* the message — §3.8's readout floors at 55 Hz and zero brightness for everything
 * below the reference radius, so a standstill and a crouch on dust are the same pixel and the
 * same note. They are not the same situation: one is inaudible to the whole world, the other is
 * audible to anything within arm's reach, and the dust apron of §3.9 exists so that difference
 * is worth routing for. Silence is carried as the absence of the tone because that is the only
 * part of the readout with room left in it.
 *
 * A **time constant**, not a duration — the gate eases one frame at a time (see `setSilent`), so
 * the tone is 95 % gone by 0.18 s and lands on exact zero at about 0.42 s.
 */
const SILENCE_FADE_SEC = 0.06;

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
  private readonly silenceGain: GainNode;
  /** Where the gate's own easing has got to, and how far its automation is scheduled. */
  private silenceValue = 1;
  private silenceLastAt = 0;
  private silenceScheduledAt = 0;

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
    // A third gain, for the same reason there are already two: this one answers "is the body
    // making any noise at all", which is a different question from "how loud" and from "get out
    // of that footstep's way". Sharing a lane would let a duck cancel a silence, or a silence
    // strand a duck at 0.32 forever.
    this.silenceGain = ctx.createGain();
    this.silenceGain.gain.value = 1;
    // Anchored so the gate's first ramp has a defined point to interpolate *from*, which is the
    // same reason the oscillators just below are anchored. Without it the first frame's ramp
    // reaches back to whenever the param last happened to be written.
    this.silenceGain.gain.setValueAtTime(1, startAt);

    lp.connect(this.duckGain);
    this.duckGain.connect(this.silenceGain);
    this.silenceGain.connect(this.levelGain);
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
   * Whether the body is emitting nothing at all — the hum's on/off, §3.8.
   *
   * Driven one short ramp per frame, exactly like `setRadius` above, and the reason is that this
   * gate has to be able to turn round *mid-fade*. Between two footfalls of a walk the body is
   * emitting nothing for a moment every stride, and a player edging round a corner taps movement
   * on and off continuously — an interrupted 60 ms fade is the normal case here, not the edge one.
   *
   * The obvious shape — two events per transition, `cancel` then one long ramp — cannot do that
   * on this backend. A ramp is *timed at its end*, so any cancel at the turnaround removes the
   * whole in-flight fade rather than truncating it, and the gain steps from where the fade started
   * to where the new one begins. Measured, that tick is 10-12x the largest step in the steady tone
   * and about a fifth of the hum's peak. `cancelAndHoldAtTime` is the method the spec added for
   * precisely this and it does not help here: it removes the future events without inserting the
   * holding one, so the next ramp interpolates from whatever came *before* the fade — the gate
   * then spends over a second sliding instead of 60 ms, which the silence tests catch outright.
   *
   * A one-frame horizon has no in-flight ramp to truncate. Reversing is just a different target
   * next frame, continuity comes free, and the easing is done in JS where it is arithmetic rather
   * than a scheduling contract. `SILENCE_FADE_SEC` is therefore a time constant, not a duration.
   *
   * Calls that do not advance the timeline are dropped, for the same reason `setRadius` drops
   * them: a `when` behind the ramp already in flight would schedule automation into the past.
   */
  setSilent(silent: boolean, when: number): void {
    if (this.stopped) return;
    const at = when + TRACK_SEC;
    if (at <= this.silenceScheduledAt) return;
    const dt = when > this.silenceLastAt ? when - this.silenceLastAt : 0;
    this.silenceLastAt = when;
    const target = silent ? 0 : 1;
    if (dt > 0) {
      this.silenceValue += (target - this.silenceValue) * (1 - Math.exp(-dt / SILENCE_FADE_SEC));
    }
    // Land on the target rather than approaching it forever. Not an audibility fix — the residual
    // an unsnapped exponential leaves is around −114 dBFS by the time anyone could listen for it,
    // which is inaudible by any definition — but "silent" is a state this readout asserts, and a
    // state asserted as `1e-5` is one nothing downstream can test for. It is also the difference
    // between a render that measures as digital silence and one that measures as very quiet.
    if (Math.abs(this.silenceValue - target) < 1e-3) this.silenceValue = target;
    this.silenceGain.gain.linearRampToValueAtTime(this.silenceValue, at);
    this.silenceScheduledAt = at;
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
