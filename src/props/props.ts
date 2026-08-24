/**
 * The clutter — every loose thing in the hall, and the physics that makes it noisy.
 *
 * M2's question is whether the world becoming *audible in response to you* is frightening, and
 * this file is where the response comes from. Nothing here is scripted: a body is pushed, Rapier
 * resolves the contact, the contact force becomes a loudness in metres, and that single number
 * goes onto the one bus that the marker layer, the audio synth and (in M4) spider hearing all
 * read independently.
 *
 * Three decisions worth knowing before reading the code:
 *
 * **Sleep is architecture, not an optimisation.** Four hundred bodies are affordable only
 * because three hundred and ninety of them cost nothing on a normal frame. Rapier sleeps a body
 * that has been still for a moment; everything downstream — the reveal fade, the debug counters,
 * the audio — is written in terms of "asleep" rather than in terms of "not moving much", so a
 * sleeping body genuinely does no work anywhere in the pipeline.
 *
 * **Static geometry stays where it is.** The hall keeps the M1 AABB world for the player, which
 * is tuned, deterministic and known-good; Rapier gets the same boxes as fixed cuboids purely so
 * props have a floor and shelves to land on. Two representations of static collision is a real
 * cost, but it is a build-time one, and the alternative — moving the player controller onto a
 * physics engine in the same milestone that introduces the physics engine — is how milestones
 * die.
 *
 * **The player and the rifle are kinematic bodies.** They are driven by the controller, not by
 * forces, so they shove props without props ever shoving them. The rifle in particular is a bare
 * box on a stick: turn round in a tight aisle and it sweeps a metre of shelf onto the floor.
 */
import type RAPIER from '@dimforge/rapier3d-compat';
import { StaticWorld, canOccupy, highestTopUnder, type Aabb } from '../core/collision';
import { makeRng, range, rangeInt, type Rng } from '../core/rng';
import type { SoundBus } from '../events/bus';
import {
  ARCHETYPES,
  MATERIALS,
  sampleShape,
  shapeEdges,
  shapeSpan,
  type EdgeSet,
  type PointCloud,
} from './shapes';

export type Rapier = typeof RAPIER;

/** Loaded once, cached: the wasm is inlined in the compat build, so this is pure decode cost. */
let rapierModule: Rapier | null = null;
export async function loadRapier(): Promise<Rapier> {
  if (rapierModule !== null) return rapierModule;
  const mod = await import('@dimforge/rapier3d-compat');
  await mod.init();
  rapierModule = mod as unknown as Rapier;
  return rapierModule;
}

export interface PropTunables {
  /** Physics ticks per second. Below the render loop's 120: props do not need visual-rate physics. */
  hz: number;
  /**
   * Contact force, in newtons, under which a collision makes no sound at all. Without it every
   * resting body would chirp forever at its own weight.
   */
  quietForce: number;
  /** Newtons that map to one metre of notice. The whole loudness scale hangs off this number. */
  forcePerMetre: number;
  /** Ceiling on one impact, metres of notice. */
  maxLoudness: number;
  /** Minimum seconds between two sound events from the same body. A tumbling can is one voice. */
  perBodyGap: number;
  /**
   * How many props the hall gets. The concept wants a *lot* of junk, and the ceiling on that is
   * not physics — Rapier sleeps everything that is not moving — but the lidar mask: every prop
   * carries a few hundred points, and those points are uploaded, aged and drawn. See the report
   * for the frame-budget measurement this number came out of.
   */
  cap: number;
}

export function defaultPropTunables(): PropTunables {
  return { hz: 60, quietForce: 90, forcePerMetre: 26, maxLoudness: 34, perBodyGap: 0.055, cap: 1100 };
}

export interface PropStats {
  bodies: number;
  awake: number;
  asleep: number;
  /** Sound events emitted by props since the start. */
  impacts: number;
  stepMs: number;
  points: number;
}


export class PropWorld {
  readonly tunables: PropTunables;
  /** Per-prop archetype index. */
  readonly arch: Int32Array;
  /** Per-prop world transform, refreshed every physics step. */
  readonly pos: Float32Array;
  readonly quat: Float32Array;
  /** 1 while the body is awake. A sleeping body is, for every consumer, part of the furniture. */
  readonly moving: Uint8Array;
  /** Scene time the body last fell asleep. Reveal fade is written against this (see dynamic.ts). */
  readonly settleAt: Float32Array;
  readonly clouds: PointCloud[] = [];
  /** Per archetype, the contour of the shape — what actually makes it recognisable. */
  readonly edges: EdgeSet[] = [];

