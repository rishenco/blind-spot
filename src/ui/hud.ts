/**
 * Debug HUD, title, hint line, help card, mouse-capture prompt — and the two readouts the player
 * is actually meant to read: §3.8's Halo ring and the rack row.
 *
 * Plain DOM on top of the canvas — no framework, no per-frame allocation beyond the
 * strings it writes, and every element is pointer-events:none.
 *
 * The two readouts are drawn here and decided elsewhere. The ring's number comes from
 * `paint/halo.ts`, which owns it so the ring and the hum cannot drift apart; the rack row's comes
 * from `advanceRackReadout` below, which is pure for a blunter reason — the node suite has no
 * DOM, so a rule inside a method of this class is a rule nothing can test.
 */

import { SPHERE_COUNT } from '../game/spheres';

/**
 * The Halo ring's geometry, px — the two numbers `.bs-halo` is drawn from.
 *
 * Here rather than inline in the CSS because the ring is no longer the only thing at the centre
 * of the screen. The rack row (below) is sized to sit *inside* it, and a clearance measured
 * against a literal in a stylesheet is a clearance nothing re-measures when the literal moves.
 * `rackPipBounds` is the arithmetic and `tests/hud.test.ts` is what holds it.
 *
 * 30 px across is the same constraint the rack obeys and for the same reason — see the comment
 * on `.bs-halo` itself.
 */
export const HALO_RING_PX = 30;
export const HALO_RING_BORDER_PX = 2;

/**
 * The furthest anything drawn at the screen centre may be from it, px — a box, not a circle.
 *
 * `tools/shoot.mjs` punches a 40 px hole at the screen centre out of its measurement window, so
 * every photometric golden in the screenshot suite is a reading of the frame *minus this box*.
 * A pixel of HUD chrome outside it is not a cosmetic overrun: it is counted as world paint, and
 * every mean-luminance golden in the suite moves at once, which reads as a rendering regression
 * in a change that only moved a dot on the reticle.
 *
 * It bounds the ring and the rack row together, because it is one hole and they share it.
 */
export const CENTRE_SAFE_BOX_PX = 40;

/**
 * The rack pip, px across — a dot, deliberately smaller than the 5 px reticle.
 *
 * The reticle is where you are aiming and the pips are a thing you glance at; a pip that matched
 * it would put two glyphs of equal weight in the same 20 px of screen and make the centre of the
 * frame ambiguous at exactly the moment (§3.8's ring is already there) it has the most to say.
 * Three pixels is the smallest dot that still reads as round after the bloom pass rather than as
 * a lit pixel.
 */
export const RACK_PIP_PX = 3;

/**
 * Space between two pips, px.
 *
 * Two thirds of a pip: wide enough that four of them are four things rather than a dash, tight
 * enough that the row is 18 px wide and clears the ring it sits inside. This is the knob that
 * pays for the clearance — grow it and the outer pips walk into the ring's stroke, which is why
 * `tests/hud.test.ts` asserts the clearance rather than the gap.
 */
export const RACK_PIP_GAP_PX = 2;

/**
 * How far below the screen centre the row's own centre sits, px.
 *
 * Below rather than above because the ring's brightness is read at its whole circumference and
 * the reticle is read at the centre, so the row has to go somewhere that is neither — and down
 * is where every player has been trained by every ammo counter ever built to look for "how many
 * left". Six pixels clears the reticle's 5 px disc and its 1 px shadow by a pixel, and puts the
 * row's far corner 11.7 px from centre against the ring's 13 px inner edge.
 */
export const RACK_PIP_DROP_PX = 6;

/**
 * An unfilled slot's opacity — how a spent slot says it is still a slot.
 *
 * Not zero, because the readout's claim is "two of four" and not "two": a row that dropped its
 * empty slots would be a row whose *width* encoded the count, which is a length to compare
 * rather than a group to perceive, and comparing lengths is the counting `SPHERE_COUNT` was
 * chosen to avoid. Four pips always, two of them lit.
 *
 * 0.22 is §3.6's memory-skeleton alpha floor, borrowed on purpose rather than tuned afresh: an
 * empty slot is a slot you *had*, and "present, and not fresh" is a question this game has
 * already answered once. The ring's own floor (`HALO_RING_MIN_ALPHA`) is a different question —
 * the bottom of a continuous range, not the off state of a discrete one — so it is not this.
 */
