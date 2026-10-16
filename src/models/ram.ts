import * as THREE from 'three';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { ModelDef } from './types';
import { mat, PALETTE } from '../style';

// ANGRY RAM. Meters, +Y up, faces +Z, hooves on y=0, ~1.1 m at the shoulder, ~1.65 m long.
//
// Rig (all pivots are named Groups placed at the joint):
//   body                    inner root (center of mass, y=0.75) — tilt / spin / bob
//   ├ neck                  base of neck; +x rotation = head down
//   │ └ head                poll joint; carries horns, eyes, brows
//   │   ├ jaw               lower jaw; +x rotation = mouth open
//   │   ├ hornL / hornR     the grab handles (static meshes, named for lookup)
//   │   └ stars             dizzy stars, only visible in 'stunned'
//   ├ legFL legFR legBL legBR   shoulder/hip pivots; +x rotation = leg swings back
//   │ └ legXX_low           knee pivot; front +x = hoof back
//   └ tail
// Poses never move the root; they only animate the parts above.

const C = {
  ...PALETTE,
  faceDark: 0x3e3026,
  nostril: 0x1a1210,
  brow: 0x2b1e16,
  mouth: 0x5a1a1a,
  hornDark: 0xa8946a,
  star: 0xffd84a,
  tooth: 0xf4efe0,
};

const BODY_Y = 0.75;
const HIP_Y = -0.07; // relative to body pivot
const UPPER = 0.34;
const LOWER = 0.26;
const HOOF = 0.08;

// ---------- geometry helpers ----------

function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Faceted lumpy blob (icosahedron with jittered verts). */
function lumpy(r: number, detail: number, sx: number, sy: number, sz: number, jitter: number, seed: number) {
  let g: THREE.BufferGeometry = new THREE.IcosahedronGeometry(r, detail);
  g.deleteAttribute('normal');
  g.deleteAttribute('uv');
  g = mergeVertices(g);
  const rand = rng(seed);
  const p = g.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const k = 1 + (rand() - 0.5) * 2 * jitter;
    p.setXYZ(i, p.getX(i) * k * sx, p.getY(i) * k * sy, p.getZ(i) * k * sz);
  }
  g.computeVertexNormals();
  return g;
}

/** Box whose +Z face is scaled (fx, fy) and shifted down by dy — wedge heads, snouts. */
function taperBox(w: number, h: number, d: number, fx: number, fy: number, dy = 0) {
  const g = new THREE.BoxGeometry(w, h, d);
  const p = g.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    if (p.getZ(i) > 0) p.setXYZ(i, p.getX(i) * fx, p.getY(i) * fy + dy, p.getZ(i));
  }
  g.computeVertexNormals();
  return g;
}

/** Cylinder hanging down from y=0. */
function limb(rTop: number, rBot: number, len: number, seg = 6) {
  return new THREE.CylinderGeometry(rTop, rBot, len, seg).translate(0, -len / 2, 0);
}

