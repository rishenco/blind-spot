/**
 * The rack row — the four-pip readout, and the three moments it is allowed to exist.
 *
 * Two doors, the same split `tests/throwables.test.ts` uses. Everything about the *rule* — when
 * the row is up, how many pips are lit, where on screen it lands — is asserted against the pure
 * functions in `ui/hud.ts`, because that is where the rule lives and because the node suite has
 * no DOM to build a `Hud` in. Everything about the *game* is driven through `createHeadlessGame`
 * and the real `Throwables`, in `Game.update`'s own order (one sim tick, then one frame of the
 * row, on the same `dt`), so the claims below are claims about the hand the player actually has
 * rather than about a sample a test invented.
 *
 * The one thing this file cannot reach is the five lines of `Hud.setRack` that touch elements.
 * That is why `rackPipLit` exists: the count is the whole of what this readout says, and the slot
 * mapping was the last place it could have been wrong with nothing able to notice.
 */

import { describe, expect, it } from 'vitest';
import {
  CENTRE_SAFE_BOX_PX,
  HALO_RING_BORDER_PX,
  HALO_RING_PX,
  RACK_PIP_DROP_PX,
  RACK_PIP_EMPTY_ALPHA,
  RACK_PIP_FADE_SEC,
  RACK_PIP_GAP_PX,
  RACK_PIP_PX,
  RACK_PIP_SHOW_SEC,
  RACK_READOUT_DARK,
  advanceRackReadout,
  rackFilledPips,
  rackPipBounds,
  rackPipLit,
  rackRowAlpha,
  type RackReadout,
  type RackSample,
} from '../src/ui/hud';
import { createHeadlessGame, type HeadlessGame } from '../src/game/headless';
import { CAN_RACK_CAP } from '../src/world/cans';

/** The browser loop's fixed step, so a "second" here is the number of frames it is in play. */
const FRAME = 1 / 120;

/**
 * A wall-clock duration comfortably past one showing, seconds.
 *
 * Fixed, and deliberately *not* written as `RACK_PIP_SHOW_SEC + something`. A duration derived
 * from the constant under test cannot detect that constant moving — stretch the window to an
 * hour and a test that waits "the window plus a bit" simply waits an hour and still passes. So
 * the wait is a number this file chooses, the window is asserted to fit inside it, and a window
 * that grew past a flash fails here rather than quietly becoming permanent.
 */
const PAST_WINDOW = 2.5;

/** Longer than any showing, for holding the arm back past the point the window would lapse. */
const A_LONG_WIND = 4;

const sample = (carried: number, extra: Partial<RackSample> = {}): RackSample => ({
  carried,
  charging: false,
  refused: 0,
  ...extra,
});

/** Runs `seconds` of frames on an unchanging hand. */
function hold(from: RackReadout, on: RackSample, seconds: number): RackReadout {
  let out = from;
  const frames = Math.round(seconds / FRAME);
  for (let i = 0; i < frames; i++) out = advanceRackReadout(out, on, FRAME);
  return out;
}

/** A hand that has settled: the row has been up, the window has run out, and it is dark again. */
function settled(on: RackSample): RackReadout {
  const out = hold(RACK_READOUT_DARK, on, PAST_WINDOW);
  expect(out.alpha).toBe(0);
  return out;
}

// ---------------------------------------------------------------------------

