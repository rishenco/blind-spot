/**
 * Resting prints — the matter layer for things that are not part of the level.
 *
 * ## The rule, and where it comes from
 *
 * **An object in motion is an event; an object at rest is geometry.** Vision §3.2 already splits
 * the world exactly this way — the event layer answers "what just happened", the matter layer
 * answers "what is there" — and a can that has stopped rolling is unambiguously *there*. So a
 * settled thing lays a **print**: a cairn of matter-layer dots at its true pose, on the standard
 * age ramp, cooling into the same permanent memory skeleton as every wall (§3.6).
 *
 * It is not a marker and it must never become one. Three properties are what keep it lawful:
 *
 *  - **It is bought with a sound.** A print is stamped by exactly the same predicate that stamps
 *    the wall behind it: an event you can hear (`SoundBus.canHear`, applied one layer up in
 *    `paintSystem.ts`) whose paint radius reaches it. The settling clink is usually the first
 *    such event, but nothing here knows that — a can spawned into a room and never heard has a
 *    print that has never been stamped, and is therefore nowhere. Law 1 pays for it or it does
 *    not exist.
 *  - **It cools.** Ice-white, cyan, navy, then the ~0.22 alpha skeleton, on the *shared* dot
 *    material — literally the same `ShaderMaterial` instance the lattice draws with, so the ramp,
 *    the §3.6 draw window and every dev-panel slider that moves them reach a print without this
 *    file restating any of it. A cold cairn in a dark room is genuinely hard to spot, which is
 *    correct: re-reading it costs another sound.
 *  - **It is cyan-family, always.** §3.2 forbids painted geometry from taking its source's
 *    colour, so the encoding is **form**: six dots on a tight ring plus a bigger one at the
 *    centre, locally denser than any lattice patch can be (`StructuredTunables.spacing` is
 *    0.18 m and a can is 0.12 m across). Same band, same ramp, unmistakably a *placed thing*
 *    rather than floor.
 *
 * ## Why not the lattice, and why not a ghost
 *
 * Not the lattice, because the lattice is built once off the collider list and a can moves: paint
 * left lying where a can no longer is would be the system drawing geometry that is not there
 * (law 2), and the reveal has no cheap way to retract it. Not a §3.7 ghost, because a ghost
 * *dissolves* — correct for a photograph of something that can walk away, wrong for a can, which
 * cannot. Dissolving it would mean paying a ping to find your own equipment on every retrieval,
 * which prices the throw out of the game.
 *
 * ## What this file knows about cans
 *
 * Nothing. A print is a pose and a radius; `game/throwables.ts` supplies both. The next thing
 * that rests somewhere — a dropped artifact, a spider's kill — lays one the same way.
 */

import * as THREE from 'three';
import {
  NEVER_HEARD,
  displayedAge,
  smoothstep,
  type StructuredPaint,
} from './structured';
import type { SoundEvent } from './soundEvents';

/**
 * Dots in one cairn: a ring of six plus the centre.
 *
 * Six is the smallest ring that reads as a ring rather than as a triangle or a smear, and the
 * whole glyph is still one seventh of the cost of the lattice patch it sits on. §3's prepared
 * fallback if playtests call the cairn camouflage is to raise this and `CENTRE_SCALE` — never to
 * give it a hue, and never to let it outlive its ramp.
 */
export const PRINT_RING_DOTS = 6;
export const PRINT_DOTS = PRINT_RING_DOTS + 1;

/** How much larger the centre dot is than a lattice dot. Form, not hue — see the header. */
export const CENTRE_SCALE = 1.5;

/**
 * The per-dot brightness jitter the lattice uses to break up its grid, held at its midpoint.
 *
 * `DOT_VERTEX` scales a dot by `0.88 + 0.24 · aSeed`, and 0.5 is the value that makes that
 * exactly 1. A cairn is seven dots authored in a circle; jittering them would make the glyph
 * flicker between throws for no information gained.
 */
const PRINT_SEED = 0.5;

/** How many prints can exist at once. Ten cans is the whole of M2; this is slack, not a budget. */
const DEFAULT_CAPACITY = 64;