  readonly count: number;

  private readonly world: RAPIER.World;
  private readonly queue: RAPIER.EventQueue;
  private readonly bodies: RAPIER.RigidBody[] = [];
  private readonly byCollider = new Map<number, number>();
  private readonly lastSound: Float32Array;
  private player: RAPIER.RigidBody | null = null;
  private rifle: RAPIER.RigidBody | null = null;
  private accumulator = 0;
  private time = 0;
  private stats: PropStats = { bodies: 0, awake: 0, asleep: 0, impacts: 0, stepMs: 0, points: 0 };
  private readonly vec: RAPIER.Vector3;

  constructor(
    private readonly R: Rapier,
    statics: StaticWorld,
    private readonly bus: SoundBus,
    seed: number,
    tunables: PropTunables = defaultPropTunables(),
  ) {
    this.tunables = tunables;
    this.world = new R.World({ x: 0, y: -9.81, z: 0 });
    this.world.timestep = 1 / tunables.hz;
    this.queue = new R.EventQueue(true);
    this.vec = { x: 0, y: 0, z: 0 };

    for (const a of ARCHETYPES) {
      this.clouds.push(sampleShape(a.parts, a.pitch, 0x9e37 + a.name.length));
      this.edges.push(shapeEdges(a.parts));
    }

    // --- static: the same boxes the player already collides with ----------
    for (const b of statics.boxes) {
      const hx = (b.maxX - b.minX) / 2;
      const hy = (b.maxY - b.minY) / 2;
      const hz = (b.maxZ - b.minZ) / 2;
      const body = this.world.createRigidBody(
        R.RigidBodyDesc.fixed().setTranslation(b.minX + hx, b.minY + hy, b.minZ + hz),
      );
      this.world.createCollider(R.ColliderDesc.cuboid(hx, hy, hz).setFriction(0.7), body);
    }

    // --- the clutter itself ------------------------------------------------
    const spots = layout(statics, seed, tunables.cap);
    this.count = spots.length;
    this.arch = new Int32Array(this.count);
    this.pos = new Float32Array(this.count * 3);
    this.quat = new Float32Array(this.count * 4);
    this.moving = new Uint8Array(this.count);
    this.settleAt = new Float32Array(this.count);
    this.lastSound = new Float32Array(this.count);
    let points = 0;

    for (let i = 0; i < spots.length; i++) {
      const s = spots[i]!;
      this.arch[i] = s.arch;
      points += this.clouds[s.arch]!.count;
      const a = ARCHETYPES[s.arch]!;
      const mat = MATERIALS[a.material];
      const body = this.world.createRigidBody(
        R.RigidBodyDesc.dynamic()
          .setTranslation(s.x, s.y, s.z)
          .setRotation(s.rot)
          .setLinearDamping(0.08)
          .setAngularDamping(0.22),
      );
      for (const part of a.parts) {
        let desc: RAPIER.ColliderDesc;
        if (part.kind === 'box') {
          desc = R.ColliderDesc.cuboid(part.hx, part.hy, part.hz).setTranslation(part.cx, part.cy, part.cz);
        } else if (part.kind === 'ball') {
          desc = R.ColliderDesc.ball(part.r).setTranslation(0, part.cy, 0);
        } else {
          const r = ((part.r1 ?? part.r0) + part.r0) / 2;
          const hh = Math.max(0.004, (part.y1 - part.y0) / 2);
          desc = R.ColliderDesc.cylinder(hh, Math.max(0.004, r)).setTranslation(0, (part.y0 + part.y1) / 2, 0);
        }
        this.world.createCollider(
          desc
            .setDensity(mat.density)
            .setRestitution(mat.restitution)
            .setFriction(mat.friction)
            .setActiveEvents(R.ActiveEvents.CONTACT_FORCE_EVENTS)
            .setContactForceEventThreshold(tunables.quietForce),
          body,
        );
      }
      this.bodies.push(body);
      for (let c = 0; c < body.numColliders(); c++) {
        this.byCollider.set(body.collider(c).handle, i);
      }
      this.settleAt[i] = 0;
    }
    this.stats.bodies = this.count;
    this.stats.points = points;
    this.readBack();
  }

  getStats(): PropStats {
    return this.stats;
  }

