/**
 * The rifle you are holding — the mesh, and the one rule it has to obey.
 *
 * The gun has had a physical collider since M3 ("если резко крутиться в тесноте, стволом
 * сшибаешь вещи"), but nothing ever drew it, so the player was swinging an invisible bat. This
 * file gives that collider a body. What it must not do is give the player a *lamp*: concept.md
 * law 1 says nothing renders just because, and a rifle hanging permanently in the blackness is
 * exactly the thing that law forbids. So:
 *
 *  - The mesh is lit by the muzzle flash and by nothing else. There is no ambient term, no
 *    fill, no "so you can see your gun" cheat. With the flash out, the shader's light energy is
 *    zero, the group is switched invisible, and it costs one branch a frame.
 *  - The lighting is honest: a point light at the real muzzle position, real normals, real
 *    inverse-square falloff. Turn your body and the far side of the receiver goes dark, because
 *    that is where the light actually is.
 *
 * Why a shader of its own instead of a MeshStandardMaterial in the scene light:
 *
 *  - The flash is a 160 cd point light and the receiver is 25 cm from it. Physically that is
 *    ~2500 lux on the gun; any ordinary material clips to flat white and the silhouette — the
 *    only thing this mesh is for — disappears. The shader keeps the same falloff and rolls the
 *    top off with `1 - exp(-x)`, so the near surfaces saturate the way a photograph does and the
 *    shape survives. Nothing else in the scene is touched by this, so the flash the human liked
 *    is bit-for-bit the flash he liked.
 *  - It also makes the law enforceable in one place: `uEnergy` is the flash envelope and only
 *    the flash envelope. There is no code path in which this material emits anything at zero.
 *
 * Shadows: the mesh neither casts nor receives. The light is born *at the muzzle*, i.e. in front
 * of the gun, so the only shadow the gun could throw is backwards past the player's own eye;
 * putting it in the cube map would buy nothing but acne on a surface 5 cm from the near plane.
 *
 * Geometry: boxes and cylinders, one merged buffer, one draw call, flat grey. Silhouette, not
 * detail — "текстур нет, материалов нет, PBR нет" is a law too.
 *
 * The `L` debug view lights it with a flat key so the shape can be inspected; that is the same
 * switch that already lights the hall and is not part of the game.
 *
 * **The second channel draws it in the second channel's own language.** The hand does not light
 * the gun and never did — but the first attempt let the *mesh* carry the tactile term, and a
 * shaded solid is what the world's props look like under the debug lights, so the rifle read as
 * one more grey object lying in the hall instead of as something the player is feeling. The
 * tactile layer everywhere else in this game draws two things and only two: a stipple of hard
 * grey points on the surfaces the hand reached, and grey contour pieces along their edges. So
 * that is what the rifle is now — its own lattice of points and its own contour, in `TOUCH_GREY`,
 * at the same handful of pixels per point the hall's felt dots use. Same channel, same switch,
 * same alphabet.
 *
 * The two channels never draw at once by accident and never blend: with a flash in flight the
 * solid is drawn (there is real light on it), and with only the hand on it, only the stipple and
 * the contour are. What the stipple *does* borrow from the solid is depth: the mesh is drawn
 * colour-less into the depth buffer first, so the far side of the receiver does not show through
 * the near side. You cannot feel through your own rifle.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { TOUCH_GREY } from '../lidar/structured';
import type { TouchSink } from '../touch/touch';

export interface ViewModelTunables {
  /** Master switch. Off is for measuring what the mesh costs, not for playing. */
  visible: boolean;
  /** Surface grey. One number, because there are no materials in this game. */
  albedo: number;
  /**
   * How much of the flash's candela the gun is allowed to keep before the roll-off. Physically
   * this should be 1: the receiver is 30 cm from a 160 cd source and would be the brightest
   * thing in the hall by a wide margin. It is a small number instead for a reason that showed
   * up the moment the mesh existed — the floor a metre and a half away is *already* clipped to
   * white by the flash, so a gun that is also clipped to white is a white shape on a white
   * floor and the silhouette disappears. Held down here the gun keeps its own tonal range
   * against a blown background and reads as a gun. Measured on the flash keyframe, not guessed.
   */
  gain: number;
  /** Shoulder of the roll-off. Lower = the near surfaces blow out sooner. */
  exposure: number;
  /** Grazing-edge term, so the silhouette still reads where the normal faces away. */
  rim: number;
  /**
   * How brightly the *tactile* channel draws the gun, as a fraction of the touch layer's own
   * near-hand alpha. This is the second and only other thing allowed to make the rifle visible,
   * and it is not a lamp: it is the same channel that already draws the crate you are leaning
   * on, asking the same question about the nearest object there is — and, since the human looked
   * at it, drawing the answer the same way too: grey stipple and grey contour, never a lit body.
   *
   * Unlike everything else the hand draws, the gun is drawn *whole* rather than by radius —
   * the human's call, and the right one: the reach test exists because you only know the piece
   * of the world your hand happens to be on, and that reasoning simply does not apply to the
   * one object you are holding in both hands and have carried all night. Ты её знаешь на ощупь
   * целиком.
   */
  feel: number;
  /** Brightness of the contour relative to the stipple. Higher = more edge, less surface. */
  feelEdge: number;
  /**
   * How much of a *ball* the flash is treated as. A muzzle flash is a fistful of burning
   * powder, not a mathematical point, and the difference matters here and nowhere else: the
   * light is born at the tip of the barrel, so to a point light the whole gun behind it is
   * exactly edge-on and renders as a black stripe. Wrapping the diffuse term is the standard
   * cheap stand-in for an emitter with a size, and it is what lets the receiver, the magazine
   * and the handguard read as surfaces instead of as one silhouette.
   */
  wrap: number;
  /** Extra metres the gun is shoved back relative to the camera per unit of view punch. */
  kickBack: number;
  /** Extra degrees the muzzle climbs relative to the camera per degree of view punch. */
  kickPitch: number;
  /**
   * Where the muzzle is drawn, metres from the eye: forward, down, and to the right. This is a
   * *drawing* offset and not the shot origin — the round still leaves from the muzzle the rifle
   * itself reports, and the flash is still born there. The gun is held off to the right for the
   * same reason every first-person shooter holds it there: down the centre it is seen end-on
   * down its own barrel and reads as nothing at all.
   */
  ahead: number;
  drop: number;
  side: number;
  /**
   * The hold, radians, all three about the muzzle — so the barrel tip stays exactly where the
   * flash is born and only the body of the gun swings. `cant` takes the stock to the right
   * shoulder, `tilt` drops it below the sight line, `roll` turns the receiver's flat towards
   * the eye. Together they are the difference between a rifle you can read and a rifle seen
   * end-on down its own barrel, which is what a perfectly shouldered pose actually looks like.
   */
  cant: number;
  tilt: number;
  roll: number;
  /**
   * How big the gun is drawn. Not 1, and not a cheat either: the eye is half a metre behind the
   * muzzle, so a life-sized rifle in that pose runs past the camera and the only part of it left
   * on screen is a sight ring seen end-on. Drawing it smaller and therefore wholly in front of
   * the eye is what every first-person viewmodel has ever done, and it is the only way the
   * silhouette this feature exists for is actually on screen.
   */
  scale: number;
}

