/**
 * The left hand — M6a "броски".
 *
 * `E` takes the nearest small thing off the floor; `E` again throws it where you are looking.
 * That is the whole feature, and it exists for one reason the human named outright: against a
 * pack that is faster than you, running is not a plan. Throwing is. A can that lands twelve
 * metres away makes its noise *twelve metres away* — a real event, at a real place, on the same
 * bus the spiders listen to — and for a few seconds the swarm is somewhere you are not.
 *
 * Three rules keep it honest, and all three are the concept's rather than mine:
 *
 *  1. **It is the same body.** Picking up does not delete a prop and spawn an "item"; it flips
 *     the existing Rapier body to kinematic and drives it from the hand. Everything that was
 *     true of that can — its mass, its material, its point cloud, the noise it makes — is still
 *     true while you hold it and after you let go. This is also what M7's radio needs: a thing
 *     that keeps sounding in your hand, and keeps sounding on the floor where you put it down.
 *  2. **There is no throw sound.** The flight is physics, the landing is a contact, and the
 *     contact goes through the same impulse formula as every other collision in the game. Search
 *     this file for `emit` and you will not find one.
 *  3. **You cannot pick up what you cannot carry.** A can, yes; a barrel, no. The gate is mass
 *     and longest dimension, both in sliders, both read off the archetype the prop already has —
 *     no per-object "carryable" flag to keep in sync.
 *
 * Determinism: no RNG here at all. Selection is a nearest-first scan in a fixed index order with
 * ties broken by index, the hold pose is a pure function of the camera, and the throw velocity is
 * a constant times the aim. Same inputs, same can, same landing spot, every run.
 */

/** What the carry system needs the world to be able to do. `PropWorld` implements it. */
export interface CarryWorld {
  readonly count: number;
  readonly pos: Float32Array;
  massOf(i: number): number;
  spanOf(i: number): number;
  materialOf(i: number): string | undefined;
  grabProp(i: number): boolean;
  holdProp(i: number, x: number, y: number, z: number, qx: number, qy: number, qz: number, qw: number): void;
  releaseProp(i: number, vx: number, vy: number, vz: number, sx: number, sy: number, sz: number): void;
  isCarried(i: number): boolean;
}

export interface CarryTunables {
  /** How far the hand will reach for something on the floor, metres. */
  reach: number;
  /** Heaviest thing that can be picked up, kilograms. A full paint tin is about the ceiling. */
  maxMass: number;
  /** Longest dimension that still fits in one hand, metres. */
  maxSpan: number;
  /** Where the held thing sits, in camera axes: forward, left, and below the eye. Metres. */
  holdForward: number;
  holdLeft: number;
  holdDrop: number;
  /** Speed the throw imparts, m/s. */
  throwSpeed: number;
  /** Degrees the throw is aimed above the look direction — you lob, you do not fire. */
  throwLoftDeg: number;
  /** Spin given to the thrown thing, rad/s about the camera's right axis. Tumble, not a bullet. */
  throwSpin: number;
  /** Metres in front of the hand the thing is released, so it does not start inside you. */
  releaseAhead: number;
}

export function defaultCarryTunables(): CarryTunables {
  return {
    reach: 2.2,
    maxMass: 6,
    maxSpan: 0.5,
    // Far enough out that a paint tin does not fill a third of the screen, close enough that it
    // is unmistakably *in your hand*: the mirror of where the rifle sits in the right corner.
    holdForward: 0.62,
    holdLeft: 0.34,
    holdDrop: 0.30,
    throwSpeed: 11,
    throwLoftDeg: 7,
    throwSpin: 9,
    releaseAhead: 0.12,
  };
}

export interface CarryState {
  /** Prop index in hand, or -1. */
  held: number;
  /** Material of the thing in hand, for the instrument readout. */
  material: string | undefined;
  /** Mass in hand, kilograms. 0 when empty. */
  mass: number;
  /** Lifetime counters, for the debug overlay and the keyframe checks. */
  picks: number;
  throws: number;
  /** The last throw's launch point and direction — the frame generator asserts on it. */
  lastThrowX: number;
  lastThrowY: number;
  lastThrowZ: number;
}

const DEG = Math.PI / 180;

export class Carry {
  readonly tunables: CarryTunables;
  private held = -1;
  private picks = 0;
  private throws = 0;
  private lastX = 0;
  private lastY = 0;
  private lastZ = 0;
  /** Set when something is picked up or let go: the touch layer has to re-query even standing still. */
  private changed = false;

  constructor(
    private readonly world: CarryWorld,
    tunables: CarryTunables = defaultCarryTunables(),
  ) {
    this.tunables = tunables;
  }

  get holding(): number {
    return this.held;
  }

  get state(): CarryState {
    return {
      held: this.held,
      material: this.held >= 0 ? this.world.materialOf(this.held) : undefined,
      mass: this.held >= 0 ? this.world.massOf(this.held) : 0,
      picks: this.picks,
      throws: this.throws,
      lastThrowX: this.lastX,
      lastThrowY: this.lastY,
      lastThrowZ: this.lastZ,
    };
  }

  /** True once after a pick-up or a throw; clears when read. The touch layer's cue. */
  takeChanged(): boolean {
    const c = this.changed;
    this.changed = false;
    return c;
  }

