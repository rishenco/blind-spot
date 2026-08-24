/**
 * Prop shapes — silhouettes, and the point clouds that make them readable in the dark.
 *
 * Two constraints meet here, and they pull in opposite directions.
 *
 * The concept forbids textures, materials and PBR: a thing is only ever points and contours. So
 * the *only* way a bottle can be told from a can is its outline and its proportions. That means
 * shape has to carry all the information, and it means a shape has to be sampled densely enough
 * for the outline to survive.
 *
 * The static hall's mask is a 0.18 m lattice, which is right for a 24 m rack run and useless
 * here: a 0.5 m crate face gets three dots, a bottle gets one, and one dot is not a bottle, it is
 * a speck. So props do **not** share the world lattice. Every archetype carries its own pitch,
 * 0.025-0.05 m, chosen so its narrowest feature is at least two points across. A bottle ends up
 * with ~150 points and a visible neck; a barrel with ~700 and visible ribs.
 *
 * A shape is a short list of primitives in the body's local frame (Y up, origin on the floor
 * under the object). The same list produces three things and they can therefore never disagree:
 * the physics colliders, the debug "lights on" mesh, and the lidar point cloud. Points that fall
 * inside another primitive of the same object are dropped, so a neck welded into a shoulder reads
 * as one silhouette instead of two overlapping ghosts.
 */

/** One primitive of a compound shape, in body-local space. */
export type Part =
  /** A cylinder or truncated cone about the local Y axis, from y0 (radius r0) to y1 (radius r1). */
  | { kind: 'cyl'; y0: number; y1: number; r0: number; r1?: number }
  /** An axis-aligned box, given by its centre and half-extents. */
  | { kind: 'box'; cx: number; cy: number; cz: number; hx: number; hy: number; hz: number }
  /** A sphere on the local Y axis. */
  | { kind: 'ball'; cy: number; r: number };

/** What a thing is made of. Drives mass, bounce — and what it sounds like when it lands. */
export interface PropMaterial {
  readonly name: string;
  /** kg/m³ of the *collider volume*. Hollow things (a can, a drum) are far below the bulk metal. */
  readonly density: number;
  readonly restitution: number;
  readonly friction: number;
  /** Body resonance, Hz — the pitch you hear. Glass rings high, a wooden pallet thuds. */
  readonly ring: number;
  /** How long that resonance lasts, seconds at unit loudness. */
  readonly decay: number;
  /** 0 = pure tone, 1 = pure clatter. */
  readonly noise: number;
  /** Loudness multiplier: the same impulse into tin is louder than into wood. */
  readonly gain: number;
}

export const MATERIALS = {
  glass: { name: 'glass', density: 1400, restitution: 0.22, friction: 0.34, ring: 1650, decay: 0.5, noise: 0.22, gain: 1.15 },
  tin: { name: 'tin', density: 320, restitution: 0.4, friction: 0.4, ring: 880, decay: 0.28, noise: 0.55, gain: 1.3 },
  steel: { name: 'steel', density: 780, restitution: 0.24, friction: 0.55, ring: 240, decay: 0.9, noise: 0.3, gain: 1.4 },
  wood: { name: 'wood', density: 480, restitution: 0.12, friction: 0.72, ring: 190, decay: 0.13, noise: 0.72, gain: 0.85 },
  plastic: { name: 'plastic', density: 260, restitution: 0.32, friction: 0.5, ring: 540, decay: 0.16, noise: 0.5, gain: 0.7 },
} as const satisfies Record<string, PropMaterial>;

export type MaterialName = keyof typeof MATERIALS;

export interface Archetype {
  readonly name: string;
  readonly parts: readonly Part[];
  /** Point pitch on this object's surface, metres. Its own, not the world's. */
  readonly pitch: number;
  readonly material: MaterialName;
  /**
   * How this thing sits when it is placed: 'up' stands on its base, 'lie' is tipped onto its
   * side (a pipe, a spool), 'any' is chosen per instance. Purely a spawn hint.
   */
  readonly rest: 'up' | 'lie' | 'any';
  /** Relative spawn weight inside its size class. */
  readonly weight: number;
}

const cyl = (y0: number, y1: number, r0: number, r1?: number): Part => ({ kind: 'cyl', y0, y1, r0, r1 });
const box = (cy: number, hx: number, hy: number, hz: number, cx = 0, cz = 0): Part =>
  ({ kind: 'box', cx, cy, cz, hx, hy, hz });