export const RACK_PIP_EMPTY_ALPHA = 0.22;

const STYLE = `
.bs-hud, .bs-hud * { box-sizing: border-box; }
.bs-hud {
  position: fixed; inset: 0; pointer-events: none; z-index: 10;
  font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  color: #cfdbe4; letter-spacing: 0.02em;
  text-shadow: 0 1px 2px rgba(0,0,0,0.85);
  --bs-panel: rgba(10,14,18,0.62);
  --bs-edge: rgba(140,180,200,0.16);
  --bs-accent: #6fd3e0;
}
.bs-debug {
  position: absolute; top: 10px; left: 10px; padding: 8px 10px;
  background: var(--bs-panel); border: 1px solid var(--bs-edge); border-radius: 4px;
  white-space: pre; min-width: 200px;
}
.bs-debug .bs-perf { margin-top: 6px; padding-top: 6px; border-top: 1px solid var(--bs-edge); color: #8fa2b0; }
.bs-title {
  position: absolute; top: 10px; left: 50%; transform: translateX(-50%);
  padding: 6px 12px; background: var(--bs-panel); border: 1px solid var(--bs-edge);
  border-radius: 4px; text-transform: uppercase; letter-spacing: 0.14em; font-size: 11px;
  color: var(--bs-accent);
}
.bs-hint {
  position: absolute; bottom: 14px; left: 50%; transform: translateX(-50%);
  padding: 6px 14px; background: var(--bs-panel); border: 1px solid var(--bs-edge);
  border-radius: 4px; color: #9fb1bd; white-space: nowrap; max-width: 96vw; overflow: hidden;
  text-overflow: ellipsis;
}
/* Sits above the hint line rather than under the reticle: in third person the middle of the
   screen is where the character is, and the prompt was standing on his head. */
.bs-capture {
  position: absolute; bottom: 48px; left: 50%; transform: translateX(-50%);
  padding: 7px 14px; background: rgba(10,14,18,0.72); border: 1px solid var(--bs-edge);
  border-radius: 4px; color: #d8e6ee;
}
.bs-reticle {
  position: absolute; top: 50%; left: 50%; width: 5px; height: 5px; margin: -2.5px 0 0 -2.5px;
  border-radius: 50%; background: rgba(210,235,245,0.72);
  box-shadow: 0 0 0 1px rgba(0,0,0,0.55);
}
/* §3.8's ring — "a ring around the reticle whose brightness equals your current audible radius".
   Opacity is the only thing about it that ever moves. A ring that also grew would be a second
   encoding of one quantity, and two encodings of one quantity are two things that can disagree,
   which is the exact failure §3.8 is written to prevent. It is cyan rather than the amber §3.2
   gives self-events because it is not an event and not in the world: it is chrome, reporting a
   state, and an amber disc at the centre of the screen would read as a sound that just happened.
   30 px across on purpose — tools/shoot.mjs punches a 40 px hole at the screen centre out of
   its measurement window, and the ring has to stay inside it or every pixel golden moves. */
.bs-halo {
  position: absolute; top: 50%; left: 50%;
  width: ${HALO_RING_PX}px; height: ${HALO_RING_PX}px;
  margin: ${-HALO_RING_PX / 2}px 0 0 ${-HALO_RING_PX / 2}px;
  border-radius: 50%; border: ${HALO_RING_BORDER_PX}px solid var(--bs-accent);
}
/* The rack — how many spheres are left, drawn the way game/spheres.ts says the number is meant
   to be read: "humans subitize up to four: a four-pip readout is *perceived*, not counted". So
   four dots in a row and never a numeral, because a numeral is the thing that costs a glance.
   Cyan, by the ring's argument directly above: this is chrome reporting a state the player owns,
   not a §3.2 event, and the amber that layer reserves for a self-event would claim at the centre
   of the screen that a noise had just happened where the rig is standing.
   Inside the ring rather than under it, because both live in one 40 px hole (CENTRE_SAFE_BOX_PX)
   and only one of them gets to spend it. */
.bs-rack {
  position: absolute; top: 50%; left: 50%;
  transform: translate(-50%, -50%) translateY(${RACK_PIP_DROP_PX}px);
  display: flex; gap: ${RACK_PIP_GAP_PX}px;
}
.bs-rack-pip {
  width: ${RACK_PIP_PX}px; height: ${RACK_PIP_PX}px; border-radius: 50%;
  background: var(--bs-accent); opacity: ${RACK_PIP_EMPTY_ALPHA};
}
/* Filled and empty differ in opacity alone — same hue, same size, same place. Anything else and
   the row would encode the count twice, which is two things that can disagree about it. */
.bs-rack-pip.bs-rack-on { opacity: 1; }
.bs-help {
  position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%);
  padding: 20px 26px; background: rgba(8,11,15,0.93); border: 1px solid var(--bs-edge);
  border-radius: 6px; font-size: 14px; line-height: 1.9; min-width: 340px;
}
.bs-help h2 {
  margin: 0 0 12px; font-size: 12px; letter-spacing: 0.24em; text-transform: uppercase;
  color: var(--bs-accent); font-weight: 600;
}
.bs-help table { border-collapse: collapse; }
.bs-help td { padding: 1px 0; vertical-align: top; }
.bs-help td.k { color: #eef6fa; padding-right: 18px; white-space: nowrap; }
.bs-help td.v { color: #9fb1bd; }
.bs-hidden { display: none; }
`;

