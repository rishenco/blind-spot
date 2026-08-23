/**
 * The robo-dog (vision §6, engine-plan §7).
 *
 * This milestone builds the PATROL half of vision §6's three modes: a route follower that is
 * heard, seen, lost and remembered. Investigate and attack — the belief model, the lunge, the
 * detonation — arrive with the loop; nothing here predicts, chases or reacts to the player.
 *
 * Three rules from the vision shape every decision below, and none of them are negotiable:
 *
 * 1. "A stationary, silent dog is invisible" (§6). The dog is NOT drawn from its position. It is
 *    drawn from the poses its own sound events were HEARD at. `poseHistory` is written by the
 *    delivery feed, never by `update()`, so a dog behind two walls, a dog that has stopped, and a
 *    dog that never existed are the same picture: nothing. The rule that hides you hides it.
 * 2. "Never interpolated, never predicted by the renderer — a ghost is a photograph" (§3.7). A
 *    ghost is one pose sample, stamped with the instant it froze, and it is frozen at
 *    `lastHeardAt + DOG_FREEZE_DELAY` — the moment the silence became long enough — never at
 *    whatever step boundary happened to notice.
 * 3. "The system never lies" (§1.2). The dog emits a gait event every `DOG_GAIT_STRIDE` metres of
 *    ground actually covered, so the paint trail a listener reads back IS the route the body took.
 *    A paused dog covers no ground and therefore says nothing.
 *
 * The body cloud is baked ONCE, in body space, on the same lattice discipline as the world
 * (visual-brief §2: "the same surface always lights the same dots at the same spots"). It is
 * shared by every dog and owned by this system — a look builds its own Points over it and must
 * not dispose it (looks/types.ts).
 *
 * The pose is baked at one gait phase on purpose. `DOG_GAIT_STRIDE` is one full trot cycle, so
 * the dog is only ever HEARD — and therefore only ever SEEN — at the same point in its stride:
 * all four feet down, diagonals split. A phase-animated cloud would be showing the player a
 * moment nothing told them about.
 */

import { BufferAttribute, BufferGeometry } from 'three';
import {
  DOG_CLOUD_TARGET,
  DOG_FREEZE_DELAY,
  DOG_GAIT_STRIDE,
  DOG_GHOST_DISSOLVE,
  DOG_GHOST_LIFE,
  DOG_MAX_GHOSTS,
  DOG_SMEAR_SAMPLES,
  DOG_SMEAR_WINDOW,
  DOG_TURN_RADIUS,
} from './const.js';
import type { EventBus, SoundEvent } from './events.js';
import { angleDelta, clamp } from './math.js';
import { groundUnder, type World } from './map/build.js';
import type { DogRouteDef } from './map/types.js';
import { surfelDither } from './surfels.js';

/** One frozen pose of a moving thing, for motion smear (vision §3.7). */
export interface PoseSample {
  /** Sim time this pose was heard at. */
  readonly time: number;
  /** Body-space → world transform, column-major 4×4, ready for `Matrix4.fromArray`. */
  readonly matrix: readonly number[];
}

/** A dog's last-heard photograph, cooling hot → rust then dissolving (vision §3.7). */
export interface GhostSnapshot {
  readonly pose: PoseSample;
  /** Sim time the ghost was frozen — the look ages it against `LookContext.time()`. */
  readonly frozenAt: number;
  /** Quality of the event that produced it: how sure the read is (visual-brief §1.13). */
  readonly quality: number;
}

/** One dog as a look sees it: a body-local cloud plus what was last heard of it. */
export interface DogView {
  readonly id: number;
  /** Body-local sample cloud on the same lattice discipline as the world (engine-plan §7). */
  readonly cloudGeom: BufferGeometry;
  /** The pitch that cloud was solved at, metres — a splat's footprint is a cell (visual-brief §2). */
  readonly cloudSpacing: number;
  /** Newest last. Empty while the dog has made no sound this session. */
  readonly poseHistory: readonly PoseSample[];
  readonly ghosts: readonly GhostSnapshot[];
  readonly lastEventQuality: number;
}