/**
 * One layer of resting prints, sharing the lattice's dot material.
 *
 * Slots are addressed by an id the owner assigns (a can's pool index) and are pure storage: a
 * slot that has never been placed, and one whose thing has been picked up, are the same state.
 */
export class RestingPrints {
  readonly capacity: number;

  private readonly geometry = new THREE.BufferGeometry();
  private readonly points: THREE.Points;

  private readonly pos: Float32Array;
  private readonly birth: Float32Array;
  private readonly prior: Float32Array;
  private readonly wave: Float32Array;
  private readonly seed: Float32Array;
  private readonly accent: Float32Array;
  private readonly refresh: Float32Array;
  private readonly scale: Float32Array;
  /** Whether a slot currently holds a print at all — laid, as opposed to heard. */
  private readonly live: Uint8Array;

  /**
   * The wave's two numbers, pushed in by `PaintSystem.applyTunables` exactly as they are pushed
   * into the lattice. Duplicated as *storage* here and nowhere as policy: the ease is read back
   * only to reproduce what the shader is already showing (`displayedAge`).
   */
  private refreshSeconds = 0.3;
  private featherStart = 0.55;

  constructor(material: THREE.ShaderMaterial, capacity: number = DEFAULT_CAPACITY) {
    this.capacity = capacity;
    const dots = capacity * PRINT_DOTS;
    this.pos = new Float32Array(dots * 3);
    this.birth = new Float32Array(dots).fill(NEVER_HEARD);
    this.prior = new Float32Array(dots).fill(NEVER_HEARD);
    this.wave = new Float32Array(dots);
    this.seed = new Float32Array(dots).fill(PRINT_SEED);
    this.accent = new Float32Array(dots);
    // (floor, feather) per dot; feather 1 is "landed dead centre", the identity value.
    this.refresh = new Float32Array(dots * 2);
    for (let i = 0; i < dots; i++) this.refresh[i * 2 + 1] = 1;
    this.scale = new Float32Array(dots).fill(1);
    for (let id = 0; id < capacity; id++) {
      this.scale[id * PRINT_DOTS + PRINT_RING_DOTS] = CENTRE_SCALE;
    }
    this.live = new Uint8Array(capacity);

    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    this.geometry.setAttribute('aBirth', new THREE.BufferAttribute(this.birth, 1));
    this.geometry.setAttribute('aPrior', new THREE.BufferAttribute(this.prior, 1));
    this.geometry.setAttribute('aWave', new THREE.BufferAttribute(this.wave, 1));
    this.geometry.setAttribute('aSeed', new THREE.BufferAttribute(this.seed, 1));
    this.geometry.setAttribute('aAccent', new THREE.BufferAttribute(this.accent, 1));
    this.geometry.setAttribute('aRefresh', new THREE.BufferAttribute(this.refresh, 2));
    this.geometry.setAttribute('aScale', new THREE.BufferAttribute(this.scale, 1));
    this.geometry.setDrawRange(0, dots);

    this.points = new THREE.Points(this.geometry, material);
    this.points.frustumCulled = false;
    // Between the lattice (1) and the contours (2): a print is matter, drawn with matter.
    this.points.renderOrder = 1;
  }

  /** Built against a `StructuredPaint`'s shared dot material — the only supported wiring. */
  static forLattice(lattice: StructuredPaint, capacity?: number): RestingPrints {
    return new RestingPrints(lattice.dotLayerMaterial, capacity);
  }

  /**
   * The cairn layer, as a `Points` rather than an `Object3D`: the buffers *are* the readout.
   * `paint/structured.ts` can hide its geometry behind counters because a lattice dot is only
   * ever where the collider is, but a print's whole claim is that it is drawn at the pose the
   * can actually occupies (`world/cans.ts`), and nothing but the attribute can answer that.
   */
  get object(): THREE.Points {
    return this.points;
  }

  applyLook(refreshSeconds: number, featherStart: number): void {
    this.refreshSeconds = refreshSeconds;
    this.featherStart = featherStart;
  }

