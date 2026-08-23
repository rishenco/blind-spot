/**
 * BLUEPRINT — the HUD. An instrument face, drawn in the same ink as the world.
 *
 * "Halo: a thin ring with 4 compass ticks; brightness = audibleRadius; energy is a fine arc with
 * 10 graduation marks (empty marks vanish); reticle is a 3-px crosshair gap. All UI hairline, all
 * `#DFF3FF`, nothing filled." (doc/looks/blueprint.md)
 *
 * SVG, not DOM boxes: every element here is a stroked path of width 1, which is what "hairline"
 * means and what a `border` cannot promise across zoom levels. One node per instrument, laid out
 * once, and thereafter only the handful of attributes that actually carry a reading are written —
 * a HUD that rewrites its own style strings 60 times a second is a per-frame allocation in the
 * draw path (engine-plan §10). The one addition to the brief's letter is the casing pass described
 * at `CASING_W`, which is what keeps the hairline honest over bright matter.
 *
 * WHAT IS LAW HERE rather than styling: the halo's brightness IS `audibleRadius` and means nothing
 * else (vision §3.8 — the genre's most-repeated complaint is "I can't tell when I'm detectable"),
 * the ping rim is a SEPARATE ring so a moment of feedback can never be mistaken for loudness, and
 * a REFUSED ping is spoken out loud because it is the one press in the game whose answer is
 * silence — indistinguishable, otherwise, from a dead key (looks/types.ts `PingView`).
 */

import type { PlayerView } from '../types.js';
import {
  ENERGY_ARC_DEG,
  ENERGY_MARK_LEN,
  ENERGY_MARKS,
  ENERGY_R,
  HALO_R,
  HALO_TICK,
  HUD_RIM_S,
  REFUSAL_SHOW,
  RETICLE_ARM,
  RETICLE_GAP,
  UI_INK,
} from './params.js';

const NS = 'http://www.w3.org/2000/svg';

/** Half-extent of the instrument face in CSS px. Everything drawn must fit inside it. */
const FACE = 72;

/**
 * The instrument's casing: the whole face drawn once underneath in BLACK, at this stroke width.
 *
 * A hairline in a single ink is the brief's rule, and on the void it is perfect. But the reticle
 * sits exactly where a fresh ping puts its brightest matter — a near-white tank two metres away —
 * and a 1 px `#DFF3FF` line on `#F6FCFF` is nothing at all. Vision §3.8 does not allow that: the
 * halo IS the loudness readout and "you always know exactly how loud you are" has no exception for
 * "unless you are looking at something bright". So the face is plotted twice from ONE definition,
 * the under-pass in the void's own colour. Nothing is filled, the ink stays hairline, and against
 * black — where the HUD spends almost all of its life — a black casing is invisible.
 */
const CASING_W = 3.2;

/** Unique per instance: the `use` reference below must not collide across live looks. */
let faceSeq = 0;

/** Alpha the halo ring keeps at total silence, so the instrument is findable when it reads zero. */
const HALO_FLOOR = 0.1;
const HALO_GAIN = 0.7;

/** The energy arc's own hairline, and the ink a graduation mark reaches when its tenth is full. */
const ENERGY_ARC_ALPHA = 0.22;
const ENERGY_MARK_ALPHA = 0.85;

const RETICLE_ALPHA = 0.7;
const TICK_ALPHA = 0.42;

/** How far the ping rim races out, as a multiple of the halo radius. */
const RIM_TRAVEL = 1.9;

const el = <K extends 'svg' | 'line' | 'circle' | 'path' | 'text' | 'g' | 'use'>(name: K): SVGElement =>
  document.createElementNS(NS, name) as SVGElement;

/** Screen angle → point on a circle. y grows DOWNWARD, so 90° is straight down. */
const onCircle = (deg: number, r: number): [number, number] => {
  const a = (deg * Math.PI) / 180;
  return [r * Math.cos(a), r * Math.sin(a)];
};

export class BlueprintHud {
  private readonly root: HTMLDivElement;
  private readonly svg: SVGElement;
  private readonly halo: SVGElement;
  private readonly rim: SVGElement;
  private readonly marks: SVGElement[] = [];
  private readonly refusal: SVGElement;

  private readonly calm: boolean;
  /** Sim time of the last outgoing ping. −1 = none this session. */
  private lastPingAt = -1;

  // Last written values — an attribute is only touched when its reading has actually moved.
  private lastHalo = -1;
  private lastRim = -1;
  private lastRimScale = -1;
  private readonly lastMark: number[] = [];
  private lastRefusal = '';