export interface HelpRow {
  keys: string;
  action: string;
}

/**
 * How visible the Halo ring is at the *bottom* of its range (§3.8).
 *
 * Not zero, because the bottom of the readout is not silence. `haloBrightness` reads 0 at
 * `HALO_REFERENCE_M` — 1.5 m, the radius the pitch map is referenced to — and "nothing further
 * away than a metre and a half can hear you" is a reading the player is entitled to *see*. Fade
 * the ring to nothing there and the quietest state on the dial becomes indistinguishable from a
 * HUD that is not drawing, which is the complaint §3.8 calls non-negotiable, reintroduced at the
 * one end of the range where a player is most carefully listening for an answer.
 *
 * 0.18 is the same argument §3.6's memory skeleton makes with its alpha floor of ~0.22: dim
 * enough to read as "nearly nothing", bright enough to read as *present*.
 */
export const HALO_RING_MIN_ALPHA = 0.18;

/**
 * Ring brightness (0–1, from `paint/halo`) → the ring's opacity.
 *
 * Affine and nothing more. `haloBrightness` has already done the interesting part — it is derived
 * from `humPitch`, which is what keeps the ring and the hum from disagreeing about which of two
 * states is louder — and a second curve here would undo exactly that. Anything this function does
 * beyond a floor and a scale is a place the two faces of §3.8 can drift apart.
 *
 * Out-of-range and NaN both land on the floor rather than propagating: `brightness > 0` is false
 * for NaN, and a NaN opacity is a ring that vanishes.
 */
export function haloRingAlpha(brightness: number): number {
  const b = brightness > 0 ? (brightness < 1 ? brightness : 1) : 0;
  return HALO_RING_MIN_ALPHA + b * (1 - HALO_RING_MIN_ALPHA);
}

/**
 * How far the opacity must move before the DOM is written again.
 *
 * A write-elision, not a quantization of the readout — 1/2000 is finer than the 1/255 an 8-bit
 * compositor can show, so no state the eye could distinguish is ever collapsed into another. It
 * exists because `setHalo` is called every frame (§3.8's ring is continuous, so it cannot ride
 * the HUD's tenth-of-a-second timer) and a per-frame string assignment to `style.opacity` is the
 * one allocation this file otherwise does not make.
 *
 * Which side of one 8-bit step it falls on is the whole of it, and that is why it is exported
 * and asserted rather than left as a private tuning digit. Below a step this is an optimisation,
 * invisible by construction: every write it suppresses would have painted the pixel that is
 * already there. At or above a step it is no longer an optimisation but a *quantization of the
 * readout* — the ring stops gliding and starts clicking through roughly 1/ε rungs, sixteen of
 * them across the 0.18–1 span at 0.05 — and that is exactly §3.8's stepped variant, which the
 * doc parks behind a playtest gate ("if more than half of testers mute it, the stepped variant
 * is the prepared fallback") and does not ship.
 *
 * Moving the digit is a change nothing else in the build can see, which is measured rather than
 * assumed: at 0.05 the node suite and the browser suite are both green, and `tools/shoot.mjs`
 * reads back the same crouch/walk/sprint ring means it always has. It cannot see it because it
 * only ever reads the ring *settled*, and an elision leaves a settled reading within ε of the
 * truth. The stepping lives in the transit between stances — §3.8's 0.18 s glide — and nothing
 * photographs that.
 *
 * The string this guards is rounded to three decimals, a coarser grid than 1/2000 — but 1/1000
 * is itself well under 1/255, so the bound that matters is the compositor's either way, and the
 * compositor's is the one `tests/halo.test.ts` holds.
 */
