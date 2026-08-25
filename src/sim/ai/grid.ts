/**
 * The occupancy grid — the one data structure the whole belief layer is built on.
 *
 * Why a grid and not a Kalman filter or a particle cloud: the research pass measured it, and
 * the arithmetic is not close. The worst localisation error in the game (a running step heard
 * at 9 m) is 0.54 m; half a second of silence lets a body move 2.75 m. So belief is almost
 * never limited by how precisely we heard — it is limited by how long ago. What has to be
 * represented well is therefore the *shape* of the distribution (walls, the forbidden crease,
 * and above all the bimodality of "he broke right OR he stopped dead"), not the precision of a
 * mean. A Gaussian cannot express any of those three; a grid expresses all of them with the
 * same three lines of code.
 *
 * Everything here is deterministic: fixed-size Float32Arrays, fixed iteration order, no RNG,
 * no `Math.exp` in the hot path (see `expApprox`). Two runs of the same match produce the same
 * grids bit for bit, which is what makes the deception scenarios reproducible.
 */
import type { FieldInfo, Vec2 } from '../types';

export interface GridSpec {
  nx: number;
  ny: number;
  /** Cell edge in metres. */
  cell: number;
  /** World position of the centre of cell (0, 0). */
  ox: number;
  oy: number;
}

/**
 * A grid's static passability, shared by every grid of the same shape: 0 in the walls and
 * inside the two creases, 1 where a body may stand. Belief must never leak into a place the
 * rules forbid — that is most of what a grid buys over a Gaussian.
 */
export interface GridMask {
  spec: GridSpec;
  passable: Float32Array;
  passableCount: number;
}

const maskCache = new Map<string, GridMask>();

/** Builds (and caches) the grid shape and passability mask for a pitch at a given resolution. */
export function gridMaskFor(field: FieldInfo, cell: number, bodyRadius: number): GridMask {
  const key = `${field.width}x${field.height}x${field.creaseRadius}x${field.goalWidth}@${cell}+${bodyRadius}`;
  const cached = maskCache.get(key);
  if (cached) return cached;

  const nx = Math.max(2, Math.round(field.width / cell));
  const ny = Math.max(2, Math.round(field.height / cell));
  const spec: GridSpec = {
    nx,
    ny,
    cell,
    ox: -field.halfWidth + cell / 2,
    oy: -field.halfHeight + cell / 2,
  };
  const passable = new Float32Array(nx * ny);
  let count = 0;
  for (let iy = 0; iy < ny; iy++) {
    for (let ix = 0; ix < nx; ix++) {
      const x = spec.ox + ix * cell;
      const y = spec.oy + iy * cell;
      let ok = Math.abs(x) <= field.halfWidth - bodyRadius && Math.abs(y) <= field.halfHeight - bodyRadius;
      if (ok) {
        for (const g of field.goalCentre) {
          const dx = x - g.x;
          const dy = y - g.y;
          const r = field.creaseRadius + bodyRadius;
          if (dx * dx + dy * dy < r * r) {
            ok = false;
            break;
          }
        }
      }
      if (ok) {
        passable[iy * nx + ix] = 1;
        count++;
      }
    }
  }
  const mask: GridMask = { spec, passable, passableCount: Math.max(1, count) };
  maskCache.set(key, mask);
  return mask;
}

/**
 * exp(-u) for u >= 0, without `Math.exp`.
 *
 * The simulation bans transcendentals because they are not bit-reproducible across engines
 * (see `sim/math.ts`), and the belief layer decides what a bot does, so it is held to the same
 * rule. This is exp(-u) built by repeated squaring of (1 - u/64), which is exact to ~1e-4 over
 * the range that matters and is monotone everywhere — the two properties a likelihood needs.
 */
export function expApprox(u: number): number {
  if (u <= 0) return 1;
  if (u > 40) return 0;
  let v = 1 - u / 64;
  if (v < 0) v = 0;
  v *= v;
  v *= v;
  v *= v;
  v *= v;
  v *= v;
  v *= v;
  return v;
}

