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
 * tactile layer draws grey contour pieces along the edges where a surface turns, and that is what
 * the rifle is now: its own contour and nothing else, in `TOUCH_GREY`.
 *
 * It used to also carry a stipple of grey points over its whole surface — the hall's other
 * tactile letter. The human's call of 2026-08-25 removed it ("точки с винтовки убрать, только
 * контур"), and the reason holds up: the hall's dots are *returns*, one per patch of world you
 * learned about, and the gun is the one object you never had to learn. A silhouette in the
 * bottom of frame says "your hands are here" without ever pretending to be information.
 *
 * The two channels never draw at once by accident and never blend: with a flash in flight the
 * solid is drawn (there is real light on it), and with only the hand on it, only the contour is.
 * What the contour *does* borrow from the solid is depth: the mesh is drawn colour-less into the
 * depth buffer first, so the far side of the receiver does not show through the near side. You
 * cannot feel through your own rifle.
 *
 * **M7 addendum — the radio.** Strapped to the side of the handguard, drawn in exactly the
 * contour channel above and nothing else: it never gets a solid/lit pass, because the spec is
 * explicit that this is a felt object, not a lit one (`doc/proto/m7-radio.md`, "рисуется тем же
 * контуром"). `setRadio()` is a second small method rather than new `update()` parameters, so
 * every existing caller of `update()` is untouched. Its indicator dot reuses the *same*
 * `uBright` the rifle's own contour just computed that frame — the dot only ever multiplies that
 * by 0 or 1 (off vs. lit), so it can never leak the one thing law 2 and the spec both forbid it
 * to show: signal clarity. Off/blinking/steady is the whole vocabulary.
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
   * at it, drawing the answer in that channel's own alphabet: a grey contour, never a lit body.
   *
   * Unlike everything else the hand draws, the gun is drawn *whole* rather than by radius —
   * the human's call, and the right one: the reach test exists because you only know the piece
   * of the world your hand happens to be on, and that reasoning simply does not apply to the
   * one object you are holding in both hands and have carried all night. Ты её знаешь на ощупь
   * целиком.
   */
  feel: number;
  /**
   * Brightness of the contour, as a multiple of `feel`. Since the stipple was removed this is the
   * *only* thing that draws the gun in the dark, so it carries the weight the surface used to
   * share: raised from 1.4 to 2.4 by eye on a keyframe, which puts the edges back at roughly the
   * brightness the whole gun used to read at.
   */
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
    feelEdge: 2.4,
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
 * The tactile shader. It is the whole point of the rework: what the hand draws is lines in one
 * flat grey, with no lighting model anywhere in it. There is no light position here, no falloff,
 * no exposure — a felt thing is not a lit thing, and if any of that crept in the channel would be
 * a lamp again.
 */
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
  /** The tactile channel, and the depth-only copy that stops it showing through the gun. */
  private readonly contour: THREE.LineSegments;
  private readonly occluder: THREE.Mesh;
  private readonly contourMaterial: THREE.ShaderMaterial;
  /** M7: the radio's own contour + depth mask, and its indicator dot. Hidden until picked up. */
  private readonly radioGeometry: THREE.BufferGeometry;
  private readonly radioContour: THREE.LineSegments;
  private readonly radioOccluder: THREE.Mesh;
  private readonly indicatorMesh: THREE.Mesh;
  private readonly indicatorMaterial: THREE.ShaderMaterial;
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
    // 25 degrees: every crease of a box and the rim of every cylinder, and nothing along the
    // flats. This is the same idea as the hall's contour pieces — where a surface turns, the hand
    // knows it — reused instead of hand-listing thirty edges.
    this.contour = new THREE.LineSegments(new THREE.EdgesGeometry(geometry, 25), this.contourMaterial);
    this.contour.frustumCulled = false;
    /*
     * Depth only, no colour. Without it the contour draws every hidden edge — the far side of
     * the receiver, the inside of the magazine well — and the gun turns into a wireframe box with
     * no front or back. Polygon offset pushes this copy a hair further from the eye so the lines
     * sitting exactly on the surface are not fighting it for the same depth.
     */
    this.occluder = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({
      colorWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 2,
    }));
    this.occluder.frustumCulled = false;
    this.occluder.renderOrder = -1;

    // M7 — the radio, strapped to the side of the handguard (the handguard box above sits at
    // local z=0.28, spanning roughly z 0.16..0.40) — clear of the front sight post at z=0.176
    // (that post is centred on x=0 and never reaches past x=0.006; the radio starts at x=0.035)
    // and the receiver cluster from z=0.43 on, so its silhouette reads on its own instead of
    // disappearing into either. A first pass sized it to match the rifle's own small accessories
    // (the rear sight block) and it measured out to a real but sub-pixel difference on screen —
    // legible to the diff check, invisible to a human glancing at the frame, which is the one
    // thing a proof frame may never be. Sized up a second time, deliberately bigger than its
    // realistic strapped-on-a-handguard proportions would suggest, specifically so a person
    // scanning the screenshot sees a chunky attached case with an antenna, not another sliver of
    // the rifle's own silhouette. Contour-only, same reasoning as the rifle's own: it is felt,
    // never lit.
    const radioParts: THREE.BufferGeometry[] = [
      box(0.054, 0.11, 0.047, 0.062, 0.045, 0.235),  // body
      tube(0.006, 0.13, 0.235, 0.105, 0.062),        // antenna
    ];
    const radioMerged = mergeGeometries(radioParts, false);
    for (const p of radioParts) p.dispose();
    if (radioMerged === null) throw new Error('rifle viewmodel: radio merge failed');
    radioMerged.computeVertexNormals();
    this.radioGeometry = radioMerged;
    this.radioContour = new THREE.LineSegments(
      new THREE.EdgesGeometry(radioMerged, 20),
      this.contourMaterial,
    );
    this.radioContour.frustumCulled = false;
    this.radioOccluder = new THREE.Mesh(radioMerged, new THREE.MeshBasicMaterial({
      colorWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 2,
    }));
    this.radioOccluder.frustumCulled = false;
    this.radioOccluder.renderOrder = -1;
    this.radioContour.visible = false;
    this.radioOccluder.visible = false;

    // The indicator dot: a filled quad, not an edge — it is a readout, not a crease of the case.
    // Same unlit shader as the contour, so it is exempt from law 2 in exactly the same way.
    this.indicatorMaterial = new THREE.ShaderMaterial({
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
    // Sized to actually read in a screenshot, not just to exist: the (now enlarged) body's front
    // face sits at z=0.2115, so the dot is pulled just proud of it (z=0.204) to avoid z-fighting
    // with the occluder, at roughly a third of the body's own face — big enough to be the first
    // thing a human notices change between "off" and "ready", never so big it reads as a second
    // light source of its own. Offset off the body's own centre line (x=0.042 vs the body/antenna
    // centre at x=0.062) so its silhouette does not fall directly behind the antenna mast, which
    // runs the full height of the front face right through the middle.
    const dotGeom = box(0.045, 0.045, 0.015, 0.042, 0.06, 0.2);
    this.indicatorMesh = new THREE.Mesh(dotGeom, this.indicatorMaterial);
    this.indicatorMesh.frustumCulled = false;
    this.indicatorMesh.visible = false;

    this.body.add(
      this.mesh,
      this.occluder,
      this.contour,
      this.radioContour,
      this.radioOccluder,
      this.indicatorMesh,
    );
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
     * the hand on it: the contour, and the solid reduced to a depth mask. The
     * hand never adds a single lumen to the shaded pass, which is why the tactile channel here
     * cannot become the "gun lamp" law 1 forbids.
     */
    this.mesh.visible = solid;
    const felt = !solid && feel > 1e-3;
    this.occluder.visible = felt;
    this.contour.visible = felt;
    const u = this.material.uniforms;
    u.uEnergy!.value = energy;
    u.uDebug!.value = debugLit ? 0.75 : 0;
    (u.uLightPos!.value as THREE.Vector3).set(lightX, lightY, lightZ);
    (u.uEye!.value as THREE.Vector3).set(eyeX, eyeY, eyeZ);
    if (felt) {
      // A line covers many more pixels than a point does, so the contour is scaled down before
      // the ratio slider ever sees it — the same reasoning as the hall's own uTouchEdge.
      this.contourMaterial.uniforms.uBright!.value = feel * t.feelEdge * 0.34;
    }
    this.body.position.set(this.rest.x, this.rest.y, this.rest.z + punchBack * t.kickBack);
    this.body.rotation.x = t.tilt + punchPitch * t.kickPitch;
  }

  /**
   * M7. Call once per frame, right after `update()` — it reads the tactile brightness `update()`
   * just computed for the rifle's own contour and reuses it verbatim, so the radio fades with
   * touch distance exactly like the gun does and never needs a brightness law of its own.
   *
   * `indicatorState` is the three-state readout from `Radio.indicator()`; `blinkOn` is
   * `Radio.blinkOn(now)` — a sim-time phase, computed by the caller so this method stays a pure
   * function of its arguments. Brightness is only ever multiplied by 0 or 1: the dot cannot leak
   * clarity because clarity never reaches this method at all.
   */
  setRadio(present: boolean, indicatorState: 'off' | 'settling' | 'ready', blinkOn: boolean): void {
    const felt = this.contour.visible;
    const show = present && felt;
    this.radioContour.visible = show;
    this.radioOccluder.visible = show;
    this.indicatorMesh.visible = show;
    if (!show) return;
    const lit = indicatorState === 'ready' || (indicatorState === 'settling' && blinkOn);
    this.indicatorMaterial.uniforms.uBright!.value = lit
      ? this.contourMaterial.uniforms.uBright!.value
      : 0;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.contour.geometry.dispose();
    this.radioGeometry.dispose();
    this.radioContour.geometry.dispose();
    (this.occluder.material as THREE.Material).dispose();
    (this.radioOccluder.material as THREE.Material).dispose();
    this.indicatorMesh.geometry.dispose();
    this.indicatorMaterial.dispose();
    this.contourMaterial.dispose();
    this.material.dispose();
  }
}