/**
 * The catalogue. Fifteen silhouettes, deliberately spread across size, proportion and material:
 * tall-and-thin, squat-and-wide, flat, round, ribbed, handled. If two of them read the same at
 * four metres, one of them is not earning its place.
 */
export const ARCHETYPES: readonly Archetype[] = [
  {
    name: 'bottle', pitch: 0.026, material: 'glass', rest: 'any', weight: 1.0,
    parts: [cyl(0, 0.19, 0.038), cyl(0.19, 0.255, 0.038, 0.017), cyl(0.255, 0.305, 0.017), cyl(0.305, 0.322, 0.02)],
  },
  {
    name: 'flask', pitch: 0.026, material: 'glass', rest: 'up', weight: 0.55,
    parts: [cyl(0, 0.022, 0.055), { kind: 'ball', cy: 0.095, r: 0.088 }, cyl(0.17, 0.235, 0.022), cyl(0.235, 0.25, 0.029)],
  },
  {
    name: 'jar', pitch: 0.026, material: 'glass', rest: 'up', weight: 0.7,
    parts: [cyl(0, 0.128, 0.056), cyl(0.128, 0.152, 0.056, 0.04), cyl(0.152, 0.17, 0.043)],
  },
  {
    name: 'can', pitch: 0.022, material: 'tin', rest: 'any', weight: 1.3,
    parts: [cyl(0, 0.012, 0.035), cyl(0.012, 0.102, 0.033), cyl(0.102, 0.114, 0.035)],
  },
  {
    name: 'paint-tin', pitch: 0.03, material: 'tin', rest: 'up', weight: 0.7,
    parts: [cyl(0, 0.18, 0.125), cyl(0.18, 0.196, 0.132)],
  },
  {
    name: 'canister', pitch: 0.034, material: 'plastic', rest: 'up', weight: 0.8,
    parts: [box(0.17, 0.115, 0.17, 0.075), box(0.375, 0.05, 0.035, 0.05), cyl(0.41, 0.455, 0.023)],
  },
  {
    name: 'bucket', pitch: 0.036, material: 'plastic', rest: 'any', weight: 0.9,
    parts: [cyl(0, 0.3, 0.13, 0.19), cyl(0.3, 0.325, 0.2)],
  },
  {
    name: 'barrel', pitch: 0.06, material: 'steel', rest: 'up', weight: 0.75,
    parts: [
      cyl(0, 0.1, 0.265, 0.295), cyl(0.1, 0.24, 0.295), cyl(0.24, 0.3, 0.315),
      cyl(0.3, 0.56, 0.295), cyl(0.56, 0.62, 0.315), cyl(0.62, 0.78, 0.295),
      cyl(0.78, 0.88, 0.295, 0.265),
    ],
  },
  {
    name: 'keg', pitch: 0.05, material: 'steel', rest: 'up', weight: 0.5,
    parts: [cyl(0, 0.055, 0.185), cyl(0.055, 0.46, 0.21), cyl(0.46, 0.52, 0.185), cyl(0.52, 0.55, 0.16)],
  },
  {
    name: 'gas-cylinder', pitch: 0.045, material: 'steel', rest: 'any', weight: 0.5,
    parts: [cyl(0, 0.98, 0.11), cyl(0.98, 1.1, 0.11, 0.05), cyl(1.1, 1.19, 0.032), cyl(1.19, 1.22, 0.048)],
  },
  {
    name: 'pipe', pitch: 0.05, material: 'steel', rest: 'lie', weight: 0.8,
    parts: [cyl(0, 1.75, 0.058)],
  },
  {
    name: 'spool', pitch: 0.055, material: 'wood', rest: 'lie', weight: 0.45,
    parts: [cyl(0, 0.055, 0.31), cyl(0.055, 0.36, 0.125), cyl(0.36, 0.415, 0.31)],
  },
  {
    name: 'pallet', pitch: 0.065, material: 'wood', rest: 'up', weight: 0.6,
    parts: [
      box(0.036, 0.055, 0.036, 0.6, -0.53, 0), box(0.036, 0.055, 0.036, 0.6, 0, 0), box(0.036, 0.055, 0.036, 0.6, 0.53, 0),
      box(0.085, 0.6, 0.013, 0.06, 0, -0.54), box(0.085, 0.6, 0.013, 0.06, 0, -0.27),
      box(0.085, 0.6, 0.013, 0.06, 0, 0), box(0.085, 0.6, 0.013, 0.06, 0, 0.27), box(0.085, 0.6, 0.013, 0.06, 0, 0.54),
    ],
  },
  {
    name: 'crate', pitch: 0.05, material: 'wood', rest: 'up', weight: 1.1,
    parts: [box(0.21, 0.26, 0.21, 0.19)],
  },
  {
    name: 'toolbox', pitch: 0.038, material: 'steel', rest: 'up', weight: 0.55,
    parts: [box(0.09, 0.21, 0.09, 0.1), box(0.2, 0.04, 0.02, 0.02), box(0.16, 0.02, 0.045, 0.02, -0.11), box(0.16, 0.02, 0.045, 0.02, 0.11)],
  },
];