export interface DiffuseOptions {
  /** Seconds of world time this prediction step covers. */
  dt: number;
  /** Prior weights over what an unheard body is doing. They are renormalised internally. */
  wStand: number;
  wWalk: number;
  wRun: number;
  walkSpeed: number;
  runSpeed: number;
  /**
   * Per-cell probability that a body *walking* in that cell would have gone unheard over `dt`,
   * and the same for running. This is the negative information carried by silence, and it is
   * what makes the belief cloud grow as a doughnut rather than a disc: near the listener a
   * runner would have been heard, so the running component is all but deleted there, while far
   * away it survives untouched. Pass `null` when a matching sound *was* heard this step (the
   * event explains the noise, so silence says nothing).
   */
  silentWalk: Float32Array | null;
  silentRun: Float32Array | null;
  /** Fraction of the distribution replaced by uniform each step, so a lost body reappears. */
  floor: number;
}

/** A probability distribution over "where is this body", on a fixed grid. */
export class OccupancyGrid {
  readonly mask: GridMask;
  readonly spec: GridSpec;
  readonly p: Float32Array;

  private readonly a: Float32Array;
  private readonly b: Float32Array;
  private readonly c: Float32Array;

  constructor(mask: GridMask) {
    this.mask = mask;
    this.spec = mask.spec;
    const n = mask.spec.nx * mask.spec.ny;
    this.p = new Float32Array(n);
    this.a = new Float32Array(n);
    this.b = new Float32Array(n);
    this.c = new Float32Array(n);
    this.setUniform();
  }

  get cellArea(): number {
    return this.spec.cell * this.spec.cell;
  }

  cellX(ix: number): number {
    return this.spec.ox + ix * this.spec.cell;
  }

  cellY(iy: number): number {
    return this.spec.oy + iy * this.spec.cell;
  }

  setUniform(): void {
    this.centroidCache = null;
    const { passable, passableCount } = this.mask;
    const v = 1 / passableCount;
    for (let i = 0; i < this.p.length; i++) this.p[i] = passable[i]! > 0 ? v : 0;
  }

  /** Collapses the whole distribution onto one point — a sonar hit, or a ping heard exactly. */
  setPoint(at: Vec2, sigma = 0.4): void {
    this.setUniform();
    this.multiplyGaussian(at, { x: 1, y: 0 }, sigma, sigma, 0.0005);
  }

  copyFrom(other: OccupancyGrid): void {
    this.centroidCache = null;
    this.p.set(other.p);
  }

  /** Renormalises to sum 1; falls back to uniform if the belief has been annihilated. */
  normalize(): void {
    this.centroidCache = null;
    let sum = 0;
    for (let i = 0; i < this.p.length; i++) sum += this.p[i]!;
    if (!(sum > 1e-30)) {
      this.setUniform();
      return;
    }
    const k = 1 / sum;
    for (let i = 0; i < this.p.length; i++) this.p[i] = this.p[i]! * k;
  }