  /**
   * Lays (or moves) the print for `id`: a ring of `PRINT_RING_DOTS` at `radius` in the horizontal
   * plane through the pose, plus the centre dot.
   *
   * Horizontal because the thing it draws is lying on a floor and the eye is above it: a ring in
   * the ground plane reads as a small ellipse from anywhere a player stands, where a vertical one
   * would be edge-on — a line — from exactly the directions you approach it from.
   *
   * **Laying a print reveals nothing.** Every dot starts on the never-stamp, so a print that
   * nothing has heard is not drawn, and moving one carries none of the old pose's knowledge to
   * the new one. That is what lets a level author put ten cans in a room without lighting any of
   * them (law 1), and it is why this takes no clock: there is nothing here to be the age of.
   */
  place(id: number, x: number, y: number, z: number, radius: number): void {
    if (id < 0 || id >= this.capacity) return;
    const base = id * PRINT_DOTS;
    for (let k = 0; k < PRINT_RING_DOTS; k++) {
      const a = (k / PRINT_RING_DOTS) * Math.PI * 2;
      const i3 = (base + k) * 3;
      this.pos[i3] = x + Math.cos(a) * radius;
      this.pos[i3 + 1] = y;
      this.pos[i3 + 2] = z + Math.sin(a) * radius;
    }
    const c3 = (base + PRINT_RING_DOTS) * 3;
    this.pos[c3] = x;
    this.pos[c3 + 1] = y;
    this.pos[c3 + 2] = z;
    this.live[id] = 1;
    this.forget(id);
    this.flush();
  }

  /**
   * Takes the print away — the thing moved, so its geometry did too.
   *
   * The instant half of law 2: paint that outlived its subject is the system drawing something
   * that is not there. Every caller of this is a moment the *player* caused (a lift, a kick), so
   * the removal is always witnessed; the day something else can move a resting thing while you
   * are out of earshot, §3.7's photograph doctrine says the print stands until an observation
   * contradicts it, and that rule belongs here.
   */
  remove(id: number): void {
    if (id < 0 || id >= this.capacity) return;
    this.live[id] = 0;
    this.forget(id);
    this.flush();
  }

  /** Forgets every print, keeping the poses: K clears the map, it does not tidy the room. */
  clear(): void {
    this.birth.fill(NEVER_HEARD);
    this.prior.fill(NEVER_HEARD);
    this.wave.fill(0);
    for (let i = 0; i < this.refresh.length; i += 2) {
      this.refresh[i] = 0;
      this.refresh[i + 1] = 1;
    }
    this.flush();
  }

  /**
   * One heard event, answered exactly as the lattice answers it.
   *
   * The caller has already applied §3.1's hearing gate; what is left is the same three tests a
   * lattice dot gets — inside the paint radius, inside the cone, stamped at the instant the front
   * physically arrives — and the same dual stamp, so a refresh eases instead of jumping.
   *
   * **No occlusion test, deliberately.** §3.4's through-a-wall rules are unbuilt; the lattice
   * runs a real one only for *shell* dots (walls and floors, which a sound must actually strike)
   * and hands whole props their reveal the moment they are in range. A can is a prop, so it takes
   * the prop rule. The day occlusion lands, it lands for both in one place.
   */
  handle(event: SoundEvent, now: number, floorAge: number, slot: number): void {
    const radius = event.paintRadius;
    if (!(radius > 0)) return;
    const featherFrom = radius * Math.min(0.999, Math.max(0, this.featherStart));
    const invSpeed = 1 / event.waveSpeed;
    const omni = event.coneAngleDeg >= 359.9;
    const cosHalf = omni ? -1 : Math.cos((event.coneAngleDeg * Math.PI) / 360);
    let touched = false;

    for (let id = 0; id < this.capacity; id++) {
      if (this.live[id] === 0) continue;
      const base = id * PRINT_DOTS;
      for (let k = 0; k < PRINT_DOTS; k++) {
        const i = base + k;
        const i3 = i * 3;
        const dx = this.pos[i3]! - event.x;
        const dy = this.pos[i3 + 1]! - event.y;
        const dz = this.pos[i3 + 2]! - event.z;
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (dist > radius) continue;
        if (cosHalf > -1 && dist > 1e-4) {
          if ((dx * event.dirX + dy * event.dirY + dz * event.dirZ) / dist < cosHalf) continue;
        }
        const feather = 1 - smoothstep(featherFrom, radius, dist);
        this.stamp(i, event.time + dist * invSpeed, now, slot, floorAge, feather);
        touched = true;
      }
    }
    if (touched) this.flush();
  }