export function archetypeByName(name: string): number {
  return ARCHETYPES.findIndex((a) => a.name === name);
}

// ---------------------------------------------------------------------------
// Sampling
// ---------------------------------------------------------------------------

/** Is this point strictly inside the primitive (by `eps`)? Used to weld a compound silhouette. */
function insidePart(p: Part, x: number, y: number, z: number, eps: number): boolean {
  if (p.kind === 'box') {
    return (
      Math.abs(x - p.cx) < p.hx - eps &&
      Math.abs(y - p.cy) < p.hy - eps &&
      Math.abs(z - p.cz) < p.hz - eps
    );
  }
  if (p.kind === 'ball') {
    return Math.hypot(x, y - p.cy, z) < p.r - eps;
  }
  if (y < p.y0 + eps || y > p.y1 - eps) return false;
  const t = (y - p.y0) / Math.max(1e-6, p.y1 - p.y0);
  const r = p.r0 + ((p.r1 ?? p.r0) - p.r0) * t;
  return Math.hypot(x, z) < r - eps;
}

export interface PointCloud {
  /** Local positions, 3 per point. */
  readonly pos: Float32Array;
  /** Outward normals, 3 per point. */
  readonly nrm: Float32Array;
  readonly count: number;
  /** Radius of the local bounding sphere about the local origin. */
  readonly radius: number;
  /** Local AABB, [minX,minY,minZ,maxX,maxY,maxZ]. */
  readonly bounds: number[];
}

/**
 * Turns a compound shape into the point cloud the lidar unlocks.
 *
 * Lateral surfaces are sampled in rings so the outline is continuous — a ring of points around a
 * bottle's neck is what makes it a neck rather than three stray dots. Caps get concentric rings
 * so a barrel lid reads as a disc. Everything buried inside a sibling primitive is dropped.
 */