/** Where a dog actually is — for the top-down plan and for specs, never for the first-person image. */
export interface DogBody {
  readonly routeId: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly yaw: number;
  /** False while serving a waypoint pause. A stopped dog steers but does not travel or sound. */
  readonly moving: boolean;
}

/**
 * How high above the paws a gait event is emitted.
 *
 * Not zero, and the reason is geometric rather than aesthetic: paint's per-surfel face test
 * (core/paint.ts, "Step 5") drops any surfel whose normal points away from the origin, and an
 * origin sitting exactly ON the floor plane is on neither side of it. Whether the floor the dog
 * is standing on paints at all would then depend on the sign of a float — or, through a wall, on
 * the sign of the fuzz vector. A hand's width up and the answer is always yes.
 */
const DOG_EMIT_LIFT = 0.1;

/** A waypoint is reached when the body crosses the plane through it, perpendicular to the leg. */
const ARRIVE_EPS = 1e-4;

/**
 * How many despawned dogs may keep cooling at once (see `DogSystem.despawn`).
 *
 * A ghost is information the player paid a sound for; removing the body must not confiscate it.
 * Each orphan holds at most DOG_MAX_GHOSTS of its own, so this is the second half of a bounded
 * budget rather than a guess: a debug key cycling the roster cannot grow the ghost pool without
 * limit, and four cooling routes is already more than the ±1-floor window ever shows.
 */
const DOG_MAX_ORPHANS = 4;

// ---------------------------------------------------------------------------------------------
// The body: a box skeleton sampled on a body-local lattice
// ---------------------------------------------------------------------------------------------

/**
 * A box in BODY space: +x forward, +y up, +z to the dog's right. `rot` turns it about +z, which
 * is the only rotation a quadruped's parts need — every joint in this skeleton bends in the
 * sagittal plane.
 */
interface Part {
  cx: number;
  cy: number;
  cz: number;
  hx: number;
  hy: number;
  hz: number;
  rot: number;
}

const HIP_Y = 0.5;
const HIP_X = 0.32;
const HIP_Z = 0.2;
const LIMB_SEG = 0.3;
const LIMB_HALF = 0.05;
/** How far fore/aft a planted paw sits from its hip at the footfall phase. */
const STRIDE_REACH = 0.16;

const part = (cx: number, cy: number, cz: number, hx: number, hy: number, hz: number, rot = 0): Part => ({
  cx,
  cy,
  cz,
  hx,
  hy,
  hz,
  rot,
});

/** Knee of a two-link leg, solved in the sagittal plane. `bend` picks elbow-back / stifle-forward. */
function knee(hx: number, hy: number, fx: number, fy: number, bend: number): [number, number] {
  const dx = fx - hx;
  const dy = fy - hy;
  const len = Math.hypot(dx, dy) || 1e-6;
  // Both links are the same length, so the elbow sits over the midpoint of the hip→foot line and
  // the only unknown is how far off it. Clamped rather than trusted: a fully extended leg gives
  // a negative discriminant by a float's width and NaN would poison the whole cloud.
  const a = len / 2;
  const h = Math.sqrt(Math.max(0, LIMB_SEG * LIMB_SEG - a * a));
  const ux = dx / len;
  const uy = dy / len;
  return [hx + ux * a - bend * uy * h, hy + uy * a + bend * ux * h];
}

/**
 * One limb segment as an oriented box from `(x0,y0)` to `(x1,y1)` at side offset `z`.
 *
 * The box is grown past the JOINT end only, by half its own thickness, so the hip and knee read
 * as filled corners rather than as gaps. The far end stops exactly on the point given — which for
 * the lower segments is the paw, and a paw baked below the floor plane would draw a dog standing
 * in the concrete.
 */
