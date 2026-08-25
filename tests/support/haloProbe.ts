/**
 * The Halo hum prototype — the last fixture voice, and the only one left.
 *
 * `probeVoices.ts` used to hold a fixture for every sound the game might make, because the game
 * made none. It is gone: `src/audio/voices.ts` ships the contact and ping voices and
 * `tests/audio/` measures those directly, so a number pinned there is a number the game produces.
 *
 * §3.8's Halo is the one sound still unbuilt (M1 continues), and it is worth having a measurable
 * prototype of rather than nothing: §3.8 is the only place the vision doc uses the word
 * *non-negotiable*, and the claims it makes — `55·√(r/1.5)` Hz, gliding, at a level that does not
 * track the radius — are exactly the kind that a listening test never catches and a metric catches
 * instantly. This file exists so those three claims have somewhere to fail before the real hum is
 * written, and it leaves the day the real one lands, the same way the material fixture just did.
 *
 * Everything here takes a `BaseAudioContext`, so the prototype and its replacement are measured
 * by the same harness under the same offline renderer.
 */

/**
 * Audible radius (m) → Halo hum pitch (Hz): 1.5 m reads 55 Hz, 24 m reads 220 Hz — two octaves
 * across the whole loudness range, on a square-root (i.e. half-log) map so the quiet end, where
 * the player is making decisions about being heard, gets the resolution.
 *
 * §3.8 is emphatic that the player must always know how loud they are; pitch is the readout, so
 * this function is the readout's calibration and `estimateF0` is how a test checks it.
 */
export const humPitch = (radiusM: number): number =>
  55 * Math.sqrt(Math.max(1.5, Math.min(24, radiusM)) / 1.5);

export interface HumPoint {
  t: number;
  /** Audible radius at that moment, metres. */
  r: number;
}

/**
 * The Halo hum: three oscillators (fundamental, a 0.7 % detune for body, a quiet 2.5× partial)
 * lowpassed, following a piecewise radius automation.
 *
 * Level stays near-constant on purpose — *pitch* is the readout, not loudness, so a player can
 * hear their own radius over their own footsteps.
 */
export function haloHum(
  ctx: BaseAudioContext,
  out: AudioNode,
  points: readonly HumPoint[],
  level: number,
  until: number,
): void {
  if (points.length === 0) throw new Error('haloHum: needs at least one point');
  const first = points[0]!;
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 520;
  lp.Q.value = 0.6;
  const master = ctx.createGain();
  master.gain.value = level;
  lp.connect(master);
  master.connect(out);

  for (const [ratio, gain] of [[1, 1], [1.007, 0.8], [2.5, 0.12]] as const) {
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(humPitch(first.r) * ratio, first.t);
    for (let i = 1; i < points.length; i++) {
      const point = points[i]!;
      osc.frequency.exponentialRampToValueAtTime(humPitch(point.r) * ratio, point.t);
    }
    const g = ctx.createGain();
    g.gain.value = gain;
    osc.connect(g);
    g.connect(lp);
    osc.start(first.t);
    osc.stop(until);
  }
}