/** Tapering, ridged tube along a curl — the ram horn. s = +1 (ram's left, +X) or -1. */
function hornGeo(s: number) {
  const N = 26;
  const RAD = 6;
  const pts: THREE.Vector3[] = [];
  // spiral centred beside the ear; starts on top of the skull, sweeps back, down under the
  // ear, forward past the cheek, tip flaring outward and up beside the eye
  const cx = 0.11, cy = -0.07, cz = -0.03;
  const turns = 1.75 * Math.PI;
  for (let i = 0; i <= N; i++) {
    const u = i / N;
    const th = -0.45 + u * turns;
    const r = 0.24 * (1 - 0.38 * u);
    const x = s * (cx + 0.06 * Math.sin(u * Math.PI) + 0.25 * Math.pow(u, 1.5));
    pts.push(new THREE.Vector3(x, cy + r * Math.cos(th), cz - r * Math.sin(th)));
  }
  const curve = new THREE.CatmullRomCurve3(pts);
  const frames = curve.computeFrenetFrames(N, false);
  const pos: number[] = [];
  const idx: number[] = [];
  const P = new THREE.Vector3();
  for (let i = 0; i <= N; i++) {
    const u = i / N;
    curve.getPointAt(u, P);
    let rad = 0.115 * Math.pow(1 - u, 0.8) + 0.012;
    if (i % 2 === 1 && i < N - 2) rad *= 1.12; // growth ridges
    if (i === N) rad = 0.004;
    const nrm = frames.normals[i], bin = frames.binormals[i];
    for (let j = 0; j < RAD; j++) {
      const a = (j / RAD) * Math.PI * 2;
      // slightly flattened (triangular-ish) cross-section like a real horn
      const ca = Math.cos(a) * rad * 1.15, sa = Math.sin(a) * rad * 0.85;
      pos.push(P.x + nrm.x * ca + bin.x * sa, P.y + nrm.y * ca + bin.y * sa, P.z + nrm.z * ca + bin.z * sa);
    }
  }
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < RAD; j++) {
      const a = i * RAD + j, b = i * RAD + ((j + 1) % RAD);
      const c = a + RAD, d = b + RAD;
      idx.push(a, b, c, b, d, c);
    }
  }
  // cap the root end so it never shows as an open ring
  const p0 = pts[0], ci = pos.length / 3;
  pos.push(p0.x - frames.tangents[0].x * 0.03, p0.y - frames.tangents[0].y * 0.03, p0.z - frames.tangents[0].z * 0.03);
  for (let j = 0; j < RAD; j++) idx.push(ci, (j + 1) % RAD, j);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function mesh(geo: THREE.BufferGeometry, color: number, opts: { emissive?: number } = {}) {
  return new THREE.Mesh(geo, mat(color, opts));
}

function pivot(name: string, x: number, y: number, z: number, parent: THREE.Object3D) {
  const g = new THREE.Group();
  g.name = name;
  g.position.set(x, y, z);
  parent.add(g);
  return g;
}

// ---------- build ----------

function buildLeg(body: THREE.Object3D, name: string, x: number, z: number, front: boolean, seed: number) {
  const hip = pivot(name, x, HIP_Y, z, body);
  const s = Math.sign(x);
  // woolly shoulder / thigh so the joint never gaps out of the fleece
  const fluff = mesh(
    lumpy(front ? 0.15 : 0.17, 0, 1, front ? 1.4 : 1.5, front ? 1.1 : 1.2, 0.12, seed),
    front ? C.wool : C.woolShade,
  );
  fluff.position.set(s * 0.02, front ? -0.06 : -0.08, front ? 0.01 : -0.02);
  hip.add(fluff);
  const upper = mesh(limb(front ? 0.095 : 0.11, 0.068, UPPER + 0.02), C.ramFace);
  hip.add(upper);
  const knee = pivot(name + '_low', 0, -UPPER, 0, hip);
  knee.add(mesh(new THREE.IcosahedronGeometry(0.062, 0), C.ramFace));
  const lower = mesh(limb(0.062, 0.05, LOWER + 0.01, 5), C.ramFace);
  knee.add(lower);
  const hoof = mesh(new THREE.CylinderGeometry(0.052, 0.072, HOOF, 6).translate(0, -HOOF / 2, 0), C.hoof);
  hoof.position.set(0, -LOWER, 0.012);
  knee.add(hoof);
  return hip;
}

