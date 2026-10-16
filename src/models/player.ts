import * as THREE from 'three';
import type { ModelDef } from './types';
import { mat, PALETTE } from '../style';

/*
 * The player: a topless bodybuilder with a ridiculous V-taper.
 * Meters, +Y up, faces +Z, feet on y=0, ~1.86 m tall.
 * "Left" = the character's own left (+X).
 *
 * Hierarchy (all named pivot Groups, rotations at the joints):
 *   root
 *   └ body            (hip height, inner root for rolls/tumbles; never moved by the game)
 *     └ hips          (pelvis / shorts)
 *       ├ legL / legR (hip joints) └ shinL / shinR (knees) └ footL / footR (ankles)
 *       └ torso       (waist)
 *         ├ chest     (pecs/lats, scaled for "breathing" pulses)
 *         ├ head      (neck) └ bandTail (headband ribbons)
 *         └ armL / armR (shoulders) └ forearmL / forearmR (elbows) └ handL / handR (fist centers)
 */
export const PLAYER_PARTS = [
  'body',
  'hips',
  'torso',
  'chest',
  'head',
  'bandTail',
  'armL',
  'armR',
  'forearmL',
  'forearmR',
  'handL',
  'handR',
  'legL',
  'legR',
  'shinL',
  'shinR',
  'footL',
  'footR',
] as const;
export type PlayerPart = (typeof PLAYER_PARTS)[number];

export const PLAYER_POSES = ['idle', 'run', 'dodge', 'kick', 'bounce', 'tumble', 'fall', 'flex'] as const;
/** Recommended durations (s) of the one-shot poses. */
export const PLAYER_POSE_DURATION = { dodge: 0.35, kick: 0.35, bounce: 0.4 } as const;

const HIP_Y = 0.82; // body origin height (hip joints)

// Local colors (materials still come from mat()).
const C = {
  skin: PALETTE.skin,
  hair: PALETTE.hair,
  band: PALETTE.headband,
  shorts: PALETTE.shorts,
  shoe: PALETTE.shoe,
  sole: 0x3a3a44,
};

// ---------------------------------------------------------------- geometry helpers
// Design rule: few, big, clean chunks. One prism per muscle mass, no small detail pieces.

/**
 * Tapered prism with a flat face toward +Z: bottom radius rb, top radius rt, height h,
 * depth squashed by zs. `segs` = number of sides (6 = hexagonal, 8 = rounder).
 */
function prism(rb: number, rt: number, h: number, zs = 1, segs = 6): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(rt, rb, h, segs, 1, false, Math.PI / segs);
  g.scale(1, 1, zs);
  return g;
}

/**
 * Faceted "muscle" solid of revolution with a flat face toward +Z. `pts` = [radius, y] profile
 * from bottom to top (closed at both ends automatically); depth squashed by zs.
 */
function lathe(pts: [number, number][], zs = 1, segs = 6): THREE.BufferGeometry {
  const v = pts.map(([r, y]) => new THREE.Vector2(r, y));
  v.unshift(new THREE.Vector2(0, pts[0][1]));
  v.push(new THREE.Vector2(0, pts[pts.length - 1][1]));
  const g = new THREE.LatheGeometry(v, segs, Math.PI / segs);
  g.scale(1, 1, zs);
  return g;
}

/** Box whose bottom face is (wb x db) and top face is (wt x dt); height h, centered. */
function tbox(wb: number, wt: number, h: number, db: number, dt: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(1, h, 1);
  const p = g.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const top = p.getY(i) > 0;
    p.setX(i, p.getX(i) * (top ? wt : wb));
    p.setZ(i, p.getZ(i) * (top ? dt : db));
  }
  g.computeVertexNormals();
  return g;
}

function mesh(geo: THREE.BufferGeometry, color: number, x = 0, y = 0, z = 0, parent?: THREE.Object3D): THREE.Mesh {
  const m = new THREE.Mesh(geo, mat(color));
  m.position.set(x, y, z);
  parent?.add(m);
  return m;
}