export const HALO_ALPHA_EPSILON = 0.0005;

/**
 * How long one showing of the rack row lasts, seconds — from the trigger to fully dark.
 *
 * The row is not permanent, and that is §14's "no minimap, no compass, no objective markers"
 * applied to the one piece of state the world genuinely cannot show you: a sphere in the rack
 * makes no sound and paints nothing, so it is invisible by the rules the rest of the game plays
 * by.
 * The answer is not to draw it forever — a glyph that is always lit stops being read within a
 * minute and is then just a bright spot in the middle of a black screen, competing with §3.8's
 * ring for the one place on screen the player is already looking. The answer is to draw it when
 * the number is *in question*, which is what the three triggers in `advanceRackReadout` are.
 *
 * 1.6 s is roughly two beats of a wind-up (`SPHERE_CHARGE_SECONDS` is 0.9) — long enough that a
 * glance a moment late still catches it, short enough that a throw and the row that reported it
 * are the same event in the player's head rather than two.
 */
export const RACK_PIP_SHOW_SEC = 1.6;

/**
 * The tail of that window spent fading out, seconds.
 *
 * The row holds full brightness for the first 1.2 s and only then leaves, rather than fading
 * across the whole window, because the fade is not a second readout and must not be read as one.
 * An empty pip is already at `RACK_PIP_EMPTY_ALPHA`; multiply that by a falling row opacity and
 * the empty slots reach the floor of what a display can show while the lit ones are still
 * plainly there, so a dying "two of four" passes through a stretch where it reads as "two". The
 * count would be *wrong* on the way out — not dimmer, wrong — and law 2 does not get an
 * exemption for chrome. Holding first means the row is only ever misread while it is already on
 * its way to nothing.
 */
export const RACK_PIP_FADE_SEC = 0.4;

/** What the hand looks like to the readout — the three numbers, and nothing else about it. */
export interface RackSample {
  /** Spheres in the rack. */
  readonly carried: number;
  /** True for every frame the arm is winding. */
  readonly charging: boolean;
  /** Monotonic count of F-presses that found an empty rack (`Spheres.refused`). */
  readonly refused: number;
}

/** The readout's memory, and the two numbers a frame draws it from. */
export interface RackReadout {
  /** Seconds since the last trigger, saturating at `RACK_PIP_SHOW_SEC`. */
  readonly since: number;
  /** The rack count the previous frame sampled — what a *change* is measured against. */
  readonly carried: number;
  /** The refusal count the previous frame sampled. */
  readonly refused: number;
  /** Lit pips, 0–`SPHERE_COUNT`. */
  readonly filled: number;
  /** The row's opacity; exactly 0 when the row is not drawn at all. */
  readonly alpha: number;
}

/**
 * The readout before anything has happened: dark, and remembering a rack it has never seen.
 *
 * `carried: 0` rather than `SPHERE_COUNT` is deliberate. A run opens with a full rack, so the
 * first sample is a change and the row states the count once at spawn — which is the one moment
 * a player has not yet been told what they are carrying, and a readout that fired only on
 * *change* would never tell them.
 */
export const RACK_READOUT_DARK: RackReadout = {
  since: RACK_PIP_SHOW_SEC,
  carried: 0,
  refused: 0,
  filled: 0,
  alpha: 0,
};

/**
 * Lit pips for a rack count: clamped to the four slots the row has.
 *
 * The clamp is not defensive tidying, it is the row refusing to grow. `SPHERE_COUNT` is four
 * because four is the ceiling of subitizing, so a fifth pip would not be more information — it
 * would convert the whole readout from something perceived into something counted, and the count
 * is what the row exists to avoid. A rack that somehow held five reads as four here and the bug
 * is in whatever filled it, not in the glyph.
 */
export function rackFilledPips(carried: number): number {
  if (!(carried > 0)) return 0;
  return carried < SPHERE_COUNT ? Math.floor(carried) : SPHERE_COUNT;
}