function segment(x0: number, y0: number, x1: number, y1: number, z: number): Part {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.hypot(dx, dy);
  const rot = Math.atan2(dy, dx);
  const back = LIMB_HALF / 2;
  return part(
    (x0 + x1) / 2 - Math.cos(rot) * back,
    (y0 + y1) / 2 - Math.sin(rot) * back,
    z,
    len / 2 + back,
    LIMB_HALF,
    LIMB_HALF,
    rot,
  );
}

/**
 * The skeleton at the footfall phase (see the header). Diagonal pairs are split fore and aft —
 * the silhouette a trot is recognised by, and the one the Lantern Test (vision §15.2) asks a
 * tester to call a heading from.
 */
function skeleton(): Part[] {
  const parts: Part[] = [
    part(0, 0.725, 0, 0.45, 0.225, 0.275), // torso
    part(0.51, 0.935, 0, 0.09, 0.085, 0.09), // neck
    part(0.62, 1.02, 0, 0.13, 0.1, 0.11), // head
  ];
  // Diagonal pairs: front-left and hind-right lead, front-right and hind-left trail.
  const legs: ReadonlyArray<readonly [number, number, number, number]> = [
    [HIP_X, -HIP_Z, 1, -1], // hipX, hipZ, phase sign, bend
    [HIP_X, HIP_Z, -1, -1],
    [-HIP_X, -HIP_Z, -1, 1],
    [-HIP_X, HIP_Z, 1, 1],
  ];
  for (const [hx, hz, lead, bend] of legs) {
    const fx = hx + STRIDE_REACH * lead;
    const fy = 0;
    const [kx, ky] = knee(hx, HIP_Y, fx, fy, bend);
    parts.push(segment(hx, HIP_Y, kx, ky, hz));
    parts.push(segment(kx, ky, fx, fy, hz));
  }
  return parts;
}

/** Body-local coordinates of a point inside `p`'s own frame. */
function toLocal(p: Part, x: number, y: number, z: number): [number, number, number] {
  const c = Math.cos(p.rot);
  const s = Math.sin(p.rot);
  const dx = x - p.cx;
  const dy = y - p.cy;
  return [dx * c + dy * s, -dx * s + dy * c, z - p.cz];
}

const INSIDE_MARGIN = 1e-3;

function insideAny(parts: readonly Part[], own: number, x: number, y: number, z: number): boolean {
  for (let i = 0; i < parts.length; i++) {
    if (i === own) continue;
    const p = parts[i]!;
    const [a, b, c] = toLocal(p, x, y, z);
    if (
      Math.abs(a) < p.hx - INSIDE_MARGIN &&
      Math.abs(b) < p.hy - INSIDE_MARGIN &&
      Math.abs(c) < p.hz - INSIDE_MARGIN
    ) {
      return true;
    }
  }
  return false;
}

interface Cloud {
  readonly position: number[];
  readonly normal: number[];
  readonly dither: number[];
  readonly count: number;
}

/** Walk every part's six faces on a lattice of spacing `s`, dropping samples buried in a neighbour. */
function sampleBody(parts: readonly Part[], s: number): Cloud {
  const position: number[] = [];
  const normal: number[] = [];
  const dither: number[] = [];
  const first = (w: number): number => Math.ceil(w / s - 0.5);
  const centre = (i: number): number => (i + 0.5) * s;

  for (let pi = 0; pi < parts.length; pi++) {
    const p = parts[pi]!;
    const c = Math.cos(p.rot);
    const sn = Math.sin(p.rot);
    const half: [number, number, number] = [p.hx, p.hy, p.hz];
    for (let axis = 0; axis < 3; axis++) {
      const u = (axis + 1) % 3;
      const v = (axis + 2) % 3;
      for (const sign of [-1, 1] as const) {
        const loc: [number, number, number] = [0, 0, 0];
        loc[axis] = sign * half[axis]!;
        for (let iu = first(-half[u]!); centre(iu) <= half[u]!; iu++) {
          loc[u] = centre(iu);
          for (let iv = first(-half[v]!); centre(iv) <= half[v]!; iv++) {
            loc[v] = centre(iv);
            // local -> body (rotation is about +z only)
            const bx = p.cx + loc[0] * c - loc[1] * sn;
            const by = p.cy + loc[0] * sn + loc[1] * c;
            const bz = p.cz + loc[2];
            if (insideAny(parts, pi, bx, by, bz)) continue;
            const nl: [number, number, number] = [0, 0, 0];
            nl[axis] = sign;
            position.push(bx, by, bz);
            normal.push(nl[0] * c - nl[1] * sn, nl[0] * sn + nl[1] * c, nl[2]);
            dither.push(surfelDither(bx, by, bz));
          }
        }
      }
    }
  }
  return { position, normal, dither, count: dither.length };
}