  /**
   * The prediction step: a mixture over movement modes, masked by the pitch, plus a uniform
   * floor. Runs at 10 Hz — the rate at which `vmax·dt` is about one cell, which is not a
   * coincidence but the reason to pick that rate.
   */
  predict(o: DiffuseOptions): void {
    const { nx, ny, cell } = this.spec;
    const n = nx * ny;
    // A 3-tap kernel [alpha, 1-2alpha, alpha] has variance 2*alpha*cell^2; a displacement drawn
    // uniformly from [-v*dt, v*dt] has variance (v*dt)^2/3. Matching them fixes alpha.
    const alphaFor = (v: number): number => {
      const s = v * o.dt;
      return Math.min(0.35, (s * s) / (6 * cell * cell));
    };
    const wsum = Math.max(1e-9, o.wStand + o.wWalk + o.wRun);
    const wStand = o.wStand / wsum;
    const wWalk = o.wWalk / wsum;
    const wRun = o.wRun / wsum;

    // Silence does NOT say "he is not here". It says "if he is here, he is not moving" — so the
    // probability taken off the walking and running components is handed to the standing one at
    // the same cell, instead of being deleted.
    //
    // This distinction is the difference between a belief that works and one that does not.
    // Multiplying it away treats every 0.1 s of quiet as an independent chance to have been
    // caught moving, which compounds: six seconds of silence made the bot 99.96 % sure that a
    // man standing four metres away had left the area, and it would walk straight past him. What
    // silence really rules out is the *movement*, not the *place*, and the two only look alike
    // for the first half-second.
    const out = this.a;
    if (wWalk > 1e-6) {
      this.blurInto(this.b, alphaFor(o.walkSpeed));
      if (o.silentWalk) {
        for (let i = 0; i < n; i++) {
          const sw = o.silentWalk[i]!;
          out[i] = this.p[i]! * (wStand + wWalk * (1 - sw)) + this.b[i]! * wWalk * sw;
        }
      } else {
        for (let i = 0; i < n; i++) out[i] = this.p[i]! * wStand + this.b[i]! * wWalk;
      }
    } else {
      for (let i = 0; i < n; i++) out[i] = this.p[i]! * wStand;
    }
    if (wRun > 1e-6) {
      this.blurInto(this.b, alphaFor(o.runSpeed));
      if (o.silentRun) {
        for (let i = 0; i < n; i++) {
          const sr = o.silentRun[i]!;
          out[i] = out[i]! + this.p[i]! * wRun * (1 - sr) + this.b[i]! * wRun * sr;
        }
      } else {
        for (let i = 0; i < n; i++) out[i] = out[i]! + this.b[i]! * wRun;
      }
    }

    const { passable, passableCount } = this.mask;
    const floor = o.floor > 0 ? o.floor / passableCount : 0;
    for (let i = 0; i < n; i++) {
      this.p[i] = passable[i]! > 0 ? out[i]! * (1 - o.floor) + floor : 0;
    }
    this.normalize();
  }

  /** Separable 3-tap blur of `p` into `dst`, mass-conserving at the edges. */
  private blurInto(dst: Float32Array, alpha: number): void {
    const { nx, ny } = this.spec;
    const mid = 1 - 2 * alpha;
    const tmp = this.c;
    for (let iy = 0; iy < ny; iy++) {
      const row = iy * nx;
      for (let ix = 0; ix < nx; ix++) {
        const v = this.p[row + ix]!;
        const left = ix > 0 ? this.p[row + ix - 1]! : v;
        const right = ix < nx - 1 ? this.p[row + ix + 1]! : v;
        tmp[row + ix] = mid * v + alpha * (left + right);
      }
    }
    for (let iy = 0; iy < ny; iy++) {
      const row = iy * nx;
      const up = iy > 0 ? row - nx : row;
      const down = iy < ny - 1 ? row + nx : row;
      for (let ix = 0; ix < nx; ix++) {
        dst[row + ix] = mid * tmp[row + ix]! + alpha * (tmp[up + ix]! + tmp[down + ix]!);
      }
    }
  }

  /**
   * Multiplies in the likelihood of one heard event: an anisotropic Gaussian, long along the
   * bearing to the source and short across it, because that is the shape hearing error really
   * has. Returns the likelihood mass (the evidence for "this track made that sound"), which is
   * what the data association step compares between tracks.
   */
  multiplyGaussian(z: Vec2, bearing: Vec2, sigmaRadial: number, sigmaTangential: number, floor = 0.001): number {
    return this.applyKernel(z, bearing, sigmaRadial, sigmaTangential, Math.max(1e-4, floor), 1, true);
  }

  /**
   * The mirror belief's update: "with probability `pHeard` the opponent heard this and now
   * believes I am near z; with probability 1 - pHeard he heard nothing and still believes what
   * he believed". A mixture, not a multiplication — this is what makes a sound made just out of
   * earshot cost almost nothing, and a sound made close cost everything.
   */
  multiplyDetection(z: Vec2, bearing: Vec2, sigmaRadial: number, sigmaTangential: number, pHeard: number): void {
    const w = Math.min(0.995, Math.max(0, pHeard));
    if (w <= 1e-4) return;
    this.applyKernel(z, bearing, sigmaRadial, sigmaTangential, 1 - w, w, true);
  }

  /** The same computation without touching the belief — used to score an association. */
  likelihoodMass(z: Vec2, bearing: Vec2, sigmaRadial: number, sigmaTangential: number): number {
    return this.applyKernel(z, bearing, sigmaRadial, sigmaTangential, 0, 1, false);
  }

