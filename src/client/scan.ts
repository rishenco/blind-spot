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
  /** Vertical band for omni pulses (radians from horizon). */
  elevMax?: number;
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

      if (omni) {
        const yy = yLo + ySpan * ((i + 0.5) / s.rays);
        const r = Math.sqrt(Math.max(0, 1 - yy * yy));
        const th = i * GOLDEN;
        dx = r * Math.cos(th); dy = yy; dz = r * Math.sin(th);
      } else {
        // Uniform within the cone, in the axis-aligned frame, then rotated onto the axis.
        const cz = 1 - ((i + 0.5) / s.rays) * (1 - cosHalf);
        const sr = Math.sqrt(Math.max(0, 1 - cz * cz));
        const th = i * GOLDEN;
        const lx = sr * Math.cos(th), ly = sr * Math.sin(th);
        dx = this.bx.x * lx + this.by.x * ly + s.dx * cz;
        dy = this.bx.y * lx + this.by.y * ly + s.dy * cz;
        dz = this.bx.z * lx + this.by.z * ly + s.dz * cz;
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
        const inc = Math.abs(h.nx * dx + h.ny * dy + h.nz * dz);
        let strength = resp.gain * (0.30 + 0.70 * inc);
        // Inverse-ish falloff: far surfaces come back thin and dim.
        const dn = d / s.range;
        strength *= 1 - 0.55 * dn * dn;

        // Density thinning with range keeps the point budget on nearby, useful geometry.
        const keep = (1 - dn * 0.75 * s.densityFalloff) * (resp.gain > 0.1 ? 1 : 0.35);
        if (this.rng() < keep && strength > 0.02) {
          const nz2 = resp.noise * (0.004 + 0.012 * dn);
          const px = ox + dx * h.t + (this.rng() - 0.5) * nz2 * 6;
          const py = oy + dy * h.t + (this.rng() - 0.5) * nz2 * 6;
          const pz = oz + dz * h.t + (this.rng() - 0.5) * nz2 * 6;
          const hue = clampf(0.10 + 0.62 * dn + resp.hueShift, 0, 1);
          field.push(px, py, pz, s.startTime + d / s.waveSpeed, hue, clampf(strength, 0, 1), kind);
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