/**
 * The shared body cloud, sized to `DOG_CLOUD_TARGET` (engine-plan §7: ~600 points).
 *
 * The spacing is solved rather than guessed: an analytic first guess from the skeleton's surface
 * area, then a fixed number of deterministic refinements, keeping whichever spacing landed
 * closest to the budget. Fixed iteration count and no randomness, so the geometry a spec measures
 * and the geometry a capture draws are byte-identical.
 */
export function buildDogCloud(target = DOG_CLOUD_TARGET): BufferGeometry {
  const parts = skeleton();
  let area = 0;
  for (const p of parts) area += 8 * (p.hx * p.hy + p.hy * p.hz + p.hz * p.hx);
  let s = Math.sqrt(area / Math.max(1, target));
  let best = sampleBody(parts, s);
  let bestS = s;
  for (let i = 0; i < 16 && best.count !== target; i++) {
    s *= Math.sqrt(Math.max(1, best.count) / target);
    if (!(s > 1e-4)) break;
    const next = sampleBody(parts, s);
    if (Math.abs(next.count - target) < Math.abs(best.count - target)) {
      best = next;
      bestS = s;
    }
  }

  const geom = new BufferGeometry();
  // The lattice pitch this cloud was actually solved at. A look needs it for the same reason it
  // needs SURFEL_SPACING: a splat is drawn at the projected footprint of its own cell
  // (visual-brief §2), and the dog's lattice is finer than the world's by about a factor of three.
  geom.userData.spacing = bestS;
  geom.setAttribute('position', new BufferAttribute(new Float32Array(best.position), 3));
  geom.setAttribute('normal', new BufferAttribute(new Float32Array(best.normal), 3));
  geom.setAttribute('dither', new BufferAttribute(new Float32Array(best.dither), 1));
  geom.setDrawRange(0, best.count);
  return geom;
}

// ---------------------------------------------------------------------------------------------
// One dog
// ---------------------------------------------------------------------------------------------

class Dog implements DogView, DogBody {
  readonly id: number;
  readonly routeId: string;
  readonly cloudGeom: BufferGeometry;
  readonly cloudSpacing: number;
  private readonly route: DogRouteDef;
  private readonly world: World;

  x: number;
  y: number;
  z: number;
  yaw: number;
  /** Index of the waypoint the dog most recently left. The target is the next one, cyclically. */
  private leg = 0;
  private legDirX = 1;
  private legDirZ = 0;
  private pauseLeft: number;
  private strideAccum = 0;

  readonly poseHistory: PoseSample[] = [];
  readonly ghosts: GhostSnapshot[] = [];
  lastEventQuality = 0;
  private lastHeardAt = -Infinity;
  private frozen = true;