  /**
   * Multiplies the belief by `base + gain * L(cell)` where L is the anisotropic hearing kernel:
   * long along the bearing to the source and short across it, because that is the shape hearing
   * error really has. Returns the likelihood mass — the evidence for "this track made that
   * sound", which is what data association compares between tracks.
   */
  private applyKernel(
    z: Vec2,
    bearing: Vec2,
    sigmaRadial: number,
    sigmaTangential: number,
    base: number,
    gain: number,
    write: boolean,
  ): number {
    const { nx, ny, cell } = this.spec;
    // A sigma below half a cell would collapse the belief into a single cell and make the
    // update depend on where the grid lines happen to fall. Never let it.
    const sr = Math.max(cell * 0.7, sigmaRadial);
    const st = Math.max(cell * 0.7, sigmaTangential);
    const reach = Math.max(sr, st) * 3;
    const ix0 = Math.max(0, Math.floor((z.x - reach - this.spec.ox) / cell));
    const ix1 = Math.min(nx - 1, Math.ceil((z.x + reach - this.spec.ox) / cell));
    const iy0 = Math.max(0, Math.floor((z.y - reach - this.spec.oy) / cell));
    const iy1 = Math.min(ny - 1, Math.ceil((z.y + reach - this.spec.oy) / cell));
    const ux = bearing.x;
    const uy = bearing.y;
    const invR = 1 / (2 * sr * sr);
    const invT = 1 / (2 * st * st);

    let mass = 0;
    if (write && base !== 1) {
      for (let i = 0; i < this.p.length; i++) this.p[i] = this.p[i]! * base;
    }
    for (let iy = iy0; iy <= iy1; iy++) {
      const y = this.cellY(iy);
      const row = iy * nx;
      for (let ix = ix0; ix <= ix1; ix++) {
        const idx = row + ix;
        const scaled = this.p[idx]!;
        if (scaled <= 0) continue;
        const prior = write && base !== 1 ? scaled / base : scaled;
        const dx = this.cellX(ix) - z.x;
        const dy = y - z.y;
        const dr = dx * ux + dy * uy;
        const dt = -dx * uy + dy * ux;
        const l = expApprox(dr * dr * invR + dt * dt * invT);
        mass += prior * l;
        if (write) this.p[idx] = prior * (base + gain * l);
      }
    }
    if (write) this.normalize();
    return mass;
  }

  /** Mixes another distribution in: `p = (1-w)*p + w*other`. The soft half of PDA. */
  blendFrom(other: OccupancyGrid, w: number): void {
    const k = Math.min(1, Math.max(0, w));
    for (let i = 0; i < this.p.length; i++) this.p[i] = this.p[i]! * (1 - k) + other.p[i]! * k;
    this.normalize();
  }

  /**
   * Slides the whole distribution by (dx, dy) metres, bilinearly.
   *
   * This is the "he is running that way" hint: the grid stores no velocity, so a fresh
   * direction estimate is applied as a shift of the prediction instead. It is also what makes a
   * feint legible — the cloud honestly slides after the runner, and then the braking sound
   * lands and pins it to a place the runner has already left.
   */
  advect(dx: number, dy: number): void {
    const { nx, ny, cell } = this.spec;
    const sx = dx / cell;
    const sy = dy / cell;
    if (Math.abs(sx) < 1e-3 && Math.abs(sy) < 1e-3) return;
    const out = this.a;
    out.fill(0);
    const fx = Math.floor(sx);
    const fy = Math.floor(sy);
    const rx = sx - fx;
    const ry = sy - fy;
    const w00 = (1 - rx) * (1 - ry);
    const w10 = rx * (1 - ry);
    const w01 = (1 - rx) * ry;
    const w11 = rx * ry;
    const put = (ix: number, iy: number, v: number): void => {
      if (v <= 0) return;
      const cx = ix < 0 ? 0 : ix >= nx ? nx - 1 : ix;
      const cy = iy < 0 ? 0 : iy >= ny ? ny - 1 : iy;
      out[cy * nx + cx] = out[cy * nx + cx]! + v;
    };
    for (let iy = 0; iy < ny; iy++) {
      const row = iy * nx;
      for (let ix = 0; ix < nx; ix++) {
        const v = this.p[row + ix]!;
        if (v <= 0) continue;
        const tx = ix + fx;
        const ty = iy + fy;
        put(tx, ty, v * w00);
        put(tx + 1, ty, v * w10);
        put(tx, ty + 1, v * w01);
        put(tx + 1, ty + 1, v * w11);
      }
    }
    const passable = this.mask.passable;
    for (let i = 0; i < this.p.length; i++) this.p[i] = passable[i]! > 0 ? out[i]! : 0;
    this.normalize();
  }