function group(name: string, parent: THREE.Object3D, x = 0, y = 0, z = 0): THREE.Group {
  const g = new THREE.Group();
  g.name = name;
  g.position.set(x, y, z);
  parent.add(g);
  return g;
}

// ---------------------------------------------------------------- build

function buildArm(side: 1 | -1, torso: THREE.Object3D) {
  const s = side === 1 ? 'L' : 'R';
  const arm = group('arm' + s, torso, 0.42 * side, 0.55, -0.01);
  // Upper arm: one big chunk, fattest at the shoulder (doubles as the deltoid), overlaps the elbow.
  mesh(lathe([[0.085, -0.36], [0.155, -0.17], [0.165, -0.02], [0.11, 0.08]], 0.95), C.skin, 0.01 * side, 0, 0, arm);
  const fore = group('forearm' + s, arm, 0, -0.33, 0);
  // Forearm: fat near the elbow, thin at the wrist; starts above the elbow so bends don't gap.
  mesh(lathe([[0.065, -0.29], [0.115, -0.08], [0.085, 0.05]]), C.skin, 0, 0, 0, fore);
  const hand = group('hand' + s, fore, 0, -0.33, 0.01);
  mesh(new THREE.BoxGeometry(0.15, 0.14, 0.15), C.skin, 0, 0, 0, hand); // fist
}

function buildLeg(side: 1 | -1, hips: THREE.Object3D) {
  const s = side === 1 ? 'L' : 'R';
  const leg = group('leg' + s, hips, 0.115 * side, 0, 0);
  mesh(prism(0.115, 0.11, 0.18, 1), C.shorts, 0.005 * side, -0.07, 0, leg); // shorts leg
  mesh(prism(0.05, 0.07, 0.3, 1, 5), C.skin, 0, -0.27, 0, leg); // skinny thigh
  const shin = group('shin' + s, leg, 0, -0.4, 0);
  mesh(prism(0.04, 0.052, 0.4, 1, 5), C.skin, 0, -0.16, 0, shin); // shin, overlaps knee
  const foot = group('foot' + s, shin, 0, -0.36, 0);
  // Chunky sneaker + dark sole.
  mesh(tbox(0.15, 0.13, 0.09, 0.3, 0.24), C.shoe, 0, 0.0, 0.05, foot);
  mesh(new THREE.BoxGeometry(0.155, 0.03, 0.31), C.sole, 0, -0.045, 0.05, foot);
}

function buildHead(torso: THREE.Object3D) {
  const head = group('head', torso, 0, 0.64, 0.01);
  // One tapered block: wide jaw at the bottom, narrower skull on top.
  mesh(prism(0.135, 0.115, 0.27, 0.95), C.skin, 0, 0.12, 0, head);
  // Flat-top + headband: two plain slabs on top.
  mesh(prism(0.12, 0.12, 0.07, 0.97), C.hair, 0, 0.285, -0.005, head);
  mesh(prism(0.125, 0.125, 0.05, 0.97), C.band, 0, 0.225, -0.005, head);
  // Brow strip (reads as angry eyes) and a big mustache.
  mesh(new THREE.BoxGeometry(0.15, 0.025, 0.02), C.hair, 0, 0.165, 0.11, head);
  mesh(tbox(0.17, 0.11, 0.045, 0.035, 0.035), C.hair, 0, 0.085, 0.115, head);
  // Headband tails.
  const tail = group('bandTail', head, 0, 0.22, -0.11);
  const t1 = mesh(new THREE.BoxGeometry(0.06, 0.035, 0.18), C.band, 0, -0.03, -0.08, tail);
  t1.rotation.x = 0.55;
}

function buildTorso(hips: THREE.Object3D) {
  const torso = group('torso', hips, 0, 0.1, 0);
  // Tiny waist.
  mesh(prism(0.17, 0.22, 0.24, 0.8), C.skin, 0, 0.1, 0, torso);
  const chest = group('chest', torso, 0, 0.2, 0);
  // The V: one big flat-fronted wedge, flaring from the waist to the shoulders.
  mesh(lathe([[0.22, -0.04], [0.5, 0.3], [0.4, 0.42]], 0.6), C.skin, 0, 0, -0.01, chest);
  // Traps: a low slab sloping up into the head (no visible neck).
  mesh(prism(0.3, 0.12, 0.16, 0.6), C.skin, 0, 0.44, -0.02, chest);
  buildHead(torso);
  buildArm(1, torso);
  buildArm(-1, torso);
}

