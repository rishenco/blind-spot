/**
 * The shot's aftermath — being concussed, in one place.
 *
 * It used to live twice: once in the live stage (`audio.ts`) and once, copy-pasted, in the
 * offline renderer (`offline.ts`). Two copies of the thing whose whole job is to be *proved* by
 * the offline renderer is exactly one copy too many, so both now call this.
 *
 * What it does, and why it is shaped like this. The verdict on the previous version was
 * «звон есть, но он от детской игрушки, а не от контузии»: a single 3.9 kHz sine fading over a
 * second, over a world that had dipped politely to a quarter of its level. A whistle in a clear
 * room is a toy. Being concussed is the opposite arrangement — the *world* is what disappears,
 * and what is left is a narrow, rough, unpleasant band sitting inside your own head that does
 * not go away for a long time. So:
 *
 *   - **the hall falls through the floor.** The duck goes to a few per cent, not a quarter, and
 *     behind a much lower lowpass — a couple of hundred hertz, which is a wall, not a blanket —
 *     and it climbs back over seconds rather than over one second.
 *   - **the ring is a band, not a note.** Two sines a third of a semitone apart beat against each
 *     other, and a very resonant noise band sits above them. Beating plus hiss is *roughness*,
 *     the thing that makes a sound physically unpleasant; a pure sine is merely a pitch.
 *   - **it breathes.** Two LFOs, one fast enough to shimmer and one slow enough to swell, so the
 *     ring never settles into something the ear can file away and stop hearing.
 *   - **it drifts down** over its life and outlasts the ducking by a wide margin. That overhang
 *     is the whole feeling: the hall is back, and you are still ringing.
 *
 * Nothing here is spatial. The ring is injected *after* the ducking bus, straight into the
 * master, because it is not a thing in the world — it is your own ears. That is also why the
 * spiders cannot hear it: it never touches the bus.
 */

export interface DeafTunables {
  /** How far the world is pushed down while the shot is still in your ears, 0..1. */
  deafDepth: number;
  /** How long the world takes to climb back, seconds. */
  deafSeconds: number;
  /** Cutoff of the muffling filter at the bottom of the duck, Hz. */
  deafCutoff: number;
  /** Level of the ring left in your ears, 0..1. 0 turns it off. */
  tinnitus: number;
  /** How long that ring lasts, seconds. It is meant to outlive the ducking several times over. */
  tinnitusSeconds: number;
  /** Where the ring sits, Hz. High and narrow; the roughness comes from the layers, not this. */
  tinnitusFreq: number;
}

export function defaultDeafTunables(): DeafTunables {
  return {
    deafDepth: 0.05,
    deafSeconds: 1.7,
    deafCutoff: 300,
    tinnitus: 0.055,
    tinnitusSeconds: 5.5,
    tinnitusFreq: 4300,
  };
}

/** The three nodes the effect acts on: the world bus, its muffler, and the post-duck master. */
export interface DeafBus {
  duck: GainNode;
  muffle: BiquadFilterNode;
  master: AudioNode;
}

/**
 * Schedules one concussion at `t0`. Safe to call again while a previous one is still running —
 * later calls simply re-schedule the ducking from wherever it currently is, and each shot adds
 * its own ring, so a burst leaves you deafer than a single round rather than resetting the clock.
 *
 * `endsAt` is when the last of it stops sounding, so the caller can hold its voice that long.
 */
export function applyDeafen(
  ctx: BaseAudioContext,
  bus: DeafBus,
  noise: AudioBuffer,
  t0: number,
  t: DeafTunables,
): number {
  // Onset 20 ms after the trigger: the crack of the shot lands first, then the world goes.
  const shut = t0 + 0.02;
  const secs = Math.max(0.05, t.deafSeconds);

  const duck = bus.duck;
  duck.gain.cancelScheduledValues(t0);
  duck.gain.setValueAtTime(duck.gain.value, t0);
  duck.gain.linearRampToValueAtTime(Math.max(0.005, t.deafDepth), shut);
  // A hold before the climb: the first third of a second is simply *gone*, and only then does the
  // hall start coming back. Without the hold the recovery starts at its fastest exactly when the
  // player is supposed to be most deaf.
  duck.gain.setValueAtTime(Math.max(0.005, t.deafDepth), shut + secs * 0.22);
  duck.gain.setTargetAtTime(1, shut + secs * 0.22, secs * 0.5);
  duck.gain.setValueAtTime(1, shut + secs * 3);

  const muffle = bus.muffle;
  muffle.frequency.cancelScheduledValues(t0);
  muffle.frequency.setValueAtTime(20000, t0);
  muffle.frequency.linearRampToValueAtTime(Math.max(80, t.deafCutoff), shut);
  muffle.frequency.setValueAtTime(Math.max(80, t.deafCutoff), shut + secs * 0.22);
  muffle.frequency.setTargetAtTime(20000, shut + secs * 0.22, secs * 0.45);
  muffle.frequency.setValueAtTime(20000, shut + secs * 3);

  let end = shut + secs * 1.2;
  if (t.tinnitus > 0) {
    const ring = buildTinnitus(ctx, bus.master, noise, shut, t);
    if (ring > end) end = ring;
  }
  return end;
}