  /**
   * Negative information: "I checked here and found nobody".
   *
   * Three rules, all from the RoboCup literature and all learned the hard way there:
   * the checked region is shrunk relative to the sensor's real one, `pDetect` is strictly below
   * 1, and the belief is multiplied rather than zeroed. Break any of them and one wrong reading
   * deletes the truth for good, after which the bot hunts confidently in the wrong half of the
   * pitch and reads as broken rather than as mistaken.
   */
  multiplyNegativeSector(
    origin: Vec2,
    r0: number,
    r1: number,
    aim: Vec2,
    coneCos: number,
    pDetect: number,
    spare: readonly Vec2[],
    spareRadius: number,
  ): void {
    if (r1 <= r0) return;
    const { nx, ny, cell } = this.spec;
    const keep = 1 - Math.min(0.95, pDetect);
    const ix0 = Math.max(0, Math.floor((origin.x - r1 - this.spec.ox) / cell));
    const ix1 = Math.min(nx - 1, Math.ceil((origin.x + r1 - this.spec.ox) / cell));
    const iy0 = Math.max(0, Math.floor((origin.y - r1 - this.spec.oy) / cell));
    const iy1 = Math.min(ny - 1, Math.ceil((origin.y + r1 - this.spec.oy) / cell));
    const spare2 = spareRadius * spareRadius;
    let touched = false;
    for (let iy = iy0; iy <= iy1; iy++) {
      const y = this.cellY(iy);
      const row = iy * nx;
      for (let ix = ix0; ix <= ix1; ix++) {
        const idx = row + ix;
        if (this.p[idx]! <= 0) continue;
        const x = this.cellX(ix);
        const dx = x - origin.x;
        const dy = y - origin.y;
        const d2 = dx * dx + dy * dy;
        if (d2 < r0 * r0 || d2 > r1 * r1) continue;
        if (coneCos > -1) {
          const d = Math.sqrt(d2);
          if (d > 1e-6 && (dx / d) * aim.x + (dy / d) * aim.y < coneCos) continue;
        }
        // A body the ping *did* find explains its own patch: never carve there.
        let shielded = false;
        for (const s of spare) {
          const sx = x - s.x;
          const sy = y - s.y;
          if (sx * sx + sy * sy <= spare2) {
            shielded = true;
            break;
          }
        }
        if (shielded) continue;
        this.p[idx] = this.p[idx]! * keep;
        touched = true;
      }
    }
    if (touched) this.normalize();
  }

  massInCircle(centre: Vec2, radius: number): number {
    const { nx, ny, cell } = this.spec;
    const r2 = radius * radius;
    const ix0 = Math.max(0, Math.floor((centre.x - radius - this.spec.ox) / cell));
    const ix1 = Math.min(nx - 1, Math.ceil((centre.x + radius - this.spec.ox) / cell));
    const iy0 = Math.max(0, Math.floor((centre.y - radius - this.spec.oy) / cell));
    const iy1 = Math.min(ny - 1, Math.ceil((centre.y + radius - this.spec.oy) / cell));
    let sum = 0;
    for (let iy = iy0; iy <= iy1; iy++) {
      const y = this.cellY(iy);
      const row = iy * nx;
      for (let ix = ix0; ix <= ix1; ix++) {
        const v = this.p[row + ix]!;
        if (v <= 0) continue;
        const dx = this.cellX(ix) - centre.x;
        const dy = y - centre.y;
        if (dx * dx + dy * dy <= r2) sum += v;
      }
    }
    return sum;
  }

