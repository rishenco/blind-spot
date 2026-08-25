/**
 * The age ramp — vision §3.2 ("age is a color") and §3.6 ("you never lose the map, only the
 * fine read"), asserted as arithmetic.
 *
 * Five constants decide how everything in this game looks, and until this file they had no Node
 * coverage at all: `skeletonAlpha` could be set to 0 — §3.6's law deleted, the map going black
 * behind you instead of settling into a skeleton — and the whole suite stayed green, as did the
 * screenshot suite. `coldSeconds` could be raised to 600 and the same law fails the other way
 * round, by never arriving; `coolSeconds` could be cut to 5 and §3.2's three visually distinct
 * ages collapse into two with a hinge between them. None of that is a pixel question. It is
 * arithmetic, and arithmetic deserves an oracle that answers in a millisecond and can be asked
 * about ages — an hour of paint clock — that no screenshot run will ever reach.
 *
 * So the division of labour is deliberate and both halves ship:
 *
 *  - here, the *law*: three ordered stages, each strictly dimmer than the last; a floor that is
 *    real, positive and permanent; and each stage sized against something the game actually
 *    does, so a number that drifts out of the shape the design needs fails on the design's
 *    terms rather than because a digit changed;
 *  - `tools/shoot.mjs` §06, the *photograph*: that all of it reaches the framebuffer — that the
 *    room really does cool, really does stop cooling, and stops on something you can still see.
 *
 * Neither is sufficient. A ramp asserted only here could be wired to nothing; a ramp asserted
 * only there is asserted at whatever ages a 90-second screenshot run happens to visit. §1's
 * standard for sight and hearing is the standard here too: both must say it, and they must
 * agree.
 *
 * What this file deliberately does *not* pin is `skeletonSize`. The skeleton being thinner as
 * well as dimmer is a secondary cue §3.6 mentions in half a clause, and there is no law about
 * the multiplier's value — 0.7 is a look, and a look is what playtests are for. Its being an
 * accepted survivor is a decision, not an oversight.
 */

import { describe, expect, it } from 'vitest';
import {
  RAMP_ALPHA_COOL_END,
  RAMP_ALPHA_FRESH_END,
  RAMP_ALPHA_NEW,
  defaultAgeRamp,
  rampAlpha,
  rampStage,
} from '../src/paint/ageRamp';
import { EVENT_FADE, defaultPerceptionTunables } from '../src/paint/paintSystem';
import { defaultMovementTunables } from '../src/player/controller';

const ramp = defaultAgeRamp();

/**
 * The longest a surface may take to reach the memory skeleton, seconds.
 *
 * Derived, not chosen. doc/core-loop.md §2: "One session = one map, 15-25 min", and "4 humming
 * artifacts ... Carry each to the crane and bank it". §5 then states what the skeleton is *for*
 * in one sentence: "The outbound entry hall of every pocket is its return spine ... **The return
 * runs on memory skeleton.**" That is a claim with a deadline in it. The map painted on the way
 * down has to have *finished cooling* by the time the player comes back up through it, or the
 * return runs on mid-ramp navy and the skeleton is a thing the mode is designed around but
 * nobody ever sees.
 *
 * The tightest version of that deadline is the shortest run's shortest trip: 15 minutes divided
 * by four artifacts is one round trip, and the outbound leg that does the painting is half of
 * it. A `coldSeconds` above this is a ramp whose last stage exists only in runs longer than the
 * mode is scoped for.
 */
const OUTBOUND_LEG_SECONDS = (15 * 60) / 4 / 2;

/**
 * The shortest the cool stage may be, seconds — the time to walk the radius of what you can see.
 *
 * §3.6 draws geometry within `windowRadius` of the listener and nothing beyond it; §5's walk is
 * the speed the game is played at when the player is buying information rather than spending it.
 * Together they size the middle of the ramp: paint laid at one edge of your own window should
 * still be reading as *stale* — cyan going navy, not yet skeleton — when you have walked to
 * where it is. A cool stage shorter than that crossing means everything behind you snaps from
 * fresh to remembered inside one room, and law 3's three distinct ages ("fresh, stale, and
 * remembered are visually distinct") is two ages and a cliff.
 */