export function defaultViewModelTunables(): ViewModelTunables {
  return {
    visible: true,
    albedo: 0.42,
    gain: 0.0018,
    exposure: 1.15,
    rim: 0.25,
    feel: 1.0,
    feelEdge: 1.4,
    wrap: 0.55,
    kickBack: 0.55,
    kickPitch: 0.8,
    ahead: 0.90,
    drop: 0.20,
    side: 0.20,
    cant: 0.30,
    tilt: 0.16,
    roll: 0.10,
    scale: 0.75,
  };
}

const VERT = `
varying vec3 vWorld;
varying vec3 vNormal2;
void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vWorld = world.xyz;
  vNormal2 = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * world;
}`;

const FRAG = `
uniform vec3 uLightPos;
uniform vec3 uLightColor;
uniform vec3 uEye;
uniform float uEnergy;
uniform float uAlbedo;
uniform float uExposure;
uniform float uRim;
uniform float uWrap;
uniform float uDebug;
varying vec3 vWorld;
varying vec3 vNormal2;
void main() {
  vec3 n = normalize(vNormal2);
  vec3 toEye = normalize(uEye - vWorld);
  // Two-sided: the merged boxes are closed, but a near-plane slice through the stock would
  // otherwise show a black hole where the inside faces are.
  if (dot(n, toEye) < 0.0) n = -n;

  vec3 l = uLightPos - vWorld;
  float d2 = max(dot(l, l), 1e-4);
  // Wrapped diffuse: the flash has a size, so the terminator is soft and the surfaces the
  // point-light maths calls edge-on still get some of it.
  float ndl = max((dot(n, normalize(l)) + uWrap) / (1.0 + uWrap), 0.0);
  // Real inverse square from the real muzzle. uEnergy is the flash envelope times its
  // intensity, so with no flash in flight this whole term is exactly zero.
  float atten = uEnergy / d2;
  float rim = pow(1.0 - max(dot(n, toEye), 0.0), 3.0) * uRim;
  vec3 c = vec3(uAlbedo) * uLightColor * atten * (ndl + rim);
  c = vec3(1.0) - exp(-c * uExposure);
  // Debug lights only (the L key). Never on in the game.
  c += uDebug * uAlbedo * (0.30 + 0.70 * max(dot(n, toEye), 0.0));
  gl_FragColor = vec4(c, 1.0);
}`;