  /** Local point cloud of prop `i`. */
  cloudOf(i: number): PointCloud {
    return this.clouds[this.arch[i]!]!;
  }

  /** Local contour of prop `i`. */
  edgesOf(i: number): EdgeSet {
    return this.edges[this.arch[i]!]!;
  }

  /**
   * The player as a kinematic capsule, and the rifle as a kinematic box a metre in front of the
   * eye. Both are created lazily so a headless run that never poses a player pays nothing.
   */
  setPlayer(x: number, feetY: number, z: number, radius: number, height: number): void {
    const R = this.R;
    if (this.player === null) {
      this.player = this.world.createRigidBody(R.RigidBodyDesc.kinematicPositionBased());
      this.world.createCollider(
        R.ColliderDesc.capsule(Math.max(0.1, height / 2 - radius), radius).setFriction(0.4),
        this.player,
      );
    }
    this.vec.x = x;
    this.vec.y = feetY + height / 2;
    this.vec.z = z;
    this.player.setNextKinematicTranslation(this.vec);
  }

  /** The rifle's collider — position and orientation of a 0.7 m barrel box. */
  setRifle(x: number, y: number, z: number, qx: number, qy: number, qz: number, qw: number): void {
    const R = this.R;
    if (this.rifle === null) {
      this.rifle = this.world.createRigidBody(R.RigidBodyDesc.kinematicPositionBased());
      this.world.createCollider(
        R.ColliderDesc.cuboid(0.045, 0.085, 0.38)
          .setFriction(0.3)
          .setRestitution(0.1)
          .setActiveEvents(R.ActiveEvents.CONTACT_FORCE_EVENTS)
          .setContactForceEventThreshold(this.tunables.quietForce),
        this.rifle,
      );
    }
    this.vec.x = x;
    this.vec.y = y;
    this.vec.z = z;
    this.rifle.setNextKinematicTranslation(this.vec);
    this.rifle.setNextKinematicRotation({ x: qx, y: qy, z: qz, w: qw });
  }

  /**
   * Advances physics by `dt` of scene time in fixed steps.
   *
   * The simulation clock is the caller's, never the wall clock: the keyframe generator steps this
   * by hand and expects the same hall every time.
   */
  step(dt: number, now: number): void {
    const t0 = performance.now();
    this.time = now;
    const h = 1 / this.tunables.hz;
    this.accumulator += dt;
    let steps = 0;
    while (this.accumulator >= h && steps < 4) {
      this.world.step(this.queue);
      this.accumulator -= h;
      steps++;
      this.drain();
    }
    if (steps > 0) this.readBack();
    this.stats.stepMs = performance.now() - t0;
  }

  /** Contact forces -> loudness in metres -> the one bus. This is the whole "sound from physics". */
  private drain(): void {
    const t = this.tunables;
    this.queue.drainContactForceEvents((e) => {
      const force = e.totalForceMagnitude();
      if (force < t.quietForce) return;
      const i = this.byCollider.get(e.collider1()) ?? this.byCollider.get(e.collider2());
      if (i === undefined) return;
      if (this.time - this.lastSound[i]! < t.perBodyGap) return;
      this.lastSound[i] = this.time;
      const mat = MATERIALS[ARCHETYPES[this.arch[i]!]!.material];
      // Loudness in metres of notice, from the impulse and nothing else. Square-root because
      // the ear is not linear in energy and neither is a spider's attention.
      const loud = Math.min(
        t.maxLoudness,
        Math.sqrt((force - t.quietForce) / t.forcePerMetre) * 4.2 * mat.gain,
      );
      if (loud < 0.6) return;
      const body = this.bodies[i]!;
      const p = body.translation();
      this.stats.impacts++;
      this.bus.emit({ source: 'prop-impact', x: p.x, y: p.y, z: p.z, loudness: loud, material: mat.name });
    });
  }

  private readBack(): void {
    let awake = 0;
    for (let i = 0; i < this.count; i++) {
      const b = this.bodies[i]!;
      const p = b.translation();
      const q = b.rotation();
      this.pos[i * 3] = p.x;
      this.pos[i * 3 + 1] = p.y;
      this.pos[i * 3 + 2] = p.z;
      this.quat[i * 4] = q.x;
      this.quat[i * 4 + 1] = q.y;
      this.quat[i * 4 + 2] = q.z;
      this.quat[i * 4 + 3] = q.w;
      const asleep = b.isSleeping();
      if (asleep) {
        if (this.moving[i] === 1) {
          this.moving[i] = 0;
          this.settleAt[i] = this.time;
        }
      } else {
        this.moving[i] = 1;
        awake++;
      }
    }
    this.stats.awake = awake;
    this.stats.asleep = this.count - awake;
  }