  /**
   * The nearest thing the hand could take, or -1. Distance is measured from the *feet* column
   * rather than the eye, so a can at your boot is nearer than a bottle at your chin: you are
   * reaching down for it, and a metre of height is not a metre of walking.
   */
  candidate(eyeX: number, eyeY: number, eyeZ: number): number {
    const t = this.tunables;
    const w = this.world;
    let best = -1;
    let bestD = t.reach * t.reach;
    for (let i = 0; i < w.count; i++) {
      if (w.isCarried(i)) continue;
      if (w.massOf(i) > t.maxMass) continue;
      if (w.spanOf(i) > t.maxSpan) continue;
      const dx = w.pos[i * 3]! - eyeX;
      const dy = (w.pos[i * 3 + 1]! - eyeY) * 0.5;
      const dz = w.pos[i * 3 + 2]! - eyeZ;
      const d = dx * dx + dy * dy + dz * dz;
      // Strictly less: ties go to the lower index, so the choice is reproducible.
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  }

  /**
   * One `E`. Empty hand: take the nearest thing that fits. Full hand: throw it. Returns what
   * actually happened, so the caller can report "nothing there" without guessing.
   */
  toggle(
    eyeX: number, eyeY: number, eyeZ: number,
    fx: number, fy: number, fz: number,
    rx: number, ry: number, rz: number,
  ): 'picked' | 'thrown' | 'nothing' {
    if (this.held >= 0) {
      this.throwIt(eyeX, eyeY, eyeZ, fx, fy, fz, rx, ry, rz);
      return 'thrown';
    }
    const i = this.candidate(eyeX, eyeY, eyeZ);
    if (i < 0) return 'nothing';
    if (!this.world.grabProp(i)) return 'nothing';
    this.held = i;
    this.picks++;
    this.changed = true;
    return 'picked';
  }

  /** Where the held thing is this tick. Pure function of the camera — no smoothing, no springs. */
  private handPose(
    eyeX: number, eyeY: number, eyeZ: number,
    fx: number, fy: number, fz: number,
    rx: number, ry: number, rz: number,
  ): [number, number, number] {
    const t = this.tunables;
    return [
      eyeX + fx * t.holdForward - rx * t.holdLeft,
      eyeY + fy * t.holdForward - ry * t.holdLeft - t.holdDrop,
      eyeZ + fz * t.holdForward - rz * t.holdLeft,
    ];
  }

  /**
   * Drives the held body. Called every tick *before* physics steps, with the camera basis; the
   * orientation is left as identity because a can does not need a pose in your fist and giving
   * it one only makes it clip through the rifle.
   */
  update(
    eyeX: number, eyeY: number, eyeZ: number,
    fx: number, fy: number, fz: number,
    rx: number, ry: number, rz: number,
  ): void {
    if (this.held < 0) return;
    const [hx, hy, hz] = this.handPose(eyeX, eyeY, eyeZ, fx, fy, fz, rx, ry, rz);
    this.world.holdProp(this.held, hx, hy, hz, 0, 0, 0, 1);
  }

  private throwIt(
    eyeX: number, eyeY: number, eyeZ: number,
    fx: number, fy: number, fz: number,
    rx: number, ry: number, rz: number,
  ): void {
    const t = this.tunables;
    const i = this.held;
    const [hx, hy, hz] = this.handPose(eyeX, eyeY, eyeZ, fx, fy, fz, rx, ry, rz);
    // Loft: rotate the aim up about the camera's own right axis, so looking straight ahead still
    // produces an arc rather than a flat line that lands under the nearest shelf.
    const a = t.throwLoftDeg * DEG;
    const c = Math.cos(a);
    const s = Math.sin(a);
    // Rodrigues about `r`, for the special case of a unit axis perpendicular to `f`.
    const ux = ry * fz - rz * fy;
    const uy = rz * fx - rx * fz;
    const uz = rx * fy - ry * fx;
    const dx = fx * c + ux * s;
    const dy = fy * c + uy * s;
    const dz = fz * c + uz * s;
    const len = Math.hypot(dx, dy, dz) || 1;
    this.lastX = hx + (dx / len) * t.releaseAhead;
    this.lastY = hy + (dy / len) * t.releaseAhead;
    this.lastZ = hz + (dz / len) * t.releaseAhead;
    this.world.holdProp(i, this.lastX, this.lastY, this.lastZ, 0, 0, 0, 1);
    this.world.releaseProp(
      i,
      (dx / len) * t.throwSpeed, (dy / len) * t.throwSpeed, (dz / len) * t.throwSpeed,
      rx * t.throwSpin, ry * t.throwSpin, rz * t.throwSpin,
    );
    this.held = -1;
    this.throws++;
    this.changed = true;
  }

  /**
   * Drops whatever is in hand where it stands, with no velocity. The player teleporting (respawn,
   * and the harness's `pose`) must not drag a can through half the hall on a kinematic leash.
   */
  dropInPlace(): void {
    if (this.held < 0) return;
    this.world.releaseProp(this.held, 0, 0, 0, 0, 0, 0);
    this.held = -1;
    this.changed = true;
  }
}