function buildHead(neck: THREE.Object3D) {
  const head = pivot('head', 0, 0.2, 0.3, neck);
  head.rotation.x = 0.55; // snout angled down-forward at rest
  head.scale.setScalar(1.12); // cartoon big head

  // skull wedge + snout
  const skull = mesh(taperBox(0.34, 0.3, 0.42, 0.6, 0.66, -0.03), C.ramFace);
  skull.position.set(0, -0.04, 0.15);
  head.add(skull);
  const snout = mesh(taperBox(0.2, 0.18, 0.12, 0.85, 0.8), C.faceDark);
  snout.position.set(0, -0.08, 0.41);
  head.add(snout);
  // flared nostrils
  for (const s of [-1, 1]) {
    const n = mesh(new THREE.CylinderGeometry(0.032, 0.022, 0.05, 6).rotateX(Math.PI / 2), C.nostril);
    n.position.set(s * 0.045, -0.06, 0.47);
    n.rotation.y = s * 0.35;
    head.add(n);
  }
  // forehead boss — a hard battering block between the horns
  const boss = mesh(lumpy(0.13, 0, 1.25, 0.65, 1, 0.08, 7), C.faceDark);
  boss.position.set(0, 0.1, 0.06);
  head.add(boss);
  // glowing rage eyes + furious V brows (big enough to read head-on)
  for (const s of [-1, 1]) {
    const eye = mesh(new THREE.OctahedronGeometry(0.068, 0).scale(0.9, 0.65, 1), C.eyeRage, { emissive: C.eyeRage });
    eye.name = s > 0 ? 'eyeL' : 'eyeR';
    eye.position.set(s * 0.135, 0.03, 0.215);
    eye.rotation.y = s * 0.5;
    head.add(eye);
    const brow = mesh(new THREE.BoxGeometry(0.15, 0.045, 0.09), C.brow);
    brow.position.set(s * 0.1, 0.095, 0.22);
    brow.rotation.set(-0.25, s * 0.35, s * 0.5);
    head.add(brow);
    // ears tucked under the horn curl
    const ear = mesh(taperBox(0.05, 0.03, 0.14, 0.6, 0.4).rotateY(s * (Math.PI / 2 + 0.3)), C.faceDark);
    ear.position.set(s * 0.17, -0.04, -0.02);
    ear.rotation.z = s * -0.35;
    head.add(ear);
  }
  // mouth interior (visible when the jaw drops)
  const mouth = mesh(new THREE.BoxGeometry(0.13, 0.04, 0.3), C.mouth);
  mouth.position.set(0, -0.17, 0.25);
  head.add(mouth);
  // jaw
  const jaw = pivot('jaw', 0, -0.16, 0.06, head);
  const jawM = mesh(taperBox(0.2, 0.07, 0.36, 0.7, 0.8, 0.005), C.ramFace);
  jawM.position.set(0, -0.03, 0.18);
  jaw.add(jawM);
  // scruffy goatee
  const beard = mesh(lumpy(0.06, 0, 1, 1.6, 1, 0.15, 11), C.woolShade);
  beard.position.set(0, -0.09, 0.12);
  jaw.add(beard);

  // THE HORNS
  for (const s of [-1, 1]) {
    const h = mesh(hornGeo(s), C.horn);
    h.name = s > 0 ? 'hornL' : 'hornR';
    // curl is authored in an upright frame; undo most of the head's resting pitch
    h.rotation.x = -0.45;
    h.position.set(0, 0.04, -0.02);
    head.add(h);
  }

  // dizzy stars (stunned only)
  const stars = pivot('stars', 0, 0.42, 0.05, head);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2;
    const st = mesh(new THREE.OctahedronGeometry(0.055, 0).scale(1, 1, 0.45), C.star, { emissive: 0x806010 });
    st.position.set(Math.cos(a) * 0.26, 0, Math.sin(a) * 0.26);
    stars.add(st);
  }
  stars.visible = false;
  return head;
}

