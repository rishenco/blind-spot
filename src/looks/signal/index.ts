/**
 * SIGNAL — the raw-data school (doc/looks/signal.md).
 *
 * "Nothing you see is the world — it is telemetry, decoded barely in time. Paint doesn't appear;
 * it RESOLVES." Electric cyan, square samples, a whisper of chromatic fringe on the newest
 * information only, and glitch that lives exclusively in the births and deaths of information —
 * the decode burst and the Bayer dissolve — never at rest.
 *
 * This file is the assembly. The look's parts each own one question:
 *
 *   matter.ts   the lattice, the edges and the dashed holds — "what is there"
 *   marks.ts    the interference stains and the dog cloud with its ghosts — "what just happened"
 *   rig.ts      the hands: dark panels, bright seams, one dash run per grab
 *   hud.ts      the halo dial, the quantized reactor ring, the reticle, the refusal line
 *   glsl.ts     the shader chunks the layers must not be allowed to disagree about
 *   params.ts   every colour and every duration an art pass would want to move
 *
 * SEVEN DRAW CALLS at most, and the last three of them are usually skipped: dots, edges, holds
 * ×2, stains (only when one is alive), the dog cloud (only when a dog has been heard), and the
 * rig (only during a grab). Nothing here allocates per frame — the clock is a uniform, and ageing
 * is entirely a shader's job.
 *
 * SHARED-GEOMETRY DISCIPLINE (engine-plan §9): this look creates materials, its own geometries, a
 * scene and HUD nodes, and disposes exactly those. `ctx.surfelGeom`, `ctx.edgeGeom` and every
 * dog's `cloudGeom` belong to core and hold the run's paint — which is what lets you flip looks
 * mid-run and compare the same painted world.
 */

import { Scene } from 'three';
import type { SoundEvent } from '../../core/events.js';
import { deliveredOrigin } from '../../core/paint.js';
import type { Look, LookContext } from '../types.js';
import { SignalHud } from './hud.js';
import { MatterLayer, type ConeState, type MatterFrame } from './matter.js';
import { SignalDogs, SignalStains, type MarkFrame } from './marks.js';
import * as P from './params.js';
import { SignalRig } from './rig.js';

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

