// Entity contacts, rendered.
//
// A ghost is a photograph, not an object. It is written once when a contact arrives and
// is never touched again until a NEWER contact for the same entity replaces it wholesale.
// Fixed slots (rather than a ring buffer) make that replacement exact and make it
// structurally impossible for a ghost to drift toward its subject.

import * as THREE from 'three';
import { PKind } from './pointfield.ts';
import { Res } from '../shared/config.ts';
import { mulberry32 } from '../shared/math.ts';

const SLOT_POINTS = 900;
const SLOTS = 10;

/** Local-space humanoid, y-up, facing -Z. Returns [x,y,z,intensity] quads. */
function humanoid(n: number, crouch: boolean, rnd: () => number): number[] {
  const out: number[] = [];
  const sc = crouch ? 0.62 : 1;
  const push = (x: number, y: number, z: number, i: number) => out.push(x, y * sc, z, i);

  const parts = [
    // [count share, cx, cy, cz, rx, ry, rz, intensity]
    [0.13, 0, 1.60, 0, 0.105, 0.125, 0.105, 1.0],   // head
    [0.10, 0, 1.44, 0, 0.075, 0.06, 0.075, 0.85],   // neck
    [0.30, 0, 1.14, 0, 0.20, 0.26, 0.11, 0.95],     // torso
    [0.10, 0, 0.88, 0, 0.16, 0.09, 0.10, 0.8],      // hips
    [0.075, -0.255, 1.16, 0, 0.055, 0.24, 0.055, 0.7], // arm L
    [0.075, 0.255, 1.16, 0, 0.055, 0.24, 0.055, 0.7],  // arm R
    [0.11, -0.10, 0.44, 0, 0.07, 0.42, 0.07, 0.75],    // leg L
    [0.11, 0.10, 0.44, 0, 0.07, 0.42, 0.07, 0.75],     // leg R
  ] as const;

  for (const [share, cx, cy, cz, rx, ry, rz, inten] of parts) {
    const c = Math.max(2, Math.round(n * share));
    for (let i = 0; i < c; i++) {
      // Surface-biased sampling: silhouettes read better than solid blobs.
      let ux = rnd() * 2 - 1, uy = rnd() * 2 - 1, uz = rnd() * 2 - 1;
      const l = Math.hypot(ux, uy, uz) || 1;
      const shell = 0.82 + rnd() * 0.18;
      ux = (ux / l) * shell; uy = (uy / l) * shell; uz = (uz / l) * shell;
      push(cx + ux * rx, cy + uy * ry, cz + uz * rz, inten * (0.75 + rnd() * 0.25));
    }
  }
  return out;
}

/** A soft blob with a facing wedge — enough to say "someone, roughly there, roughly facing". */
function coarseBlob(n: number, rnd: () => number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = rnd() * Math.PI * 2, r = Math.pow(rnd(), 0.6) * 0.55;
    out.push(Math.cos(a) * r, 0.35 + rnd() * 1.35, Math.sin(a) * r, 0.5 + rnd() * 0.35);
  }
  // Facing wedge: a short spray forward, so a coarse contact still tells you where they looked.
  for (let i = 0; i < Math.round(n * 0.28); i++) {
    const t = 0.5 + rnd() * 1.4;
    const spread = (rnd() - 0.5) * t * 0.5;
    out.push(spread, 1.0 + (rnd() - 0.5) * 0.35, -t, 0.35 + rnd() * 0.2);
  }
  return out;
}

/** Bearing only: a vertical smudge with no shape to read. */
function traceSmudge(n: number, rnd: () => number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    out.push((rnd() - 0.5) * 1.1, 0.4 + rnd() * 1.4, (rnd() - 0.5) * 1.1, 0.3 + rnd() * 0.3);
  }
  return out;
}

interface Slot { id: number; at: number }

export class GhostField {
  readonly points: THREE.Points;
  private geom: THREE.BufferGeometry;
  private pos: THREE.BufferAttribute;
  private birth: THREE.BufferAttribute;
  private depth: THREE.BufferAttribute;
  private inten: THREE.BufferAttribute;
  private kind: THREE.BufferAttribute;
  private slots: (Slot | null)[] = new Array(SLOTS).fill(null);
  private nextSlot = 0;
  /** Last accepted contact time per entity, so an out-of-order packet cannot un-refresh a ghost. */
  private lastAt = new Map<number, number>();

  constructor(material: THREE.ShaderMaterial) {
    const cap = SLOTS * SLOT_POINTS;
    const g = new THREE.BufferGeometry();
    this.pos = new THREE.BufferAttribute(new Float32Array(cap * 3), 3);
    this.birth = new THREE.BufferAttribute(new Float32Array(cap).fill(-1e9), 1);
    this.depth = new THREE.BufferAttribute(new Float32Array(cap), 1);
    this.inten = new THREE.BufferAttribute(new Float32Array(cap), 1);
    this.kind = new THREE.BufferAttribute(new Float32Array(cap), 1);
    for (const a of [this.pos, this.birth, this.depth, this.inten, this.kind]) a.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', this.pos);
    g.setAttribute('aBirth', this.birth);
    g.setAttribute('aDepth', this.depth);
    g.setAttribute('aInt', this.inten);
    g.setAttribute('aKind', this.kind);
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this.geom = g;
    this.points = new THREE.Points(g, material);
    this.points.frustumCulled = false;
  }

