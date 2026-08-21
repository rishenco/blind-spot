// PERCEIVED STATE.
//
// The renderer reads this and nothing else. Every point on screen can be traced back to a
// single `Ev` the server decided this player had earned. There is deliberately no path in
// this file from "the network told me where the enemy is" to "draw the enemy" — the only
// entry point is applyEvent(), and the only entity data it can act on is a frozen contact.

import * as THREE from 'three';
import { PointField, PKind } from './pointfield.ts';
import { GhostField } from './ghost.ts';
import { PulseQueue } from './scan.ts';
import { POOL, AGE, TOUCH, Res } from '../shared/config.ts';
import type { Ev } from '../shared/proto.ts';
import type { World } from '../shared/world.ts';

export interface Notice { text: string; tone: string; at: number }

export class Perception {
  structural: PointField;
  aux: PointField;
  ghosts: GhostField;
  pulses: PulseQueue;
  auxPulses: PulseQueue;
  group = new THREE.Group();

  notices: Notice[] = [];
  /** Direction the last damage arrived from, for the hit indicator. */
  lastHit: { fx: number; fy: number; fz: number; at: number } | null = null;
  /** Set when a pulse-flash contact arrives, to flare the HUD. */
  lastFlashAt = -999;
  lastHeartbeatAt = -999;
  predictGhosts = false;
  private tag = 1;
  private touchAt = 0;

  constructor(private world: World, private clock: () => number) {
    this.structural = new PointField(POOL.structural, {
      transient: AGE.transient, structFresh: AGE.structuralFresh,
      structMemory: AGE.structuralMemory, entity: AGE.entityCool,
    });
    this.aux = new PointField(POOL.transient, {
      transient: AGE.transient, structFresh: AGE.structuralFresh,
      structMemory: AGE.structuralMemory, entity: AGE.entityCool,
    });
    this.ghosts = new GhostField(this.structural.material);
    this.pulses = new PulseQueue(world, this.structural, 4200);
    this.auxPulses = new PulseQueue(world, this.aux, 1600);
    this.group.add(this.structural.points, this.aux.points, this.ghosts.points);
  }

  setDpr(v: number) { this.structural.dpr = v; this.aux.dpr = v; }

  applyEvent(e: Ev, serverT: number, nowLocal: number) {
    // Events are stamped with server time; render them on the local clock, offset so the
    // wavefront starts now rather than retroactively.
    switch (e.k) {
      case 'geom': {
        const gold = e.src === 'heartbeat' || e.gold === true;
        const target = gold ? this.auxPulses : this.pulses;
        if (e.src === 'tracer' && e.ex !== undefined) {
          this.drawTracer(e.ox, e.oy, e.oz, e.ex, e.ey!, e.ez!, nowLocal);
          break;
        }
        target.add({
          ox: e.ox, oy: e.oy, oz: e.oz, dx: e.dx, dy: e.dy, dz: e.dz,
          rays: e.rays, halfAngle: e.half, range: e.range,
          waveSpeed: e.speed, startTime: nowLocal, densityFalloff: 1,
          seed: e.seed, kind: gold ? PKind.Objective : PKind.Static,
          elevMax: e.half >= Math.PI ? 1.15 : undefined,
        });
        if (gold) this.lastHeartbeatAt = nowLocal;
        break;
      }
      case 'contact': {
        this.ghosts.write(e.id, e.x, e.y, e.z, e.yaw, e.stance, e.vx, e.vz, e.res, nowLocal, this.tag++, this.predictGhosts);
        break;
      }
      case 'sound': {
        this.drawSound(e.x, e.y, e.z, e.kind, e.res, nowLocal);
        if (e.kind === 'pulse') this.lastFlashAt = nowLocal;
        break;
      }
      case 'hit': {
        this.lastHit = { fx: e.fx, fy: e.fy, fz: e.fz, at: nowLocal };
        break;
      }
      case 'notice': {
        this.notices.push({ text: e.text, tone: e.tone ?? 'info', at: nowLocal });
        if (this.notices.length > 5) this.notices.shift();
        break;
      }
    }
  }

  /** A tracer is a true measurement of the line the bullet actually travelled. */
  private drawTracer(ox: number, oy: number, oz: number, ex: number, ey: number, ez: number, now: number) {
    const dx = ex - ox, dy = ey - oy, dz = ez - oz;
    const len = Math.hypot(dx, dy, dz) || 1;
    const n = Math.min(240, Math.max(30, Math.round(len * 8)));
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n;
      const j = 0.045;
      this.aux.push(
        ox + dx * t + (Math.random() - 0.5) * j,
        oy + dy * t + (Math.random() - 0.5) * j,
        oz + dz * t + (Math.random() - 0.5) * j,
        now + (t * len) / 400, t, 0.9, PKind.Impact,
      );
    }
  }

  /** Sound is amber, short-lived, and shaped by how sure you are of where it came from. */
  private drawSound(x: number, y: number, z: number, kind: string, res: Res, now: number) {
    const n = res === Res.Full ? 140 : res === Res.Coarse ? 90 : 34;
    const spread = res === Res.Full ? 0.5 : res === Res.Coarse ? 1.0 : 1.9;
    const isRing = kind === 'heartbeat' || kind === 'pulse' || kind === 'shot';
    for (let i = 0; i < n; i++) {
      let px: number, py: number, pz: number;
      if (isRing) {
        // An expanding ring reads as "something happened over there", not "someone is there".
        const a = (i / n) * Math.PI * 2 + Math.random() * 0.3;
        const r = spread * (0.85 + Math.random() * 0.4);
        px = x + Math.cos(a) * r; py = y + (Math.random() - 0.5) * 0.5; pz = z + Math.sin(a) * r;
      } else {
        px = x + (Math.random() - 0.5) * spread;
        py = y + Math.random() * 0.55;
        pz = z + (Math.random() - 0.5) * spread;
      }
      this.aux.push(px, py, pz, now + Math.random() * 0.06, 0, res === Res.Trace ? 0.55 : 0.95, PKind.Impact);
    }
  }

  /** The anti-frustration floor: you can always feel the wall you are touching. */
  touch(x: number, eyeY: number, z: number, now: number) {
    if (now < this.touchAt) return;
    this.touchAt = now + TOUCH.intervalS;
    this.pulses.add({
      ox: x, oy: eyeY, oz: z, dx: 0, dy: -1, dz: 0,
      rays: TOUCH.rays, halfAngle: Math.PI, range: TOUCH.radius,
      waveSpeed: 400, startTime: now, densityFalloff: 0, gain: 0.20,
      seed: (this.tag++ * 2246822519) >>> 0, elevMax: 1.35,
    });
  }

  step(now: number) {
    this.pulses.step();
    this.auxPulses.step();
    this.structural.update(now);
    this.aux.update(now);
  }

  reset() {
    this.structural.clearAll();
    this.aux.clearAll();
    this.ghosts.clear();
    this.pulses.clear();
    this.auxPulses.clear();
    this.notices.length = 0;
  }
}