  /**
   * Force the whole pile to rest *now*, and pretend it always was.
   *
   * The layout drops things a few millimetres above their support, so the first tenth of a second
   * of the world is a rain of small settling impacts. Nobody should hear that and no keyframe
   * should catch it, so startup steps the world blind and then calls this: every body is put to
   * sleep and its `settleAt` is rewound to zero, which is what makes a scan of untouched clutter
   * permanent rather than a three-second ghost.
   */
  settle(): void {
    for (let i = 0; i < this.count; i++) {
      const b = this.bodies[i]!;
      b.setLinvel({ x: 0, y: 0, z: 0 }, false);
      b.setAngvel({ x: 0, y: 0, z: 0 }, false);
      b.sleep();
      this.moving[i] = 0;
      this.settleAt[i] = 0;
      this.lastSound[i] = 0;
    }
    this.readBack();
    this.stats.impacts = 0;
    this.queue.clear();
  }

  /** Debug: shove everything inside a radius, which is how the "spilled stack" frames happen. */
  disturb(x: number, y: number, z: number, radius: number, impulse: number): number {
    let hit = 0;
    for (let i = 0; i < this.count; i++) {
      const dx = this.pos[i * 3]! - x;
      const dy = this.pos[i * 3 + 1]! - y;
      const dz = this.pos[i * 3 + 2]! - z;
      const d = Math.hypot(dx, dy, dz);
      if (d > radius) continue;
      const inv = 1 / Math.max(0.2, d);
      const b = this.bodies[i]!;
      b.wakeUp();
      b.applyImpulse({ x: dx * inv * impulse, y: impulse * 0.45, z: dz * inv * impulse }, true);
      hit++;
    }
    return hit;
  }

  dispose(): void {
    this.queue.free();
    this.world.free();
  }
}

// ---------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------

interface Spot {
  arch: number;
  x: number;
  y: number;
  z: number;
  rot: { x: number; y: number; z: number; w: number };
}

/** Axis-angle quaternion, because that is the only rotation placement ever needs. */
function quat(ax: number, ay: number, az: number, angle: number): { x: number; y: number; z: number; w: number } {
  const s = Math.sin(angle / 2);
  return { x: ax * s, y: ay * s, z: az * s, w: Math.cos(angle / 2) };
}

/**
 * Where the clutter goes.
 *
 * Not uniform noise: the concept wants a barnyard of junk you keep blundering into, and uniform
 * scatter reads as a lawn. So it is piles — a handful of things sharing one spot, often stacked —
 * plus loners, plus whatever lands on top of the shelves and benches that are already there.
 * `highestTopUnder` finds those surfaces from the existing static world, so nothing has to be
 * hand-placed onto a shelf that might move next milestone.
 */
