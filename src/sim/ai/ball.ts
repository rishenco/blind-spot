/**
 * What a listener can work out about the ball.
 *
 * The ball is the one thing that is never a secret (it hums across the whole pitch), so unlike
 * an opponent it is unimodal and continuously observed — a small filter is the right tool, not
 * a grid. But it is also the game's biggest honesty hole, and this file is where that hole is
 * closed:
 *
 *   The hum arrives 60 times a second. If a bot averaged all of it, the error would fall as
 *   1/sqrt(n) and after one second it would know the ball ~8x better than a human ever could —
 *   at `truthLeak = 0`, with nothing in the perception config to blame. The simulation already
 *   makes the error a slow random walk instead of fresh noise (`emitterNoiseSmoothing`), which
 *   removes most of it; `ai.observationMemory` closes the rest by bounding how many samples a
 *   bot is allowed to hold at all. `npm run honesty` measures both.
 */
import { clamp, dist2, len2 } from '../math';
import type { FieldInfo, ObservedEmitter, Vec2 } from '../types';

/** After this much silence the fit is thrown away rather than stretched across the gap. */
const SILENCE_RESET_SEC = 4;

export interface BallEstimate {
  pos: Vec2;
  vel: Vec2;
  /** Along-bearing sigma of the newest observation, metres. */
  sigma: number;
  /** Sim time of the newest observation. */
  t: number;
  /** How many samples the fit used — never more than `observationMemory`. */
  samples: number;
}

/**
 * A bounded ring of recent hum observations, fitted with a straight line.
 *
 * The bound is the point. Least squares over N samples is the cheapest possible "how much may
 * this bot listen", and it is a config knob rather than a constant so the honesty question can
 * be answered with numbers instead of an opinion.
 */
export class BallTracker {
  private readonly px: Float64Array;
  private readonly py: Float64Array;
  private readonly pt: Float64Array;
  private readonly capacity: number;
  private count = 0;
  private head = 0;
  private lastSigma = 0;
  private lastT = -1;

  constructor(observationMemory: number) {
    this.capacity = Math.max(1, Math.round(observationMemory));
    this.px = new Float64Array(this.capacity);
    this.py = new Float64Array(this.capacity);
    this.pt = new Float64Array(this.capacity);
  }

  reset(): void {
    this.count = 0;
    this.head = 0;
    this.lastT = -1;
  }

  /**
   * Feeds one tick's observation, or `null` for a tick in which the ball said nothing.
   *
   * Silence is no longer an anomaly: a carried ball only beeps, so most ticks of most possessions
   * have nothing in them. The history is kept and simply ages — a bot that has not heard the ball
   * for a second believes it is where it last heard it, which is exactly what a blind player
   * believes. Only a long silence (the ball is somewhere it has not been for seconds) throws the
   * fit away, because a straight line through samples that far apart is a fiction.
   */
  observe(em: ObservedEmitter | null, t: number): void {
    if (!em) {
      if (this.lastT >= 0 && t - this.lastT > SILENCE_RESET_SEC) this.reset();
      return;
    }
    // A discontinuity (a catch, a throw, a wall bounce) invalidates the old samples: fitting a
    // line across a bounce would invent a velocity that never existed.
    if (this.count > 0) {
      const last = this.at(this.count - 1);
      const dt = t - last.t;
      if (dt > 0) {
        const step = dist2({ x: last.x, y: last.y }, em.pos) / dt;
        if (step > 30) this.reset();
      }
    }
    this.px[this.head] = em.pos.x;
    this.py[this.head] = em.pos.y;
    this.pt[this.head] = t;
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
    this.lastSigma = em.sigma;
    this.lastT = t;
  }

  private at(i: number): { x: number; y: number; t: number } {
    const idx = (this.head - this.count + i + this.capacity * 2) % this.capacity;
    return { x: this.px[idx]!, y: this.py[idx]!, t: this.pt[idx]! };
  }