describe('where the row lands on screen', () => {
  it('fits inside the 40 px hole the screenshot suite punches at the centre', () => {
    /*
     * The hard one. `tools/shoot.mjs` measures the frame *minus* a 40 px box at the screen
     * centre, so a pip outside it stops being chrome and starts being world paint: every
     * photometric golden in the suite moves at once, and the diff reads as a rendering
     * regression in a change that only moved a dot.
     */
    const b = rackPipBounds();
    const half = CENTRE_SAFE_BOX_PX / 2;
    expect(Math.abs(b.left)).toBeLessThanOrEqual(half);
    expect(Math.abs(b.right)).toBeLessThanOrEqual(half);
    expect(Math.abs(b.top)).toBeLessThanOrEqual(half);
    expect(Math.abs(b.bottom)).toBeLessThanOrEqual(half);
  });

  it('measures 18 × 3 px, centred on the reticle and 6 px below it', () => {
    // The measurement itself, pinned so the report's number and the code's stay the same number.
    const b = rackPipBounds();
    expect([b.left, b.right, b.top, b.bottom]).toEqual([-9, 9, 4.5, 7.5]);
    const pips = CAN_RACK_CAP * RACK_PIP_PX;
    expect(b.right - b.left).toBe(pips + (CAN_RACK_CAP - 1) * RACK_PIP_GAP_PX);
    expect(b.bottom - b.top).toBe(RACK_PIP_PX);
    expect((b.top + b.bottom) / 2).toBe(RACK_PIP_DROP_PX);
    expect(b.left).toBe(-b.right);
  });

  it('clears the Halo ring it sits inside', () => {
    // Not a cosmetic preference: the two readouts share one 40 px hole and are the same cyan, so
    // a row that touched the ring's stroke would read as a break in the ring — §3.8's brightness
    // measured around a circumference that has a notch in it.
    const b = rackPipBounds();
    const corner = Math.hypot(Math.max(-b.left, b.right), Math.max(-b.top, b.bottom));
    const ringInner = HALO_RING_PX / 2 - HALO_RING_BORDER_PX;
    expect(corner).toBeLessThan(ringInner);
    expect(ringInner - corner).toBeGreaterThan(1);
  });

  it('keeps an empty slot visible, so the row reads "n of four"', () => {
    // Drop this to zero and the row's *width* becomes the encoding — a length to compare instead
    // of a group to perceive, which is the counting `CAN_RACK_CAP` was chosen four to avoid.
    expect(RACK_PIP_EMPTY_ALPHA).toBeGreaterThan(0);
    expect(RACK_PIP_EMPTY_ALPHA).toBeLessThan(1);
  });
});

describe('how many pips are lit', () => {
  it('is one pip per can, all the way up the rack', () => {
    for (let n = 0; n <= CAN_RACK_CAP; n++) expect(rackFilledPips(n)).toBe(n);
  });

  it('never grows past the four slots the row has', () => {
    // A fifth pip would not be more information — it would turn a perceived row into a counted
    // one, which is the whole of `CAN_RACK_CAP`'s argument.
    expect(rackFilledPips(CAN_RACK_CAP + 1)).toBe(CAN_RACK_CAP);
    expect(rackFilledPips(99)).toBe(CAN_RACK_CAP);
  });

  it('reads a spent rack as an empty row rather than an absent one', () => {
    expect(rackFilledPips(0)).toBe(0);
    expect(rackFilledPips(-1)).toBe(0);
    expect(rackFilledPips(Number.NaN)).toBe(0);
  });

  it('fills the slots from the left, and exactly that many of them', () => {
    // The slot mapping, which is the only line of the DOM write that carries a number.
    for (let filled = 0; filled <= CAN_RACK_CAP; filled++) {
      let lit = 0;
      for (let i = 0; i < CAN_RACK_CAP; i++) {
        if (rackPipLit(i, filled)) {
          lit++;
          expect(i).toBeLessThan(filled);
        }
      }
      expect(lit).toBe(filled);
    }
    expect(rackPipLit(0, 1)).toBe(true);
    expect(rackPipLit(1, 1)).toBe(false);
  });
});

describe('the 1.6 s window', () => {
  it('holds full brightness, then leaves linearly', () => {
    const holdSec = RACK_PIP_SHOW_SEC - RACK_PIP_FADE_SEC;
    expect(rackRowAlpha(0)).toBe(1);
    expect(rackRowAlpha(holdSec)).toBe(1);
    expect(rackRowAlpha(holdSec + RACK_PIP_FADE_SEC / 2)).toBeCloseTo(0.5, 10);
    expect(rackRowAlpha(RACK_PIP_SHOW_SEC)).toBe(0);
    expect(rackRowAlpha(RACK_PIP_SHOW_SEC + 10)).toBe(0);
  });

  it('spends most of itself at full brightness, not fading', () => {
    // The fade is the row leaving, not a second readout. An empty pip is already dim; multiply
    // it by a row opacity that starts falling immediately and "two of four" spends real time
    // reading as "two".
    expect(RACK_PIP_FADE_SEC).toBeLessThan(RACK_PIP_SHOW_SEC / 2);
  });

  it('is a flash rather than a fixture', () => {
    // Pinned here because every behavioural test below waits `PAST_WINDOW` and then asserts the
    // row is gone: that wait is only a test of the window while the window fits inside it.
    expect(RACK_PIP_SHOW_SEC).toBeGreaterThan(1);
    expect(RACK_PIP_SHOW_SEC).toBeLessThan(PAST_WINDOW);
  });

  it('never brightens as a showing ages', () => {
    let previous = Infinity;
    for (let t = 0; t <= PAST_WINDOW; t += 0.01) {
      const a = rackRowAlpha(t);
      expect(a).toBeLessThanOrEqual(previous);
      previous = a;
    }
  });

  it('answers dark for an age it cannot read', () => {
    // NaN fails every comparison it is given, and the state it must fail into is dark: a row
    // that never leaves stops meaning "something just happened".
    expect(rackRowAlpha(Number.NaN)).toBe(0);
  });
});