function build(): THREE.Object3D {
  const root = new THREE.Group();
  root.name = 'ram';
  const body = pivot('body', 0, BODY_Y, 0, root);

  // fleece: main barrel, chest, rump and a crop of tufts
  const barrel = mesh(lumpy(1, 1, 0.42, 0.31, 0.62, 0.07, 1), C.wool);
  barrel.position.set(0, 0.05, -0.08);
  body.add(barrel);
  const chest = mesh(lumpy(0.37, 1, 1.05, 1, 0.9, 0.08, 2), C.wool);
  chest.position.set(0, 0.09, 0.3);
  body.add(chest);
  const belly = mesh(lumpy(1, 1, 0.33, 0.18, 0.5, 0.08, 3), C.woolShade);
  belly.position.set(0, -0.12, -0.05);
  body.add(belly);
  const rump = mesh(lumpy(0.34, 1, 1.05, 0.95, 0.8, 0.08, 4), C.wool);
  rump.position.set(0, 0.06, -0.42);
  body.add(rump);
  const rand = rng(99);
  for (let i = 0; i < 16; i++) {
    const a = rand() * Math.PI * 2;
    const zz = -0.6 + rand() * 1.05;
    const r = 0.08 + rand() * 0.05;
    const tuft = mesh(lumpy(r, 0, 1, 0.7, 1, 0.15, 20 + i), rand() < 0.3 ? C.woolShade : C.wool);
    const ang = (0.35 + rand() * 0.5) * Math.PI * (i % 2 ? 1 : -1); // flanks, off the spine & belly
    tuft.position.set(Math.sin(ang) * 0.38, 0.05 + Math.cos(ang) * 0.27, zz);
    tuft.rotation.set(a, a * 2, 0);
    body.add(tuft);
  }

  // neck / mane
  const neck = pivot('neck', 0, 0.2, 0.42, body);
  const mane = mesh(lumpy(0.2, 1, 1, 1.1, 1.2, 0.1, 5), C.wool);
  mane.position.set(0, 0.04, 0.1);
  neck.add(mane);
  const throat = mesh(lumpy(0.15, 0, 1, 1.3, 1, 0.1, 6), C.woolShade);
  throat.position.set(0, -0.06, 0.18);
  neck.add(throat);
  buildHead(neck);

  buildLeg(body, 'legFL', 0.17, 0.38, true, 30);
  buildLeg(body, 'legFR', -0.17, 0.38, true, 31);
  buildLeg(body, 'legBL', 0.17, -0.45, false, 32);
  buildLeg(body, 'legBR', -0.17, -0.45, false, 33);

  const tail = pivot('tail', 0, 0.14, -0.7, body);
  tail.rotation.x = -0.5;
  const tm = mesh(lumpy(0.075, 0, 1, 1.7, 1, 0.15, 40), C.wool);
  tm.position.set(0, -0.08, -0.02);
  tail.add(tm);

  // remember rest transforms for reset()
  root.traverse((o) => {
    o.userData.rest = { p: o.position.clone(), r: o.rotation.clone(), s: o.scale.clone() };
  });
  return root;
}

// ---------- posing ----------

type Parts = Record<
  | 'body' | 'neck' | 'head' | 'jaw' | 'tail' | 'stars'
  | 'legFL' | 'legFR' | 'legBL' | 'legBR'
  | 'legFL_low' | 'legFR_low' | 'legBL_low' | 'legBR_low',
  THREE.Object3D
>;
const NAMES = [
  'body', 'neck', 'head', 'jaw', 'tail', 'stars', 'legFL', 'legFR', 'legBL', 'legBR',
  'legFL_low', 'legFR_low', 'legBL_low', 'legBR_low',
] as const;
const partCache = new WeakMap<THREE.Object3D, Parts>();

function parts(root: THREE.Object3D): Parts {
  let p = partCache.get(root);
  if (!p) {
    p = {} as Parts;
    for (const n of NAMES) p[n] = root.getObjectByName(n)!;
    partCache.set(root, p);
  }
  return p;
}

/** Restore every animated part to rest; returns the parts for the pose to offset from. */
function reset(root: THREE.Object3D): Parts {
  const p = parts(root);
  for (const n of NAMES) {
    const o = p[n];
    const r = o.userData.rest as { p: THREE.Vector3; r: THREE.Euler; s: THREE.Vector3 };
    o.position.copy(r.p);
    o.rotation.copy(r.r);
    o.scale.copy(r.s);
  }
  p.stars.visible = false;
  return p;
}

/** Add rotation deltas on top of rest. */
function rot(o: THREE.Object3D, x = 0, y = 0, z = 0) {
  const r = (o.userData.rest as { r: THREE.Euler }).r;
  o.rotation.set(r.x + x, r.y + y, r.z + z);
}

