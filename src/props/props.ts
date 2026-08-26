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
  colliderBounds,
  colliderPrims,
  sampleShape,
  shapeEdges,
  shapeSpan,
  type EdgeSet,
  type PointCloud,
} from './shapes';

export type Rapier = typeof RAPIER;

/** Reused so setting a body still does not allocate a vector a thousand times a second. */
const ZERO = { x: 0, y: 0, z: 0 };

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
   * How much of a body's own weight a contact has to exceed before it counts as an impact.
   * A prop standing on the floor pushes back with mg for ever, and mg for a barrel is several
   * hundred newtons, so support has to be subtracted before what is left can be called a bang.
   *
   * This used to be set high, as a blunt way of drowning out a hall full of bodies that never
   * settled. It no longer has that job — an untouched hall now has nothing awake in it at all,
   * and a sleeping body raises no contact events whatsoever — so it is back to being what it
   * should be: the line between "held up" and "hit", and nothing more. Measured both ways: the
   * idle hall stays at exactly zero events at any setting of this, while real collisions get
   * noticeably more of a voice.
   */
  weightSlack: number;
  /**
   * Metres per second the body must have been moving on the previous tick for a contact to be a
   * collision. The solver has already killed the velocity by the time the force event is read,
   * so the speed is remembered one tick back.
   */
  impactSpeed: number;
  /**
   * Speed, m/s, below which a body counts as at rest — applied both to how fast it is going and
   * to how fast its own surface is moving under it from spin.
   *
   * The second half matters more than the first. A bottle or a pipe lying on its side *rolls*,
   * at four centimetres a second, for ever: Rapier models no rolling friction, and a cylinder on
   * a plane has nothing else to stop it. That, and not stack jitter, is what most of the
   * never-sleeping bodies turned out to be — an idle hall of 1100 props had 25 of them quietly
   * touring the floor, waking neighbours as they went.
   *
   * Ten centimetres a second is below anything a player can perceive in the dark, and it is what
   * real junk on real concrete does anyway.
   */
  stillSpeed: number;
  /**
   * Seconds a body has to stay under that before stiction takes hold.
   *
   * Short, because it only has to outlast a transient: one tick of gravity already puts a
   * genuinely falling body far above the threshold, so nothing is frozen in mid-air.
   */
  stillTime: number;
  /** Air drag on every prop, per second. The concept's "трение с воздухом": nothing rolls for ever. */
  linearDamping: number;
  angularDamping: number;
  /**
   * How many props the hall gets. The concept wants a *lot* of junk, and the ceiling on that is
   * not physics — Rapier sleeps everything that is not moving — but the lidar mask: every prop
   * carries a few hundred points, and those points are uploaded, aged and drawn. See the report
   * for the frame-budget measurement this number came out of.
   */
  cap: number;
}

export function defaultPropTunables(): PropTunables {
  return {
    hz: 60,
    quietForce: 90,
    forcePerMetre: 26,
    maxLoudness: 34,
    perBodyGap: 0.055,
    weightSlack: 0.5,
    impactSpeed: 0.22,
    stillSpeed: 0.1,
    stillTime: 0.15,
    linearDamping: 0.45,
    angularDamping: 1.1,
    cap: 1100,
  };
}

/**
 * Minimum contact force worth asking Rapier to report for a body of `weightN` newtons.
 *
 * A fixed 90 N floor silently erased a hard-thrown 128 g can: its whole landing peaked at only
 * 38 N. Heavy bodies retain the old 90 N floor; only sub-kilogram props scale down, and the
 * existing speed/weight/loudness gates still reject resting support and powerless taps.
 */
export function impactForceThreshold(weightN: number, t: PropTunables): number {
  return Math.min(t.quietForce, Math.max(t.quietForce * 0.1, Math.max(0, weightN) * 8));
}

