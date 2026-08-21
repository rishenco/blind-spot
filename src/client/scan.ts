// Pulse casting: turns a burst of rays into measurement points in the PointField.
//
// Two properties matter here. (1) The wavefront is *data*, not animation: every point is
// stamped with `pulseStart + dist/waveSpeed`, so the reveal propagates outward even though
// the rays were cast earlier and all at once. (2) Casting is budgeted across frames, so a
// 6000-ray pulse never costs a visible hitch — the wave is travelling for ~0.6s anyway.

import type { World } from '../shared/world.ts';
import { Mat } from '../shared/world.ts';
import { mulberry32 } from '../shared/math.ts';
import { PointField, PKind } from './pointfield.ts';

export interface PulseSpec {
  ox: number; oy: number; oz: number;
  /** Cone axis. For an omni pulse this is ignored. */
  dx: number; dy: number; dz: number;
  rays: number;
  /** Cone half-angle in radians; >= Math.PI means omnidirectional. */
  halfAngle: number;
  range: number;
  waveSpeed: number;
  startTime: number;
  /** Multiplies point density falloff with distance (1 = no thinning). */
  densityFalloff: number;
  seed: number;
  kind?: PKind;
  /** Overall return-strength multiplier. The touch radius uses a low value so that
   *  feeling your way along a wall never competes with an actual pulse. */
  gain?: number;
  /** Vertical band for omni pulses (radians from horizon). */
  elevMax?: number;
  /**
   * Vertical squash of a cone pulse. Rooms here are 4.2m tall and a player's eye is at
   * 1.58m, so a circular 70-degree cone spends most of its rays on the floor two metres
   * ahead and the ceiling three metres up — the least informative surfaces in the game,
   * and the ones that fog everything worth seeing. An elliptical cone puts the same ray
   * budget on walls, doorways and people.
   */
  vScale?: number;
}

/** Per-material response to a pulse. */
interface MatResponse { gain: number; noise: number; pass: number; hueShift: number }
const RESP: Record<number, MatResponse> = {
  [Mat.Concrete]: { gain: 0.78, noise: 1.0, pass: 0.0, hueShift: 0 },
  [Mat.Metal]:    { gain: 1.00, noise: 0.35, pass: 0.0, hueShift: -0.04 },
  [Mat.Glass]:    { gain: 0.20, noise: 1.4, pass: 0.82, hueShift: 0.10 },   // faint plane, see the room beyond
  [Mat.Cloth]:    { gain: 0.05, noise: 2.2, pass: 0.0, hueShift: 0.0 },     // returns almost nothing: reads as a doorway
  [Mat.Grate]:    { gain: 0.55, noise: 2.6, pass: 0.45, hueShift: 0.03 },   // noisy, partially transparent
  [Mat.Objective]:{ gain: 1.00, noise: 0.2, pass: 0.0, hueShift: 0 },
};

const GOLDEN = Math.PI * (3 - Math.sqrt(5));

export class PulseJob {
  spec: PulseSpec;
  private i = 0;
  private rng: () => number;
  private bx = { x: 1, y: 0, z: 0 };
  private by = { x: 0, y: 1, z: 0 };
  private jitter = 0;
  done = false;