  constructor(hud: HTMLDivElement, calm: boolean) {
    this.calm = calm;

    this.root = document.createElement('div');
    this.root.style.cssText = 'position:absolute;inset:0;pointer-events:none;';

    const svg = el('svg');
    svg.setAttribute('viewBox', `${-FACE} ${-FACE} ${FACE * 2} ${FACE * 2}`);
    svg.setAttribute(
      'style',
      `position:absolute;left:50%;top:50%;width:${FACE * 2}px;height:${FACE * 2}px;` +
        `margin:${-FACE}px 0 0 ${-FACE}px;overflow:visible;`,
    );
    // One inherited stroke for the whole face: hairline, this ink, nothing filled — a rule the
    // instrument cannot break by adding an element that forgets to say so.
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', UI_INK);
    svg.setAttribute('stroke-width', '1');
    svg.setAttribute('vector-effect', 'non-scaling-stroke');
    this.svg = svg;

    // The face is defined ONCE and plotted twice: the casing pass references this group, so a
    // reading can never move on one pass and not the other. Every per-element `stroke-opacity`
    // below is inherited by the casing too, which is why an instrument that is off is off in both.
    const faceId = `bp-face-${++faceSeq}`;
    const casing = el('use');
    casing.setAttribute('href', `#${faceId}`);
    casing.setAttribute('stroke', '#000000');
    casing.setAttribute('stroke-width', String(CASING_W));
    svg.appendChild(casing);

    const face = el('g');
    face.setAttribute('id', faceId);
    svg.appendChild(face);

    // --- reticle: four arms around a 3 px gap ----------------------------------------------------
    const reticle = el('g');
    reticle.setAttribute('stroke-opacity', String(RETICLE_ALPHA));
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const l = el('line');
      l.setAttribute('x1', String(dx * RETICLE_GAP));
      l.setAttribute('y1', String(dy * RETICLE_GAP));
      l.setAttribute('x2', String(dx * (RETICLE_GAP + RETICLE_ARM)));
      l.setAttribute('y2', String(dy * (RETICLE_GAP + RETICLE_ARM)));
      reticle.appendChild(l);
    }
    face.appendChild(reticle);

    // --- halo: the loudness ring, plus its four compass ticks -------------------------------------
    this.halo = el('circle');
    this.halo.setAttribute('cx', '0');
    this.halo.setAttribute('cy', '0');
    this.halo.setAttribute('r', String(HALO_R));
    this.halo.setAttribute('stroke-opacity', '0');
    face.appendChild(this.halo);

    // The ticks are fixed: they are the instrument's cardinal marks, not a second reading. They
    // hold a constant faint ink so the ring has a scale to be bright AGAINST at every value.
    const ticks = el('g');
    ticks.setAttribute('stroke-opacity', String(TICK_ALPHA));
    for (const deg of [0, 90, 180, 270]) {
      const [x1, y1] = onCircle(deg, HALO_R - HALO_TICK * 0.5);
      const [x2, y2] = onCircle(deg, HALO_R + HALO_TICK * 0.5);
      const l = el('line');
      l.setAttribute('x1', x1.toFixed(2));
      l.setAttribute('y1', y1.toFixed(2));
      l.setAttribute('x2', x2.toFixed(2));
      l.setAttribute('y2', y2.toFixed(2));
      ticks.appendChild(l);
    }
    face.appendChild(ticks);

    // --- ping rim ---------------------------------------------------------------------------------
    this.rim = el('circle');
    this.rim.setAttribute('cx', '0');
    this.rim.setAttribute('cy', '0');
    this.rim.setAttribute('r', String(HALO_R));
    this.rim.setAttribute('stroke-opacity', '0');
    face.appendChild(this.rim);

    // --- energy: a fine arc, centred straight down, with ten graduation marks ----------------------
    const half = ENERGY_ARC_DEG * 0.5;
    const a0 = 90 - half;
    const a1 = 90 + half;
    const [ax0, ay0] = onCircle(a0, ENERGY_R);
    const [ax1, ay1] = onCircle(a1, ENERGY_R);
    const arc = el('path');
    arc.setAttribute(
      'd',
      `M ${ax0.toFixed(2)} ${ay0.toFixed(2)} A ${ENERGY_R} ${ENERGY_R} 0 0 1 ` +
        `${ax1.toFixed(2)} ${ay1.toFixed(2)}`,
    );
    arc.setAttribute('stroke-opacity', String(ENERGY_ARC_ALPHA));
    face.appendChild(arc);