const TAU = Math.PI * 2;
const sin = Math.sin, cos = Math.cos;
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const ease = (v: number) => {
  v = clamp01(v);
  return 1 - (1 - v) * (1 - v) * (1 - v);
};

/** Raise the body so the given hip (body-local y,z) has its hoof touching y=0 with leg angle a. */
function groundHip(pitch: number, hipY: number, hipZ: number, legWorldAngle: number, legLen = UPPER + LOWER + HOOF) {
  const y = hipY * cos(pitch) - hipZ * sin(pitch);
  return legLen * cos(legWorldAngle) - y;
}

function idle(root: THREE.Object3D, t: number) {
  const p = reset(root);
  const b = sin(t * TAU * 1.1); // heavy angry breathing
  const huff = Math.pow(Math.max(0, b), 3);
  p.body.position.y += 0.012 * b;
  p.body.scale.set(1 + 0.025 * b, 1 + 0.02 * b, 1);
  rot(p.body, -0.02 * b);
  rot(p.neck, 0.12 + 0.07 * sin(t * TAU * 1.1 + 0.6), 0.12 * sin(t * 0.9), 0);
  rot(p.head, 0.05 * huff, 0.08 * sin(t * 1.7), 0.05 * sin(t * 1.3));
  rot(p.jaw, 0.08 * huff);
  // tail flicks in short bursts
  const ph = t % 1.6;
  rot(p.tail, 0, ph < 0.4 ? 0.6 * sin(ph * TAU * 5) : 0, 0);
  // occasional impatient hoof tap
  const tp = t % 2.4;
  const tap = tp > 1.9 ? sin(((tp - 1.9) / 0.5) * Math.PI) : 0;
  rot(p.legFR, -0.3 * tap);
  rot(p.legFR_low, 0.9 * tap);
}

function paw(root: THREE.Object3D, t: number) {
  const p = reset(root);
  const c = (t % 0.5) / 0.5; // two scrapes per second
  // head low, horns aimed, weight rocked back on the haunches
  const rock = sin(c * TAU);
  rot(p.body, -0.1 + 0.05 * rock, 0, 0.03 * rock);
  p.body.position.z -= 0.06 + 0.03 * rock;
  p.body.position.y -= 0.03;
  rot(p.neck, 0.5 + 0.06 * sin(c * TAU + 1), 0.05 * rock);
  rot(p.head, 0.12, 0, 0.06 * rock);
  rot(p.jaw, 0.05);
  rot(p.tail, -0.6 - 0.3 * Math.abs(rock));
  // scraping hoof: lift & reach forward (0-0.35), stamp (0.35-0.45), drag back hard (0.45-1)
  let sh: number, kn: number;
  if (c < 0.35) {
    const k = ease(c / 0.35);
    sh = 0.45 - 1.25 * k;
    kn = 1.6 * sin(k * Math.PI) + 0.2 * k;
  } else if (c < 0.45) {
    const k = (c - 0.35) / 0.1;
    sh = -0.8 + 0.25 * k;
    kn = 0.2 * (1 - k);
  } else {
    const k = ease((c - 0.45) / 0.55);
    sh = -0.55 + 1.0 * k;
    kn = 0;
  }
  rot(p.legFR, sh + 0.1);
  rot(p.legFR_low, kn);
  // the other three legs brace; body pitch compensation so hooves stay planted
  rot(p.legFL, 0.1 - 0.05 * rock);
  rot(p.legBL, -0.25 - 0.05 * rock);
  rot(p.legBR, -0.25 - 0.05 * rock);
  rot(p.legBL_low, 0.2);
  rot(p.legBR_low, 0.2);
}