  constructor(spec: PulseSpec) {
    this.spec = spec;
    this.rng = mulberry32(spec.seed);
    // Orthonormal basis around the cone axis.
    const a = Math.abs(spec.dy) < 0.9 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 };
    let bx = { x: a.y * spec.dz - a.z * spec.dy, y: a.z * spec.dx - a.x * spec.dz, z: a.x * spec.dy - a.y * spec.dx };
    const l = Math.hypot(bx.x, bx.y, bx.z) || 1;
    bx = { x: bx.x / l, y: bx.y / l, z: bx.z / l };
    this.bx = bx;
    this.by = {
      x: spec.dy * bx.z - spec.dz * bx.y,
      y: spec.dz * bx.x - spec.dx * bx.z,
      z: spec.dx * bx.y - spec.dy * bx.x,
    };
    // A deterministic lattice of rays produces visible spokes. Jitter each ray by ~one
    // ray-spacing so the return reads as a measurement, not as a pattern.
    const solid = spec.halfAngle >= Math.PI
      ? 4 * Math.PI * Math.sin(spec.elevMax ?? 1.0)
      : 2 * Math.PI * (1 - Math.cos(spec.halfAngle));
    this.jitter = 1.35 * Math.sqrt(solid / (Math.PI * Math.max(1, spec.rays)));
  }

  /** Cast up to `budget` rays. Returns rays actually cast. */
  run(world: World, field: PointField, budget: number): number {
    const s = this.spec;
    const omni = s.halfAngle >= Math.PI;
    const elevMax = s.elevMax ?? 1.0;
    const yLo = omni ? -Math.sin(elevMax) : 0;
    const ySpan = omni ? 2 * Math.sin(elevMax) : 0;
    const cosHalf = Math.cos(s.halfAngle);
    const kind = s.kind ?? PKind.Static;
    let cast = 0;

    while (cast < budget && this.i < s.rays) {
      const i = this.i++;
      cast++;
      let dx: number, dy: number, dz: number;
      let u = 0; // normalised angular position within the cone (0 = axis, 1 = rim)

      if (omni) {
        const yy = yLo + ySpan * ((i + 0.5) / s.rays);
        const r = Math.sqrt(Math.max(0, 1 - yy * yy));
        const th = i * GOLDEN;
        dx = r * Math.cos(th); dy = yy; dz = r * Math.sin(th);
      } else {
        // Biased toward the cone axis, so the beam falls off instead of ending in a
        // hard-edged circle. u also feeds an edge density fade below.
        u = (i + 0.5) / s.rays;
        const uu = Math.pow(u, 1.55);
        const cz = 1 - uu * (1 - cosHalf);
        const sr = Math.sqrt(Math.max(0, 1 - cz * cz));
        const th = i * GOLDEN;
        // bx is horizontal and by is vertical by construction, so squashing ly squashes
        // the cone in world-vertical terms regardless of where the player is looking.
        const lx = sr * Math.cos(th), ly = sr * Math.sin(th) * (s.vScale ?? 1);
        dx = this.bx.x * lx + this.by.x * ly + s.dx * cz;
        dy = this.bx.y * lx + this.by.y * ly + s.dy * cz;
        dz = this.bx.z * lx + this.by.z * ly + s.dz * cz;
        { const il = 1 / (Math.hypot(dx, dy, dz) || 1); dx *= il; dy *= il; dz *= il; }
      }

      // Per-ray angular jitter.
      {
        const j = this.jitter;
        dx += (this.rng() - 0.5) * j; dy += (this.rng() - 0.5) * j; dz += (this.rng() - 0.5) * j;
        const il = 1 / (Math.hypot(dx, dy, dz) || 1);
        dx *= il; dy *= il; dz *= il;
      }

      // March, allowing partially transparent materials to let the ray continue.
      let ox = s.ox, oy = s.oy, oz = s.oz;
      let travelled = 0;
      for (let bounce = 0; bounce < 3; bounce++) {
        const remain = s.range - travelled;
        if (remain <= 0.5) break;
        const h = world.raycast(ox, oy, oz, dx, dy, dz, remain);
        if (!h) break;
        const d = travelled + h.t;
        const resp = RESP[h.mat] ?? RESP[Mat.Concrete]!;

        // Grazing incidence returns less energy.
        const rimT = omni ? 1 : 1 - smooth01((u - 0.34) / 0.66);
        const inc = Math.abs(h.nx * dx + h.ny * dy + h.nz * dz);
        let strength = (s.gain ?? 1) * resp.gain * (0.30 + 0.70 * inc) * (omni ? 1 : 0.35 + 0.65 * rimT);
        // Inverse-ish falloff: far surfaces come back thin and dim.
        const dn = d / s.range;
        strength *= 1 - 0.55 * dn * dn;

        // Density thinning with range keeps the point budget on nearby, useful geometry.
        // Range thinning keeps the budget on useful nearby geometry; the rim fade
        // dissolves the cone edge into darkness rather than cutting it off.
        const rim = omni ? 1 : 0.11 + 0.89 * rimT;
        // Thin the near field, but only where it is *splatter*: the floor underfoot and
        // the ceiling overhead, hit face-on from a metre away, are the least informative
        // returns a pulse can give and at full density they fog everything worth seeing.
        // Surfaces at grazing incidence are the opposite — they are the receding walls
        // that make a corridor read as a corridor — so incidence gates the penalty.
        const nearPenalty = smooth01((4.8 - d) / 3.8) * inc;
        const nearFade = 1 - 0.95 * Math.pow(nearPenalty, 0.65);
        const keep = (1 - dn * 0.35 * s.densityFalloff) * rim * nearFade * (resp.gain > 0.1 ? 1 : 0.35);
        if (this.rng() < keep && strength > 0.02) {
          // Measurement noise is scattered in the surface's TANGENT plane, with only a
          // sliver along the normal. Isotropic jitter puffs every flat wall into a
          // ten-centimetre slab of fog; tangential jitter keeps walls reading as planes
          // while still looking like noisy measurements rather than a lattice.
          const nz2 = resp.noise * (0.055 + 0.075 * dn);
          const nrm = resp.noise * (0.0015 + 0.006 * dn);
          // Tangent basis from the axis-aligned normal (cheap: exactly one component is set).
          let t1x: number, t1y: number, t1z: number, t2x: number, t2y: number, t2z: number;
          if (h.ny !== 0) { t1x = 1; t1y = 0; t1z = 0; t2x = 0; t2y = 0; t2z = 1; }
          else if (h.nx !== 0) { t1x = 0; t1y = 1; t1z = 0; t2x = 0; t2y = 0; t2z = 1; }
          else { t1x = 1; t1y = 0; t1z = 0; t2x = 0; t2y = 1; t2z = 0; }
          const a1 = (this.rng() - 0.5) * nz2, a2 = (this.rng() - 0.5) * nz2;
          const an = (this.rng() - 0.5) * nrm;
          const px = ox + dx * h.t + t1x * a1 + t2x * a2 + h.nx * an;
          const py = oy + dy * h.t + t1y * a1 + t2y * a2 + h.ny * an;
          const pz = oz + dz * h.t + t1z * a1 + t2z * a2 + h.nz * an;
          const depth = clampf(dn + resp.hueShift, 0, 1);
          field.push(px, py, pz, s.startTime + d / s.waveSpeed, depth, clampf(strength, 0, 1), kind);
        }

        if (resp.pass <= 0 || this.rng() > resp.pass) break;
        // Continue past a transparent surface.
        travelled = d + 0.02;
        ox = s.ox + dx * travelled; oy = s.oy + dy * travelled; oz = s.oz + dz * travelled;
      }
    }
    if (this.i >= s.rays) this.done = true;
    return cast;
  }
}

const clampf = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x);
const smooth01 = (x: number) => { const t = x < 0 ? 0 : x > 1 ? 1 : x; return t * t * (3 - 2 * t); };

/** Runs pulses with a per-frame ray budget so big scans never stall the frame. */
export class PulseQueue {
  private jobs: PulseJob[] = [];
  constructor(private world: World, private field: PointField, public budgetPerFrame = 2200) {}

  add(spec: PulseSpec) { this.jobs.push(new PulseJob(spec)); }
  get pending() { return this.jobs.length; }

  step() {
    let left = this.budgetPerFrame;
    while (left > 0 && this.jobs.length) {
      const j = this.jobs[0]!;
      left -= j.run(this.world, this.field, left);
      if (j.done) this.jobs.shift(); else break;
    }
  }
  clear() { this.jobs.length = 0; }
}