export function sampleShape(parts: readonly Part[], pitch: number, seed = 1): PointCloud {
  const pos: number[] = [];
  const nrm: number[] = [];
  let rnd = seed >>> 0;
  // A whisper of jitter, so a ring does not alias into a picket fence when seen edge-on.
  const jit = (): number => {
    rnd = (rnd * 1664525 + 1013904223) >>> 0;
    return ((rnd / 4294967296) - 0.5) * pitch * 0.18;
  };

  const push = (x: number, y: number, z: number, nx: number, ny: number, nz: number, self: Part): void => {
    // Buried surface, dropped two ways. Strictly inside a sibling is the obvious one; the one
    // that actually matters is a *face against* a sibling — the shared lid between two stacked
    // cylinders of a barrel is a boundary, not an interior, so it passes the first test and
    // would fill the barrel with invisible discs. Step off along the outward normal and ask
    // whether that is inside anything: if it is, nothing can ever see this patch.
    const ox = x + nx * pitch * 0.5;
    const oy = y + ny * pitch * 0.5;
    const oz = z + nz * pitch * 0.5;
    for (const other of parts) {
      if (other === self) continue;
      if (insidePart(other, x, y, z, pitch * 0.35)) return;
      if (insidePart(other, ox, oy, oz, 0)) return;
    }
    pos.push(x + jit(), y + jit(), z + jit());
    nrm.push(nx, ny, nz);
  };

  /** A flat annulus at height `y` facing `sign`, from radius 0 to `r`. */
  const disc = (y: number, r: number, sign: number, self: Part): void => {
    const rings = Math.max(1, Math.round(r / pitch));
    for (let i = 0; i < rings; i++) {
      const rr = ((i + 0.5) / rings) * r;
      const n = Math.max(4, Math.round((2 * Math.PI * rr) / pitch));
      for (let k = 0; k < n; k++) {
        const a = (k / n) * Math.PI * 2 + i * 0.7;
        push(Math.cos(a) * rr, y, Math.sin(a) * rr, 0, sign, 0, self);
      }
    }
  };

  for (const part of parts) {
    if (part.kind === 'cyl') {
      const r1 = part.r1 ?? part.r0;
      const dy = part.y1 - part.y0;
      const dr = r1 - part.r0;
      const slant = Math.hypot(dy, dr);
      const rings = Math.max(2, Math.round(slant / pitch) + 1);
      // Outward normal of the lateral surface, in the (radial, y) plane.
      const nr = dy / slant;
      const ny = -dr / slant;
      for (let i = 0; i < rings; i++) {
        const t = rings === 1 ? 0.5 : i / (rings - 1);
        const y = part.y0 + dy * t;
        const r = part.r0 + dr * t;
        if (r < 1e-4) continue;
        const n = Math.max(5, Math.round((2 * Math.PI * r) / pitch));
        for (let k = 0; k < n; k++) {
          const a = (k / n) * Math.PI * 2 + i * 0.37;
          const ca = Math.cos(a);
          const sa = Math.sin(a);
          push(ca * r, y, sa * r, ca * nr, ny, sa * nr, part);
        }
      }
      disc(part.y0, part.r0, -1, part);
      disc(part.y1, r1, 1, part);
    } else if (part.kind === 'ball') {
      // Fibonacci sphere: the one distribution that stays even without poles.
      const n = Math.max(24, Math.round((4 * Math.PI * part.r * part.r) / (pitch * pitch)));
      const ga = Math.PI * (3 - Math.sqrt(5));
      for (let i = 0; i < n; i++) {
        const yy = 1 - (2 * (i + 0.5)) / n;
        const rr = Math.sqrt(Math.max(0, 1 - yy * yy));
        const a = ga * i;
        const nx = Math.cos(a) * rr;
        const nz = Math.sin(a) * rr;
        push(nx * part.r, part.cy + yy * part.r, nz * part.r, nx, yy, nz, part);
      }
    } else {
      const h = [part.hx, part.hy, part.hz];
      const c = [part.cx, part.cy, part.cz];
      for (let axis = 0; axis < 3; axis++) {
        const u = (axis + 1) % 3;
        const v = (axis + 2) % 3;
        const nu = Math.max(1, Math.round((h[u]! * 2) / pitch));
        const nv = Math.max(1, Math.round((h[v]! * 2) / pitch));
        for (const sign of [1, -1]) {
          for (let i = 0; i < nu; i++) {
            for (let j = 0; j < nv; j++) {
              const p = [0, 0, 0];
              const nn = [0, 0, 0];
              p[axis] = c[axis]! + h[axis]! * sign;
              p[u] = c[u]! - h[u]! + ((i + 0.5) / nu) * h[u]! * 2;
              p[v] = c[v]! - h[v]! + ((j + 0.5) / nv) * h[v]! * 2;
              nn[axis] = sign;
              push(p[0]!, p[1]!, p[2]!, nn[0]!, nn[1]!, nn[2]!, part);
            }
          }
        }
      }
    }
  }

  const count = pos.length / 3;
  let radius = 0;
  const bounds = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (let i = 0; i < count; i++) {
    const x = pos[i * 3]!;
    const y = pos[i * 3 + 1]!;
    const z = pos[i * 3 + 2]!;
    radius = Math.max(radius, Math.hypot(x, y, z));
    bounds[0] = Math.min(bounds[0]!, x);
    bounds[1] = Math.min(bounds[1]!, y);
    bounds[2] = Math.min(bounds[2]!, z);
    bounds[3] = Math.max(bounds[3]!, x);
    bounds[4] = Math.max(bounds[4]!, y);
    bounds[5] = Math.max(bounds[5]!, z);
  }
  return { pos: new Float32Array(pos), nrm: new Float32Array(nrm), count, radius, bounds };
}