/**
 * Is the pip in slot `index` lit, given `filled` spheres? Slots fill from the left.
 *
 * A line this small is a function because it is the *only* logic in `setRack`'s DOM write, and
 * the DOM write is the half of this file the node suite cannot reach. Left inline it would be
 * the one place a readout whose entire job is a count could be off by one, with nothing able to
 * say so; out here it is four assertions. Which end fills first is arbitrary and therefore has to
 * be pinned somewhere rather than inferred from a loop.
 */
export function rackPipLit(index: number, filled: number): boolean {
  return index < filled;
}

/**
 * Seconds since the trigger → the row's opacity. Hold, then leave (see `RACK_PIP_FADE_SEC`).
 *
 * Written as `!(since < SHOW)` rather than `since >= SHOW` for the trapdoor `paint/halo.ts`
 * names: NaN fails every comparison it is given, so the negated form is the one that catches it,
 * and the state it catches it into is *dark* — a stuck-on readout is worse than an absent one,
 * because a row that never leaves is a row that stops meaning "something just happened".
 */
export function rackRowAlpha(since: number): number {
  if (!(since < RACK_PIP_SHOW_SEC)) return 0;
  const hold = RACK_PIP_SHOW_SEC - RACK_PIP_FADE_SEC;
  return since <= hold ? 1 : (RACK_PIP_SHOW_SEC - since) / RACK_PIP_FADE_SEC;
}

/**
 * One frame of the rack readout: the previous frame's memory, this frame's hand, `dt` seconds.
 *
 * Pure, and the whole of the decision — the class this lives in only paints what it returns.
 * That split is what makes the readout testable at all: `ui/hud.ts` builds DOM and the node
 * suite has no DOM, so a rule that lived inside `setRack` would be a rule nothing could check.
 *
 * ## The three triggers
 *
 * **The count changed.** A throw spent one, the reactor finished rebuilding one. The row reports
 * what the number became, at the moment it became it.
 *
 * **The arm is winding.** `charging` is a level, not an edge, so it re-arms the window every
 * frame and the row is up for the whole wind-up however long it is held. This is not covered by
 * the change trigger: the rack does not decrement until `launch`, so without this line the one
 * moment the count decides whether to commit — the arm is back, is this the last one? — is the
 * one moment the row is dark.
 *
 * **A refusal.** F pressed on an empty rack. `Spheres.advanceCharge` deliberately makes no
 * sound for this and gives the argument in full: the world may not carry a noise that paints
 * nothing, and §3.8's Halo hum is the sole carve-out because it "has no position and no emitter,
 * and nothing in the world can hear it". This row is in exactly that category and nowhere near
 * the exception — it is not a sound at all. It has no position in the world, no emitter, and the
 * spider will never hear it, so flashing an empty four-pip row at a key that did nothing answers
 * "why didn't that work" without putting a single thing on the bus. The alternative is silence
 * on both channels, which does not read as "empty", it reads as "dropped input".
 *
 * A refusal is detected by the count *changing*, not by its value, because `refused` is
 * monotonic: two refusals in a row are two triggers, and the second one is exactly when a player
 * who missed the first is hammering the key.
 *
 * `carried` is compared raw rather than through `rackFilledPips`, so a change the clamp would
 * hide is still a change. The row would draw the same four pips either way, but the *showing* is
 * the event, and a hidden change is a state transition the readout slept through.
 */
export function advanceRackReadout(
  prev: RackReadout,
  sample: RackSample,
  dt: number,
): RackReadout {
  const triggered =
    sample.charging || sample.carried !== prev.carried || sample.refused !== prev.refused;
  const step = dt > 0 ? dt : 0;
  const aged = prev.since + step;
  const since = triggered ? 0 : aged < RACK_PIP_SHOW_SEC ? aged : RACK_PIP_SHOW_SEC;
  return {
    since,
    carried: sample.carried,
    refused: sample.refused,
    filled: rackFilledPips(sample.carried),
    alpha: rackRowAlpha(since),
  };
}

/** The rack row's painted extent, px, in screen-centre coordinates with y pointing down. */
export interface PixelBounds {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
}