function layout(statics: StaticWorld, seed: number, cap: number): Spot[] {
  const rng = makeRng(seed ^ 0x2c10);
  const out: Spot[] = [];
  const scratch: Aabb[] = [];
  const taken: Array<[number, number, number]> = [];

  // Size class, by the thing's actual size — not by its point pitch, which is a rendering
  // decision and drifted the moment the clouds were re-tuned for readability.
  const tall = ARCHETYPES.map((a, i) => ({ a, i, span: shapeSpan(a.parts) }));
  const small = tall.filter((e) => e.span <= 0.42).map(({ a, i }) => ({ a, i }));
  const large = tall.filter((e) => e.span > 0.42).map(({ a, i }) => ({ a, i }));

  const weighted = (list: typeof small, r: Rng): number => {
    let total = 0;
    for (const e of list) total += e.a.weight;
    let v = r() * total;
    for (const e of list) {
      v -= e.a.weight;
      if (v <= 0) return e.i;
    }
    return list[list.length - 1]!.i;
  };

  /** Is (x,z) clear ground at height y, with `r` of elbow room and nothing already claiming it? */
  const free = (x: number, y: number, z: number, r: number, h: number): boolean => {
    for (const [tx, tz, tr] of taken) {
      if (Math.hypot(x - tx, z - tz) < r + tr) return false;
    }
    statics.query(x - r - 0.6, y - 0.1, z - r - 0.6, x + r + 0.6, y + h, z + r + 0.6, scratch);
    return canOccupy(scratch, x, y + 0.02, z, r, h);
  };

  /**
   * Seats one prop and reports the height of its top, or null if it did not fit.
   *
   * `stacked` skips the clearance test: a thing put *on* another thing is deliberately sharing
   * that column, and the physics settles the last centimetre anyway. Without it a pile is a
   * lawn — every member elbowed out to arm's length from every other, which is what "300 props"
   * looked like before and is not what a warehouse floor looks like.
   */
  const place = (
    archIdx: number,
    x: number,
    y: number,
    z: number,
    r: Rng,
    stacked = false,
  ): number | null => {
    const a = ARCHETYPES[archIdx]!;
    const cloud = sampleShape(a.parts, Math.max(a.pitch, 0.08), 1);
    const half = Math.max(cloud.bounds[3]! - cloud.bounds[0]!, cloud.bounds[5]! - cloud.bounds[2]!) / 2;
    const height = cloud.bounds[4]! - cloud.bounds[1]!;
    const lying = a.rest === 'lie' || (a.rest === 'any' && r() < 0.28);
    const radius = lying ? Math.max(half, height / 2) : half;
    if (!stacked && !free(x, y, z, radius + 0.06, lying ? half * 2 : height)) return null;
    if (!stacked) taken.push([x, z, radius + 0.05]);
    const yaw = r() * Math.PI * 2;
    const rot = lying
      ? mul(quat(0, 1, 0, yaw), quat(1, 0, 0, Math.PI / 2))
      : quat(0, 1, 0, yaw);
    // Seated so the lowest point of the shape is a hair above the support.
    const lift = lying ? half + 0.01 : -cloud.bounds[1]! + 0.01;
    out.push({ arch: archIdx, x, y: y + lift, z, rot });
    return y + 0.02 + (lying ? half * 2 : height);
  };

  // --- piles -------------------------------------------------------------
  // A pile is a cluster of footprints *and* a stack on each of them. Both matter: the cluster is
  // what you blunder into, the stack is what comes down when you do.
  for (let n = 0; n < 420 && out.length < cap; n++) {
    const cx = range(rng, -32, 32);
    const cz = range(rng, -22, 22);
    const top = highestTopUnder(statics.boxes, cx, cz, 0.5, -0.5, 2.7);
    const y = top === -Infinity ? 0 : top;
    if (y > 0.05 && rng() < 0.45) continue; // shelves get fewer piles than the floor
    const members = rangeInt(rng, 3, 9);
    let placed = 0;
    for (let k = 0; k < members * 2 && placed < members && out.length < cap; k++) {
      const ang = rng() * Math.PI * 2;
      const rad = Math.sqrt(rng()) * range(rng, 0.35, 1.4);
      const x = cx + Math.cos(ang) * rad;
      const z = cz + Math.sin(ang) * rad;
      if (Math.abs(x) > 32.5 || Math.abs(z) > 22.5) continue;
      const list = rng() < 0.42 ? small : large;
      let level = place(weighted(list, rng), x, y, z, rng);
      if (level === null) continue;
      placed++;
      // Stack on top of what just landed, small things only — a barrel on a bottle is a joke,
      // a can on a barrel is a warehouse.
      let storeys = rangeInt(rng, 0, 3);
      while (storeys-- > 0 && level !== null && level < 2.4 && out.length < cap) {
        const next = place(weighted(small, rng), x + range(rng, -0.06, 0.06), level, z + range(rng, -0.06, 0.06), rng, true);
        if (next === null) break;
        level = next;
        placed++;
      }
    }
  }

  // --- loners: the thing you kick in an aisle you thought was empty -------
  for (let n = 0; n < 900 && out.length < cap; n++) {
    const x = range(rng, -32, 32);
    const z = range(rng, -22, 22);
    const top = highestTopUnder(statics.boxes, x, z, 0.4, -0.5, 2.7);
    const y = top === -Infinity ? 0 : top;
    place(weighted(rng() < 0.45 ? small : large, rng), x, y, z, rng);
  }

  return out;
}

function mul(
  a: { x: number; y: number; z: number; w: number },
  b: { x: number; y: number; z: number; w: number },
): { x: number; y: number; z: number; w: number } {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}