function charge(root: THREE.Object3D, t: number) {
  const p = reset(root);
  const w = t * TAU * 3; // 3 strides / s
  rot(p.body, 0.1 + 0.07 * sin(w), 0, 0.03 * sin(w * 0.5));
  p.body.position.y += -0.06 + 0.07 * Math.abs(sin(w));
  p.body.scale.set(1, 0.97, 1.04);
  rot(p.neck, 0.45 + 0.08 * sin(w + 1), 0, 0);
  rot(p.head, -0.02 - 0.06 * sin(w + 1.4), 0, 0);
  rot(p.jaw, 0.12 + 0.06 * sin(w));
  rot(p.tail, -1.1 + 0.25 * sin(w * 2));
  // gallop: big reach, knees fold on recovery
  const leg = (hip: THREE.Object3D, kneeO: THREE.Object3D, ph: number, front: boolean) => {
    const s = sin(w + ph);
    rot(hip, (front ? 0.75 : 0.65) * s + (front ? -0.1 : 0.15));
    const recovering = Math.max(0, cos(w + ph));
    rot(kneeO, front ? 1.3 * recovering : -0.9 * recovering);
  };
  leg(p.legFL, p.legFL_low, 0, true);
  leg(p.legFR, p.legFR_low, 0.5, true);
  leg(p.legBL, p.legBL_low, Math.PI + 0.3, false);
  leg(p.legBR, p.legBR_low, Math.PI + 0.8, false);
}

function skid(root: THREE.Object3D, t: number) {
  const p = reset(root);
  const k = ease(t / 0.15);
  const shake = sin(t * 90) * (1 - clamp01(t / 0.5)) * 0.04;
  const pitch = 0.5 * k + shake;
  rot(p.body, pitch, 0, shake);
  // front legs jammed forward stiff, butt flipping up
  const fa = -0.85 * k;
  rot(p.legFL, fa - pitch);
  rot(p.legFR, fa - pitch + 0.05);
  rot(p.legFL_low, -0.05 * k);
  rot(p.legFR_low, -0.05 * k);
  p.body.position.y += groundHip(pitch, HIP_Y, 0.38, fa) - (BODY_Y - 0) ;
  // rear legs lifted and trailing
  rot(p.legBL, 0.95 * k - pitch, 0, 0.12 * k);
  rot(p.legBR, 0.8 * k - pitch, 0, -0.12 * k);
  rot(p.legBL_low, -0.5 * k);
  rot(p.legBR_low, -0.4 * k);
  // head snaps up in alarm, mouth agape
  rot(p.neck, -0.55 * k - pitch, 0, 0);
  rot(p.head, -0.25 * k, 0, 0);
  rot(p.jaw, 0.5 * k);
  rot(p.tail, -1.4 * k);
}

function stunned(root: THREE.Object3D, t: number) {
  const p = reset(root);
  const sw = sin(t * TAU * 0.7);
  const sp = 0.28;
  rot(p.body, 0.05, 0.08 * sin(t * TAU * 0.35), 0.12 * sw);
  p.body.position.y -= 0.06;
  p.body.position.x += -0.04 * sw;
  rot(p.legFL, 0.1, 0, sp - 0.1 * sw);
  rot(p.legBL, -0.1, 0, sp - 0.1 * sw);
  rot(p.legFR, 0.1, 0, -sp - 0.1 * sw);
  rot(p.legBR, -0.1, 0, -sp - 0.1 * sw);
  rot(p.legFL_low, 0.15);
  rot(p.legFR_low, 0.15);
  // drunken head circles
  const a = t * TAU * 0.9;
  rot(p.neck, 0.3 + 0.15 * sin(a), 0.25 * cos(a), 0.15 * sin(a));
  rot(p.head, 0.1 * cos(a), 0, 0.35 * sin(a + 0.5));
  rot(p.jaw, 0.25 + 0.1 * sin(t * 5));
  rot(p.tail, 0.3, 0, 0);
  p.stars.visible = true;
  p.stars.rotation.set(0.15 * sin(a), t * 4, 0.1);
}