const WINDOW_CROSSING_SECONDS =
  defaultPerceptionTunables().windowRadius / defaultMovementTunables().walkSpeed;

describe('the age ramp has three stages, in order (§3.2)', () => {
  it('orders the stage boundaries, and every age lands in exactly one', () => {
    expect(ramp.freshSeconds).toBeGreaterThan(0);
    expect(ramp.coolSeconds).toBeGreaterThan(ramp.freshSeconds);
    expect(ramp.coldSeconds).toBeGreaterThan(ramp.coolSeconds);

    expect(rampStage(ramp, 0)).toBe('fresh');
    expect(rampStage(ramp, ramp.freshSeconds - 1e-6)).toBe('fresh');
    expect(rampStage(ramp, ramp.freshSeconds)).toBe('cool');
    expect(rampStage(ramp, ramp.coolSeconds - 1e-6)).toBe('cool');
    expect(rampStage(ramp, ramp.coolSeconds)).toBe('cold');
    expect(rampStage(ramp, ramp.coldSeconds * 1000)).toBe('cold');
  });

  it('makes each stage strictly dimmer than the one before it', () => {
    const fresh = rampAlpha(ramp, ramp.freshSeconds / 2);
    const cool = rampAlpha(ramp, (ramp.freshSeconds + ramp.coolSeconds) / 2);
    const cold = rampAlpha(ramp, (ramp.coolSeconds + ramp.coldSeconds) / 2);

    expect(rampAlpha(ramp, 0)).toBe(RAMP_ALPHA_NEW);
    expect(fresh).toBeLessThan(RAMP_ALPHA_NEW);
    expect(cool).toBeLessThan(fresh);
    expect(cold).toBeLessThan(cool);
    expect(rampAlpha(ramp, ramp.coldSeconds)).toBeLessThan(cold);
  });

  it('hands the stages over to each other without a step in brightness', () => {
    // A discontinuity here would draw as a visible band at a fixed age — a contour line across
    // the room marking two minutes ago, which is exactly the kind of thing law 2 would have to
    // account for and cannot.
    expect(rampAlpha(ramp, ramp.freshSeconds)).toBe(RAMP_ALPHA_FRESH_END);
    expect(rampAlpha(ramp, ramp.freshSeconds - 1e-9)).toBeCloseTo(RAMP_ALPHA_FRESH_END, 8);
    expect(rampAlpha(ramp, ramp.coolSeconds)).toBe(RAMP_ALPHA_COOL_END);
    expect(rampAlpha(ramp, ramp.coolSeconds - 1e-9)).toBeCloseTo(RAMP_ALPHA_COOL_END, 8);
  });

  it('never brightens with age, anywhere along the ramp', () => {
    // The ramp is a one-way trip: nothing gets younger by being left alone. (Paint *is* made
    // younger by being re-heard, but that is the refresh policy in paintSystem, not the ramp.)
    let previous = rampAlpha(ramp, 0);
    for (let age = 0.05; age <= ramp.coldSeconds * 3; age += 0.05) {
      const alpha = rampAlpha(ramp, age);
      expect(alpha).toBeLessThanOrEqual(previous);
      previous = alpha;
    }
  });
});