  // ---- readouts ------------------------------------------------------------

  /** Prints currently laid — things at rest, heard or not. */
  get placed(): number {
    let n = 0;
    for (let id = 0; id < this.capacity; id++) n += this.live[id]!;
    return n;
  }

  /** Prints with at least one dot on the map. The rest are lying in the dark. */
  get known(): number {
    let n = 0;
    for (let id = 0; id < this.capacity; id++) if (this.isKnown(id)) n++;
    return n;
  }

  /** Every print dot that has ever been stamped — the photometric weight of what is drawn. */
  get knownDots(): number {
    let n = 0;
    for (let id = 0; id < this.capacity; id++) {
      if (this.live[id] === 0) continue;
      const base = id * PRINT_DOTS;
      for (let k = 0; k < PRINT_DOTS; k++) if (this.birth[base + k]! > -1e8) n++;
    }
    return n;
  }

  isKnown(id: number): boolean {
    if (id < 0 || id >= this.capacity || this.live[id] === 0) return false;
    const base = id * PRINT_DOTS;
    for (let k = 0; k < PRINT_DOTS; k++) if (this.birth[base + k]! > -1e8) return true;
    return false;
  }

  /**
   * How old the centre dot of this print looks right now, seconds — or `Infinity` for a print
   * nobody has heard.
   *
   * Through `displayedAge`, which is the curve the shader runs, so "a Q-ping re-whitens the
   * cairn" is a number a headless test can read rather than a claim about pixels.
   */
  age(id: number, now: number): number {
    if (!this.isKnown(id)) return Infinity;
    const i = id * PRINT_DOTS + PRINT_RING_DOTS;
    if (this.birth[i]! <= -1e8) return Infinity;
    return displayedAge(
      this.birth[i]!,
      this.prior[i]!,
      this.refresh[i * 2]!,
      this.refresh[i * 2 + 1]!,
      now,
      this.refreshSeconds,
    );
  }

  dispose(): void {
    this.geometry.dispose();
  }

  // ---- internals -----------------------------------------------------------

  /** Drops a slot's knowledge without touching its pose. */
  private forget(id: number): void {
    const base = id * PRINT_DOTS;
    for (let k = 0; k < PRINT_DOTS; k++) {
      const i = base + k;
      this.birth[i] = NEVER_HEARD;
      this.prior[i] = NEVER_HEARD;
      this.wave[i] = 0;
      this.refresh[i * 2] = 0;
      this.refresh[i * 2 + 1] = 1;
    }
  }

  /**
   * `StructuredPaint.unlockDot`'s stamp, on a dot that is not on the lattice.
   *
   * The dual stamp is the whole of it: only an arrival that has already landed may become the
   * fallback, and what lands there is the *effective* stamp — the age the dot is displaying this
   * instant — so a bounded refresh has no baseline to snap to. Get that wrong and re-hearing a
   * cairn makes it visibly jump, which is precisely the "refresh you can see happening" the
   * lattice's continuity invariant exists to forbid.
   */
  private stamp(
    i: number,
    arrival: number,
    now: number,
    slot: number,
    floor: number,
    feather: number,
  ): void {
    const old = this.birth[i]!;
    const before = displayedAge(
      old,
      this.prior[i]!,
      this.refresh[i * 2]!,
      this.refresh[i * 2 + 1]!,
      now,
      this.refreshSeconds,
    );
    if (old <= now) this.prior[i] = now - before;
    this.birth[i] = arrival;
    this.wave[i] = slot;
    this.refresh[i * 2] = floor;
    this.refresh[i * 2 + 1] = feather;
  }

  private flush(): void {
    for (const name of ['position', 'aBirth', 'aPrior', 'aWave', 'aRefresh']) {
      (this.geometry.getAttribute(name) as THREE.BufferAttribute).needsUpdate = true;
    }
  }
}