/*
 * The tactile pair. These two shaders are the whole point of the rework: what the hand draws is
 * points and lines in one flat grey, with no lighting model anywhere in them. There is no light
 * position here, no falloff, no exposure — a felt thing is not a lit thing, and if any of that
 * crept in the channel would be a lamp again.
 *
 * Two details are borrowed deliberately from `structured.ts`, because "the same language" has to
 * mean the same numbers and not a similar mood:
 *
 *  - a felt point is a *hard small stipple* of a few drawing-buffer pixels, not the lidar's
 *    energy-conserving blob that swells with proximity. The hall's felt dots clamp to 5-9 px; the
 *    gun sits at a fixed 30 cm from the eye and never moves, so its dots need no distance maths
 *    at all — they are simply drawn at that size.
 *  - the facing term. A point whose surface has turned away from the eye is dropped, and one at a
 *    grazing angle is dimmer, exactly as the hall's lattice does it. This is what keeps the far
 *    side of the receiver from stippling through the near side even before the depth pass.
 */
const FEEL_VERT = `
uniform vec3 uEye;
uniform vec3 uColor;
uniform float uBright;
uniform float uPixels;
varying vec3 vColor;
void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vec3 n = normalize(mat3(modelMatrix) * normal);
  float facing = dot(n, normalize(uEye - world.xyz));
  if (facing < 0.02) {
    // Off the clip volume entirely: a point has no second end to leave a streak behind.
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    gl_PointSize = 0.0;
    return;
  }
  vColor = uColor * uBright * (0.45 + 0.55 * facing);
  gl_PointSize = uPixels;
  gl_Position = projectionMatrix * viewMatrix * world;
}`;

const FEEL_FRAG = `
varying vec3 vColor;
void main() {
  float r = length(gl_PointCoord - 0.5) * 2.0;
  // Harder-edged than a lidar dot: a felt point is a fingertip, not a return. Same 0.6 of the
  // hall's dot softness that its own touch branch uses.
  float shape = 1.0 - smoothstep(0.79, 1.0, r);
  if (shape <= 0.002) discard;
  gl_FragColor = vec4(vColor, shape);
}`;