describe('the memory skeleton is real and permanent (§3.6)', () => {
  it('floors the ramp above nothing at all', () => {
    /*
     * §3.6, in full: "every surface cools into a permanent dim memory skeleton (alpha floor
     * ~0.22) — you never lose the map, only the fine read."
     *
     * A `skeletonAlpha` of zero is that sentence deleted. It is not a dimmer skeleton, it is no
     * skeleton: the map you bought with noise on the way down goes black behind you, and the
     * return ascent that core-loop §5 says "runs on memory skeleton" runs on a black room. The
     * whole outbound half of the mode — spend noise, buy the map — is paying for something the
     * renderer throws away, and every other test in this repo passes while it does.
     *
     * The second assertion is the same law at the resolution a screen has. A floor of 0.001 is
     * a positive number and is black on every display the game will be played on, so the floor
     * has to stay a readable fraction of the navy it settles out of rather than merely a
     * non-zero one. A fifth is the loosest reading of "dim" that is still a picture; the
     * shipped 0.22 sits at a bit over half.
     */
    expect(ramp.skeletonAlpha).toBeGreaterThan(0);
    expect(ramp.skeletonAlpha).toBeGreaterThan(RAMP_ALPHA_COOL_END / 5);
  });

  it('holds that floor at any age a run can reach, and past every age it can', () => {
    // "Permanent" is the load-bearing word, and it is the one a screenshot cannot check: the
    // shoot suite ages the room for as long as a screenshot run can stand to wait, which is a
    // sample of the ramp, not the end of it. Here the end is free.
    for (const multiple of [1, 2, 10, 100, 1000]) {
      const alpha = rampAlpha(ramp, ramp.coldSeconds * multiple);
      expect(alpha).toBe(ramp.skeletonAlpha);
    }
    expect(rampAlpha(ramp, Number.MAX_SAFE_INTEGER)).toBe(ramp.skeletonAlpha);
  });

  it('reaches that floor inside a run, not after one', () => {
    /*
     * The other way to break §3.6 — not an empty skeleton but one that never arrives. A ramp
     * with `coldSeconds` of ten minutes has a perfectly good floor that no player ever sees,
     * and it fails silently in both directions: the map never settles, and the difference
     * between "heard a minute ago" and "heard at the start of the run" is never drawn.
     *
     * See OUTBOUND_LEG_SECONDS above for where the bound comes from — the outbound leg of one
     * artifact trip in the shortest run doc/core-loop.md §2 scopes, which is the leg §5 says
     * the return runs on the memory of.
     */
    expect(ramp.coldSeconds).toBeLessThanOrEqual(OUTBOUND_LEG_SECONDS);
    expect(rampStage(ramp, OUTBOUND_LEG_SECONDS)).toBe('cold');
    expect(rampAlpha(ramp, OUTBOUND_LEG_SECONDS)).toBe(ramp.skeletonAlpha);
  });
});

describe('each stage is sized for what the player does in it', () => {
  it('gives the cool stage a real span of the ramp, not a hinge', () => {
    /*
     * The stage §3.2 calls "cyan → dim navy" is where age is actually read: it holds most of
     * the ramp's dimming and the whole of its hue travel. Collapse it and the ramp still has
     * three branches on paper while drawing two states with a step between them — everything is
     * either new or remembered, and "stale" is a frame you catch in passing.
     *
     * See WINDOW_CROSSING_SECONDS above: the span is measured against walking the radius of
     * your own render window, because that is the shortest trip after which you should still be
     * able to look back at where you started and see that it has aged rather than that it has
     * finished.
     */
    expect(ramp.coolSeconds - ramp.freshSeconds).toBeGreaterThanOrEqual(WINDOW_CROSSING_SECONDS);
  });

  it('keeps the white band shorter than the marker that put it there', () => {
    /*
     * `freshSeconds` is the ice-white band of §3.2's matter layer, and the event layer makes
     * the same claim about the same instant from the other side: a transient marker at the
     * origin of the sound, fading in 2.5-6 s, shipped at the bottom of that range as
     * `EVENT_FADE`. Two layers, one event, and they have to agree about when it stopped being
     * news. A white band that outlived the marker would leave geometry insisting it was just
     * painted after the sound that painted it had gone — the two answers to §3.2's "what just
     * happened" contradicting each other on the same screen.
     *
     * This one is also caught downstream, incidentally, by shoot.mjs's hue reading (a longer
     * white band leaves the room white where it expects cyan). Incidentally is not a place to
     * leave a constant this central, so it is caught here on purpose too.
     */
    expect(ramp.freshSeconds).toBeGreaterThan(0);
    expect(ramp.freshSeconds).toBeLessThanOrEqual(EVENT_FADE);
  });
});