describe('the three triggers', () => {
  it('states the rack once at spawn, since nothing else ever will', () => {
    const first = advanceRackReadout(RACK_READOUT_DARK, sample(CAN_RACK_CAP), FRAME);
    expect(first.alpha).toBe(1);
    expect(first.filled).toBe(CAN_RACK_CAP);
  });

  it('lights on a count that changed, and is gone inside the window', () => {
    const full = settled(sample(CAN_RACK_CAP));
    const spent = advanceRackReadout(full, sample(CAN_RACK_CAP - 1), FRAME);
    expect(spent.alpha).toBe(1);
    expect(spent.filled).toBe(CAN_RACK_CAP - 1);
    expect(hold(spent, sample(CAN_RACK_CAP - 1), PAST_WINDOW).alpha).toBe(0);
  });

  it('lights on a can coming back as readily as on one going out', () => {
    const spent = settled(sample(2));
    expect(advanceRackReadout(spent, sample(3), FRAME).alpha).toBe(1);
  });

  it('stays up for the whole wind-up, however long the arm is held back', () => {
    /*
     * The rack does not decrement until `launch`, so nothing *changes* while the arm winds.
     * Without this trigger the row is dark for the entire moment the count is in question —
     * the arm is back, is this the last one? — and lights only once the answer is academic.
     */
    const armed = settled(sample(2));
    const winding = hold(armed, sample(2, { charging: true }), A_LONG_WIND);
    expect(winding.alpha).toBe(1);
    expect(winding.filled).toBe(2);
  });

  it('answers a refusal that the world is not allowed to answer', () => {
    /*
     * `Throwables.advanceCharge` makes no sound for a refusal and gives the reason in full: the
     * world may not carry a noise that paints nothing, and §3.8's hum is the sole carve-out
     * because it has no position, no emitter, and nothing in the world can hear it. This row is
     * further from the bus than that — it is not a sound at all — so it may answer where the
     * world may not. Silence on both channels does not read as "empty", it reads as "dropped
     * input".
     */
    const empty = settled(sample(0));
    const refused = advanceRackReadout(empty, sample(0, { refused: 1 }), FRAME);
    expect(refused.alpha).toBe(1);
    expect(refused.filled).toBe(0);
  });

  it('answers every press, because a monotonic count has a fresh edge each time', () => {
    // The second refusal is exactly when a player who missed the first is hammering the key.
    let r = advanceRackReadout(RACK_READOUT_DARK, sample(0, { refused: 1 }), FRAME);
    expect(r.alpha).toBe(1);
    r = hold(r, sample(0, { refused: 1 }), PAST_WINDOW);
    expect(r.alpha).toBe(0);
    r = advanceRackReadout(r, sample(0, { refused: 2 }), FRAME);
    expect(r.alpha).toBe(1);
  });

  it('draws nothing at all while nothing is happening', () => {
    const idle = hold(settled(sample(3)), sample(3), 60);
    expect(idle.alpha).toBe(0);
    expect(idle.filled).toBe(3);
    // The age saturates rather than counting up all run: a readout whose memory grows without
    // bound for an hour is one whose comparison eventually stops being exact.
    expect(idle.since).toBe(RACK_PIP_SHOW_SEC);
  });

  it('does not age on a frame that carried no time', () => {
    const aging = hold(advanceRackReadout(RACK_READOUT_DARK, sample(4), FRAME), sample(4), 0.5);
    expect(aging.since).toBeGreaterThan(0);
    expect(advanceRackReadout(aging, sample(4), 0).since).toBe(aging.since);
    expect(advanceRackReadout(aging, sample(4), -1).since).toBe(aging.since);
  });
});