  /**
   * Write a contact. Replaces any existing ghost for `id` wholesale.
   * `now` is the client clock; the ghost ages from the moment it was *captured*.
   */
  write(id: number, x: number, y: number, z: number, yaw: number, stance: number,
        vx: number, vz: number, res: Res, now: number, tag: number, predict: boolean) {
    const prev = this.lastAt.get(id) ?? -1e9;
    if (now < prev - 0.001) return; // never let a stale packet overwrite a newer sighting
    this.lastAt.set(id, now);

    let slot = this.slots.findIndex((s) => s?.id === id);
    if (slot < 0) {
      slot = this.slots.findIndex((s) => s === null);
      if (slot < 0) { slot = this.nextSlot; this.nextSlot = (this.nextSlot + 1) % SLOTS; }
    }
    this.slots[slot] = { id, at: now };

    const rnd = mulberry32((id * 2654435761 + tag) >>> 0);
    let quads: number[];
    if (res === Res.Full) quads = humanoid(560, stance === 0, rnd);
    else if (res === Res.Coarse) quads = coarseBlob(80, rnd);
    else quads = traceSmudge(18, rnd);

    const base = slot * SLOT_POINTS;
    const P = this.pos.array as Float32Array;
    const B = this.birth.array as Float32Array;
    const D = this.depth.array as Float32Array;
    const I = this.inten.array as Float32Array;
    const K = this.kind.array as Float32Array;

    const cy = Math.cos(yaw), sy = Math.sin(yaw);
    let w = 0;
    const put = (lx: number, ly: number, lz: number, inten: number) => {
      if (w >= SLOT_POINTS) return;
      const i = base + w++;
      // Local -Z is "forward"; rotate about Y into world space.
      P[i * 3] = x + (lx * cy - lz * sy);
      P[i * 3 + 1] = y + ly;
      P[i * 3 + 2] = z + (lx * sy + lz * cy);
      B[i] = now; D[i] = 0; I[i] = inten; K[i] = PKind.Ghost;
    };

    for (let q = 0; q < quads.length; q += 4) put(quads[q]!, quads[q + 1]!, quads[q + 2]!, quads[q + 3]!);

    // Motion smear: the 0.3s of travel captured with the pose. This is what lets a player
    // lead a shot into darkness — and what makes a still target read as *held still*.
    const sp = Math.hypot(vx, vz);
    if (res === Res.Full && sp > 0.6) {
      const n = 130;
      for (let i = 0; i < n; i++) {
        const t = (i / n) * 0.3;
        const jx = (rnd() - 0.5) * 0.28, jz = (rnd() - 0.5) * 0.28;
        const ly = 0.3 + rnd() * 1.35;
        const idx = base + w;
        if (w >= SLOT_POINTS) break;
        w++;
        P[idx * 3] = x - vx * t + jx;
        P[idx * 3 + 1] = y + ly;
        P[idx * 3 + 2] = z - vz * t + jz;
        B[idx] = now; D[idx] = 0; I[idx] = 0.42 * (1 - t / 0.3); K[idx] = PKind.Ghost;
      }
    }

    // EXTRAPOLATOR: the game does the leading maths and shows you its guess. Trusting it
    // is the player's decision, which is the entire point.
    if (predict && res === Res.Full && sp > 0.6) {
      for (let i = 0; i < 44 && w < SLOT_POINTS; i++) {
        const t = (i / 44) * 1.5;
        const idx = base + w++;
        P[idx * 3] = x + vx * t;
        P[idx * 3 + 1] = y + 0.9;
        P[idx * 3 + 2] = z + vz * t;
        B[idx] = now; D[idx] = 0; I[idx] = 0.30; K[idx] = PKind.Ghost;
      }
    }

    // Blank the rest of the slot so the previous, larger ghost cannot bleed through.
    for (; w < SLOT_POINTS; w++) B[base + w] = -1e9;

    for (const a of [this.pos, this.birth, this.depth, this.inten, this.kind]) {
      const mult = a === this.pos ? 3 : 1;
      a.addUpdateRange(base * mult, SLOT_POINTS * mult);
      a.needsUpdate = true;
    }
    this.geom.setDrawRange(0, SLOTS * SLOT_POINTS);
  }

  /** Where is our newest sighting of this entity? Used for HUD compass hints only. */
  lastSeen(id: number): number | undefined { return this.lastAt.get(id); }

  clear() {
    (this.birth.array as Float32Array).fill(-1e9);
    this.birth.addUpdateRange(0, SLOTS * SLOT_POINTS);
    this.birth.needsUpdate = true;
    this.slots.fill(null);
    this.lastAt.clear();
  }
}
