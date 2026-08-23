/**
 * THE LOOK CONTRACT (engine-plan §9).
 *
 * Three art directions are going to be built in parallel against this file and switched live at
 * runtime. That only works if the boundary is absolute, so it is stated as bluntly as possible:
 *
 * - A look READS core state. It never mutates it, never re-tunes `const.ts`, and never edits a
 *   file outside its own folder (plus its one line in `looks/index.ts`).
 * - The point and line GEOMETRIES ARE SHARED. A look builds its own `THREE.Points` /
 *   `THREE.LineSegments` over them with its own materials, its own scene graph, its own post
 *   chain and its own HUD drawing — and on `dispose()` it disposes those and NOT the geometries.
 *   Paint state lives in the shared buffers, which is what lets you flip between looks and
 *   compare the same painted world (engine-plan §9 "switch protocol").
 * - The FIXED semantics are aging (ice-white → family hue → navy → skeleton alpha 0.22, thinning
 *   through the dither band, rim inside RIM_WINDOW), the event-colour meanings, and the
 *   quality→stain mapping. Only styling varies (visual-brief §2–3).
 * - Distance discipline is not optional (engine-plan §9, vision §12): dot alpha fades with camera
 *   distance, past ~20 m the read biases to edges, and there is a hard cut at 45 m.
 *
 * HONESTY. A field with nothing in it carries an empty value, never a placeholder that looks like
 * data (vision §1.2): no dogs alive means `dog` is an empty array, and a look reading it draws
 * nothing rather than a guess.
 */

import type { BufferGeometry, PerspectiveCamera, WebGLRenderer } from 'three';
import type { CoreConstants } from '../core/const.js';
import type { SoundEvent } from '../core/events.js';
import type { HandsPose, PingResult, RigArm, RigBone } from '../core/player.js';
import type { Stance } from '../core/sim.js';

/**
 * The dog's view contracts. Declared in core/dog.ts — core is what FILLS them, and a shape whose
 * only declaration lived here would mean core importing from looks, which is the one direction
 * this boundary does not allow. Re-exported so a look's import path is still this file.
 */
import type { DogView } from '../core/dog.js';
export type { DogView, GhostSnapshot, PoseSample } from '../core/dog.js';

/**
 * The hands rig (engine-plan §6). Core owns the POSE — a state, a phase, a fade and four bones
 * in CAMERA space (see `RigBone` in core/player.ts for the axes and the Euler order). Looks own
 * what a hand is made of and how it is lit; the rig is deliberately not geometry, so the three
 * schools can each answer visual-brief §1.6 "faint machine hands" in their own material language.
 */
export type HandsView = HandsPose;
export type RigArmView = RigArm;
export type RigBoneView = RigBone;

/**
 * The last press of E or Q as core resolved it: which mode, the event if it fired, why it did
 * not if it did not, and the sim instant either way (core/player.ts `PingResult`).
 *
 * A refusal makes no sound, so it is the one thing in the game that a look has to say out loud —
 * silence after a press is otherwise indistinguishable from a dead key. Core owns the reason and
 * the timestamp; a look owns whether and how it shows them, and for how long.
 */
export type PingView = PingResult;

export interface PlayerView {
  /** INTERPOLATED render position — feet (engine-plan §11.1: never the raw sim pose). */
  readonly pos: readonly [number, number, number];
  readonly stance: Stance;
  /** Horizontal speed, m/s. */
  readonly speed: number;
  /** How loud you are right now, in metres (vision §3.8 "the Halo"). */
  readonly audibleRadius: number;
  /** The reactor (vision §4). One bar; `energyMax` shrinks as chips reserve capacity (§9). */
  readonly energy: number;
  readonly energyMax: number;
  readonly hands: HandsView;
  /** Null until the first press of either ping this run. See `PingView`. */
  readonly lastPing: PingView | null;
}

/**
 * The events THIS listener received, with `wallsToListener` / `distToListener` / `quality`
 * filled in (core/paint.ts). Never the raw bus: an event nobody heard must not reach a look, or
 * the look would be drawing a sound the player cannot hear (vision §1.1).
 */
export interface EventFeed {
  /** Returns the unsubscribe. */
  subscribe(cb: (e: SoundEvent) => void): () => void;
  /** Newest first. */
  recent(limit?: number): SoundEvent[];
}

export interface LookContext {
  /** Shared. A look must not leave global renderer state changed behind it. */
  readonly renderer: WebGLRenderer;
  /** Core-driven: movement pose, look angles, FOV kick. */
  readonly camera: PerspectiveCamera;
  /** Dots: position, normal, dither, paintTime, paintIntensity. SHARED — never dispose. */
  readonly surfelGeom: BufferGeometry;
  /** Line segments: position, dither, flagsHold, paintTime, paintIntensity. SHARED. */
  readonly edgeGeom: BufferGeometry;
  /** Every dog alive this run (core/dog.ts). Empty is the normal case, not a placeholder. */
  readonly dog: readonly DogView[];
  readonly events: EventFeed;
  readonly player: PlayerView;
  /** Look-owned DOM layer for the reticle, halo and any printed readout. */
  readonly hud: HTMLDivElement;
  readonly constants: CoreConstants;
  /**
   * The RENDER clock, in sim seconds: `sim.time + alpha × SIM_STEP`. Everything a look animates
   * — aging, stains, ghosts — is derived from `time() − paintTime`, so it must be this and not a
   * frame counter or a wall clock. See `main.ts` for why it leads the drawn pose by design.
   */
  time(): number;
  /** Comfort setting (vision §12): true ⇒ no strobe, no flicker; pulses become fades. */
  reduceFlashing(): boolean;
  /**
   * The vertical window the renderer is allowed to draw: `|y − centre| ≤ span` (vision §3.6,
   * ±1 floor). One floor for now; the five-floor build moves the centre with the player.
   */
  readonly floorCentre: number;
  readonly floorSpan: number;
}

export interface Look {
  readonly id: string;
  readonly title: string;
  init(ctx: LookContext): void;
  /** One delivered event — spawn stains, markers, rim cues. */
  onEvent(e: SoundEvent): void;
  /** `now` is `ctx.time()`; `dt` is real elapsed seconds (refresh-rate independent). */
  update(now: number, dt: number): void;
  /** The look owns its scene graph and post chain. */
  render(): void;
  resize(w: number, h: number): void;
  /** Full cleanup — switching looks must not leak. Never disposes the shared geometries. */
  dispose(): void;
}