/**
 * Where the rack row actually lands on screen — the CSS above, evaluated.
 *
 * It exists so the 40 px hole (`CENTRE_SAFE_BOX_PX`) is a *measured* constraint rather than a
 * remembered one. Every number in it is a number the stylesheet is generated from, so there is
 * no arithmetic here that the browser is not doing, and `tests/hud.test.ts` can hold the two
 * clearances that matter — the hole the screenshot suite depends on, and the ring the row sits
 * inside — without a browser and without a golden to re-bless.
 *
 * The row is `SPHERE_COUNT` pips wide with a gap between each pair, centred horizontally on the
 * screen and dropped `RACK_PIP_DROP_PX` below it. No shadow and no glow, deliberately: `.bs-halo`
 * has none either, and a box-shadow would paint outside these bounds — which is to say it would
 * put pixels in the hole this function exists to keep clear of.
 */
export function rackPipBounds(): PixelBounds {
  const width = SPHERE_COUNT * RACK_PIP_PX + (SPHERE_COUNT - 1) * RACK_PIP_GAP_PX;
  return {
    left: -width / 2,
    right: width / 2,
    top: RACK_PIP_DROP_PX - RACK_PIP_PX / 2,
    bottom: RACK_PIP_DROP_PX + RACK_PIP_PX / 2,
  };
}

export class Hud {
  private readonly root: HTMLDivElement;
  private readonly panelEl: HTMLDivElement;
  private readonly debugEl: HTMLDivElement;
  private readonly perfEl: HTMLDivElement;
  private readonly titleEl: HTMLDivElement;
  private readonly hintEl: HTMLDivElement;
  private readonly captureEl: HTMLDivElement;
  private readonly helpEl: HTMLDivElement;
  private readonly haloEl: HTMLDivElement;
  private readonly rackEl: HTMLDivElement;
  private readonly pipEls: HTMLDivElement[] = [];
  private readonly styleEl: HTMLStyleElement;
  private helpVisible = false;
  private lastDebug = '';
  private lastPerf = '';
  private lastHaloAlpha = Number.NaN;
  private rack: RackReadout = RACK_READOUT_DARK;
  /**
   * What the DOM currently shows, so an unchanged frame writes nothing.
   *
   * Exact equality and no epsilon, unlike `setHalo`'s: the ring is lit every frame of the run and
   * its elision is about the pixel-invisible *middle* of a continuous glide, whereas this row is
   * dark for almost all of a run and the frames worth eliding are the identical ones. `alpha`
   * lands on exactly 0 and `filled` on exactly an integer, so the idle case compares equal
   * forever. During the 1.6 s it is up, every frame really does differ and every frame is drawn.
   */
  private drawnAlpha = RACK_READOUT_DARK.alpha;
  private drawnFilled = RACK_READOUT_DARK.filled;

  constructor(parent: HTMLElement = document.body) {
    this.styleEl = document.createElement('style');
    this.styleEl.textContent = STYLE;
    document.head.append(this.styleEl);

    this.root = document.createElement('div');
    this.root.className = 'bs-hud';

    this.panelEl = document.createElement('div');
    this.panelEl.className = 'bs-debug';
    this.debugEl = document.createElement('div');
    this.perfEl = document.createElement('div');
    this.perfEl.className = 'bs-perf';
    this.panelEl.append(this.debugEl, this.perfEl);

    this.titleEl = document.createElement('div');
    this.titleEl.className = 'bs-title';

    this.hintEl = document.createElement('div');
    this.hintEl.className = 'bs-hint';

    this.captureEl = document.createElement('div');
    this.captureEl.className = 'bs-capture';

    const reticle = document.createElement('div');
    reticle.className = 'bs-reticle';

    this.haloEl = document.createElement('div');
    this.haloEl.className = 'bs-halo';
    this.setHalo(0);

    // Four pips, built once and never rebuilt — `SPHERE_COUNT` is the rack's size and the row's,
    // and the row is the same four dots all run whether they are lit or not.
    this.rackEl = document.createElement('div');
    this.rackEl.className = 'bs-rack bs-hidden';
    for (let i = 0; i < SPHERE_COUNT; i++) {
      const pip = document.createElement('div');
      pip.className = 'bs-rack-pip';
      this.pipEls.push(pip);
      this.rackEl.append(pip);
    }

    this.helpEl = document.createElement('div');
    this.helpEl.className = 'bs-help bs-hidden';

    this.root.append(
      this.haloEl,
      this.rackEl,
      reticle,
      this.panelEl,
      this.titleEl,
      this.hintEl,
      this.captureEl,
      this.helpEl,
    );
    parent.append(this.root);
  }