function flail(p: Parts, t: number, amp: number, speed: number, stiff: number) {
  const legs: [THREE.Object3D, THREE.Object3D, number, number][] = [
    [p.legFL, p.legFL_low, 0, 1],
    [p.legFR, p.legFR_low, 1.7, -1],
    [p.legBL, p.legBL_low, 3.1, 1],
    [p.legBR, p.legBR_low, 4.6, -1],
  ];
  for (const [hip, knee, ph, s] of legs) {
    const front = hip === p.legFL || hip === p.legFR;
    rot(hip, (front ? -0.5 : 0.5) * stiff + amp * sin(t * speed + ph), 0, s * (0.5 * stiff + amp * 0.5 * cos(t * speed * 1.3 + ph)));
    rot(knee, (1 - stiff) * 0.8 * (0.5 + 0.5 * sin(t * speed + ph + 1)) * (front ? 1 : -1));
  }
}

function thrown(root: THREE.Object3D, t: number) {
  const p = reset(root);
  rot(p.body, t * 9, 0.4 * sin(t * 3), 0.5 * sin(t * 2.3));
  flail(p, t, 0.8, 26, 0.2);
  rot(p.neck, -0.2 + 0.4 * sin(t * 13), 0.4 * sin(t * 9), 0);
  rot(p.head, 0, 0, 0.3 * sin(t * 11));
  rot(p.jaw, 0.6 + 0.15 * sin(t * 20));
  rot(p.tail, 0.8 * sin(t * 30));
}

function fall(root: THREE.Object3D, t: number) {
  const p = reset(root);
  // slow tumble, legs out stiff like a startled starfish, screaming upward
  rot(p.body, -0.35 + 0.25 * sin(t * 1.3), 0.6 * sin(t * 0.7), 0.3 * sin(t * 1.1));
  flail(p, t, 0.12, 40, 1);
  rot(p.neck, -0.8 + 0.1 * sin(t * 17), 0.15 * sin(t * 23), 0);
  rot(p.head, -0.3, 0, 0.1 * sin(t * 19));
  rot(p.jaw, 0.75 + 0.1 * sin(t * 31));
  rot(p.tail, -1.5 + 0.3 * sin(t * 35));
}

function headbang(root: THREE.Object3D, t: number) {
  const p = reset(root);
  const up = ease(t / 0.35);
  const bob = sin(t * TAU * 1.5);
  const pitch = (-0.95 + 0.06 * bob) * up;
  rot(p.body, pitch, 0, 0.05 * sin(t * TAU * 0.75) * up);
  p.body.position.z -= 0.15 * up;
  // hind legs stay planted under the hips, knees bent a little
  const hind = 0.25;
  rot(p.legBL, -pitch - hind * up);
  rot(p.legBR, -pitch - hind * up);
  rot(p.legBL_low, 0.35 * up);
  rot(p.legBR_low, 0.35 * up);
  p.body.position.y += groundHip(pitch, HIP_Y, -0.45, hind * up * 0.6) - BODY_Y;
  // front legs boxing the air
  rot(p.legFL, -pitch * 0.3 - 0.6 * up + 0.35 * sin(t * TAU * 3), 0, 0.15);
  rot(p.legFR, -pitch * 0.3 - 0.6 * up + 0.35 * sin(t * TAU * 3 + Math.PI), 0, -0.15);
  rot(p.legFL_low, 1.3 * up);
  rot(p.legFR_low, 1.3 * up);
  // headbang: slam down on every beat (3 per second), bleat on the downstroke
  const beat = (t * 3) % 1;
  const hit = beat < 0.3 ? ease(beat / 0.3) : 1 - ease((beat - 0.3) / 0.7);
  rot(p.neck, (-pitch * 0.6 - 0.4 + 1.1 * hit) * up, 0, 0);
  rot(p.head, (0.1 + 0.5 * hit) * up, 0, 0.15 * sin(t * TAU * 1.5) * up);
  rot(p.jaw, (0.15 + 0.55 * hit) * up);
  rot(p.tail, 0.8 * sin(t * 25));
}

const def: ModelDef = {
  name: 'ram',
  build,
  poses: { idle, paw, charge, skid, stunned, thrown, fall, headbang },
  viewDistance: 4.5,
};
export default def;