  constructor(id: number, route: DogRouteDef, world: World, cloudGeom: BufferGeometry) {
    this.id = id;
    this.routeId = route.id;
    this.route = route;
    this.world = world;
    this.cloudGeom = cloudGeom;
    this.cloudSpacing = (cloudGeom.userData.spacing as number | undefined) ?? 0;
    const start = route.waypoints[0]!;
    this.x = start.x;
    this.z = start.z;
    this.y = 0;
    this.pauseLeft = start.pause ?? 0;
    const next = route.waypoints[1 % route.waypoints.length]!;
    this.yaw = Math.atan2(next.z - start.z, next.x - start.x);
    this.beginLeg();
    this.settleOnGround();
  }

  get moving(): boolean {
    return this.pauseLeft <= 0;
  }

  private get target(): { x: number; z: number; pause?: number | undefined } {
    return this.route.waypoints[(this.leg + 1) % this.route.waypoints.length]!;
  }

  private beginLeg(): void {
    const t = this.target;
    const dx = t.x - this.x;
    const dz = t.z - this.z;
    const len = Math.hypot(dx, dz) || 1;
    this.legDirX = dx / len;
    this.legDirZ = dz / len;
  }

  private settleOnGround(): void {
    const g = groundUnder(this.world, this.x, this.z, this.y + 0.6, 0.3, 4);
    if (g) this.y = g.y;
  }

  /**
   * One step of route following. Returns the number of gait events owed — emitted by the system,
   * which has to arm event attribution around each `bus.emit` (see `DogSystem.emitGait`).
   */
  advance(dt: number): number {
    const speed = this.route.speed;
    // Vision §6 states the steering limit as a 3 m TURN RADIUS. The rate follows from the gait in
    // use, and the gait in use is the ROUTE's — not the instantaneous speed, or a dog serving a
    // 6 s pause could never turn around on the spot to leave the way it came.
    const maxTurn = (speed / DOG_TURN_RADIUS) * dt;
    const t = this.target;
    const desired = Math.atan2(t.z - this.z, t.x - this.x);
    // Wrapped back into (−π, π] every step: yaw is integrated, and an unbounded accumulator loses
    // precision to a dog that has walked its loop for twenty minutes.
    this.yaw = angleDelta(0, this.yaw + clamp(angleDelta(this.yaw, desired), -maxTurn, maxTurn));

    if (this.pauseLeft > 0) {
      this.pauseLeft -= dt;
      return 0;
    }

    const step = speed * dt;
    this.x += Math.cos(this.yaw) * step;
    this.z += Math.sin(this.yaw) * step;
    this.settleOnGround();
    this.strideAccum += step;

    // Arrival is the crossing of the plane through the waypoint, perpendicular to the leg the dog
    // came in on — not a distance test. A radius test can be overshot by a fast gait and orbited
    // forever; a plane cannot be crossed twice.
    if ((this.x - t.x) * this.legDirX + (this.z - t.z) * this.legDirZ >= -ARRIVE_EPS) {
      this.x = t.x;
      this.z = t.z;
      this.settleOnGround();
      this.leg = (this.leg + 1) % this.route.waypoints.length;
      this.pauseLeft = t.pause ?? 0;
      this.beginLeg();
    }

    let owed = 0;
    while (this.strideAccum >= DOG_GAIT_STRIDE) {
      this.strideAccum -= DOG_GAIT_STRIDE;
      owed++;
    }
    return owed;
  }

  /** Column-major body→world transform: a yaw about +y at the paws. */
  matrix(): number[] {
    const c = Math.cos(this.yaw);
    const s = Math.sin(this.yaw);
    return [c, 0, s, 0, 0, 1, 0, 0, -s, 0, c, 0, this.x, this.y, this.z, 1];
  }