function build(): THREE.Object3D {
  const root = new THREE.Group();
  root.name = 'player';
  const body = group('body', root, 0, HIP_Y, 0);
  const hips = group('hips', body);
  mesh(prism(0.2, 0.19, 0.22, 0.68), C.shorts, 0, 0.0, 0, hips); // shorts
  buildTorso(hips);
  buildLeg(1, hips);
  buildLeg(-1, hips);
  return root;
}

// ---------------------------------------------------------------- posing

type Parts = Record<PlayerPart, THREE.Object3D>;

function parts(root: THREE.Object3D): Parts {
  let p = root.userData.parts as Parts | undefined;
  if (!p) {
    p = {} as Parts;
    for (const n of PLAYER_PARTS) {
      const o = root.getObjectByName(n);
      if (!o) throw new Error('player: missing part ' + n);
      p[n] = o;
    }
    root.userData.parts = p;
  }
  return p;
}

/** Neutral stance: arms flared out by the lats, slight elbow bend. */
function reset(root: THREE.Object3D): Parts {
  const p = parts(root);
  for (const n of PLAYER_PARTS) {
    const o = p[n];
    o.rotation.set(0, 0, 0);
    o.scale.set(1, 1, 1);
  }
  p.body.position.set(0, HIP_Y, 0);
  p.armL.rotation.z = 0.32;
  p.armR.rotation.z = -0.32;
  p.forearmL.rotation.x = -0.25;
  p.forearmR.rotation.x = -0.25;
  return p;
}

const TAU = Math.PI * 2;
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const lerp = THREE.MathUtils.lerp;
const smooth = (x: number) => {
  x = clamp01(x);
  return x * x * (3 - 2 * x);
};
/** 0→1 over [a,b], smoothed. */
const seg = (t: number, a: number, b: number) => smooth((t - a) / (b - a));

/** Rotate the body about a point `c` meters above the hip joint (keeps rolls centered). */
function spinBody(p: Parts, rx: number, ry: number, rz: number, c: number, baseY = HIP_Y) {
  p.body.rotation.set(rx, ry, rz);
  const v = new THREE.Vector3(0, -c, 0).applyEuler(p.body.rotation);
  p.body.position.set(v.x, baseY + c + v.y, v.z);
}

/** Set a leg (thigh pitch, knee bend) and keep the foot roughly level. */
function leg(p: Parts, s: 'L' | 'R', thigh: number, knee: number, foot = -(thigh + knee) * 0.6) {
  p[`leg${s}`].rotation.x = thigh;
  p[`shin${s}`].rotation.x = knee;
  p[`foot${s}`].rotation.x = foot;
}