  /**
   * Points the ring at §3.8's readout: 0 is the quietest reading, 1 the loudest.
   *
   * Takes the brightness and not the radius, because `paint/halo` is where the radius becomes a
   * reading and this class has no business knowing the scale it is drawn against. Called every
   * frame rather than from `publishHud`'s timer: §3.8 says the readout glides, and a ring
   * refreshed at 10 Hz next to a hum that glides at 60 is the two faces disagreeing on the one
   * axis the doc singles out.
   */
  setHalo(brightness: number): void {
    const alpha = haloRingAlpha(brightness);
    if (Math.abs(alpha - this.lastHaloAlpha) < HALO_ALPHA_EPSILON) return;
    this.lastHaloAlpha = alpha;
    this.haloEl.style.opacity = alpha.toFixed(3);
  }

  /**
   * One frame of the rack row: the hand as it is now, and `dt` seconds since the last call.
   *
   * Takes the hand itself rather than a decision, which is the opposite of `setHalo` above and
   * deliberately so. The ring's quantity is shared with the hum and therefore has to be owned by
   * a third party neither readout can drift from; the rack's is read by exactly one thing on
   * screen, so the memory the window needs lives with the pixels it moves and nothing else has
   * to carry a timer for it. `GameSim` is spared a field it has no other use for, and `Game` is
   * spared a clock (`sim.clock` is the *paint* clock — T scales it, and how long a HUD row has
   * been up is not a thing that ages faster when you speed up the world's memory).
   *
   * `dt` is wall seconds — the loop's fixed step, the same one `setHalo`'s glide is advanced by.
   */
  setRack(sample: RackSample, dt: number): void {
    const next = advanceRackReadout(this.rack, sample, dt);
    this.rack = next;
    if (next.alpha === this.drawnAlpha && next.filled === this.drawnFilled) return;
    this.drawnAlpha = next.alpha;
    this.drawnFilled = next.filled;
    // Hidden rather than transparent: an opacity-0 row is still a layer the compositor carries
    // for the whole run, and this row is dark for most of one.
    this.rackEl.classList.toggle('bs-hidden', next.alpha <= 0);
    if (next.alpha <= 0) return;
    this.rackEl.style.opacity = next.alpha.toFixed(3);
    for (let i = 0; i < this.pipEls.length; i++) {
      this.pipEls[i]!.classList.toggle('bs-rack-on', rackPipLit(i, next.filled));
    }
  }

  /** Replaces the debug block. Keys are rendered dim, values bright. */
  setDebug(rows: Array<[string, string]>): void {
    let text = '';
    for (const [key, value] of rows) text += `${key.padEnd(9)}${value}\n`;
    if (text === this.lastDebug) return;
    this.lastDebug = text;
    this.debugEl.textContent = text.trimEnd();
  }

  /** Performance block, written by the boot loop rather than by the game. */
  setPerf(rows: Array<[string, string]>): void {
    let text = '';
    for (const [key, value] of rows) text += `${key.padEnd(9)}${value}\n`;
    if (text === this.lastPerf) return;
    this.lastPerf = text;
    this.perfEl.textContent = text.trimEnd();
  }

  setTitle(text: string): void {
    this.titleEl.textContent = text;
  }

  setHint(text: string): void {
    this.hintEl.textContent = text;
  }

  setCapturePrompt(text: string | null): void {
    if (text === null) {
      this.captureEl.classList.add('bs-hidden');
      return;
    }
    this.captureEl.classList.remove('bs-hidden');
    if (this.captureEl.textContent !== text) this.captureEl.textContent = text;
  }

  setHelp(rows: HelpRow[]): void {
    this.helpEl.replaceChildren();
    const title = document.createElement('h2');
    title.textContent = 'Controls';
    const table = document.createElement('table');
    for (const row of rows) {
      const tr = document.createElement('tr');
      const k = document.createElement('td');
      k.className = 'k';
      k.textContent = row.keys;
      const v = document.createElement('td');
      v.className = 'v';
      v.textContent = row.action;
      tr.append(k, v);
      table.append(tr);
    }
    this.helpEl.append(title, table);
  }

  toggleHelp(): void {
    this.setHelpVisible(!this.helpVisible);
  }

  setHelpVisible(visible: boolean): void {
    this.helpVisible = visible;
    this.helpEl.classList.toggle('bs-hidden', !visible);
  }

  get isHelpVisible(): boolean {
    return this.helpVisible;
  }

  dispose(): void {
    this.root.remove();
    this.styleEl.remove();
  }
}
