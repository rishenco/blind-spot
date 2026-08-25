/**
 * The age ramp (§3.2 and §3.6) — the one axis every drawn thing in this game is a function of.
 *
 * Nothing in the world is drawn because it is *there*; it is drawn because it was *heard*, and
 * how it looks is decided entirely by how long ago that was. The ramp lives in its own module
 * because both halves of the renderer read it — the lattice and the contours — and neither owns
 * it. Times are seconds on the paint clock; the last stage never completes, so a surface cools
 * into the permanent memory skeleton and stays there.
 *
 * The ramp is drawn on the GPU, which for a long time meant it could only be *photographed* —
 * `tools/shoot.mjs` §06 ages the room and reads the pixels back. That is the right test of
 * whether the ramp reaches the screen and the wrong test of what the ramp *says*: a photograph
 * of a room at one age answers one question, and the law of §3.6 ("you never lose the map, only
 * the fine read") is a claim about every age there will ever be, including ages no run is long
 * enough to photograph. So the stage arithmetic lives here, in `rampAlpha` and `rampStage`, as
 * plain numbers a Node test can interrogate at 100× the cold time in a millisecond — and
 * `tests/ageRamp.test.ts` does exactly that.
 *
 * The alpha stops below are the reason that is honest rather than a second opinion. They are
 * interpolated straight into the shader's `ageRamp()` (`src/paint/structured.ts`, `RAMP_GLSL`),
 * so the arithmetic asserted in Node and the arithmetic executed on the GPU are the same four
 * numbers, and a change to one is a change to both. What is still mirrored by hand is the
 * *shape* — three branches, the squared ease on the first — and that mirror is the reason both
 * layers are tested: the numbers are shared, the shape is photographed.
 *
 * The colour half of the ramp (`MATTER_FRESH` → `MATTER_MID` → `MATTER_COLD` in `materials.ts`)
 * is not restated here. It travels to the shader as uniforms, it is what §3.2's "age is a
 * temperature" means, and it is measured where it is visible: shoot.mjs reads the hue families
 * off the framebuffer. Alpha is the half that carries the *law* — that the map dims and never
 * dies — which is why alpha is the half with an oracle.
 */

/**
 * Alpha the instant a surface is painted — the top of the ramp, age 0.
 *
 * Full opacity, and the only place on the ramp that gets it: the white band's whole job is to
 * be unmistakably the newest thing on screen.
 */
export const RAMP_ALPHA_NEW = 1;

/**
 * Alpha where the white band ends and the long cyan cool-down begins — age `freshSeconds`.
 *
 * Barely below full on purpose. The white band is a *colour* event, not a brightness one: what
 * marks paint as new is that it is ice-white against cyan, and dimming it as it left the band
 * would make "just heard" and "heard a while ago" differ in two channels at once, which is the
 * one thing §3.2 forbids ("depth cues live only inside this band").
 */
export const RAMP_ALPHA_FRESH_END = 0.9;

/**
 * Alpha where the cyan stage ends and the settle onto the skeleton begins — age `coolSeconds`.
 *
 * Most of the ramp's total dimming is spent getting here, which is what makes age legible at a
 * glance: by the time a surface is navy it is also visibly thin, and the eye reads the pair as
 * one quantity rather than as two independent ones.
 */
export const RAMP_ALPHA_COOL_END = 0.42;

export interface AgeRamp {
  /** Ice-white → cyan. */
  freshSeconds: number;
  /** Cyan → dim navy. */
  coolSeconds: number;
  /** Navy → memory skeleton. */
  coldSeconds: number;
  /** Alpha floor of the skeleton (§3.6 asks for ~0.22). */
  skeletonAlpha: number;
  /** Size multiplier once fully cooled — the skeleton is thinner as well as dimmer. */
  skeletonSize: number;
}

export function defaultAgeRamp(): AgeRamp {
  return {
    freshSeconds: 2,
    coolSeconds: 20,
    coldSeconds: 60,
    skeletonAlpha: 0.22,
    skeletonSize: 0.7,
  };
}

/** Which of the ramp's three branches an age falls in. */
export type RampStage = 'fresh' | 'cool' | 'cold';

/**
 * The stage an age of `ageSeconds` is drawn in.
 *
 * The boundaries are half-open upward — an age of exactly `freshSeconds` is already cool — which
 * is the shader's own `<` and matters only in that both sides agree about it.
 */
export function rampStage(ramp: AgeRamp, ageSeconds: number): RampStage {
  if (ageSeconds < ramp.freshSeconds) return 'fresh';
  if (ageSeconds < ramp.coolSeconds) return 'cool';
  return 'cold';
}

/**
 * GLSL's `mix`, spelled the way the spec spells it: `x·(1−a) + y·a`.
 *
 * Not `x + (y − x)·a`, which is algebraically the same and numerically is not — the spec form
 * returns `y` *exactly* at `a = 1`, and the other one returns 0.21999999999999997 where the
 * skeleton floor is 0.22. The whole point of this module is that a Node test can ask what the
 * alpha floor is and get an answer it can compare against `skeletonAlpha`, so the endpoint has
 * to be exact rather than nearly right.
 */
function mix(x: number, y: number, a: number): number {
  return x * (1 - a) + y * a;
}

/**
 * The alpha the ramp gives an age, mirroring the shader's `ageRamp()` branch for branch.
 *
 * The `max(0.001, …)` guards are the shader's, kept because a ramp collapsed to zero width is a
 * division the GPU performs silently and the CPU would perform differently; the `clamp` on the
 * last stage is what makes the skeleton permanent rather than an alpha that keeps falling
 * through the floor as the run goes on. Past `coldSeconds` this returns `skeletonAlpha` exactly,
 * at any age, forever — that is §3.6's "you never lose the map", written as arithmetic.
 */
export function rampAlpha(ramp: AgeRamp, ageSeconds: number): number {
  if (ageSeconds < ramp.freshSeconds) {
    const t = ageSeconds / Math.max(0.001, ramp.freshSeconds);
    return mix(RAMP_ALPHA_NEW, RAMP_ALPHA_FRESH_END, t);
  }
  if (ageSeconds < ramp.coolSeconds) {
    const span = Math.max(0.001, ramp.coolSeconds - ramp.freshSeconds);
    return mix(RAMP_ALPHA_FRESH_END, RAMP_ALPHA_COOL_END, (ageSeconds - ramp.freshSeconds) / span);
  }
  const span = Math.max(0.001, ramp.coldSeconds - ramp.coolSeconds);
  const t = Math.min(1, Math.max(0, (ageSeconds - ramp.coolSeconds) / span));
  return mix(RAMP_ALPHA_COOL_END, ramp.skeletonAlpha, t);
}