  /** A delivered event of this dog's: the one thing that makes it visible. */
  heard(e: SoundEvent): void {
    this.lastEventQuality = e.quality;
    this.lastHeardAt = e.time;
    this.frozen = false;
    this.poseHistory.push({ time: e.time, matrix: this.matrix() });
    // The window is measured from the NEWEST sample and the newest is never dropped, so the real
    // invariant is NOT "no pose is older than DOG_SMEAR_WINDOW": a pose is held until the dog
    // freezes, up to `lastHeardAt + DOG_FREEZE_DELAY` (0.4 s), which is deliberately longer than
    // the smear window (0.3 s). Ageing the history against the clock instead would blank a live
    // dog for the last tenth of a second before it froze. The window bounds the SPREAD of the
    // samples behind the newest — the smear tail. Each sample carries the instant it was heard
    // and a look fades it by that age (looks/debug/marks.ts stamps `aBorn` per pose), so a pose
    // held past the smear window reads as a body going stale, never as a longer smear.
    const newest = this.poseHistory[this.poseHistory.length - 1]!.time;
    let keep = 0;
    for (let i = this.poseHistory.length - 1; i >= 0; i--) {
      if (keep >= DOG_SMEAR_SAMPLES || newest - this.poseHistory[i]!.time > DOG_SMEAR_WINDOW) break;
      keep++;
    }
    if (keep < this.poseHistory.length) this.poseHistory.splice(0, this.poseHistory.length - keep);
  }

  /** Freeze into a ghost once the silence is long enough, then age the ghosts out. */
  settleVisibility(now: number): void {
    if (!this.frozen && this.poseHistory.length > 0 && now - this.lastHeardAt >= DOG_FREEZE_DELAY) {
      this.frozen = true;
      // Stamped with the instant the silence became long enough, NOT with the step that noticed:
      // a ghost is a photograph (vision §3.7) and its age is the reason the player believes it.
      const frozenAt = this.lastHeardAt + DOG_FREEZE_DELAY;
      this.ghosts.push({
        pose: this.poseHistory[this.poseHistory.length - 1]!,
        frozenAt,
        quality: this.lastEventQuality,
      });
      // Cleared, so "no pose" means exactly one thing: the dog has vanished from your map.
      this.poseHistory.length = 0;
    }
    let write = 0;
    for (const g of this.ghosts) {
      if (now - g.frozenAt <= DOG_GHOST_LIFE + DOG_GHOST_DISSOLVE) this.ghosts[write++] = g;
    }
    this.ghosts.length = write;
    if (this.ghosts.length > DOG_MAX_GHOSTS) this.ghosts.splice(0, this.ghosts.length - DOG_MAX_GHOSTS);
  }
}

// ---------------------------------------------------------------------------------------------
// The system
// ---------------------------------------------------------------------------------------------

export class DogSystem {
  private readonly world: World;
  private readonly bus: EventBus;
  private readonly live: Dog[] = [];
  /**
   * Despawned dogs that still hold something the player heard. They no longer walk, steer or
   * sound — `update` only ages them — but they keep cooling and dissolving on the normal clock
   * and they stay in `views` until the last ghost is gone. See `despawn`.
   */
  private readonly orphans: Dog[] = [];
  /** Rebuilt in place while orphans exist, so `views` allocates nothing per frame. */
  private readonly viewList: Dog[] = [];
  /**
   * Built on first spawn, not in the constructor: a dog-free run — which every existing scripted
   * capture is — must allocate no geometry and must sample no lattice.
   */
  private cloudGeom: BufferGeometry | null = null;
  /**
   * The dog currently inside `bus.emit`. Emission and delivery are both SYNCHRONOUS (events.ts
   * and paint.ts both say so, and a spec pins it), so a delivered dog event always arrives while
   * its own emitter is still on the stack. That makes attribution exact instead of a search
   * through positions — two dogs standing on the same tile stay two dogs.
   */
  private emitting: Dog | null = null;
  private detach: (() => void) | null = null;

  constructor(world: World, bus: EventBus, roster: readonly string[]) {
    this.world = world;
    this.bus = bus;
    for (const id of roster) this.spawn(id);
  }

  get views(): readonly DogView[] {
    if (this.orphans.length === 0) return this.live;
    this.viewList.length = 0;
    for (const d of this.live) this.viewList.push(d);
    for (const d of this.orphans) this.viewList.push(d);
    return this.viewList;
  }

