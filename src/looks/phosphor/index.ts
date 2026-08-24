/**
 * PHOSPHOR — the look (doc/looks/phosphor.md).
 *
 * "A green-cyan oscilloscope phosphor. The world is a beam-scanned screen: strokes are struck
 *  bright and then decay through the tube's own persistence."
 *
 * This file is the assembly. The art lives in four places, each with its own header:
 *
 *   params.ts   the tuning surface the brief names — palette, mix, strike, rim, post amounts
 *   matter.ts   the cyan band: struck grains, hairline edges, holds, the rim, the contact shell
 *   marks.ts    the event layer: per-source FORMS, and the dog cloud with its cooling ghosts
 *   post.ts     the school signature: peak-hold persistence, glass grain, static line pattern
 *   halo.ts     the graticule instrument (vision §3.8), text-free
 *   hands.ts    dark prisms with phosphor-edge outlines (visual-brief §1.6)
 *
 * THE CONTRACT (engine-plan §9, looks/types.ts). This look reads core state and never mutates it.
 * The two BufferGeometries are SHARED and hold the run's paint, so they are never disposed — which
 * is exactly what lets 0/1/2/3 flip between looks mid-run and compare the same painted world. The
 * renderer is shared too: the post chain saves and restores every piece of global state it touches.
 *
 * THE COLOURBLIND LAW IS PAID IN marks.ts. Vision §12 says meaning is hue + shape + motion, never
 * hue alone, and engine-plan §9 leaves the per-source event forms to the first authored look. Every
 * source therefore has a form: self is a round breath, a dog is jagged with darts along its travel,
 * a prop rings outward, the objective is a breathing annulus, a detonation has spikes, a teammate is
 * a diamond glyph pip. The halo's two cues are directions, not colours: a ping that fired races
 * outward, a ping that was refused collapses inward and broken.
 */

import { Scene } from 'three';
import type { SoundEvent } from '../../core/events.js';
import type { Look, LookContext } from '../types.js';
import { MatterField, type MatterFrame } from './matter.js';
import { PhosphorDogs, PhosphorStains, type MarkFrame } from './marks.js';
import { PhosphorPost } from './post.js';
import { PhosphorHalo } from './halo.js';
import { PhosphorHands } from './hands.js';

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

