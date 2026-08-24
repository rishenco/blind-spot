/**
 * PHOSPHOR — the halo: the graticule instrument (vision §3.8, doc/looks/phosphor.md).
 *
 * "A ring around the reticle whose brightness equals your current audible radius." Vision calls
 * this non-negotiable, and names the reason: the genre's most-repeated complaint is *I can't tell
 * when I'm detectable*. So this is the one place in the look that is an instrument rather than a
 * read of the world, and it is drawn as one — a scope graticule with ticks every 30°, an energy arc
 * inside it, and a centre pip.
 *
 * TEXT-FREE, by the brief. Every quantity is a shape:
 *
 *   audible radius   the ring's brightness, plus how far the ticks read
 *   energy           an arc whose GAP opens clockwise from the top as the reactor drains
 *   a ping fired     a ring racing OUTWARD from the graticule — it left, and it is out there
 *   a ping refused   a broken ring collapsing INWARD — nothing left the rig
 *
 * The last pair is the point of the encoding: a refusal emits no event, no chirp and no paint
 * (vision §3.5), so it is the one press in the game whose honest answer is silence — and silence is
 * indistinguishable from a dead key. Outward means it happened; inward and broken means it did not.
 * Direction and continuity, never colour, so it survives any colour vision (vision §12).
 *
 * DRAWN ON A CANVAS, and only when something changed. The instrument holds still for most of a run:
 * redrawing it every frame would spend real CPU on an identical image (engine-plan §10).
 */

import {
  HALO_ENERGY_INSET_PX,
  HALO_MAX_ALPHA,
  HALO_MIN_ALPHA,
  HALO_RADIUS_PX,
  HALO_TICK_DEG,
  HALO_TICK_PX,
  PALETTE,
  REFUSAL_SHOW,
  RIM_PULSE,
  type RGB,
} from './params.js';
import type { PlayerView } from '../types.js';

/** How far past the graticule the acknowledgement ring is allowed to race, in ring radii. */
const ACK_REACH = 1.9;
/** Canvas half-size in CSS px: the graticule, the ack ring at full reach, and a pixel of margin. */
const HALF_PX = Math.ceil(HALO_RADIUS_PX * ACK_REACH) + 4;

const rgba = (c: RGB, a: number): string =>
  `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},${a.toFixed(3)})`;

export class PhosphorHalo {
  readonly root: HTMLDivElement;

  private readonly canvas: HTMLCanvasElement;
  private readonly g: CanvasRenderingContext2D | null;
  /** Zero, not one: the backing store starts at the canvas default, so the first setDpr must size it. */
  private dpr = 0;
  /**
   * The last drawn state, quantised — a redraw happens only when this key changes.
   *
   * Six fixed slots compared in place rather than a joined string: this runs on every frame to
   * decide whether to run at all, and the frame path allocates nothing (engine-plan §10).
   * `keyed` is false until the first draw, so the instrument always paints once.
   */
  private readonly key = new Int32Array(6);
  private keyed = false;

  constructor(dpr: number) {
    this.root = document.createElement('div');
    this.root.style.cssText = 'position:absolute;inset:0;pointer-events:none;';

    this.canvas = document.createElement('canvas');
    this.canvas.style.cssText =
      `position:absolute;left:50%;top:50%;width:${HALF_PX * 2}px;height:${HALF_PX * 2}px;` +
      `margin:${-HALF_PX}px 0 0 ${-HALF_PX}px;`;
    this.root.appendChild(this.canvas);
    this.g = this.canvas.getContext('2d');
    this.setDpr(dpr);
  }

  setDpr(dpr: number): void {
    const d = Math.max(1, dpr);
    if (d === this.dpr && this.canvas.width > 0) return;
    this.dpr = d;
    this.canvas.width = Math.round(HALF_PX * 2 * d);
    this.canvas.height = Math.round(HALF_PX * 2 * d);
    this.keyed = false; // the backing store was resized, so whatever was on it is gone
  }

  /**
   * `now` is the render clock; `lastPingAt` is when the last ping EVENT left, which is not the same
   * instant as the last press — a refused press never becomes an event, and that difference is the
   * whole reason the refusal cue exists.
   */
  update(now: number, p: PlayerView, haloFullM: number, lastPingAt: number, calm: boolean): void {
    const loud = Math.min(1, Math.max(0, p.audibleRadius / haloFullM));
    const energy = p.energyMax > 0 ? Math.min(1, Math.max(0, p.energy / p.energyMax)) : 0;

    const ackAge = lastPingAt < 0 ? Infinity : now - lastPingAt;
    const ack = ackAge >= 0 && ackAge < RIM_PULSE ? ackAge / RIM_PULSE : -1;

    const lp = p.lastPing;
    const refAge = lp && lp.refused ? now - lp.at : Infinity;
    const refused = refAge >= 0 && refAge < REFUSAL_SHOW ? refAge / REFUSAL_SHOW : -1;
    const lowEnergy = lp?.refused === 'energy';

    // Quantised: the instrument redraws when its READING changes, not when a float wobbles.
    const k = this.key;
    const k0 = Math.round(loud * 160);
    const k1 = Math.round(energy * 160);
    const k2 = Math.round(ack * 40);
    const k3 = Math.round(refused * 40);
    const k4 = lowEnergy ? 1 : 0;
    const k5 = calm ? 1 : 0;
    if (this.keyed && k0 === k[0] && k1 === k[1] && k2 === k[2] && k3 === k[3] && k4 === k[4] && k5 === k[5]) {
      return;
    }
    k[0] = k0;
    k[1] = k1;
    k[2] = k2;
    k[3] = k3;
    k[4] = k4;
    k[5] = k5;
    this.keyed = true;

    this.draw(loud, energy, ack, refused, lowEnergy, calm);
  }

