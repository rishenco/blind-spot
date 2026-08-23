/**
 * BLUEPRINT — the line-first school (doc/looks/blueprint.md).
 *
 * "Your sensor doesn't show the world — it DRAFTS it. Sound events are survey shots: lines snap
 * first, fields hatch in behind them, and what age leaves standing is a technical drawing of a
 * building you have never seen lit."
 *
 * Of the three looks this is the one where vision §5's "dots are matter, lines are holds" stops
 * being an encoding and becomes the entire aesthetic. Everything here serves one plot order:
 *
 *   1. a sound arrives and core stamps `paintTime` on what its wavefront reached
 *   2. the EDGES of that geometry draw first, wiping along their own length in EDGE_LEAD_MS
 *   3. the dots hatch in behind them, snapping rather than flaring
 *   4. age cools the ink, thins the CLOUD, and leaves the line work standing at the skeleton floor
 *
 * ...so an old room is a pure navy line drawing with ticked holds, and a fresh one is that drawing
 * with graph paper laid into it (matter.ts).
 *
 * NO POST CHAIN, on purpose. "Blueprint is the control group: raw renderer output" — no bloom, no
 * afterglow, no texture noise, no glow ramps. Every effect in this look is geometry or it does not
 * exist, which is also why the dog's silhouette is found in-shader from the normal it already
 * carries rather than in an edge-detect pass there is nowhere to put (marks.ts).
 *
 * SHARED-GEOMETRY DISCIPLINE (engine-plan §9, looks/types.ts). `surfelGeom`, `edgeGeom` and every
 * dog's `cloudGeom` belong to core and hold the run's paint; this look builds its own objects and
 * materials over them and `dispose()` frees exactly those. That is what lets 0/1/2/3 flip between
 * schools mid-run and compare the same painted world.
 */

import { Scene } from 'three';
import type { SoundEvent } from '../../core/events.js';
import type { Look, LookContext } from '../types.js';
import { HandsRig } from './hands.js';
import { BlueprintHud } from './hud.js';
import { makeFrame } from './frame.js';
import { DogField, StainField } from './marks.js';
import { MatterLayer } from './matter.js';

export const createBlueprintLook = (): Look => {
  let ctx: LookContext | null = null;
  const scene = new Scene();

  let matter: MatterLayer | null = null;
  let stains: StainField | null = null;
  let dogs: DogField | null = null;
  let hands: HandsRig | null = null;
  let hud: BlueprintHud | null = null;

  /** Mutated in place every frame; no allocation in the draw path (engine-plan §10). */
  const frame = makeFrame();
  const feet = [0, 0, 0];

  let viewW = 1;
  let viewH = 1;

  return {
    id: 'blueprint',
    title: 'blueprint',

    init(c: LookContext): void {
      ctx = c;
      const calm = c.reduceFlashing();
      frame.calm = calm;

      matter = new MatterLayer(scene, c.surfelGeom, c.edgeGeom, c.constants, calm);
      stains = new StainField(scene, c.constants, calm);
      dogs = new DogField(scene, c.constants);
      hands = new HandsRig(scene);
      hud = new BlueprintHud(c.hud, calm);

      this.resize(viewW, viewH);
    },

    /**
     * Every delivered event leaves a graphite stain at its origin (visual-brief §1.13) — that is
     * the event layer's whole job, and it is the same call for a footstep and for a detonation.
     *
     * Two other things are read off the event and neither is decoration. The wave SPEED sets how
     * many seconds of arrival-time the rim's 0.15 m bright zone is worth, and only the classes that
     * actually travel carry a finite one (pings and detonations), so an instant class must not be
     * allowed to overwrite it. And the ping itself gets the HUD's rim answer, because the press
     * needs an acknowledgement before its paint can possibly get anywhere — the far end of an
     * E-ping is skipped there, being the same ping arriving rather than a second press, though it
     * still stains, because it is a real sound in a real place.
     */
    onEvent(e: SoundEvent): void {
      stains?.stamp(e);
      if (Number.isFinite(e.waveSpeed) && e.waveSpeed > 0) matter?.setWaveSpeed(e.waveSpeed);
      if (e.source !== 'self' || e.variant === 'far') return;
      if (e.class === 'ePing' || e.class === 'qPing') hud?.ping(e.time);
    },

    update(now: number, _dt: number): void {
      const c = ctx;
      if (!c) return;
      const cam = c.camera;

      frame.now = now;
      frame.camPos[0] = cam.position.x;
      frame.camPos[1] = cam.position.y;
      frame.camPos[2] = cam.position.z;
      // Pixels per metre at one metre of depth. Recomputed every frame because the FOV moves with
      // the sprint kick — a splat that ignored that would swell as you accelerate.
      frame.projScale = (viewH * 0.5) / Math.tan((cam.fov * Math.PI) / 360);
      frame.pixelRatio = c.renderer.getPixelRatio();
      frame.capPx = matter ? matter.capPx : frame.capPx;
      frame.floorCentre = c.floorCentre;
      frame.floorSpan = c.floorSpan;

      // The contact shell is measured off the BODY, not the eye (vision §3.1): feet from the
      // interpolated player pose, head at the camera. Both are picture-side values (engine-plan
      // §11.1) — they must not swim at 144 Hz.
      feet[0] = c.player.pos[0];
      feet[1] = c.player.pos[1];
      feet[2] = c.player.pos[2];

      matter?.update(frame, feet);
      stains?.update(frame);
      dogs?.update(c.dog, frame);
      hands?.update(c.player.hands, cam);
      hud?.update(now, c.player, c.constants.HALO_FULL_M);
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
      matter?.resize(viewH, dpr);
    },

    dispose(): void {
      scene.clear();
      matter?.dispose();
      stains?.dispose();
      dogs?.dispose();
      hands?.dispose();
      hud?.dispose();
      matter = null;
      stains = null;
      dogs = null;
      hands = null;
      hud = null;
      ctx = null;
      // NOT disposed, on purpose: `surfelGeom`, `edgeGeom` and every dog's `cloudGeom` are core's
      // and hold the run's paint. Disposing them here would black the world on every look switch.
    },
  };
};