export const createPhosphorLook = (): Look => {
  let ctx: LookContext | null = null;
  const scene = new Scene();

  let matter: MatterField | null = null;
  let stains: PhosphorStains | null = null;
  let dogs: PhosphorDogs | null = null;
  let post: PhosphorPost | null = null;
  let halo: PhosphorHalo | null = null;
  let hands: PhosphorHands | null = null;

  // Reused every frame: the frame state is written in place, never allocated (engine-plan §10).
  const matterFrame: Mutable<MatterFrame> = {
    now: 0,
    camPos: [0, 0, 0],
    feet: [0, 0, 0],
    projScale: 500,
    floorCentre: 0,
    floorSpan: 0,
  };
  const markFrame: Mutable<MarkFrame> = {
    now: 0,
    camPos: [0, 0, 0],
    projScale: 500,
    pixelRatio: 1,
    capPx: 12,
    viewport: [1, 1],
    floorCentre: 0,
    floorSpan: 0,
  };
  const camPos: [number, number, number] = [0, 0, 0];
  const feet: [number, number, number] = [0, 0, 0];
  const viewport: [number, number] = [1, 1];

  /** Sim time of the last outgoing ping EVENT — not the last press. See halo.ts. */
  let lastPingAt = -1;
  /** Real elapsed seconds of the frame being drawn: the persistence decay is a function of it. */
  let frameDt = 1 / 60;
  let viewW = 1;
  let viewH = 1;

  return {
    id: 'phosphor',
    title: 'phosphor',

    init(c: LookContext): void {
      ctx = c;
      const dpr = c.renderer.getPixelRatio();

      matter = new MatterField(c);
      stains = new PhosphorStains(c.constants, c.reduceFlashing());
      dogs = new PhosphorDogs(c.constants);
      hands = new PhosphorHands();
      scene.add(...matter.objects, stains.points, dogs.points, hands.group);

      post = new PhosphorPost(c.renderer, viewW, viewH);
      halo = new PhosphorHalo(dpr);
      c.hud.appendChild(halo.root);

      this.resize(viewW, viewH);
    },

    /**
     * Every delivered event leaves a stain at its origin. A TRAVELLING event also sets the rim's
     * depth: the band is a width in metres, and a width in metres only becomes a width in seconds
     * against the wavefront that is actually sweeping (see RIM_DEPTH). Instant classes never touch
     * it — they have no front to be a band on, and their arrival is the strike.
     *
     * The E-ping's far end is skipped for the acknowledgement ring only: it is the same ping
     * arriving at the other end of the beam, not a second press. It still stains, because it is a
     * real sound in a real place (vision §3.3).
     */
    onEvent(e: SoundEvent): void {
      stains?.stamp(e);
      if (Number.isFinite(e.waveSpeed)) matter?.setRimWave(e.waveSpeed, e.class === 'ePing');
      if (e.source !== 'self' || e.variant === 'far') return;
      if (e.class === 'ePing' || e.class === 'qPing') lastPingAt = e.time;
    },

    update(now: number, dt: number): void {
      const c = ctx;
      if (!c) return;
      frameDt = dt;

      const cam = c.camera;
      camPos[0] = cam.position.x;
      camPos[1] = cam.position.y;
      camPos[2] = cam.position.z;
      // The contact shell is measured off the BODY: feet from the interpolated player pose, head at
      // the eye. Both are picture-side values (engine-plan §11.1) — they must not swim at 144 Hz.
      feet[0] = c.player.pos[0];
      feet[1] = c.player.pos[1];
      feet[2] = c.player.pos[2];

      // Pixels per metre at one metre of depth. Recomputed every frame because the FOV moves with
      // the sprint kick — a splat that ignored that would swell as you accelerate.
      const projScale = (viewH * 0.5) / Math.tan((cam.fov * Math.PI) / 360);

      matterFrame.now = now;
      matterFrame.camPos = camPos;
      matterFrame.feet = feet;
      matterFrame.projScale = projScale;
      matterFrame.floorCentre = c.floorCentre;
      matterFrame.floorSpan = c.floorSpan;
      matter?.update(matterFrame);

      // The event layer rides the same projection and the same window as the matter layer, so a
      // mark can never be drawn at a scale or a range the geometry it annotates is not.
      const dpr = c.renderer.getPixelRatio();
      viewport[0] = viewW * dpr;
      viewport[1] = viewH * dpr;
      markFrame.now = now;
      markFrame.camPos = camPos;
      markFrame.projScale = projScale;
      markFrame.pixelRatio = dpr;
      markFrame.capPx = matter ? matter.capPx : 12;
      markFrame.viewport = viewport;
      markFrame.floorCentre = c.floorCentre;
      markFrame.floorSpan = c.floorSpan;
      stains?.update(markFrame);
      dogs?.update(c.dog, markFrame);

      hands?.update(c.player.hands, cam);
      halo?.setDpr(dpr);
      halo?.update(now, c.player, c.constants.HALO_FULL_M, lastPingAt, c.reduceFlashing());
    },

    render(): void {
      const c = ctx;
      if (!c) return;
      if (post) post.render(scene, c.camera, frameDt);
      else c.renderer.render(scene, c.camera);
    },

    resize(w: number, h: number): void {
      viewW = Math.max(1, w);
      viewH = Math.max(1, h);
      const dpr = ctx ? ctx.renderer.getPixelRatio() : 1;
      matter?.resize(viewW, viewH, dpr);
      post?.setSize(viewW, viewH);
      halo?.setDpr(dpr);
    },

    dispose(): void {
      scene.clear();
      matter?.dispose();
      stains?.dispose();
      dogs?.dispose();
      hands?.dispose();
      post?.dispose();
      halo?.dispose();
      matter = null;
      stains = null;
      dogs = null;
      hands = null;
      post = null;
      halo = null;
      lastPingAt = -1;
      ctx = null;
      // NOT disposed, on purpose: ctx.surfelGeom / ctx.edgeGeom are the SurfelField's, and they
      // hold the run's paint. Disposing them here would black the world on every look switch.
    },
  };
};