  estimate(): BallEstimate | null {
    if (this.count === 0) return null;
    const newest = this.at(this.count - 1);
    if (this.count < 3) {
      return {
        pos: { x: newest.x, y: newest.y },
        vel: { x: 0, y: 0 },
        sigma: this.lastSigma,
        t: this.lastT,
        samples: this.count,
      };
    }
    // Least squares on (t, x) and (t, y), centred on the newest sample so the fitted point is
    // the *current* position rather than the middle of the window.
    let st = 0;
    let stt = 0;
    let sx = 0;
    let sy = 0;
    let stx = 0;
    let sty = 0;
    for (let i = 0; i < this.count; i++) {
      const s = this.at(i);
      const dt = s.t - newest.t;
      st += dt;
      stt += dt * dt;
      sx += s.x;
      sy += s.y;
      stx += dt * s.x;
      sty += dt * s.y;
    }
    const n = this.count;
    const denom = n * stt - st * st;
    if (Math.abs(denom) < 1e-12) {
      return {
        pos: { x: newest.x, y: newest.y },
        vel: { x: 0, y: 0 },
        sigma: this.lastSigma,
        t: this.lastT,
        samples: n,
      };
    }
    const vx = (n * stx - st * sx) / denom;
    const vy = (n * sty - st * sy) / denom;
    const x = (sx - vx * st) / n;
    const y = (sy - vy * st) / n;
    return {
      pos: { x, y },
      vel: { x: vx, y: vy },
      sigma: this.lastSigma,
      t: this.lastT,
      samples: n,
    };
  }
}

export interface BallPhysics {
  friction: number;
  restitution: number;
  radius: number;
  restSpeed: number;
}

/**
 * Where a loose ball will be in `t` seconds — friction and wall bounces included.
 *
 * Deliberately simple and deliberately the same shape as the simulation's own integration:
 * an interception is only ever as good as this prediction, and a prediction that ignored the
 * walls would make every rebound an unplayable surprise.
 */
export function predictBall(from: BallEstimate, field: FieldInfo, phys: BallPhysics, t: number): Vec2 {
  const out = { x: 0, y: 0 };
  rollBall(from, field, phys, t, out);
  return out;
}

/** The same integration, writing into a caller-owned vector so a scan can avoid allocating. */
function rollBall(from: BallEstimate, field: FieldInfo, phys: BallPhysics, t: number, out: Vec2): void {
  let x = from.pos.x;
  let y = from.pos.y;
  let vx = from.vel.x;
  let vy = from.vel.y;
  const limX = field.halfWidth - phys.radius;
  const limY = field.halfHeight - phys.radius;
  const step = 1 / 60;
  let left = t;
  while (left > 1e-6) {
    const h = Math.min(step, left);
    left -= h;
    const speed = Math.sqrt(vx * vx + vy * vy);
    if (speed > 0) {
      const next = Math.max(0, speed - phys.friction * h);
      if (next <= phys.restSpeed) {
        vx = 0;
        vy = 0;
      } else {
        vx = (vx / speed) * next;
        vy = (vy / speed) * next;
      }
    }
    x += vx * h;
    y += vy * h;
    if (x < -limX) {
      x = -limX;
      vx = -vx * phys.restitution;
    } else if (x > limX) {
      x = limX;
      vx = -vx * phys.restitution;
    }
    if (y < -limY) {
      y = -limY;
      vy = -vy * phys.restitution;
    } else if (y > limY) {
      y = limY;
      vy = -vy * phys.restitution;
    }
  }
  out.x = x;
  out.y = y;
}

/** Time for a body at `from` with speed `v0` to cover `d` metres, accelerating at `accel`. */
export function travelTime(d: number, v0: number, accel: number, vmax: number): number {
  if (d <= 0) return 0;
  const tAccel = Math.max(0, (vmax - v0) / accel);
  const dAccel = v0 * tAccel + 0.5 * accel * tAccel * tAccel;
  if (d <= dAccel) {
    // d = v0*t + a*t^2/2
    const disc = v0 * v0 + 2 * accel * d;
    return (Math.sqrt(Math.max(0, disc)) - v0) / accel;
  }
  return tAccel + (d - dAccel) / vmax;
}

export interface InterceptSolution {
  /** Where to run to. */
  point: Vec2;
  /** When the ball gets there. */
  t: number;
  /** How much earlier than the ball we arrive (negative = we are late). */
  slack: number;
}

/**
 * The earliest point on the ball's path this body can actually get to.
 *
 * Table-driven, like agent2d's intercept table and for the same reason: the answer has to be a
 * *time*, because every other decision (should I contest, should I pass, is that lane safe)
 * compares my time with somebody else's.
 */
