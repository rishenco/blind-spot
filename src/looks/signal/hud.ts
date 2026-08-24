/**
 * SIGNAL — the HUD (signal.md "Hands, halo, HUD", vision §3.8).
 *
 * "Halo: a segmented ring of 24 short strokes (like a signal-strength dial) — lit stroke count +
 * brightness = audibleRadius; energy is an inner thin bar-ring that drains counterclockwise in
 * visible quanta of ~4; reticle is a single square dot. UI in `#9FE8FF`; events never recolor it.
 * Everything monospaced-feeling, nothing decorative."
 *
 * THE HALO IS NON-NEGOTIABLE (vision §3.8): "you always know exactly how loud you are". Signal
 * pays that twice — a COUNT and a BRIGHTNESS — because a count is readable in a glance and at any
 * colour vision, and the brightness is what makes the last metre of a walk-to-crouch transition
 * visible before a whole stroke drops. The dial reads the same to a monochromat.
 *
 * NO NUMBERS, deliberately. The engine's printed readout belongs to the debug look, whose job is
 * to be literal; an art look that prints `audible 6.4 m` has stopped answering the question with
 * its image. The one exception is a REFUSED ping: a refusal emits nothing at all, so silence after
 * a press is otherwise indistinguishable from a dead key, and that is the one thing the look has
 * to say out loud (looks/types.ts `PingView`).
 *
 * EVERY STROKE CARRIES ITS OWN GROUND (`P.UI_SHADE`). The dial is DOM over a world that paints
 * itself bright, and the two are not correlated: `audibleRadius` decays to zero within seconds of
 * the sound that set it, while the geometry that sound painted stays hot for AGE_MID. Standing
 * still a few seconds after a ping therefore puts the dimmest possible dial on the brightest
 * possible background — measured at mean luminance 120 under the annulus with the halo at its 0.06
 * floor, which moves the pixel by three levels and is not a readout. The 1 px ground decouples the
 * dial's SHAPE from the world so the stroke COUNT survives any background; the ink's alpha still
 * carries the brightness ramp untouched, so both halves of vision §3.8 still read.
 *
 * DOM discipline: every node is created once and only touched when its own state changes. A HUD
 * that rewrites 50 style strings a frame is a per-frame allocation storm in the one place the
 * profiler will not look for it — hence the interned `INK` table rather than a built string.
 */

import type { PingView } from '../types.js';
import * as P from './params.js';

/** One stroke of a dial: a positioned div plus the last ink level actually written to it. */
interface Stroke {
  readonly el: HTMLDivElement;
  applied: number;
}

/**
 * The 101 ink strings a stroke can ever hold, built once.
 *
 * The level is quantized to a hundredth before it is used (see `setInk`), so the set of strings
 * this HUD can write is finite and small — interning it turns the per-frame `toFixed` and the
 * concatenation around it into an array index. A HUD is the one place a per-frame allocation hides
 * from a profiler, and 49 strokes x 60 fps is 2940 strings a second that never needed to exist.
 */
const INK: readonly string[] = Array.from({ length: 101 }, (_, i) => {
  // `#9FE8FF` as rgb, so the ramp can live in the alpha channel and leave element opacity alone.
  const a = (i / 100).toFixed(2);
  return `rgba(159,232,255,${a})`;
});

const stroke = (angleDeg: number, radius: number, len: number, thick: number): HTMLDivElement => {
  const el = document.createElement('div');
  // The ramp is written into the BACKGROUND's alpha, not the element's opacity, so the 1 px ground
  // under the stroke stays at full strength however dim the ink gets. Element opacity would scale
  // the two together and hand back exactly the problem the ground is here to solve.
  el.style.cssText =
    `position:absolute;left:50%;top:50%;width:${len}px;height:${thick}px;` +
    `margin:${(-thick / 2).toFixed(2)}px 0 0 0;background:${INK[0]};box-shadow:0 0 0 1px ${P.UI_SHADE};` +
    `transform-origin:0 50%;transform:rotate(${angleDeg.toFixed(2)}deg) translateX(${radius}px);`;
  return el;
};

const setInk = (s: Stroke, v: number): void => {
  // Quantized before the compare: a float that wobbles in the sixth decimal would write a style
  // string every frame and never change a pixel.
  const q = Math.round(Math.max(0, Math.min(1, v)) * 100);
  if (q === s.applied) return;
  s.applied = q;
  s.el.style.backgroundColor = INK[q]!;
};

const REFUSAL_TEXT: Record<string, string> = {
  cooldown: 'COOLDOWN',
  energy: 'NO CHARGE',
};

export class SignalHud {
  readonly root: HTMLDivElement;

  private readonly halo: Stroke[] = [];
  private readonly energyRing: HTMLDivElement;
  private energy: Stroke[] = [];
  private energySlots = 0;
  private readonly ack: HTMLDivElement;
  private readonly refusal: HTMLDivElement;

  /** Sim time of the last ping that actually fired; < 0 = none this session. */
  private ackAt = -1;
  private ackShown = false;
  private refusalShown = '';
  private readonly calm: boolean;