  /**
   * Probability-weighted mean distance from a point — how far the belief sits from the listener.
   *
   * This is how the doughnut is measured rather than described: silence pushes belief *away*
   * from whoever is listening (a body close by would have been heard moving), so this number
   * has to grow faster than the belief's overall spread. A disc would grow symmetrically and
   * leave it where it started.
   */
  meanDistanceFrom(p0: Vec2): number {
    const { nx, ny } = this.spec;
    let acc = 0;
    for (let iy = 0; iy < ny; iy++) {
      const dy = this.cellY(iy) - p0.y;
      const row = iy * nx;
      for (let ix = 0; ix < nx; ix++) {
        const v = this.p[row + ix]!;
        if (v <= 0) continue;
        const dx = this.cellX(ix) - p0.x;
        acc += v * Math.sqrt(dx * dx + dy * dy);
      }
    }
    return acc;
  }

  mode(): { pos: Vec2; weight: number } {
    let best = -1;
    let bi = 0;
    for (let i = 0; i < this.p.length; i++) {
      if (this.p[i]! > best) {
        best = this.p[i]!;
        bi = i;
      }
    }
    const nx = this.spec.nx;
    return { pos: { x: this.cellX(bi % nx), y: this.cellY(Math.floor(bi / nx)) }, weight: best };
  }

  /** Invalidated by every write; `centroid()` is asked for repeatedly and costs a full sweep. */
  private centroidCache: Vec2 | null = null;

  centroid(): Vec2 {
    if (this.centroidCache) return this.centroidCache;
    const { nx, ny } = this.spec;
    let cx = 0;
    let cy = 0;
    for (let iy = 0; iy < ny; iy++) {
      const y = this.cellY(iy);
      const row = iy * nx;
      for (let ix = 0; ix < nx; ix++) {
        const v = this.p[row + ix]!;
        if (v <= 0) continue;
        cx += this.cellX(ix) * v;
        cy += y * v;
      }
    }
    this.centroidCache = { x: cx, y: cy };
    return this.centroidCache;
  }

  /**
   * Effective support area in m² — 1/Σp² cells, times the cell area. This is the honest
   * one-number answer to "how vague is this belief", and it is the number the utility axes use
   * to price silence: a large area means the opponent has no idea, which is worth money.
   */
  effectiveArea(): number {
    let s2 = 0;
    for (let i = 0; i < this.p.length; i++) s2 += this.p[i]! * this.p[i]!;
    if (s2 <= 1e-30) return this.mask.passableCount * this.cellArea;
    return (1 / s2) * this.cellArea;
  }

  /**
   * K deterministic samples of the distribution, by systematic stratified selection over the
   * cumulative sum. Not random: the same belief always yields the same samples, and a belief
   * that moves smoothly yields samples that move smoothly instead of flickering. They cover the
   * modes in proportion to their mass, which is what the decision layer needs — a bimodal
   * belief must produce candidates on both sides, not an average of the two.
   */
  samples(k: number, out: { pos: Vec2; weight: number }[]): void {
    out.length = 0;
    if (k <= 0) return;
    const nx = this.spec.nx;
    let acc = 0;
    let target = 0.5 / k;
    let taken = 0;
    for (let i = 0; i < this.p.length && taken < k; i++) {
      const v = this.p[i]!;
      if (v <= 0) continue;
      acc += v;
      while (taken < k && acc >= target) {
        out.push({ pos: { x: this.cellX(i % nx), y: this.cellY(Math.floor(i / nx)) }, weight: 1 / k });
        taken++;
        target = (taken + 0.5) / k;
      }
    }
    while (out.length < k && out.length > 0) out.push({ ...out[out.length - 1]! });
  }

  /** Cells worth drawing, heaviest first — the overlay's input. */
  debugPoints(max: number, relativeCut = 0.06): { pos: Vec2; weight: number }[] {
    const mode = this.mode().weight;
    if (mode <= 0) return [];
    const cut = mode * relativeCut;
    const nx = this.spec.nx;
    const out: { pos: Vec2; weight: number }[] = [];
    for (let i = 0; i < this.p.length; i++) {
      const v = this.p[i]!;
      if (v < cut) continue;
      out.push({ pos: { x: this.cellX(i % nx), y: this.cellY(Math.floor(i / nx)) }, weight: v / mode });
    }
    out.sort((a, b) => (b.weight === a.weight ? a.pos.x - b.pos.x || a.pos.y - b.pos.y : b.weight - a.weight));
    if (out.length > max) out.length = max;
    return out;
  }
}