export interface PropStats {
  bodies: number;
  awake: number;
  asleep: number;
  /** Sound events emitted by props since the start. */
  impacts: number;
  /** Props caught falling out of the world and put back where the layout meant them to be. */
  rescued: number;
  /** Ticks on which stiction took a body's residual crawl away. Debug: how load-bearing it is. */
  stuck: number;
  stepMs: number;
  points: number;
  /** Contact-force callbacks seen since settle; gate counters explain why a body stayed silent. */
  contacts: number;
  rejectedForce: number;
  rejectedWeight: number;
  rejectedSpeed: number;
  rejectedGap: number;
  rejectedLoudness: number;
  maxForce: number;
}

/**
 * Deterministic layout injection for focused physics/keyframe scenarios. Production omits it and
 * keeps the procedural layout; a scenario can name exact archetype ids without searching a
 * random warehouse through the gameplay selector.
 */
export interface PropPlacement {
  readonly arch: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly rot?: { readonly x: number; readonly y: number; readonly z: number; readonly w: number };
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
  /** Speed on the previous tick, and the body's own weight in newtons — the two impact gates. */
  private readonly prevSpeed: Float32Array;
  /** Seconds each body has been below the rest threshold. Reset by any real motion. */
  private readonly stillFor: Float32Array;
  /** Horizontal half-extent of each body, metres — the lever arm that turns spin into rolling. */
  private readonly rollRadius: Float32Array;
  /** How many times a body has fallen out of the world. Three strikes and it is furniture. */
  private readonly rescues: Uint8Array;
  private readonly weight: Float32Array;
  /** Where each prop was laid out, so one that falls out of the world can be put back. */
  private readonly spawn: Float32Array;
  private readonly spawnRot: Float32Array;
  private player: RAPIER.RigidBody | null = null;
  private rifle: RAPIER.RigidBody | null = null;
  private accumulator = 0;
  private time = 0;
  private stats: PropStats = {
    bodies: 0, awake: 0, asleep: 0, impacts: 0, rescued: 0, stuck: 0, stepMs: 0, points: 0,
    contacts: 0, rejectedForce: 0, rejectedWeight: 0, rejectedSpeed: 0, rejectedGap: 0,
    rejectedLoudness: 0, maxForce: 0,
  };
  private readonly vec: RAPIER.Vector3;