  constructor(reduceFlashing: boolean) {
    this.calm = reduceFlashing;

    this.root = document.createElement('div');
    this.root.style.cssText = 'position:absolute;inset:0;pointer-events:none;';

    // Reticle: a single square dot. Square because every sample in this look is square — the
    // reticle is the smallest possible statement of the same grid.
    const reticle = document.createElement('div');
    reticle.style.cssText =
      'position:absolute;left:50%;top:50%;width:3px;height:3px;margin:-1.5px 0 0 -1.5px;' +
      `background:${P.UI_INK};opacity:0.8;box-shadow:0 0 0 1px ${P.UI_SHADE};`;
    this.root.appendChild(reticle);

    // The halo dial. Strokes run clockwise from the top, so the ring fills the way a dial does.
    const haloRing = document.createElement('div');
    haloRing.style.cssText = 'position:absolute;inset:0;';
    for (let i = 0; i < P.HALO_SEGMENTS; i++) {
      const a = -90 + (360 * i) / P.HALO_SEGMENTS;
      const el = stroke(a, P.HALO_RADIUS_PX, P.HALO_STROKE_PX, 2);
      haloRing.appendChild(el);
      this.halo.push({ el, applied: -1 });
    }
    this.root.appendChild(haloRing);

    this.energyRing = document.createElement('div');
    this.energyRing.style.cssText = 'position:absolute;inset:0;';
    this.root.appendChild(this.energyRing);

    // The ping acknowledgement: a decode window that runs out once and fades. A ping needs an
    // answer before its paint can possibly arrive (visual-brief §1.11) — the wavefront takes half
    // a second to reach the far end of an E-ping's 40 m.
    this.ack = document.createElement('div');
    this.ack.style.cssText =
      `position:absolute;left:50%;top:50%;width:${P.ACK_SIZE_PX}px;height:${P.ACK_SIZE_PX}px;` +
      `margin:${-P.ACK_SIZE_PX / 2}px 0 0 ${-P.ACK_SIZE_PX / 2}px;` +
      `border:1px solid ${P.UI_INK};opacity:0;box-shadow:0 0 0 1px ${P.UI_SHADE},inset 0 0 0 1px ${P.UI_SHADE};`;
    this.root.appendChild(this.ack);

    this.refusal = document.createElement('div');
    this.refusal.style.cssText =
      'position:absolute;left:50%;top:50%;margin:46px 0 0 -90px;width:180px;text-align:center;' +
      `font:11px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:0.16em;` +
      `color:${P.UI_INK};opacity:0;text-shadow:0 0 2px ${P.UI_SHADE},0 1px 0 ${P.UI_SHADE};`;
    this.root.appendChild(this.refusal);
  }

  /** A ping that FIRED. A refusal is not an acknowledgement — it is read off `player.lastPing`. */
  ping(at: number): void {
    this.ackAt = at;
  }

  update(now: number, audibleRadius: number, haloFullM: number, energy: number, energyMax: number, lastPing: PingView | null): void {
    // --- the halo: brightness IS the audible radius (vision §3.8) --------------------------------
    const loud = Math.min(1, Math.max(0, audibleRadius / Math.max(1e-3, haloFullM)));
    const lit = Math.round(loud * P.HALO_SEGMENTS);
    // The floor exists so the dial is findable at silence; the READING is the ramp above it.
    const bright = 0.22 + 0.72 * loud;
    for (let i = 0; i < this.halo.length; i++) {
      setInk(this.halo[i]!, i < lit ? bright : 0.06);
    }

    // --- the reactor: an inner bar-ring, draining counterclockwise in quanta ---------------------
    // Quanta, not a sweep: vision §4 makes the loadout an allocation game of discrete costs, and a
    // bar that reads in units of one ping is a bar you can plan against. Chips move `energyMax`,
    // so the slot count is derived and rebuilt when it changes rather than being a constant.
    const slots = Math.max(1, Math.ceil(energyMax / P.ENERGY_QUANTUM));
    if (slots !== this.energySlots) this.rebuildEnergy(slots);
    const litE = Math.min(slots, Math.ceil(Math.max(0, energy) / P.ENERGY_QUANTUM));
    for (let i = 0; i < this.energy.length; i++) {
      setInk(this.energy[i]!, i < litE ? 0.62 : 0.05);
    }

    // --- ping acknowledgement --------------------------------------------------------------------
    const ackAge = this.ackAt < 0 ? Infinity : now - this.ackAt;
    const ackLife = P.ACK_MS / 1000;
    if (ackAge >= 0 && ackAge < ackLife) {
      const u = ackAge / ackLife;
      // Reduce-flashing (vision §12): the window still answers, it just fades in place instead of
      // running out. The information is the acknowledgement, never the motion.
      const scale = this.calm ? 1 : 1 + 1.05 * u;
      this.ack.style.opacity = (1 - u).toFixed(2);
      this.ack.style.transform = this.calm ? '' : `scale(${scale.toFixed(3)})`;
      this.ackShown = true;
    } else if (this.ackShown) {
      this.ack.style.opacity = '0';
      this.ackShown = false;
    }

    // --- refusal ---------------------------------------------------------------------------------
    const show =
      lastPing && lastPing.refused && now - lastPing.at < P.REFUSAL_SHOW
        ? (REFUSAL_TEXT[lastPing.refused] ?? lastPing.refused.toUpperCase())
        : '';
    if (show !== this.refusalShown) {
      this.refusalShown = show;
      this.refusal.textContent = show;
      this.refusal.style.opacity = show ? '0.7' : '0';
    }
  }

  private rebuildEnergy(slots: number): void {
    this.energyRing.replaceChildren();
    this.energy = [];
    this.energySlots = slots;
    for (let i = 0; i < slots; i++) {
      const a = -90 + (360 * i) / slots;
      const el = stroke(a, P.ENERGY_RADIUS_PX, P.ENERGY_STROKE_PX, 2);
      this.energyRing.appendChild(el);
      this.energy.push({ el, applied: -1 });
    }
  }

  dispose(): void {
    this.root.remove();
    this.halo.length = 0;
    this.energy = [];
    this.energySlots = 0;
    this.ackAt = -1;
  }
}