const EDGE_VERT = `
void main() {
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const EDGE_FRAG = `
uniform vec3 uColor;
uniform float uBright;
void main() {
  gl_FragColor = vec4(uColor * uBright, 1.0);
}`;

/** Stipple pitch on the gun's own surface, metres before the viewmodel scale. */
const FEEL_PITCH = 0.02;
/** How far a felt point sits proud of the surface it belongs to, metres. */
const FEEL_LIFT = 0.0022;
/** Diameter of one felt point, drawing-buffer pixels — inside the hall's own 5-9 band. */
const FEEL_PIXELS = 6;

/** Deterministic and seeded: `Math.random()` in a viewmodel would break every keyframe run. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The gun's own lattice. The hall snaps its dots to a world grid so that coplanar faces line up;
 * that trick is not available here (the gun moves with the eye, and a grid in its local frame
 * would swim as it kicks), so the points are laid down per triangle at a fixed area density with
 * a fractional carry, which gives the same even, unpatterned covering. Built once.
 */
function buildStipple(source: THREE.BufferGeometry): THREE.BufferGeometry {
  const pos = source.getAttribute('position');
  const nor = source.getAttribute('normal');
  const index = source.getIndex();
  const count = index !== null ? index.count : pos.count;
  const rnd = mulberry32(0x1f1e33);
  const P: number[] = [];
  const N: number[] = [];
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const na = new THREE.Vector3(), nb = new THREE.Vector3(), nc = new THREE.Vector3();
  const e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), cross = new THREE.Vector3();
  const p = new THREE.Vector3(), n = new THREE.Vector3();
  const per = FEEL_PITCH * FEEL_PITCH;
  let carry = 0;
  for (let t = 0; t + 2 < count; t += 3) {
    const i0 = index !== null ? index.getX(t) : t;
    const i1 = index !== null ? index.getX(t + 1) : t + 1;
    const i2 = index !== null ? index.getX(t + 2) : t + 2;
    a.fromBufferAttribute(pos, i0); b.fromBufferAttribute(pos, i1); c.fromBufferAttribute(pos, i2);
    na.fromBufferAttribute(nor, i0); nb.fromBufferAttribute(nor, i1); nc.fromBufferAttribute(nor, i2);
    e1.subVectors(b, a); e2.subVectors(c, a);
    carry += 0.5 * cross.crossVectors(e1, e2).length() / per;
    while (carry >= 1) {
      carry -= 1;
      let u = rnd(), v = rnd();
      if (u + v > 1) { u = 1 - u; v = 1 - v; }
      n.set(0, 0, 0)
        .addScaledVector(na, 1 - u - v).addScaledVector(nb, u).addScaledVector(nc, v)
        .normalize();
      p.copy(a).addScaledVector(e1, u).addScaledVector(e2, v).addScaledVector(n, FEEL_LIFT);
      P.push(p.x, p.y, p.z);
      N.push(n.x, n.y, n.z);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
  return g;
}

/** One part of the silhouette. All coordinates local: +Z runs back towards the shoulder. */
function box(w: number, h: number, d: number, x: number, y: number, z: number, pitch = 0): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  if (pitch !== 0) g.rotateX(pitch);
  g.translate(x, y, z);
  return g;
}

function tube(r: number, len: number, z: number, y = 0, x = 0): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(r, r, len, 10, 1);
  g.rotateX(Math.PI / 2);
  g.translate(x, y, z);
  return g;
}

/**
 * The shape. An AR-15 read at arm's length and nothing more: flash hider, thin barrel under a
 * fat handguard, a receiver with a sight rail, a magazine raked forward, grip, stock.
 * The muzzle is the local origin, so the flash and the mesh cannot drift apart.
 */
function buildGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [
    tube(0.021, 0.062, 0.031),                     // flash hider
    tube(0.0105, 0.10, 0.112),                     // exposed barrel
    box(0.052, 0.056, 0.235, 0, -0.002, 0.28),     // handguard
    box(0.012, 0.030, 0.022, 0, 0.040, 0.176),     // front sight post
    box(0.046, 0.062, 0.215, 0, -0.004, 0.505),    // upper + lower receiver
    box(0.020, 0.016, 0.175, 0, 0.036, 0.500),     // sight rail
    box(0.026, 0.028, 0.030, 0, 0.049, 0.430),     // rear sight block
    box(0.030, 0.150, 0.060, 0, -0.098, 0.487, 0.20),  // magazine, raked forward
    box(0.034, 0.115, 0.052, 0, -0.086, 0.618, -0.30), // pistol grip
    box(0.040, 0.052, 0.090, 0, 0.004, 0.660),     // buffer tube
    box(0.046, 0.078, 0.175, 0, -0.008, 0.780),    // stock
  ];
  const merged = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  if (merged === null) throw new Error('rifle viewmodel: merge failed');
  merged.computeVertexNormals();
  return merged;
}

export class RifleViewModel implements TouchSink {
  readonly tunables: ViewModelTunables;
  /** Add this to the *camera*: the gun is held in view space, like every viewmodel ever. */
  readonly object = new THREE.Group();
  /** Everything the gun is made of, in one frame: the hold and the kick are applied here once. */
  private readonly body = new THREE.Group();
  private readonly mesh: THREE.Mesh;
  private readonly material: THREE.ShaderMaterial;
  /** The tactile pair, and the depth-only copy that stops them showing through the gun. */
  private readonly stipple: THREE.Points;
  private readonly contour: THREE.LineSegments;
  private readonly occluder: THREE.Mesh;
  private readonly stippleMaterial: THREE.ShaderMaterial;
  private readonly contourMaterial: THREE.ShaderMaterial;
  private readonly rest = new THREE.Vector3();
  private lastEnergy = 0;
  /** Set by the touch layer: is the tactile channel on at all, and how bright is it up close. */
  private feltOn = false;
  private feltAlpha = 0;

  constructor(tunables: ViewModelTunables = defaultViewModelTunables()) {
    this.tunables = tunables;
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uLightPos: { value: new THREE.Vector3() },
        uLightColor: { value: new THREE.Color(0xfff1d0) },
        uEye: { value: new THREE.Vector3() },
        uEnergy: { value: 0 },
        uAlbedo: { value: tunables.albedo },
        uExposure: { value: tunables.exposure },
        uRim: { value: tunables.rim },
        uWrap: { value: tunables.wrap },
        uDebug: { value: 0 },
      },
      transparent: false,
      depthWrite: true,
      side: THREE.DoubleSide,
    });
    const geometry = buildGeometry();
    this.mesh = new THREE.Mesh(geometry, this.material);
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    // It is 30 cm from the eye and always in front of it; culling it is a test that can only
    // ever answer "yes" and can, at the edges of the near plane, answer it wrongly.
    this.mesh.frustumCulled = false;
    // The stock is canted to the shoulder while the muzzle stays on the sight line, so the
    // barrel is not a stripe down the middle of the screen and the flash is where the shot is.

    const grey = new THREE.Color(TOUCH_GREY);
    this.stippleMaterial = new THREE.ShaderMaterial({
      vertexShader: FEEL_VERT,
      fragmentShader: FEEL_FRAG,
      uniforms: {
        uEye: { value: new THREE.Vector3() },
        uColor: { value: grey.clone() },
        uBright: { value: 0 },
        uPixels: { value: FEEL_PIXELS },
      },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.contourMaterial = new THREE.ShaderMaterial({
      vertexShader: EDGE_VERT,
      fragmentShader: EDGE_FRAG,
      uniforms: {
        uColor: { value: grey.clone() },
        uBright: { value: 0 },
      },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.stipple = new THREE.Points(buildStipple(geometry), this.stippleMaterial);
    this.stipple.frustumCulled = false;
    // 25 degrees: every crease of a box and the rim of every cylinder, and nothing along the
    // flats. This is the same idea as the hall's contour pieces — where a surface turns, the hand
    // knows it — reused instead of hand-listing thirty edges.
    this.contour = new THREE.LineSegments(new THREE.EdgesGeometry(geometry, 25), this.contourMaterial);
    this.contour.frustumCulled = false;
    /*
     * Depth only, no colour. Without it the stipple on the far side of the receiver shows through
     * the near side and the gun turns into a cloud with no front or back. The facing test in the
     * shader gets most of the way there, but the contour has no normal to test and would still
     * draw its hidden edges. Polygon offset pushes this copy a hair further from the eye so the
     * points and lines sitting exactly on the surface are not fighting it for the same depth.
     */
    this.occluder = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({
      colorWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 2,
    }));
    this.occluder.frustumCulled = false;
    this.occluder.renderOrder = -1;

    this.body.add(this.mesh, this.occluder, this.stipple, this.contour);
    this.object.add(this.body);
    this.object.visible = false;
    this.applyLook();
  }

  /** Pushes the tunables that live in uniforms. Called after the GUI moves a slider. */
  applyLook(): void {
    const t = this.tunables;
    this.material.uniforms.uAlbedo!.value = t.albedo;
    this.material.uniforms.uExposure!.value = t.exposure;
    this.material.uniforms.uRim!.value = t.rim;
    this.material.uniforms.uWrap!.value = t.wrap;
    // x stays at zero on purpose: the muzzle has to sit exactly where the flash is born, so
    // the gun is swung to the shoulder by rotating it about that point, not by sliding it.
    this.rest.set(t.side, -t.drop, -t.ahead);
    this.body.rotation.set(t.tilt, t.cant, t.roll);
    this.body.scale.setScalar(t.scale);
  }

  get lit(): boolean {
    return this.object.visible;
  }

  /** How much of the gun the hand is currently drawing, 0 when the tactile channel is off. */
  get felt(): number {
    return this.feltOn ? this.tunables.feel * this.feltAlpha : 0;
  }

  // --- TouchSink ------------------------------------------------------------
  // The rifle registers with the touch layer exactly like the hall's mask and the props do, and
  // is asked the same three questions. It answers the first two and ignores the third: there is
  // no reach test to run, because the gun is not somewhere in the world for the hand to find —
  // it is the thing the hand is holding.

  setTouchVisible(on: boolean): void {
    this.feltOn = on;
  }

  setHand(_x: number, _y: number, _z: number, _span: number, _range: number, near: number): void {
    this.feltAlpha = near;
  }

  revealTouch(): number {
    // Nothing is *discovered* here — you have not just found your own rifle — so this reports
    // no newly felt points and keeps the hand's own statistics honest.
    return 0;
  }

  get energy(): number {
    return this.lastEnergy;
  }

  /**
   * One rendered frame. `lightX/Y/Z` is where the flash actually is (world space), `intensity`
   * is its candela already multiplied by the envelope — zero when there is no flash, which is
   * the whole law in one argument.
   *
   * `inView` is false in the top and free-camera debug views: a viewmodel seen from outside the
   * head is a prop floating in the hall, which is the one thing it must never become.
   *
   * `punch` is the render-only recoil the camera is already applying; the gun takes a little
   * more of it than the head does, which is where the weight in "отдача потяжелее" is felt
   * without costing the player a single degree of extra aim.
   */
  update(
    inView: boolean,
    debugLit: boolean,
    intensity: number,
    lightX: number, lightY: number, lightZ: number,
    eyeX: number, eyeY: number, eyeZ: number,
    punchPitch: number, punchBack: number,
  ): void {
    const t = this.tunables;
    const energy = Math.max(0, intensity) * t.gain;
    this.lastEnergy = energy;
    const feel = inView ? this.felt : 0;
    const solid = energy > 1e-4 || debugLit;
    const on = inView && t.visible && (solid || feel > 1e-3);
    this.object.visible = on;
    if (!on) return;
    /*
     * One object, two channels, never mixed. Light on it: the solid, shaded by the flash. Only
     * the hand on it: the stipple and the contour, and the solid reduced to a depth mask. The
     * hand never adds a single lumen to the shaded pass, which is why the tactile channel here
     * cannot become the "gun lamp" law 1 forbids.
     */
    this.mesh.visible = solid;
    const felt = !solid && feel > 1e-3;
    this.occluder.visible = felt;
    this.stipple.visible = felt;
    this.contour.visible = felt;
    const u = this.material.uniforms;
    u.uEnergy!.value = energy;
    u.uDebug!.value = debugLit ? 0.75 : 0;
    (u.uLightPos!.value as THREE.Vector3).set(lightX, lightY, lightZ);
    (u.uEye!.value as THREE.Vector3).set(eyeX, eyeY, eyeZ);
    if (felt) {
      this.stippleMaterial.uniforms.uBright!.value = feel;
      // A line covers many more pixels than a point does, so the contour is scaled down before
      // the ratio slider ever sees it — the same reasoning as the hall's own uTouchEdge.
      this.contourMaterial.uniforms.uBright!.value = feel * t.feelEdge * 0.34;
      (this.stippleMaterial.uniforms.uEye!.value as THREE.Vector3).set(eyeX, eyeY, eyeZ);
    }
    this.body.position.set(this.rest.x, this.rest.y, this.rest.z + punchBack * t.kickBack);
    this.body.rotation.x = t.tilt + punchPitch * t.kickPitch;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.stipple.geometry.dispose();
    this.contour.geometry.dispose();
    (this.occluder.material as THREE.Material).dispose();
    this.stippleMaterial.dispose();
    this.contourMaterial.dispose();
    this.material.dispose();
  }
}