// ---------------------------------------------------------------------------

/**
 * The row driven against a real hand, in `Game.update`'s order: `sim.tick`, then one frame of the
 * readout on the same wall `dt`.
 */
function rackDriver(game: HeadlessGame): {
  now(): RackReadout;
  every(seconds: number): RackReadout[];
  run(seconds: number): void;
} {
  let readout = RACK_READOUT_DARK;
  const frames: RackReadout[] = [];
  const run = (seconds: number): void => {
    const ticks = Math.round(seconds / game.stepSeconds);
    for (let i = 0; i < ticks; i++) {
      game.step(1);
      readout = advanceRackReadout(readout, game.sim.throwables, game.stepSeconds);
      frames.push(readout);
    }
  };
  return {
    now: () => readout,
    every: (seconds) => frames.slice(-Math.round(seconds / game.stepSeconds)),
    run,
  };
}

/** Aims at the floor, so every can thrown below lands at the rig's feet and stays inert there. */
function aimDown(game: HeadlessGame, d: { run(seconds: number): void }): void {
  game.input.look(0, 900);
  d.run(0.1);
}

describe('against the hand it reports on', () => {
  it('is up for the wind-up, and again for the throw that ends it', () => {
    const game = createHeadlessGame();
    const d = rackDriver(game);
    aimDown(game, d);
    d.run(PAST_WINDOW);
    expect(d.now().alpha).toBe(0);

    game.input.hold('throw');
    d.run(PAST_WINDOW);
    // Still winding, long past the window, and the count has not moved — this is the trigger the
    // change alone could not have supplied.
    expect(game.sim.throwables.charging).toBe(true);
    expect(game.sim.throwables.carried).toBe(CAN_RACK_CAP);
    expect(d.now().alpha).toBe(1);
    expect(d.now().filled).toBe(CAN_RACK_CAP);

    game.input.release('throw');
    d.run(0.1);
    expect(game.sim.throwables.carried).toBe(CAN_RACK_CAP - 1);
    expect(d.now().alpha).toBe(1);
    expect(d.now().filled).toBe(CAN_RACK_CAP - 1);

    d.run(PAST_WINDOW);
    expect(game.sim.throwables.carried).toBe(CAN_RACK_CAP - 1);
    expect(d.now().alpha).toBe(0);
  });

  it('answers an empty rack with an empty row, on the tick F is refused', () => {
    const game = createHeadlessGame();
    const d = rackDriver(game);
    aimDown(game, d);
    for (let i = 0; i < CAN_RACK_CAP; i++) {
      game.input.hold('throw');
      d.run(0.1);
      game.input.release('throw');
      d.run(1.2);
    }
    expect(game.sim.throwables.carried).toBe(0);
    d.run(PAST_WINDOW);
    expect(d.now().alpha).toBe(0);

    const before = game.sim.throwables.refused;
    game.input.press('throw');
    d.run(game.stepSeconds);
    expect(game.sim.throwables.refused).toBe(before + 1);
    expect(d.now().alpha).toBe(1);
    expect(d.now().filled).toBe(0);
  });

  it('stays dark through movement, which the rack has nothing to say about', () => {
    const game = createHeadlessGame();
    const d = rackDriver(game);
    d.run(PAST_WINDOW);
    game.input.hold('forward');
    d.run(2);
    game.input.hold('sprint');
    d.run(1);
    // Sprinting is the loudest the rig gets and the Halo ring is wide open; the rack row is not
    // a loudness readout and has nothing to add to it.
    expect(game.sim.throwables.carried).toBe(CAN_RACK_CAP);
    expect(d.every(2.5).every((f) => f.alpha === 0)).toBe(true);
  });

  it('reports the rack a respawn hands back', () => {
    const game = createHeadlessGame();
    const d = rackDriver(game);
    aimDown(game, d);
    game.input.hold('throw');
    d.run(0.1);
    game.input.release('throw');
    d.run(PAST_WINDOW);
    expect(game.sim.throwables.carried).toBe(CAN_RACK_CAP - 1);
    expect(d.now().alpha).toBe(0);

    game.input.tapKey('KeyR');
    d.run(0.05);
    expect(game.sim.throwables.carried).toBe(CAN_RACK_CAP);
    expect(d.now().alpha).toBe(1);
    expect(d.now().filled).toBe(CAN_RACK_CAP);
  });
});