export function createSignalLook(): Look {
  let ctx: LookContext | null = null;
  const scene = new Scene();

  let matter: MatterLayer | null = null;
  let stains: SignalStains | null = null;
  let dogs: SignalDogs | null = null;
  let rig: SignalRig | null = null;
  let hud: SignalHud | null = null;

  const matterFrame: Mutable<MatterFrame> = {
    now: 0,
    camPos: [0, 0, 0],
    bodyFeet: [0, 0, 0],
    projScale: 500,
    pixelRatio: 1,
    floorCentre: 0,
    floorSpan: 0,
  };
  const markFrame: Mutable<MarkFrame> = {
    now: 0,
    camPos: [0, 0, 0],
    projScale: 500,
    pixelRatio: 1,
    stainCapPx: 64,
    dotCapPx: 10,
    viewport: [1, 1],
    floorCentre: 0,
    floorSpan: 0,
  };
  const camPos: [number, number, number] = [0, 0, 0];
  const feet: [number, number, number] = [0, 0, 0];
  const viewport: [number, number] = [1, 1];
  matterFrame.camPos = camPos;
  matterFrame.bodyFeet = feet;
  markFrame.camPos = camPos;
  markFrame.viewport = viewport;

  /** Scratch for one dog heading. Read out by `stamp` before the next event can overwrite it. */
  const heading: [number, number, number] = [0, 0, 0];

  /** The beam a live E-ping is still travelling down, or null. */
  let cone: ConeState | null = null;

  let viewW = 1;
  let viewH = 1;

  /**
   * Which way was the dog that made this sound going?
   *
   * Not predicted and not invented (vision §3.7, §1 law 2): core writes a pose into the dog's
   * history at the instant each gait event is DELIVERED, and the dog system subscribes to that
   * feed before this look does — so by the time an event arrives here the pose it produced is
   * already the newest one, and the difference against the one before it is the ground the body
   * actually covered between two footfalls. No history, no second pose, no match inside
   * `DOG_MATCH_RADIUS` ⇒ no dart. An unknown heading is drawn as no heading.
   */
  const headingFor = (e: SoundEvent): [number, number, number] | null => {
    const c = ctx;
    if (!c || e.source !== 'dog') return null;
    let best: [number, number, number] | null = null;
    let bestD = P.DOG_MATCH_RADIUS * P.DOG_MATCH_RADIUS;
    for (const d of c.dog) {
      const n = d.poseHistory.length;
      if (n < 2) continue;
      const a = d.poseHistory[n - 1]!.matrix;
      const b = d.poseHistory[n - 2]!.matrix;
      const dx = a[12]! - e.origin[0];
      const dy = a[13]! - e.origin[1];
      const dz = a[14]! - e.origin[2];
      const dist = dx * dx + dy * dy + dz * dz;
      if (dist > bestD) continue;
      const hx = a[12]! - b[12]!;
      const hy = a[13]! - b[13]!;
      const hz = a[14]! - b[14]!;
      const len = Math.hypot(hx, hy, hz);
      if (len < 1e-3) continue;
      bestD = dist;
      heading[0] = hx / len;
      heading[1] = hy / len;
      heading[2] = hz / len;
      best = heading;
    }
    return best;
  };

  return {
    id: 'signal',
    title: 'signal',

    init(c: LookContext): void {
      ctx = c;
      matter = new MatterLayer(c);
      stains = new SignalStains(c.constants, c.reduceFlashing());
      dogs = new SignalDogs(c.constants);
      rig = new SignalRig();
      hud = new SignalHud(c.reduceFlashing());

      scene.add(matter.dots, matter.edges, matter.holdsA, matter.holdsB);
      scene.add(stains.points, dogs.points, rig.group);
      c.hud.appendChild(hud.root);
      this.resize(viewW, viewH);
    },

    /**
     * Every delivered event leaves a stain at its origin, and two of them leave more than that.
     *
     * A live E-ping hands the matter layer its real cone, so the rim's decode preview is denser
     * along the beam — the ping reads directional because the test is the actual cone against the
     * actual wavefront, not because the renderer drew a shape. The far end of the beam is the SAME
     * ping arriving somewhere else (core/events.ts `SoundVariant`): it stains, because it is a real
     * sound in a real place, but it neither re-aims the cone nor acknowledges a second press.
     */
    onEvent(e: SoundEvent): void {
      stains?.stamp(e, headingFor(e));
      if (e.source !== 'self' || e.variant === 'far') return;
      if (e.class === 'ePing' || e.class === 'qPing') hud?.ping(e.time);
      if (e.class === 'ePing' && e.cone) {
        const d = e.cone.dir;
        const len = Math.hypot(d[0], d[1], d[2]) || 1;
        const o = deliveredOrigin(e);
        cone = {
          origin: [o[0], o[1], o[2]],
          dir: [d[0] / len, d[1] / len, d[2] / len],
          cosHalf: Math.cos((e.cone.angleDeg * Math.PI) / 360),
          from: e.time,
          // The instant the wavefront leaves the far end. An instant class (waveSpeed Infinity)
          // still gets the decode's own window, or the densification would never be on screen.
          until: e.time + Math.max(e.paintRadius / e.waveSpeed, P.DECODE_MS / 1000),
        };
        matter?.setCone(cone);
      }
    },

    update(now: number, _dt: number): void {
      const c = ctx;
      if (!c || !matter) return;

      const cam = c.camera;
      camPos[0] = cam.position.x;
      camPos[1] = cam.position.y;
      camPos[2] = cam.position.z;
      // The contact shell is measured off the BODY: feet from the interpolated player pose, head
      // at the eye. Both are picture-side values (engine-plan §11.1) — they must not swim at 144 Hz.
      feet[0] = c.player.pos[0];
      feet[1] = c.player.pos[1];
      feet[2] = c.player.pos[2];

      // Pixels per metre at one metre of depth. Recomputed every frame because the FOV moves with
      // the sprint kick — a splat that ignored that would swell as you accelerate.
      const projScale = (viewH * 0.5) / Math.tan((cam.fov * Math.PI) / 360);
      const dpr = c.renderer.getPixelRatio();

      matterFrame.now = now;
      matterFrame.projScale = projScale;
      matterFrame.pixelRatio = dpr;
      matterFrame.floorCentre = c.floorCentre;
      matterFrame.floorSpan = c.floorSpan;
      matter.update(matterFrame);

      // A beam that has arrived is no longer a beam. Cleared rather than left to expire in the
      // shader so a stale origin cannot reappear if the clock is ever wound back (a run restart).
      if (cone && now > cone.until) {
        cone = null;
        matter.setCone(null);
      }

      // The event layer rides the same projection and the same window as the matter layer, so a
      // mark can never be drawn at a scale or a range the geometry it annotates is not.
      markFrame.now = now;
      markFrame.projScale = projScale;
      markFrame.pixelRatio = dpr;
      markFrame.stainCapPx = P.STAIN_CAP_FRAC * viewH;
      markFrame.dotCapPx = P.DOT_SAMPLE_CAP_FRAC * viewH;
      markFrame.floorCentre = c.floorCentre;
      markFrame.floorSpan = c.floorSpan;
      stains?.update(markFrame);
      dogs?.update(c.dog, markFrame);

      rig?.update(c.player.hands, cam, now);
      hud?.update(
        now,
        c.player.audibleRadius,
        c.constants.HALO_FULL_M,
        c.player.energy,
        c.player.energyMax,
        c.player.lastPing,
      );
    },

    render(): void {
      const c = ctx;
      if (!c) return;
      c.renderer.render(scene, c.camera);
    },

    resize(w: number, h: number): void {
      viewW = Math.max(1, w);
      viewH = Math.max(1, h);
      const dpr = ctx ? ctx.renderer.getPixelRatio() : 1;
      viewport[0] = viewW * dpr;
      viewport[1] = viewH * dpr;
      matter?.resize(viewW, viewH, dpr);
      rig?.setPixelRatio(dpr);
    },

    dispose(): void {
      scene.clear();
      matter?.dispose();
      stains?.dispose();
      dogs?.dispose();
      rig?.dispose();
      hud?.dispose();
      matter = null;
      stains = null;
      dogs = null;
      rig = null;
      hud = null;
      cone = null;
      ctx = null;
      // NOT disposed, on purpose: ctx.surfelGeom / ctx.edgeGeom are the SurfelField's and every
      // dog's cloudGeom is the DogSystem's. They hold the run's paint; disposing them here would
      // black the world on every look switch.
    },
  };
}