  get bodies(): readonly DogBody[] {
    return this.live;
  }

  /** Is this route's dog alive right now? The top-down plan draws live routes solid. */
  has(routeId: string): boolean {
    return this.live.some((d) => d.routeId === routeId);
  }

  spawn(routeId: string): void {
    if (this.has(routeId)) return;
    const index = this.world.map.dogRoutes.findIndex((r) => r.id === routeId);
    if (index < 0) return;
    const route = this.world.map.dogRoutes[index]!;
    if (route.waypoints.length < 2) return;
    this.cloudGeom ??= buildDogCloud();
    this.live.push(new Dog(index, route, this.world, this.cloudGeom));
    // Map order, always — a roster is a set, and a spawn order that depended on the order a URL
    // happened to name things would make two identical runs differ.
    this.live.sort((a, b) => a.id - b.id);
  }

  /**
   * Remove a dog's BODY. Whatever the player has already heard of it survives.
   *
   * A ghost is information a sound was spent on (vision §3.7, §1 law 1): the debug key that
   * removes a dog must not reach into the player's map and erase reads it already paid for. The
   * body leaves the roster — it stops walking, stops sounding, stops being a `bodies` entry — and
   * the record it left behind is detached into `orphans`, where it keeps cooling and dissolving on
   * the same clock as any other ghost and stays visible to `views` until it is gone. A pose still
   * inside its smear window is kept too, and freezes into its ghost at `lastHeardAt +
   * DOG_FREEZE_DELAY` exactly as it would have: the freeze is the silence maturing, and removing
   * the body does not change when the sound stopped.
   */
  despawn(routeId: string): void {
    const i = this.live.findIndex((d) => d.routeId === routeId);
    if (i < 0) return;
    const [dog] = this.live.splice(i, 1);
    if (!dog || (dog.ghosts.length === 0 && dog.poseHistory.length === 0)) return;
    this.orphans.push(dog);
    if (this.orphans.length > DOG_MAX_ORPHANS) this.orphans.splice(0, this.orphans.length - DOG_MAX_ORPHANS);
  }

  /**
   * Subscribe to one listener's DELIVERED feed (`PaintPipeline.onDelivered`). Structural on
   * purpose: core/dog.ts knows about a feed of delivered sound and nothing about surfels.
   */
  attach(feed: { onDelivered(fn: (e: SoundEvent) => void): () => void }): void {
    this.detach?.();
    this.detach = feed.onDelivered((e) => this.hearDelivered(e));
  }

  /** A delivered event. Only a dog's own gait makes that dog visible (vision §6). */
  hearDelivered(e: SoundEvent): void {
    if (e.source !== 'dog') return;
    this.emitting?.heard(e);
  }

  update(dt: number): void {
    for (const dog of this.live) {
      const owed = dog.advance(dt);
      for (let i = 0; i < owed; i++) this.emitGait(dog);
    }
    for (const dog of this.live) dog.settleVisibility(this.bus.now);
    // Orphans only age: no advance, no gait, no attribution — a removed body makes no sound.
    let write = 0;
    for (const dog of this.orphans) {
      dog.settleVisibility(this.bus.now);
      if (dog.ghosts.length > 0 || dog.poseHistory.length > 0) this.orphans[write++] = dog;
    }
    this.orphans.length = write;
  }

  dispose(): void {
    this.detach?.();
    this.detach = null;
    this.live.length = 0;
    this.orphans.length = 0;
    this.viewList.length = 0;
    this.cloudGeom?.dispose();
    this.cloudGeom = null;
  }

  private emitGait(dog: Dog): void {
    this.emitting = dog;
    try {
      this.bus.emit({
        class: 'dogGait',
        source: 'dog',
        variant: 'patrol',
        x: dog.x,
        y: dog.y + DOG_EMIT_LIFT,
        z: dog.z,
      });
    } finally {
      this.emitting = null;
    }
  }
}