const poses: ModelDef['poses'] = {
  idle(root, t) {
    const p = reset(root);
    const b = Math.sin(t * TAU * 0.6); // breathing
    const flex = Math.max(0, Math.sin(t * TAU * 0.3)) ** 4; // occasional pec bounce
    p.body.position.y = HIP_Y - 0.015 + 0.012 * b;
    leg(p, 'L', -0.08, 0.14, -0.06);
    leg(p, 'R', -0.08, 0.14, -0.06);
    p.legL.rotation.z = 0.08;
    p.legR.rotation.z = -0.08;
    p.footL.rotation.z = -0.08;
    p.footR.rotation.z = 0.08;
    p.chest.scale.set(1 + 0.03 * b, 1 + 0.015 * b, 1 + 0.04 * b + 0.06 * flex);
    p.torso.rotation.x = -0.04 * b;
    p.head.rotation.x = 0.03 * b;
    p.head.rotation.y = 0.15 * Math.sin(t * 0.7);
    p.armL.rotation.z = 0.34 + 0.05 * b;
    p.armR.rotation.z = -0.34 - 0.05 * b;
    p.forearmL.rotation.x = -0.3 - 0.08 * b;
    p.forearmR.rotation.x = -0.3 - 0.08 * b;
    p.bandTail.rotation.x = 0.1 * b;
  },

  run(root, t) {
    const p = reset(root);
    const ph = t * TAU * 1.25; // 1.25 strides/s = 2.5 steps/s
    const s = Math.sin(ph);
    const c = Math.cos(ph);
    p.body.position.y = HIP_Y - 0.04 + 0.06 * Math.abs(Math.cos(ph));
    p.body.rotation.x = 0.22;
    p.hips.rotation.y = -0.15 * s;
    p.torso.rotation.y = 0.3 * s;
    p.torso.rotation.z = 0.06 * c;
    p.head.rotation.x = -0.2;
    p.head.rotation.y = -0.25 * s;
    // Legs: short skinny legs going like pistons.
    leg(p, 'L', -0.95 * s, 0.35 + 0.95 * Math.max(0, -c) + 0.3 * Math.max(0, s), 0.2 * s);
    leg(p, 'R', 0.95 * s, 0.35 + 0.95 * Math.max(0, c) + 0.3 * Math.max(0, -s), -0.2 * s);
    // Arms: huge pumping swings, elbows locked at 90°, lats keep them flared.
    p.armL.rotation.x = 1.1 * s;
    p.armR.rotation.x = -1.1 * s;
    p.armL.rotation.z = 0.45;
    p.armR.rotation.z = -0.45;
    p.forearmL.rotation.x = -1.5 - 0.3 * Math.max(0, -s);
    p.forearmR.rotation.x = -1.5 - 0.3 * Math.max(0, s);
    p.bandTail.rotation.x = -0.6 + 0.25 * Math.sin(ph * 2);
    p.bandTail.rotation.y = 0.3 * s;
  },

  dodge(root, t) {
    // 0.35 s forward dive-roll.
    const p = reset(root);
    const u = clamp01(t / 0.35);
    const tuck = Math.sin(Math.PI * Math.min(1, u * 1.15));
    const roll = TAU * smooth(u);
    const dip = 0.45 * Math.sin(Math.PI * u);
    spinBody(p, roll, 0, 0, 0.22, HIP_Y - dip);
    p.torso.rotation.x = 0.9 * tuck;
    p.head.rotation.x = 0.6 * tuck;
    leg(p, 'L', -1.7 * tuck, 2.1 * tuck, 0);
    leg(p, 'R', -1.5 * tuck, 2.2 * tuck, 0);
    p.armL.rotation.x = -1.0 * tuck;
    p.armR.rotation.x = -1.0 * tuck;
    p.armL.rotation.z = lerp(0.32, 0.1, tuck);
    p.armR.rotation.z = lerp(-0.32, -0.1, tuck);
    p.forearmL.rotation.x = lerp(-0.25, -1.9, tuck);
    p.forearmR.rotation.x = lerp(-0.25, -1.9, tuck);
    p.bandTail.rotation.x = -0.8 * tuck;
  },

  kick(root, t) {
    // 0.35 s: chamber (0–0.08) → snap (0.08–0.15) → hold → retract (0.25–0.35).
    const p = reset(root);
    const chamber = seg(t, 0, 0.08);
    const snap = seg(t, 0.07, 0.14);
    const back = seg(t, 0.25, 0.35);
    const k = (1 - back);
    // Kicking leg = right.
    const thigh = lerp(lerp(0, -1.3, chamber), -1.5, snap) * k;
    const knee = lerp(lerp(0, 1.7, chamber), 0.0, snap) * k;
    leg(p, 'R', thigh, knee, lerp(0, -0.5 * snap, 1) * k + 0.6 * chamber * (1 - snap) * k);
    // Support leg bends, body leans back to counter.
    leg(p, 'L', 0.15 * k, 0.25 * k, -0.35 * k);
    p.body.position.y = HIP_Y - 0.05 * k;
    p.body.position.z = -0.08 * k;
    p.body.rotation.x = -0.26 * snap * k - 0.08 * chamber * k;
    p.torso.rotation.x = 0.12 * snap * k;
    p.torso.rotation.y = -0.2 * snap * k;
    p.head.rotation.x = 0.25 * snap * k;
    // Arms fling out for balance.
    p.armL.rotation.z = lerp(0.32, 1.25, snap * k);
    p.armR.rotation.z = lerp(-0.32, -1.0, snap * k);
    p.armL.rotation.x = -0.4 * snap * k;
    p.armR.rotation.x = 0.6 * snap * k;
    p.forearmL.rotation.x = lerp(-0.25, -0.9, snap * k);
    p.forearmR.rotation.x = lerp(-0.25, -0.6, snap * k);
    p.bandTail.rotation.x = -0.5 * snap * k;
  },

  bounce(root, t) {
    // 0.4 s: kicked a ram that didn't budge. The kicking (right) leg rebounds, he hops
    // backwards on the left foot, leaning way back with arms windmilling, then catches himself.
    const p = reset(root);
    const u = clamp01(t / 0.4);
    const rec = Math.sin(Math.PI * Math.min(1, u / 0.95)); // 0 → 1 → 0
    const hit = 1 - seg(t, 0, 0.12); // leg still out at impact
    p.body.position.y = HIP_Y + 0.08 * Math.abs(Math.sin(Math.PI * u * 2)) * (1 - u) - 0.04 * rec;
    p.body.position.z = -0.18 * rec;
    p.body.rotation.x = -0.5 * rec;
    p.body.rotation.z = 0.12 * Math.sin(u * TAU * 1.5) * rec;
    p.torso.rotation.x = -0.15 * rec;
    p.head.rotation.x = 0.45 * rec;
    p.head.rotation.y = 0.35 * Math.sin(t * 45) * rec;
    // Rebounding kick leg and hopping support leg.
    leg(p, 'R', lerp(-0.3 * rec, -1.5, hit), lerp(0.9 * rec, 0, hit), lerp(0, -0.5, hit));
    leg(p, 'L', -0.15 * rec, 0.55 * rec, -0.3 * rec);
    p.legR.rotation.z = -0.2 * rec;
    // Arms windmill backwards, flung wide.
    const w = TAU * 1.6 * u;
    p.armL.rotation.z = 0.32 + 0.95 * rec;
    p.armR.rotation.z = -0.32 - 0.95 * rec;
    p.armL.rotation.x = -Math.sin(w) * 2.0 * rec - 0.6 * rec;
    p.armR.rotation.x = -Math.sin(w + Math.PI * 0.7) * 2.0 * rec - 0.6 * rec;
    p.forearmL.rotation.x = -0.25 - 0.5 * rec;
    p.forearmR.rotation.x = -0.25 - 0.5 * rec;
    p.bandTail.rotation.x = 0.7 * rec;
  },

  tumble(root, t) {
    // Launched: spinning head over heels with a wobble, limbs flailing.
    const p = reset(root);
    spinBody(p, -t * 7.5, Math.sin(t * 2.3) * 0.6, Math.sin(t * 3.1) * 0.5, 0.3);
    const f = (a: number, w: number, o: number) => a * Math.sin(t * w + o);
    p.armL.rotation.z = 1.4 + f(0.5, 17, 0);
    p.armR.rotation.z = -1.4 + f(0.5, 15, 1);
    p.armL.rotation.x = f(0.9, 13, 2);
    p.armR.rotation.x = f(0.9, 11, 0.5);
    p.forearmL.rotation.x = -0.6 + f(0.6, 19, 1);
    p.forearmR.rotation.x = -0.6 + f(0.6, 21, 3);
    leg(p, 'L', f(0.8, 14, 0), 0.6 + f(0.5, 18, 1), f(0.5, 10, 0));
    leg(p, 'R', f(0.8, 12, 2), 0.6 + f(0.5, 16, 0), f(0.5, 9, 1));
    p.legL.rotation.z = 0.5 + f(0.2, 9, 0);
    p.legR.rotation.z = -0.5 + f(0.2, 8, 1);
    p.head.rotation.x = f(0.4, 12, 0);
    p.head.rotation.z = f(0.3, 9, 1);
    p.torso.rotation.x = f(0.25, 7, 0);
    p.bandTail.rotation.x = -1 + f(0.4, 25, 0);
  },

  fall(root, t) {
    // Long fall: upright-ish panic, arms windmilling, legs bicycling.
    const p = reset(root);
    spinBody(p, -0.25 + 0.15 * Math.sin(t * 2), 0.3 * Math.sin(t * 0.9), 0.12 * Math.sin(t * 1.7), 0.3);
    const w = t * 13;
    p.armL.rotation.z = 1.1;
    p.armR.rotation.z = -1.1;
    p.armL.rotation.x = -w;
    p.armR.rotation.x = -w + Math.PI;
    p.forearmL.rotation.x = -0.3 - 0.3 * Math.sin(w);
    p.forearmR.rotation.x = -0.3 + 0.3 * Math.sin(w);
    const lg = t * 11;
    leg(p, 'L', -0.7 + 0.8 * Math.sin(lg), 0.9 + 0.7 * Math.cos(lg), 0.4 * Math.sin(lg));
    leg(p, 'R', -0.7 - 0.8 * Math.sin(lg), 0.9 - 0.7 * Math.cos(lg), -0.4 * Math.sin(lg));
    p.legL.rotation.z = 0.25;
    p.legR.rotation.z = -0.25;
    p.head.rotation.x = -0.35 + 0.15 * Math.sin(t * 9);
    p.head.rotation.y = 0.6 * Math.sin(t * 5);
    p.torso.rotation.y = 0.15 * Math.sin(w);
    p.bandTail.rotation.x = 1.2 + 0.4 * Math.sin(t * 30);
  },

  flex(root, t) {
    // Alternates double-biceps (front) and most-muscular (crab), with a pulse.
    const p = reset(root);
    const cyc = t % 4;
    const crab = seg(cyc, 1.8, 2.1) * (1 - seg(cyc, 3.8, 4.0)) + (t < 0.01 ? 0 : 0);
    const enter = seg(t, 0, 0.18);
    const pulse = Math.max(0, Math.sin(t * TAU * 1.6)) ** 3;
    const db = enter * (1 - crab);
    const mm = enter * crab;
    // Wide stance, slight squat.
    p.body.position.y = HIP_Y - 0.03 * enter - 0.06 * mm - 0.015 * pulse;
    p.legL.rotation.z = 0.2 * enter;
    p.legR.rotation.z = -0.2 * enter;
    p.footL.rotation.z = -0.2 * enter;
    p.footR.rotation.z = 0.2 * enter;
    leg(p, 'L', -0.15 * enter - 0.15 * mm, 0.25 * enter + 0.25 * mm, -0.1 * enter);
    leg(p, 'R', -0.15 * enter - 0.15 * mm, 0.25 * enter + 0.25 * mm, -0.1 * enter);
    // Double biceps: upper arms horizontal, forearms up.
    // Most-muscular: arms down in front, fists together, shoulders hunched.
    for (const [s, sg] of [['L', 1], ['R', -1]] as const) {
      const arm = p[`arm${s}`];
      const fore = p[`forearm${s}`];
      arm.rotation.x = -0.25 * db - 0.45 * mm;
      arm.rotation.y = 0;
      arm.rotation.z = sg * (0.32 + db * (1.3 + 0.05 * pulse) + mm * (0.35 + 0.08 * pulse));
      fore.rotation.x = -0.25 * (1 - enter) + db * -0.15 + mm * -0.75;
      fore.rotation.z = sg * (db * (1.9 + 0.15 * pulse) - mm * (1.35 + 0.1 * pulse));
    }
    p.torso.rotation.x = 0.05 * db + 0.3 * mm;
    p.head.rotation.x = -0.1 * db - 0.15 * mm;
    p.head.rotation.z = 0.1 * db * Math.sin(t * 2.2);
    p.chest.scale.set(1 + 0.05 * pulse * enter + 0.04 * mm, 1, 1 + 0.08 * pulse * enter);
    p.bandTail.rotation.x = 0.2 * pulse;
  },
};

const def: ModelDef = {
  name: 'player',
  build,
  poses,
  viewDistance: 4.5,
};
export default def;