export function solveIntercept(
  self: Vec2,
  selfSpeed: number,
  ball: BallEstimate,
  field: FieldInfo,
  phys: BallPhysics,
  accel: number,
  vmax: number,
  reach: number,
  horizon = 2.5,
): InterceptSolution | null {
  // One integration, sampled as it goes — not one integration per candidate time. Re-rolling the
  // ball from t = 0 for every checkpoint was, by a wide margin, the most expensive thing the bot
  // did: fifty checkpoints times up to a hundred and fifty sub-steps, sixty times a second, per
  // bot. It is the same answer either way; this one costs 3 % of it.
  let x = ball.pos.x;
  let y = ball.pos.y;
  let vx = ball.vel.x;
  let vy = ball.vel.y;
  const limX = field.halfWidth - phys.radius;
  const limY = field.halfHeight - phys.radius;
  const step = 1 / 60;
  let best: InterceptSolution | null = null;
  let nextCheck = 0;
  for (let t = 0; t <= horizon + 1e-9; t += step) {
    if (t >= nextCheck - 1e-9) {
      nextCheck += 0.05;
      const dx = x - self.x;
      const dy = y - self.y;
      const need = travelTime(Math.max(0, Math.sqrt(dx * dx + dy * dy) - reach), selfSpeed, accel, vmax);
      const slack = t - need;
      if (slack >= 0) return { point: { x, y }, t, slack };
      if (!best || slack > best.slack) best = { point: { x, y }, t, slack };
    }
    const speed = Math.sqrt(vx * vx + vy * vy);
    if (speed > 0) {
      const next = Math.max(0, speed - phys.friction * step);
      if (next <= phys.restSpeed) {
        vx = 0;
        vy = 0;
      } else {
        vx = (vx / speed) * next;
        vy = (vy / speed) * next;
      }
    }
    x += vx * step;
    y += vy * step;
    if (x < -limX) {
      x = -limX;
      vx = -vx * phys.restitution;
    } else if (x > limX) {
      x = limX;
      vx = -vx * phys.restitution;
    }
    if (y < -limY) {
      y = -limY;
      vy = -vy * phys.restitution;
    } else if (y > limY) {
      y = limY;
      vy = -vy * phys.restitution;
    }
  }
  return best;
}

/** How fast the ball leaves the hand for a given wind-up — mirrors `Simulation.releaseThrow`. */
export function throwSpeed(charge: number, th: { minCharge: number; maxCharge: number; weakSpeed: number; minSpeed: number; maxSpeed: number }): number {
  if (charge < th.minCharge) {
    return th.weakSpeed + (th.minSpeed - th.weakSpeed) * clamp(charge / th.minCharge, 0, 1);
  }
  const u = clamp((charge - th.minCharge) / (th.maxCharge - th.minCharge), 0, 1);
  return th.minSpeed + (th.maxSpeed - th.minSpeed) * u;
}

/** The wind-up needed to make a throw of `speed`, clamped to what the arm can do. */
export function chargeForSpeed(speed: number, th: { minCharge: number; maxCharge: number; weakSpeed: number; minSpeed: number; maxSpeed: number }): number {
  if (speed <= th.minSpeed) {
    const u = clamp((speed - th.weakSpeed) / Math.max(1e-6, th.minSpeed - th.weakSpeed), 0, 1);
    return u * th.minCharge;
  }
  const u = clamp((speed - th.minSpeed) / Math.max(1e-6, th.maxSpeed - th.minSpeed), 0, 1);
  return th.minCharge + u * (th.maxCharge - th.minCharge);
}

/** Perpendicular distance from `p` to the segment a-b, and how far along it the foot lies. */
export function pointToSegment(p: Vec2, a: Vec2, b: Vec2): { dist: number; u: number } {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const ll = abx * abx + aby * aby;
  if (ll < 1e-9) return { dist: dist2(p, a), u: 0 };
  let u = ((p.x - a.x) * abx + (p.y - a.y) * aby) / ll;
  u = clamp(u, 0, 1);
  const cx = a.x + abx * u;
  const cy = a.y + aby * u;
  return { dist: len2({ x: p.x - cx, y: p.y - cy }), u };
}