  private draw(loud: number, energy: number, ack: number, refused: number, lowEnergy: boolean, calm: boolean): void {
    const g = this.g;
    if (!g) return;
    const d = this.dpr;
    g.setTransform(d, 0, 0, d, HALF_PX * d, HALF_PX * d);
    g.clearRect(-HALF_PX, -HALF_PX, HALF_PX * 2, HALF_PX * 2);
    g.lineCap = 'butt';

    const hud = PALETTE.hud;
    // Vision §3.8: ring brightness IS the audible radius. The floor exists so the instrument stays
    // findable in total silence — the READING is the ramp above it, not the floor.
    const ringA = HALO_MIN_ALPHA + (HALO_MAX_ALPHA - HALO_MIN_ALPHA) * loud;
    const R = HALO_RADIUS_PX;

    // The graticule ring.
    g.lineWidth = 1;
    g.strokeStyle = rgba(hud, ringA);
    g.beginPath();
    g.arc(0, 0, R, 0, Math.PI * 2);
    g.stroke();

    // Ticks every 30°, outward. The cardinals are longer, so the ring has an up: a graticule you
    // cannot orient is a circle.
    for (let deg = 0; deg < 360; deg += HALO_TICK_DEG) {
      const a = (deg * Math.PI) / 180;
      const cardinal = deg % 90 === 0;
      const len = cardinal ? HALO_TICK_PX * 1.8 : HALO_TICK_PX;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      g.strokeStyle = rgba(hud, ringA * (cardinal ? 1 : 0.7));
      g.beginPath();
      g.moveTo(ca * (R + 1), sa * (R + 1));
      g.lineTo(ca * (R + 1 + len), sa * (R + 1 + len));
      g.stroke();
    }

    // The energy arc, inside the ring and thinner. It starts at the top and sweeps anticlockwise,
    // so the GAP it leaves opens clockwise from the top as the reactor drains (the brief).
    const rE = R - HALO_ENERGY_INSET_PX;
    const top = -Math.PI / 2;
    if (energy > 0.001) {
      // A refusal for lack of energy brightens the arc that explains it. It is a brightening and
      // not a strobe, and comfort mode drops it entirely (vision §12).
      const boost = !calm && refused >= 0 && lowEnergy ? 0.35 * (1 - refused) : 0;
      g.lineWidth = 1.6;
      g.strokeStyle = rgba(hud, Math.min(0.95, 0.34 + 0.3 * energy + boost));
      g.beginPath();
      g.arc(0, 0, rE, top, top - energy * Math.PI * 2, true);
      g.stroke();
    }

    // The centre pip: the reticle, and the only always-bright thing in the frame.
    g.fillStyle = rgba(hud, 0.8);
    g.beginPath();
    g.arc(0, 0, 1.4, 0, Math.PI * 2);
    g.fill();

    // A ping fired: a ring racing OUTWARD. Under reduce-flashing it fades in place instead of
    // racing — the instrument still answers, it just does not move (vision §12).
    if (ack >= 0) {
      const rA = calm ? R : R * (1 + (ACK_REACH - 1) * ack);
      g.lineWidth = 1;
      g.strokeStyle = rgba(hud, 0.85 * (1 - ack));
      g.beginPath();
      g.arc(0, 0, rA, 0, Math.PI * 2);
      g.stroke();
    }

    // A ping refused: a BROKEN ring collapsing INWARD. Opposite direction, opposite continuity —
    // it cannot be mistaken for the acknowledgement above at any brightness or in any palette.
    if (refused >= 0) {
      const rR = R * (1 - 0.55 * refused);
      g.lineWidth = 1.4;
      g.strokeStyle = rgba(hud, 0.7 * (1 - refused));
      const seg = Math.PI / 6;
      for (let i = 0; i < 6; i++) {
        const a0 = (i * Math.PI) / 3;
        g.beginPath();
        g.arc(0, 0, rR, a0, a0 + seg);
        g.stroke();
      }
    }
  }

  dispose(): void {
    this.root.remove();
    // Drop the backing store as well: a detached canvas still holds its pixels until collected.
    this.canvas.width = 0;
    this.canvas.height = 0;
  }
}