    for (let i = 0; i < ENERGY_MARKS; i++) {
      // Mark i stands for the tenth of the bar it sits in the middle of; the arc runs left to
      // right, which is the direction a reactor fills.
      const deg = a0 + ((i + 0.5) / ENERGY_MARKS) * (a1 - a0);
      const [x1, y1] = onCircle(deg, ENERGY_R - ENERGY_MARK_LEN * 0.5);
      const [x2, y2] = onCircle(deg, ENERGY_R + ENERGY_MARK_LEN * 0.5);
      const l = el('line');
      l.setAttribute('x1', x1.toFixed(2));
      l.setAttribute('y1', y1.toFixed(2));
      l.setAttribute('x2', x2.toFixed(2));
      l.setAttribute('y2', y2.toFixed(2));
      l.setAttribute('stroke-opacity', '0');
      face.appendChild(l);
      this.marks.push(l);
      this.lastMark.push(-1);
    }

    // --- refusal ----------------------------------------------------------------------------------
    // Outside the face group, because glyphs get their casing from `paint-order` instead of from a
    // second pass — cheaper, and it keeps the letterforms from being drawn twice.
    this.refusal = el('text');
    this.refusal.setAttribute('x', '0');
    this.refusal.setAttribute('y', String(ENERGY_R + ENERGY_MARK_LEN + 12));
    this.refusal.setAttribute('text-anchor', 'middle');
    this.refusal.setAttribute('stroke', '#000000');
    this.refusal.setAttribute('stroke-width', String(CASING_W));
    this.refusal.setAttribute('stroke-opacity', '0');
    this.refusal.setAttribute('fill', UI_INK);
    this.refusal.setAttribute('fill-opacity', '0');
    this.refusal.setAttribute(
      'style',
      'font:9px/1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:1.4px;' +
        'text-transform:uppercase;paint-order:stroke fill;',
    );
    svg.appendChild(this.refusal);

    this.root.appendChild(svg);
    hud.appendChild(this.root);
  }

  /** A ping the player actually fired. The far end of an E-ping is the same press, not a second. */
  ping(time: number): void {
    this.lastPingAt = time;
  }

  update(now: number, p: PlayerView, haloFullM: number): void {
    // Vision §3.8: linear in loudness, with a floor that exists so the ring stays findable at
    // silence. The reading is the ramp; the floor is not part of it.
    const loud = Math.min(1, p.audibleRadius / haloFullM);
    const halo = HALO_FLOOR + HALO_GAIN * loud;
    if (Math.abs(halo - this.lastHalo) > 0.004) {
      this.lastHalo = halo;
      this.halo.setAttribute('stroke-opacity', halo.toFixed(3));
    }

    const pingAge = this.lastPingAt < 0 ? Infinity : now - this.lastPingAt;
    if (pingAge >= 0 && pingAge < HUD_RIM_S) {
      const u = pingAge / HUD_RIM_S;
      const a = 0.85 * (1 - u);
      // Reduce-flashing (vision §12): the ring still answers, it just fades in place instead of
      // racing. No school may depend on the motion, so neither may the instrument.
      const r = this.calm ? HALO_R : HALO_R * (1 + (RIM_TRAVEL - 1) * u);
      if (Math.abs(a - this.lastRim) > 0.004) {
        this.lastRim = a;
        this.rim.setAttribute('stroke-opacity', a.toFixed(3));
      }
      if (Math.abs(r - this.lastRimScale) > 0.2) {
        this.lastRimScale = r;
        this.rim.setAttribute('r', r.toFixed(2));
      }
    } else if (this.lastRim !== 0) {
      this.lastRim = 0;
      this.lastRimScale = HALO_R;
      this.rim.setAttribute('stroke-opacity', '0');
      this.rim.setAttribute('r', String(HALO_R));
    }

    // Empty marks VANISH. The tenth the bar is currently inside fades in proportion, so the arc
    // reads continuously while still being a set of discrete graduations — the reactor is a bar,
    // and a bar that only moves in tenths would lie about when a ping becomes affordable.
    const frac = p.energyMax > 0 ? Math.min(1, Math.max(0, p.energy / p.energyMax)) : 0;
    for (let i = 0; i < this.marks.length; i++) {
      const fill = Math.min(1, Math.max(0, (frac - i / ENERGY_MARKS) * ENERGY_MARKS));
      const a = fill * ENERGY_MARK_ALPHA;
      if (Math.abs(a - this.lastMark[i]!) > 0.01) {
        this.lastMark[i] = a;
        this.marks[i]!.setAttribute('stroke-opacity', a.toFixed(3));
      }
    }

    const lp = p.lastPing;
    const text = lp && lp.refused && now - lp.at < REFUSAL_SHOW ? lp.refused : '';
    if (text !== this.lastRefusal) {
      this.lastRefusal = text;
      this.refusal.textContent = text;
      this.refusal.setAttribute('fill-opacity', text ? '0.6' : '0');
      this.refusal.setAttribute('stroke-opacity', text ? '0.6' : '0');
    }
  }

  dispose(): void {
    this.svg.remove();
    this.root.remove();
    this.marks.length = 0;
    this.lastPingAt = -1;
  }
}