/**
 * The ring itself. Not a scripted scare: it is the shot's own after-image, born from the same
 * event, and it is the one sound in the game that has no position because it is not in the world.
 */
function buildTinnitus(
  ctx: BaseAudioContext,
  dest: AudioNode,
  noise: AudioBuffer,
  shut: number,
  t: DeafTunables,
): number {
  const life = Math.max(0.2, t.tinnitusSeconds);
  const stop = shut + life;
  const f = Math.min(9000, Math.max(600, t.tinnitusFreq));

  // Envelope: instant, then a long *shallow* slide, then a quick clean exit.
  //
  // The shape matters more than the numbers here. An exponential ramp all the way down to silence
  // — which is what this was — collapses: measured, it lost 45 dB over the four seconds it was
  // supposed to be ringing through, so by the time the hall came back the ring was already gone
  // and the whole overhang, the point of the effect, did not exist. Now the long leg only drops
  // to 8% and the ring is still plainly there at the end of its life; the last 150 ms take it to
  // nothing so it stops without a click. Numbers are in `tools/audio.mjs` ("ring after the shot").
  const env = ctx.createGain();
  env.gain.setValueAtTime(0.0001, shut - 0.02);
  env.gain.exponentialRampToValueAtTime(t.tinnitus, shut + 0.03);
  env.gain.exponentialRampToValueAtTime(t.tinnitus * 0.45, shut + life * 0.3);
  env.gain.exponentialRampToValueAtTime(t.tinnitus * 0.08, stop - 0.15);
  env.gain.exponentialRampToValueAtTime(0.0001, stop);

  // Two LFOs on a shared gain: a shimmer you notice and a swell you do not. Their sum sits around
  // 0.85 ± 0.3, so the ring is never steady and never silent.
  const trem = ctx.createGain();
  trem.gain.setValueAtTime(0.85, shut - 0.02);
  const fast = ctx.createOscillator();
  fast.type = 'sine';
  fast.frequency.setValueAtTime(6.3, shut);
  fast.frequency.linearRampToValueAtTime(4.1, stop);
  const fastAmt = ctx.createGain();
  fastAmt.gain.value = 0.2;
  fast.connect(fastAmt);
  fastAmt.connect(trem.gain);
  const slow = ctx.createOscillator();
  slow.type = 'sine';
  slow.frequency.value = 0.43;
  const slowAmt = ctx.createGain();
  slowAmt.gain.value = 0.12;
  slow.connect(slowAmt);
  slowAmt.connect(trem.gain);
  fast.start(shut - 0.02);
  slow.start(shut - 0.02);
  fast.stop(stop + 0.02);
  slow.stop(stop + 0.02);

  env.connect(trem);
  trem.connect(dest);

  // Two sines a third of a semitone apart. Their difference tone (~30 Hz at 4.3 kHz) is beating,
  // and beating in this band is the definition of an unpleasant ring. One sine alone is a whistle.
  for (const [mul, gain] of [[1, 0.62], [1.0072, 0.5]] as const) {
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(f * mul, shut);
    // A slow slide downwards over the whole life: nothing biological holds a pitch for five
    // seconds, and a held pitch is the exact thing the chatter had to be cured of.
    osc.frequency.exponentialRampToValueAtTime(f * mul * 0.88, stop);
    const g = ctx.createGain();
    g.gain.value = gain;
    osc.connect(g);
    g.connect(env);
    osc.start(shut - 0.02);
    osc.stop(stop + 0.02);
  }

  // And a very resonant band of hiss above them — the "sssss" inside the whine. This is the layer
  // that makes it a damaged ear rather than a test tone.
  const src = ctx.createBufferSource();
  src.buffer = noise;
  src.loop = true;
  const band = ctx.createBiquadFilter();
  band.type = 'bandpass';
  band.frequency.setValueAtTime(f * 1.35, shut);
  band.frequency.exponentialRampToValueAtTime(f * 1.1, stop);
  band.Q.value = 26;
  const bandGain = ctx.createGain();
  bandGain.gain.value = 0.85;
  src.connect(band);
  band.connect(bandGain);
  bandGain.connect(env);
  src.start(shut - 0.02, 0.13);
  src.stop(stop + 0.02);

  return stop;
}