  constructor(
    private readonly R: Rapier,
    statics: StaticWorld,
    private readonly bus: SoundBus,
    seed: number,
    tunables: PropTunables = defaultPropTunables(),
    placements?: readonly PropPlacement[],
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

    /*
     * The ground. The hall has no floor *box* — the player's collider treats y = 0 as ground
     * implicitly — so Rapier had nothing under the open floor at all, and every prop that was
     * not standing on a shelf fell for ever. One fifth of the clutter was several hundred metres
     * below the hall and still accelerating, which is also where the permanent fog of sound
     * markers came from: a body in free fall never sleeps.
     */
    {
      let half = 40;
      for (const b of statics.boxes) {
        half = Math.max(half, Math.abs(b.minX), Math.abs(b.maxX), Math.abs(b.minZ), Math.abs(b.maxZ));
      }
      half += 20;
      const ground = this.world.createRigidBody(R.RigidBodyDesc.fixed().setTranslation(0, -0.5, 0));
      this.world.createCollider(R.ColliderDesc.cuboid(half, 0.5, half).setFriction(0.8), ground);
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
    const spots: Spot[] = placements === undefined
      ? layout(statics, seed, tunables.cap)
      : placements.map((p) => ({
          arch: p.arch,
          x: p.x,
          y: p.y,
          z: p.z,
          rot: p.rot ?? { x: 0, y: 0, z: 0, w: 1 },
          radius: 0,
        }));
    this.count = spots.length;
    this.arch = new Int32Array(this.count);
    this.pos = new Float32Array(this.count * 3);
    this.quat = new Float32Array(this.count * 4);
    this.moving = new Uint8Array(this.count);
    this.settleAt = new Float32Array(this.count);
    this.lastSound = new Float32Array(this.count);
    this.prevSpeed = new Float32Array(this.count);
    this.stillFor = new Float32Array(this.count);
    this.rollRadius = new Float32Array(this.count);
    this.rescues = new Uint8Array(this.count);
    this.weight = new Float32Array(this.count);
    this.spawn = new Float32Array(this.count * 3);
    this.spawnRot = new Float32Array(this.count * 4);
    let points = 0;

    for (let i = 0; i < spots.length; i++) {
      const s = spots[i]!;
      this.arch[i] = s.arch;
      this.spawn[i * 3] = s.x;
      this.spawn[i * 3 + 1] = s.y;
      this.spawn[i * 3 + 2] = s.z;
      this.spawnRot[i * 4] = s.rot.x;
      this.spawnRot[i * 4 + 1] = s.rot.y;
      this.spawnRot[i * 4 + 2] = s.rot.z;
      this.spawnRot[i * 4 + 3] = s.rot.w;
      points += this.clouds[s.arch]!.count;
      const a = ARCHETYPES[s.arch]!;
      const mat = MATERIALS[a.material];
      const body = this.world.createRigidBody(
        R.RigidBodyDesc.dynamic()
          .setTranslation(s.x, s.y, s.z)
          .setRotation(s.rot)
          // Air drag. Enough that a bottle knocked over rolls a metre and stops, instead of
          // rolling for the rest of the session: an awake body is solver time, mask expiry and
          // an ear-catching event, all for a bottle nobody is looking at.
          .setLinearDamping(tunables.linearDamping)
          .setAngularDamping(tunables.angularDamping),
      );
      for (const prim of colliderPrims(a.parts)) {
        let desc: RAPIER.ColliderDesc;
        if (prim.kind === 'box') {
          desc = R.ColliderDesc.cuboid(prim.hx, prim.hy, prim.hz);
        } else if (prim.kind === 'ball') {
          desc = R.ColliderDesc.ball(prim.r);
        } else {
          desc = R.ColliderDesc.cylinder(prim.hh, prim.r);
        }
        desc.setTranslation(prim.cx, prim.cy, prim.cz);
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
      // Weight in newtons, cached once: the contact that merely holds this thing up is not sound.
      this.weight[i] = body.mass() * 9.81;
      // Contact events need the same mass-aware entrance gate as `drain`. Setting the old fixed
      // 90 N threshold here meant the light can's real 38 N impact never reached our code at all.
      const eventThreshold = impactForceThreshold(this.weight[i]!, tunables);
      for (let c = 0; c < body.numColliders(); c++) {
        body.collider(c).setContactForceEventThreshold(eventThreshold);
      }
      const cb = colliderBounds(a.parts);
      // Mean half-extent: the lever arm that turns a body's spin into speed at its own surface.
      this.rollRadius[i] = ((cb[3]! - cb[0]!) + (cb[4]! - cb[1]!) + (cb[5]! - cb[2]!)) / 6;
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
      // Speed *before* the solve. Afterwards an impact and a resting body look identical: the
      // solver has taken the velocity away in both cases, which is what an impact is.
      this.rememberSpeeds();
      this.world.step(this.queue);
      this.accumulator -= h;
      steps++;
      this.drain();
    }
    if (steps > 0) this.readBack();
    this.stats.stepMs = performance.now() - t0;
  }

  /**
   * One pass over the awake bodies: remembers the pre-solve speed, and puts to sleep anything
   * that has stopped moving in any way that matters.
   *
   * Sleep is architecture here, not an optimisation — a sleeping prop costs no solver time, no
   * mask expiry and no sound. But a quarter of a thousand-prop pile never reached Rapier's own
   * sleep threshold: junk leaning on junk keeps trading millimetres for ever, which showed up
   * as a permanent fog of sound markers over a hall where nothing was happening. Half a second
   * under six centimetres a second is not motion, whatever the solver still has to say about it.
   */
  private rememberSpeeds(): void {
    const t = this.tunables;
    const h = 1 / t.hz;
    for (let i = 0; i < this.count; i++) {
      const b = this.bodies[i]!;
      /*
       * Rescue. A prop that spawns interpenetrating a rack can be ejected downwards hard enough
       * to end up *inside* the ground slab, and a body fully buried in a big convex shape stops
       * generating contacts with it — so it falls for ever, awake for ever, chirping for ever.
       * A tenth of the clutter did exactly that. Put it back where the layout meant it to be,
       * still, and asleep: if it lands badly a second time it lands badly asleep, which is
       * invisible and free, and anything that touches it later wakes it normally.
       */
      if (b.translation().y < -0.4) {
        /*
         * placeholder
         */
        this.rescues[i]! = Math.min(255, this.rescues[i]! + 1);
        this.vec.x = this.spawn[i * 3]!;
        this.vec.y = this.spawn[i * 3 + 1]!;
        this.vec.z = this.spawn[i * 3 + 2]!;
        b.setTranslation(this.vec, false);
        b.setRotation(
          {
            x: this.spawnRot[i * 4]!,
            y: this.spawnRot[i * 4 + 1]!,
            z: this.spawnRot[i * 4 + 2]!,
            w: this.spawnRot[i * 4 + 3]!,
          },
          false,
        );
        b.setLinvel({ x: 0, y: 0, z: 0 }, false);
        b.setAngvel({ x: 0, y: 0, z: 0 }, false);
        b.sleep();
        this.prevSpeed[i] = 0;
        this.stillFor[i] = 0;
        this.stats.rescued++;
        continue;
      }
      if (b.isSleeping()) {
        this.prevSpeed[i] = 0;
        this.stillFor[i] = 0;
        continue;
      }
      const v = b.linvel();
      const w = b.angvel();
      const speed = Math.hypot(v.x, v.y, v.z);
      this.prevSpeed[i] = speed;
      /*
       * Stiction — the reason an untouched hall is now actually silent.
       *
       * Two things kept a hundred and fifty bodies awake for ever. Junk leaning on junk trades
       * millimetres between its members and never satisfies Rapier's own sleep test; and a
       * bottle or a pipe lying on its side *rolls*, at a few centimetres a second, for the rest
       * of the session, because a cylinder on a plane has no rolling friction and Rapier does
       * not model any. Both are below anything a player could see. Both are live contacts, and
       * a live contact can cross the loudness threshold — which is where "something keeps
       * clattering in the distance in an empty hall" came from.
       *
       * The obvious fix, calling `sleep()` on such a body, is a trap and was measured to be one:
       * a sleeping body is infinite mass to the neighbour still leaning on it, so the contact
       * force spikes on the very next step — more sound events, not fewer, and enough positional
       * correction to fire props through the floor. Rescues went from 13 to 81.
       *
       * So instead of overruling the engine, the body is simply given the static friction that
       * real junk on a real concrete floor has: below the threshold, its velocity is taken away
       * rather than damped. Rapier then sees a body that is not moving and sleeps it itself —
       * as a whole contact island, at its own pace, with no impulse anywhere.
       */
      const roll = Math.hypot(w.x, w.y, w.z) * this.rollRadius[i]!;
      if (speed < t.stillSpeed && roll < t.stillSpeed) {
        this.stillFor[i]! += h;
        if (this.stillFor[i]! >= t.stillTime) {
          b.setLinvel(ZERO, false);
          b.setAngvel(ZERO, false);
          this.prevSpeed[i] = 0;
          this.stats.stuck++;
        }
      } else {
        this.stillFor[i] = 0;
      }
    }
  }

  /** Contact forces -> loudness in metres -> the one bus. This is the whole "sound from physics". */
  private drain(): void {
    const t = this.tunables;
    this.queue.drainContactForceEvents((e) => {
      const force = e.totalForceMagnitude();
      this.stats.contacts++;
      this.stats.maxForce = Math.max(this.stats.maxForce, force);
      /*
       * Both sides of the contact, not just whichever Rapier happened to list first. The gates
       * below ask "was this body moving a tick ago", so attributing a barrel landing on a
       * standing can to the *can* silently threw the impact away — and which of the two ends up
       * as `collider1` is an implementation detail of the broad phase. The louder story is the
       * one that was moving, so that is the body the event is filed under.
       */
      const a = this.byCollider.get(e.collider1());
      const b = this.byCollider.get(e.collider2());
      let i: number | undefined;
      if (a === undefined) i = b;
      else if (b === undefined) i = a;
      else i = this.prevSpeed[a]! >= this.prevSpeed[b]! ? a : b;
      if (i === undefined) return;
      const forceThreshold = impactForceThreshold(this.weight[i]!, t);
      if (force < forceThreshold) {
        this.stats.rejectedForce++;
        return;
      }
      /*
       * Two gates, and both of them exist because of one frame: with an absolute force threshold
       * alone the whole hall drew a permanent fog of sound markers over a thousand props that
       * were standing perfectly still. A resting body's contact carries its own weight for ever,
       * and a barrel weighs far more newtons than any threshold worth setting for a dropped can.
       *
       *   - the contact has to exceed the body's own weight by a margin, so support is not sound;
       *   - the body has to have been moving a tick ago, so only a *collision* speaks.
       *
       * The floor of the loudness scale then subtracts the weight too: what is heard is the part
       * of the force that the fall put there, not the part gravity was always paying.
       */
      const floor = forceThreshold + this.weight[i]! * t.weightSlack;
      if (force < floor) {
        this.stats.rejectedWeight++;
        return;
      }
      if (this.prevSpeed[i]! < t.impactSpeed) {
        this.stats.rejectedSpeed++;
        return;
      }
      if (this.time - this.lastSound[i]! < t.perBodyGap) {
        this.stats.rejectedGap++;
        return;
      }
      this.lastSound[i] = this.time;
      const mat = MATERIALS[ARCHETYPES[this.arch[i]!]!.material];
      // Loudness in metres of notice, from the impulse and nothing else. Square-root because
      // the ear is not linear in energy and neither is a spider's attention.
      const loud = Math.min(
        t.maxLoudness,
        Math.sqrt((force - floor) / t.forcePerMetre) * 4.2 * mat.gain,
      );
      if (loud < 0.6) {
        this.stats.rejectedLoudness++;
        return;
      }
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
   * Run the world blind until it stops moving, then declare that its resting state.
   *
   * The layout seats every prop a clean five millimetres above its support, so the first fraction
   * of a second of the world is a rain of small settling taps. Nobody should hear that and no
   * keyframe should catch it, so this steps the simulation with the event queue discarded until
   * the last body has fallen asleep — usually well under a second of simulated time — and then
   * pins the result: every body still, asleep, `settleAt` rewound to zero, and the impact counter
   * back at nought. That last part is what makes a scan of untouched clutter permanent rather
   * than a three-second ghost.
   *
   * The budget is a guard, not a target: if the hall has not gone quiet in `maxSeconds` of
   * simulated time something is wrong with the layout, and it is better to know that from the
   * stats than to hang the loading screen.
   */
  settle(maxSeconds = 6): void {
    const steps = Math.round(maxSeconds * this.tunables.hz);
    for (let n = 0; n < steps; n++) {
      this.rememberSpeeds();
      this.world.step(this.queue);
      // Sound born before the world exists is not sound.
      this.queue.clear();
      let awake = 0;
      for (let i = 0; i < this.count; i++) if (!this.bodies[i]!.isSleeping()) awake++;
      if (awake === 0) break;
    }
    for (let i = 0; i < this.count; i++) {
      const b = this.bodies[i]!;
      b.setLinvel(ZERO, false);
      b.setAngvel(ZERO, false);
      b.sleep();
      this.moving[i] = 0;
      this.settleAt[i] = 0;
      this.lastSound[i] = 0;
      this.stillFor[i] = 0;
      this.rescues[i] = 0;
    }
    this.accumulator = 0;
    this.readBack();
    this.stats.impacts = 0;
    this.stats.stuck = 0;
    this.stats.rescued = 0;
    this.stats.contacts = 0;
    this.stats.rejectedForce = 0;
    this.stats.rejectedWeight = 0;
    this.stats.rejectedSpeed = 0;
    this.stats.rejectedGap = 0;
    this.stats.rejectedLoudness = 0;
    this.stats.maxForce = 0;
    this.queue.clear();
  }


  /**
   * A hitscan against everything solid in the hall, for the rifle (M3).
   *
   * The rifle does not get its own geometry query. Rapier's world here already holds the whole
   * truth — the hall's static boxes, the ground plane, and every one of the ~1100 dynamic props —
   * so a bullet asking "what is in front of me" and a prop asking "what am I resting on" are the
   * same question asked of the same structure. A second, parallel raycaster over the AABB world
   * would have been a second truth, and the two would have drifted the first time a crate was
   * knocked over.
   *
   * The player's own capsule and the rifle's barrel box sit in that world too, and both are
   * inside the muzzle. They are filtered out by predicate rather than by nudging the ray origin
   * forward: an origin far enough ahead to clear the barrel is also far enough to shoot through
   * a shelf the muzzle is pressed against.
   *
   * Returns the impact point in world space, the surface normal, the distance travelled and the
   * prop index if a prop was hit (undefined for hall geometry — walls do not fly away).
   */
  raycast(
    ox: number, oy: number, oz: number,
    dx: number, dy: number, dz: number,
    maxDistance: number,
  ): { x: number; y: number; z: number; nx: number; ny: number; nz: number; distance: number; prop: number } | null {
    const R = this.R;
    const ray = new R.Ray({ x: ox, y: oy, z: oz }, { x: dx, y: dy, z: dz });
    const playerHandle = this.player === null ? -1 : this.player.handle;
    const rifleHandle = this.rifle === null ? -1 : this.rifle.handle;
    const hit = this.world.castRayAndGetNormal(
      ray, maxDistance, true, undefined, undefined, undefined, undefined,
      (c: RAPIER.Collider) => {
        const parent = c.parent();
        if (parent === null) return true;
        return parent.handle !== playerHandle && parent.handle !== rifleHandle;
      },
    );
    if (hit === null) return null;
    const d = hit.timeOfImpact;
    const prop = this.byCollider.get(hit.collider.handle) ?? -1;
    return {
      x: ox + dx * d,
      y: oy + dy * d,
      z: oz + dz * d,
      nx: hit.normal.x,
      ny: hit.normal.y,
      nz: hit.normal.z,
      distance: d,
      prop,
    };
  }

  /**
   * Concept: "пули расшвыривают лёгкие предметы". An impulse at a point, so a can takes the hit
   * on its rim and spins, rather than sliding away flat — the shot has to *look* like it landed.
   *
   * Impulse, not force: the bullet is gone within the tick, and the prop's own mass decides what
   * that means. The same round throws a plastic bottle across the aisle and barely rocks a steel
   * drum, out of the densities the archetypes already carry, with no per-object tuning.
   */
  pushProp(i: number, x: number, y: number, z: number, ix: number, iy: number, iz: number): void {
    if (i < 0 || i >= this.count) return;
    const b = this.bodies[i]!;
    b.wakeUp();
    b.applyImpulseAtPoint({ x: ix, y: iy, z: iz }, { x, y, z }, true);
  }

  /** Mass of a prop, kilograms. The gate for "банка да, бочка нет". */
  massOf(i: number): number {
    if (i < 0 || i >= this.count) return Infinity;
    return this.weight[i]! / 9.81;
  }

  /** Longest dimension of a prop's shape, metres. The other half of that gate. */
  spanOf(i: number): number {
    if (i < 0 || i >= this.count) return Infinity;
    return shapeSpan(ARCHETYPES[this.arch[i]!]!.parts);
  }

  /**
   * Picks a body up (M6a). It stays the same body in the same world with the same colliders —
   * this is the whole point: a carried thing is not a UI item, it is a prop you happen to be
   * driving. Only its type changes, to kinematic, exactly like the player and the rifle: it
   * shoves the world and the world does not shove it, so a can in your fist cannot be knocked
   * out of it by a shelf.
   *
   * Everything downstream keeps working unchanged, which is what the radio in M7 needs: whatever
   * makes noise about prop `i` goes on making it, from wherever the hand is.
   */
  grabProp(i: number): boolean {
    if (i < 0 || i >= this.count) return false;
    const b = this.bodies[i]!;
    if (b.bodyType() !== this.R.RigidBodyType.Dynamic) return false;
    b.setBodyType(this.R.RigidBodyType.KinematicPositionBased, true);
    return true;
  }

  /** Drives a carried body. Called once per tick with wherever the hand is. */
  holdProp(i: number, x: number, y: number, z: number, qx: number, qy: number, qz: number, qw: number): void {
    if (i < 0 || i >= this.count) return;
    const b = this.bodies[i]!;
    if (b.bodyType() === this.R.RigidBodyType.Dynamic) return;
    this.vec.x = x;
    this.vec.y = y;
    this.vec.z = z;
    b.setNextKinematicTranslation(this.vec);
    b.setNextKinematicRotation({ x: qx, y: qy, z: qz, w: qw });
  }

  /**
   * Lets go, with a velocity. Dynamic again from this tick on, so everything after the release —
   * the arc, the bounce, the noise where it lands — is ordinary physics and the ordinary impulse
   * formula. There is deliberately no "throw sound": the only noise a throw makes is the one the
   * can makes when it arrives.
   */
  releaseProp(i: number, vx: number, vy: number, vz: number, sx: number, sy: number, sz: number): void {
    if (i < 0 || i >= this.count) return;
    const b = this.bodies[i]!;
    b.setBodyType(this.R.RigidBodyType.Dynamic, true);
    b.setLinvel({ x: vx, y: vy, z: vz }, true);
    b.setAngvel({ x: sx, y: sy, z: sz }, true);
    b.wakeUp();
  }

  /** True while prop `i` is being carried. */
  isCarried(i: number): boolean {
    if (i < 0 || i >= this.count) return false;
    return this.bodies[i]!.bodyType() !== this.R.RigidBodyType.Dynamic;
  }

  /** Material name of a prop, so a bullet hit can be reported as hitting steel rather than air. */
  materialOf(i: number): string | undefined {
    if (i < 0 || i >= this.count) return undefined;
    return MATERIALS[ARCHETYPES[this.arch[i]!]!.material].name;
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
  /** Footprint radius of the seated body — what a thing stacked on top has to fit inside. */
  radius: number;
}

/**
 * Gap left between a prop's lowest collider point and whatever holds it up, metres.
 *
 * Small enough that the drop is inaudible and invisible, big enough that no prop in the hall
 * begins its life inside another one. Zero would be better still, but floating-point placement
 * against a solver that treats a millimetre of overlap as a shove is not worth the risk.
 */
const CLEARANCE = 0.005;

/** Worst-case footprint radius of a shape over every yaw — what it needs to sit on something. */
function seatRadius(b: readonly number[]): number {
  return Math.max(
    Math.hypot(b[0]!, b[2]!), Math.hypot(b[3]!, b[2]!),
    Math.hypot(b[0]!, b[5]!), Math.hypot(b[3]!, b[5]!),
  );
}

/** The AABB `b`, rotated by quaternion `q` and re-bounded. Corners, because eight is cheap. */
function rotateBounds(
  b: readonly number[],
  q: { x: number; y: number; z: number; w: number },
): [number, number, number, number, number, number] {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let c = 0; c < 8; c++) {
    const x = c & 1 ? b[3]! : b[0]!;
    const y = c & 2 ? b[4]! : b[1]!;
    const z = c & 4 ? b[5]! : b[2]!;
    // q * v * q^-1, written out.
    const ix = q.w * x + q.y * z - q.z * y;
    const iy = q.w * y + q.z * x - q.x * z;
    const iz = q.w * z + q.x * y - q.y * x;
    const iw = -q.x * x - q.y * y - q.z * z;
    const rx = ix * q.w + iw * -q.x + iy * -q.z - iz * -q.y;
    const ry = iy * q.w + iw * -q.y + iz * -q.x - ix * -q.z;
    const rz = iz * q.w + iw * -q.z + ix * -q.y - iy * -q.x;
    minX = Math.min(minX, rx); maxX = Math.max(maxX, rx);
    minY = Math.min(minY, ry); maxY = Math.max(maxY, ry);
    minZ = Math.min(minZ, rz); maxZ = Math.max(maxZ, rz);
  }
  return [minX, minY, minZ, maxX, maxY, maxZ];
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

  // Collider bounds, once per archetype. Placement used to re-sample a whole point cloud for
  // every candidate spot — thousands of times, for a measurement it then got wrong.
  const bounds = ARCHETYPES.map((a) => colliderBounds(a.parts));

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
    return clearOfStatics(x, y, z, r, h);
  };

  /** Does a cylinder of radius `r` and height `h` standing at (x,y,z) miss every static box? */
  const clearOfStatics = (x: number, y: number, z: number, r: number, h: number): boolean => {
    statics.query(x - r - 0.6, y - 0.1, z - r - 0.6, x + r + 0.6, y + h, z + r + 0.6, scratch);
    return canOccupy(scratch, x, y + 0.02, z, r, h);
  };

  /**
   * Seats one prop and reports the world height of the top of its colliders, or null if it did
   * not fit.
   *
   * Everything here is measured off the *colliders*, rotated the way the body will actually be
   * rotated, and seated a clean 5 mm above its support. That sounds fussy; it is the whole fix.
   * Seating a prop by its point cloud put it centimetres into the floor, and a thousand bodies
   * that start the session interpenetrating are a thousand bodies the solver is still pushing
   * apart a minute later — which is what the hall's phantom background clatter was.
   *
   * `stacked` skips the elbow-room test against neighbours: a thing put *on* another thing is
   * deliberately sharing that column. It does not skip the test against static geometry, because
   * a stack growing up through a shelf is exactly the kind of buried contact that never settles.
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
    const b = bounds[archIdx]!;
    const lying = a.rest === 'lie' || (a.rest === 'any' && r() < 0.28);
    const yaw = r() * Math.PI * 2;
    const rot = lying
      ? mul(quat(0, 1, 0, yaw), quat(1, 0, 0, Math.PI / 2))
      : quat(0, 1, 0, yaw);
    const rb = rotateBounds(b, rot);
    const radius = Math.max(rb[3]! - rb[0]!, rb[5]! - rb[2]!) / 2;
    const height = rb[4]! - rb[1]!;
    if (stacked) {
      if (!clearOfStatics(x, y, z, radius, height)) return null;
    } else {
      if (!free(x, y, z, radius + 0.06, height)) return null;
      taken.push([x, z, radius + 0.05]);
    }
    // Seated so the lowest point of the *colliders* is CLEARANCE above the support: touching,
    // not overlapping. The settle pass at startup closes the gap in silence.
    const lift = -rb[1]! + CLEARANCE;
    out.push({ arch: archIdx, x, y: y + lift, z, rot, radius });
    return y + lift + rb[4]!;
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
      let support = out[out.length - 1]!;
      // Stack on top of what just landed, small things only — a barrel on a bottle is a joke,
      // a can on a barrel is a warehouse.
      //
      // The upper storey has to *fit* on the one below, and its offset has to stay inside the
      // support's footprint. A can balanced half off the edge of a bottle is not a stack, it is
      // a body that spends the session slowly toppling, waking its neighbours and chirping.
      let storeys = rangeInt(rng, 0, 3);
      while (storeys-- > 0 && level !== null && level < 2.4 && out.length < cap) {
        const archIdx = weighted(small, rng);
        const seat = seatRadius(bounds[archIdx]!);
        if (seat > support.radius * 0.95) break;
        const slack = Math.max(0, support.radius - seat) * 0.6;
        const next = place(
          archIdx,
          support.x + range(rng, -slack, slack),
          level,
          support.z + range(rng, -slack, slack),
          rng,
          true,
        );
        if (next === null) break;
        level = next;
        support = out[out.length - 1]!;
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
